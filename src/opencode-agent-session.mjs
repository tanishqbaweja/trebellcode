import { createServer as createNetServer } from "node:net";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { Readable } from "node:stream";
import spawn from "cross-spawn";
import { fileUri, fileUriPath } from "./file-uri.mjs";
import { isDocumentTextPath } from "./document-text.mjs";
import { attachmentLine } from "./attachment-line.mjs";
import { PROMPT_TEXT_PATH } from "./prompt-attachments.mjs";
import { retryNotice } from "./retry-notice.mjs";
import { HarnessSessionLostError } from "./harness-session-lost.mjs";
import { NATIVE_PROMPT_PROVENANCE } from "./native-request-metrics.mjs";
import { normalizePermissionKind, normalizePermissionMode, permissionDisposition } from "./permission-policy.mjs";
import { runtimeInstructions } from "./runtime-instructions.mjs";
import { isUserResponseTimeout } from "./user-response-timeout.mjs";

// OpenCode's SDK clients load with the first OpenCode server Trebell talks to, before it starts one, not with the server (budget B25).
let openCodeSdk=null,openCodeV2Sdk=null,openCode2Client=null;
const loadOpenCodeClients=()=>Promise.all([openCodeSdk??=import("@opencode-ai/sdk"),openCodeV2Sdk??=import("@opencode-ai/sdk/v2")]);
const loadOpenCode2Client=()=>openCode2Client??=import("@opencode/client");

// OpenCode reads a file part itself: it sends an image or a PDF to the model and reads any other file as text. Audio and video are
// named by their saved path instead, as is every attachment that does not go as an image, text or PDF. A Word, Excel or
// other document (document-text.mjs), which OpenCode would read as the bytes of its archive, goes as the text extracted from it,
// named with the document's path; one Trebell has no text of is named by its path alone.
const MIME={".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".gif":"image/gif",".webp":"image/webp",".pdf":"application/pdf",".md":"text/markdown",".json":"application/json",".txt":"text/plain"};
const MEDIA=new Map([...[".mp3",".wav",".m4a",".ogg",".oga",".flac",".aac",".opus",".aiff"].map(extension=>[extension,"audio"]),...[".mp4",".mov",".mkv",".webm",".avi",".m4v",".mpeg",".mpg"].map(extension=>[extension,"video"])]);
export function openCodeBodyParts(parts){
  return parts.flatMap(part=>{
    if(part.type==="text")return {type:"text",text:String(part.text||"")};
    if(part.type==="image")return {type:"file",mime:part.mimeType||"image/png",url:`data:${part.mimeType||"image/png"};base64,${part.data}`};
    if(part.type==="resource_link"){
      const path=fileUriPath(part.uri)||"",extension=extname(path).toLowerCase(),media=MEDIA.get(extension),name=part.name||basename(path);
      if(media)return {type:"text",text:attachmentLine(media,name,path)};
      const textPath=part[PROMPT_TEXT_PATH];
      if(textPath)return [{type:"text",text:attachmentLine("file",name,path,textPath)},{type:"file",mime:"text/plain",filename:`${name}.txt`,url:fileUri(textPath)}];
      if(isDocumentTextPath(path))return {type:"text",text:attachmentLine("file",name,path)};
      return {type:"file",mime:MIME[extension]||"text/plain",filename:part.name||undefined,url:part.uri};
    }
    return {type:"text",text:JSON.stringify(part)};
  });
}

// OpenCode errors arrive as {name,data:{message}}, {message} or, from a server that is not OpenCode's JSON API, as a web page. Some
// carry the server's stack trace after the message; only the message is shown.
const OPENCODE_ERROR_TEXT=Object.freeze({MessageOutputLengthError:"The reply reached the model's output limit before it finished",MessageAbortedError:"The request was stopped"});
const withoutStack=text=>text.replace(/\r?\n\s+at\s[\s\S]*$/,"").trim();
function openCodeErrorText(error){
  if(error==null)return "";
  if(typeof error==="string"){const text=error.trim();return !text||text.startsWith("<")?"":withoutStack(text).slice(0,2000)}
  const message=[error?.data?.message,error?.message].find(value=>typeof value==="string"&&value.trim());
  if(message)return withoutStack(message.trim()).slice(0,2000);
  const name=String(error?.name||"").trim();
  return OPENCODE_ERROR_TEXT[name]||(name?`OpenCode reported ${name}`:"");
}
// OpenCode answers a prompt whose model call failed before it began (an unknown model, for one) with this, and reports the reason
// itself as a session.error event.
const GENERIC_SERVER_ERROR=/^Unexpected server error\b/i;
const LATE_SESSION_ERROR_MS=1000;
// The error keeps the HTTP status OpenCode answered with: OpenCode 1.x refuses a wrong password with an empty 401, which says nothing.
function unwrap(result,label="OpenCode request"){
  const status=Number(result?.response?.status)||0;
  if(result?.error)throw Object.assign(new Error(openCodeErrorText(result.error)||`${label} failed`),status?{status}:{});
  return result?.data;
}

async function freePort(){
  const server=createNetServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}
async function cleanupWithin(promise,timeoutMs=1500){
  if(!promise)return;
  let timer;try{await Promise.race([Promise.resolve(promise).catch(()=>{}),new Promise(resolve=>{timer=setTimeout(resolve,timeoutMs)})])}finally{if(timer)clearTimeout(timer)}
}

// OpenCode 1.x prints "opencode server listening on <url>"; 2.x prints "server listening on <url>" and then a generated server password,
// which never reaches an error message. The URL counts once its line has ended, so a chunk boundary cannot cut it short.
const SERVER_LISTENING=/server listening\b.*?\bon\s+(https?:\/\/[^\s]+)\s/i;
function startupLog(output){return String(output||"").replace(/^(.*?server password\b).*$/gim,"$1 [redacted]").slice(-2000).trim()}
function stopProcessTree(child){
  if(!child||child.exitCode!==null||child.signalCode!==null)return;
  if(process.platform==="win32"&&child.pid){
    try{execFileSync("taskkill",["/PID",String(child.pid),"/T","/F"],{stdio:"ignore",windowsHide:true});return}catch{}
  }
  try{child.kill()}catch{}
}
// A managed 1.x server takes OPENCODE_SERVER_PASSWORD (and OPENCODE_SERVER_USERNAME, else "opencode") from the profile's environment and
// then answers only Basic auth with them, so each of its clients sends them. A server of the
// profile's own (serverUrl) is not sent this machine's password.
export function openCodeServerHeaders(env={}){
  const password=String(env?.OPENCODE_SERVER_PASSWORD||"");if(!password)return {};
  return {Authorization:`Basic ${Buffer.from(`${String(env?.OPENCODE_SERVER_USERNAME||"")||"opencode"}:${password}`,"utf8").toString("base64")}`};
}
// The 1.x SDK client of a server startServer gave.
export function openCodeClientOptions(server,directory){
  const headers=server?.headers||{};return {baseUrl:server.url,directory,...(Object.keys(headers).length?{headers}:{})};
}
// How long `opencode serve` may take to say it listens: Trebell's own 45 s. OpenCode 2 converts the shared database on its first run
// before it listens, which takes longest on a large database and a slow disk; a start that takes longer is reported as failed.
const SERVER_START_TIMEOUT_MS=45_000;
// Every `opencode serve` Trebell starts shares OpenCode's database (opencode.db): each thread's, the status check's and model list's,
// and Git text's. One that finds the database locked by another exits saying so on stderr, and is started again on a new port, at most
// four more times half a second apart: Trebell's own two seconds in all for the other server to finish its start and let go of the
// database. Any other exit is final. So is one that lost the first run's schema setup to
// another: OpenCode 1.x and 2.x then fail a CREATE statement of their own ("Failed query: CREATE TABLE ...", a table that already
// exists), which a second start a moment later gets past.
const SERVER_LOCK_RETRIES=4,SERVER_LOCK_RETRY_MS=500,DATABASE_CONTENDED=/SQLITE_BUSY|database is locked|Failed query:\s*CREATE\s/i;
// A server that exited can still have its last words in its pipes, which a process it started may hold open: they get a second,
// Trebell's own wait for a server's late words, as long as a session's late error gets (LATE_SESSION_ERROR_MS).
const SERVER_EXIT_DRAIN_MS=1_000;
async function startServer({command="opencode",cwd,env=process.env,serverUrl=null}={}){
  if(serverUrl)return {url:serverUrl,headers:{},close(){}};
  for(let retry=0;;retry++){
    try{return await startServerOnce({command,cwd,env})}
    catch(error){
      if(error?.code!=="OPENCODE_DATABASE_BUSY"||retry>=SERVER_LOCK_RETRIES)throw error;
      await new Promise(resolve=>setTimeout(resolve,SERVER_LOCK_RETRY_MS));
    }
  }
}
async function startServerOnce({command,cwd,env}){
  const port=await freePort();const args=["serve","--hostname=127.0.0.1",`--port=${port}`];
  const child=spawn(command,args,{cwd,env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
  // Only the recent output is kept: it is just for startup errors, and the server lives as long as the session. Its stderr is kept apart
  // too: only what it says there of the database counts.
  let output="",errors="";const keep=chunk=>{output=(output+String(chunk)).slice(-8192)};
  try{
    const url=await new Promise((resolve,reject)=>{
      let settled=false,exited=false;const timer=setTimeout(()=>finish(new Error(`OpenCode server did not start within ${SERVER_START_TIMEOUT_MS/1000} seconds. ${startupLog(output)}`)),SERVER_START_TIMEOUT_MS);
      const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value)};
      child.stdout?.on("data",chunk=>{keep(chunk);const match=output.match(SERVER_LISTENING);if(match&&!exited)finish(null,match[1])});
      child.stderr?.on("data",chunk=>{keep(chunk);errors=(errors+String(chunk)).slice(-8192)});child.once("error",error=>finish(error));
      // The exit's error waits for both pipes to end ('close'), or for SERVER_EXIT_DRAIN_MS, after which they are let go.
      child.once("exit",code=>{
        exited=true;if(settled)return;clearTimeout(timer);
        const failed=()=>{
          clearTimeout(drain);child.off("close",failed);child.stdout?.destroy();child.stderr?.destroy();
          finish(Object.assign(new Error(`OpenCode server exited with code ${code}. ${startupLog(output)}`),DATABASE_CONTENDED.test(errors)?{code:"OPENCODE_DATABASE_BUSY"}:{}));
        };
        const drain=setTimeout(failed,SERVER_EXIT_DRAIN_MS);child.once("close",failed);
      });
    });
    return {url,child,headers:openCodeServerHeaders(env),close(){stopProcessTree(child)}};
  }catch(error){
    // A server that did not come up (a timeout, or a version Trebell cannot talk to) is not left running.
    stopProcessTree(child);throw error;
  }
}
export const startOpenCodeServer=startServer;

const OPENCODE2_USERNAME="opencode";
function openCode2Authorization(password=""){return `Basic ${Buffer.from(`${OPENCODE2_USERNAME}:${String(password)}`,"utf8").toString("base64")}`}
export async function startOpenCode2Server({command="opencode",cwd,env=process.env,serverUrl=null}={}){
  if(serverUrl){
    const password=String(env?.OPENCODE_PASSWORD||env?.OPENCODE_SERVER_PASSWORD||"");
    return {url:serverUrl,password,close(){}};
  }
  const password=randomBytes(32).toString("base64url"),serverEnv={...(env||{})};
  delete serverEnv.OPENCODE_SERVER_PASSWORD;serverEnv.OPENCODE_PASSWORD=password;
  const server=await startServer({command,cwd,env:serverEnv});return {...server,password};
}
function createOpenCode2Client(OpenCode2,server){
  return OpenCode2.make({baseUrl:server.url,headers:{Authorization:openCode2Authorization(server.password)}});
}
// A request to an OpenCode 2 server that must answer within ms (signal => request): past that it is cancelled and fails with message.
export async function openCode2Within(ms,message,request){
  const controller=new AbortController();let timer;
  const late=new Promise((_,reject)=>{timer=setTimeout(()=>{reject(new Error(message));controller.abort()},ms)});
  try{return await Promise.race([Promise.resolve().then(()=>request(controller.signal)),late])}finally{clearTimeout(timer)}
}
// An OpenCode 2 server is ready once it answers server.info, which it answers from memory: Trebell's own 8 s leaves room for a
// machine busy with a build, and one that has not answered by then is not ready.
export const OPENCODE2_INFO_TIMEOUT_MS=8_000;
export function openCode2ServerInfo(client){
  return openCode2Within(OPENCODE2_INFO_TIMEOUT_MS,`OpenCode server did not answer within ${OPENCODE2_INFO_TIMEOUT_MS/1000} seconds.`,signal=>client.server.info({signal}));
}

// OpenCode 1.x answers POST /session/{id}/message (and /summarize) only once the whole turn has finished. Node's fetch (undici) stops
// waiting for response headers after 300 seconds, so every OpenCode turn longer than five minutes failed in Trebell while OpenCode went
// on working; the SDK's own remedy (request.timeout=false) only applies on Bun. These long requests go through Node's http client
// instead, which has no header or body deadline. Trebell ends them by aborting the OpenCode session, or through the request's signal.
export async function openCodeLongRequestFetch(input,init){
  const request=input instanceof Request?(init?new Request(input,init):input):new Request(input,init);
  const url=new URL(request.url);
  if(url.protocol!=="http:"&&url.protocol!=="https:")throw new TypeError(`Unsupported OpenCode server URL protocol: ${url.protocol}`);
  const body=request.body?Buffer.from(await request.arrayBuffer()):null,signal=request.signal;
  const headers={};request.headers.forEach((value,key)=>{if(key!=="content-length")headers[key]=value});
  headers["accept-encoding"]="identity";if(body)headers["content-length"]=String(body.length);
  const send=url.protocol==="https:"?httpsRequest:httpRequest;
  return await new Promise((resolve,reject)=>{
    const aborted=()=>signal?.reason instanceof Error?signal.reason:Object.assign(new Error("The OpenCode request was aborted"),{name:"AbortError"});
    if(signal?.aborted)return reject(aborted());
    // agent:false: a dedicated connection without the shared agent's idle-socket timeout.
    const req=send(url,{method:request.method,headers,agent:false},res=>{
      const status=res.statusCode||0;
      if(status<200||status>599){res.resume();reject(new Error(`OpenCode answered with HTTP status ${status}`));return}
      const responseHeaders=new Headers();
      for(const [key,value] of Object.entries(res.headers))for(const item of Array.isArray(value)?value:[value])if(item!=null)responseHeaders.append(key,String(item));
      const empty=request.method==="HEAD"||status===204||status===205||status===304;if(empty)res.resume();
      resolve(new Response(empty?null:Readable.toWeb(res),{status,statusText:res.statusMessage||"",headers:responseHeaders}));
    });
    const onAbort=()=>req.destroy(aborted());
    signal?.addEventListener?.("abort",onAbort,{once:true});
    req.once("error",reject);req.once("close",()=>signal?.removeEventListener?.("abort",onAbort));
    req.end(body||undefined);
  });
}

function toProviderModel(value,map){
  if(map.has(value))return map.get(value);
  const raw=String(value||"");const index=raw.indexOf("/");if(index>0)return {providerID:raw.slice(0,index),modelID:raw.slice(index+1)};
  return null;
}

// OpenCode 2.x serves its web app on the 1.x routes (/provider, /session, /event) and its JSON API only under /api with a server
// password, so Trebell's requests get a web page back. That is reported as an incompatible server, not as an empty model list.
export const OPENCODE_UNSUPPORTED_SERVER="This OpenCode server does not offer the OpenCode 1.x API that Trebell Code's OpenCode harness uses (OpenCode 2.x serves a different API). Use OpenCode 1.x (the opencode-ai npm package), or point this OpenCode profile's binary at a 1.x build.";
export function checkedOpenCodeProviders(data){
  if(data&&typeof data==="object"&&Array.isArray(data.all))return data;
  throw Object.assign(new Error(OPENCODE_UNSUPPORTED_SERVER),{code:"OPENCODE_UNSUPPORTED_SERVER"});
}

// OpenCode picks a new session's model in this order: the model in its merged config ("model"), then the most recently used model
// that is still available, then a connected provider's default. Trebell's default OpenCode model follows the same order; a configured
// or recent model whose provider is no longer connected is skipped, as OpenCode's own model picker does.
const trimmedText=value=>typeof value==="string"?value.trim():"";
// A model's reasoning levels are its OpenCode variants, by the names OpenCode gives them.
const OPENCODE_VARIANT=/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export function openCodeModelVariants(entry){
  const variants=entry?.variants&&typeof entry.variants==="object"&&!Array.isArray(entry.variants)?entry.variants:{};
  return Object.entries(variants).filter(([name,options])=>OPENCODE_VARIANT.test(name)&&options?.disabled!==true).map(([name])=>name);
}
// The reasoning level a model starts on when the thread has not picked one: a model with a single level starts on it; otherwise
// the provider decides which names come first (Anthropic's and Google's models start high, OpenAI's and OpenCode Zen's at medium,
// or high without one), and a provider with no such names leaves the level unset (null).
const STARTING_LEVELS=Object.freeze([
  {provider:id=>id==="anthropic"||id.startsWith("google"),levels:["high"]},
  {provider:id=>id==="openai"||id==="opencode",levels:["medium","high"]},
]);
export function openCodeStartingVariant(providerID,variants=[]){
  const offered=Array.isArray(variants)?variants:[];
  if(offered.length===1)return offered[0];
  const id=providerID?String(providerID):"";
  const preferred=STARTING_LEVELS.find(entry=>entry.provider(id))?.levels??[];
  return preferred.find(level=>offered.includes(level))??null;
}

export function connectedOpenCodeModels(providers={},{configured=null,recent=[]}={}){
  const connected=new Set(Array.isArray(providers?.connected)?providers.connected.map(String):[]),models=[];
  const visible=(Array.isArray(providers?.all)?providers.all:[]).filter(provider=>!connected.size||connected.has(String(provider.id)));
  for(const provider of visible)for(const entry of Object.values(provider.models||{}))models.push({
    id:`${provider.id}/${entry.id}`,providerID:String(provider.id),modelID:String(entry.id),
    name:trimmedText(entry.name)||String(entry.id),providerName:trimmedText(provider.name)||String(provider.id),
    context:Number(entry.limit?.context)||0,variants:openCodeModelVariants(entry),
  });
  const ids=new Set(models.map(item=>item.id));
  const providerDefault=[...connected].map(providerID=>providers.default?.[providerID]?`${providerID}/${providers.default[providerID]}`:null).find(id=>id&&ids.has(id))||models[0]?.id||null;
  const preferred=[configured,...(Array.isArray(recent)?recent:[])].map(value=>String(value??"").trim()).find(id=>id&&ids.has(id))||providerDefault;
  return {models,preferred};
}

// OpenCode keeps the models picked in its TUI and app in <state>/opencode/model.json ("recent", newest first). Its state folder follows
// xdg-basedir on every platform, Windows and macOS included: $XDG_STATE_HOME, else <home>/.local/state. The file holds no credentials.
export function openCodeStateDirectory(env=process.env,{platform=process.platform}={}){
  const state=String(env?.XDG_STATE_HOME||"").trim();
  if(state)return join(state,"opencode");
  const home=String((platform==="win32"?env?.USERPROFILE:env?.HOME)||"").trim()||homedir();
  return join(home,".local","state","opencode");
}
export async function readOpenCodeRecentModels({env=process.env,platform=process.platform,readText=path=>readFile(path,"utf8")}={}){
  try{
    const parsed=JSON.parse(String(await readText(join(openCodeStateDirectory(env,{platform}),"model.json"))||""));
    const recent=Array.isArray(parsed?.recent)?parsed.recent:[];
    return [...new Set(recent.flatMap(item=>{
      const provider=typeof item?.providerID==="string"?item.providerID.trim():"",model=typeof item?.modelID==="string"?item.modelID.trim():"";
      return provider&&model?[`${provider}/${model}`]:[];
    }))].slice(0,50);
  }catch{return []}
}
async function openCodeConfiguredModel(client,directory){
  try{
    const config=unwrap(await client?.config?.get?.({query:{directory}}),"config");
    const model=typeof config?.model==="string"?config.model.trim():"";return model||null;
  }catch{return null}
}
// The configured model comes from the server's config API. The recent list exists only in OpenCode's state folder, which is read just for
// a server Trebell started on this machine: an external server may run elsewhere, with other state. Trebell starts OpenCode with an
// allowlisted environment that may leave XDG_STATE_HOME out, so the user's own value (where their OpenCode writes) still counts.
export async function openCodeModelPreferences({client,directory,env=process.env,platform=process.platform,localState=true,readText}={}){
  const stateEnv={XDG_STATE_HOME:process.env.XDG_STATE_HOME,...(env||{})};
  const [configured,recent]=await Promise.all([
    openCodeConfiguredModel(client,directory),
    localState?readOpenCodeRecentModels({env:stateEnv,platform,...(readText?{readText}:{})}):Promise.resolve([]),
  ]);
  return {configured,recent};
}

// The agents a session can run as: OpenCode's primary agents (build, plan and the user's own). Subagents run
// only through the task tool, and hidden agents (title, summary, compaction) are OpenCode's internals.
export function openCodePrimaryAgents(agents=[]){
  return (Array.isArray(agents)?agents:[]).filter(agent=>agent&&typeof agent==="object"&&agent.name&&agent.hidden!==true&&agent.mode!=="subagent");
}
// One of OpenCode's lists (commands, skills, agents), waited for at most timeoutMs: OpenCode lists MCP prompts among its commands, which
// can take long. null when it did not answer in time or failed: the list is pending, and a later read
// fills it in. A null timeoutMs waits for OpenCode's answer, for a list nothing waits on.
export function openCodeListWithin(read,timeoutMs=COMMAND_LIST_TIMEOUT_MS){
  const listed=Promise.resolve().then(read).then(value=>Array.isArray(value)?value:[]);
  if(timeoutMs==null)return listed.catch(()=>null);
  let timer;
  return Promise.race([listed,new Promise(resolve=>{timer=setTimeout(()=>resolve(null),timeoutMs);timer.unref?.()})]).catch(()=>null).finally(()=>clearTimeout(timer));
}
// A session's commands, skills and agents, each a list or null while it is pending (openCodeListWithin). listMs bounds the commands and
// skills; the agents are always waited for at most COMMAND_LIST_TIMEOUT_MS.
function openCodeInventoryReads(client,v2Client,directory,{listMs=COMMAND_LIST_TIMEOUT_MS}={}){
  return {
    commands:openCodeListWithin(()=>client.command.list({query:{directory}}).then(result=>unwrap(result,"command list")),listMs),
    skills:openCodeListWithin(()=>Promise.resolve(v2Client?.app?.skills?.({directory})).then(result=>unwrap(result,"skill list")),listMs),
    agents:openCodeListWithin(()=>client.app.agents({query:{directory}}).then(result=>unwrap(result,"agent list"))),
  };
}
// A session's commands, skills and agents reach the composer (session_info_update) as OpenCode lists them. The returned function sends
// the session's first update, with the lists in by then; each list that comes later goes in an update of its own, with every list known
// by then (the relay keeps a thread's last update). A list that failed or never came stays the profile's (its model list's inventory).
export function openCodeListsAsListed(session,reads,{agents:primary=openCodePrimaryAgents}={}){
  const lists={};for(const [name,read] of Object.entries(reads))void read.then(list=>{if(list)lists[name]=list});
  const update=(extra={})=>({sessionUpdate:"session_info_update",...(lists.commands?{commands:lists.commands}:{}),...(lists.skills?{skills:lists.skills}:{}),...(lists.agents?{agents:primary(lists.agents)}:{}),...extra});
  return first=>{
    session.onUpdate?.({sessionId:session.sessionId,update:update(first)});
    for(const [name,read] of Object.entries(reads))if(!lists[name])void read.then(list=>{if(list&&!session.closed)session.onUpdate?.({sessionId:session.sessionId,update:update()})});
  };
}
// The lists of an inventory that are pending, by name.
const pendingLists=lists=>Object.entries(lists).filter(([,list])=>list===null).map(([name])=>name);
// A profile's commands, skills and agents, which a new chat shows before its first message, and the names of those still pending.
async function openCodeInventory(client,v2Client,directory){
  const reads=openCodeInventoryReads(client,v2Client,directory),[commands,skills,agents]=await Promise.all([reads.commands,reads.skills,reads.agents]);
  return {commands:commands||[],skills:skills||[],agents:agents||[],pending:pendingLists({commands,skills,agents})};
}

// onServerStart(promise): the read's server start, which can take SERVER_START_TIMEOUT_MS (the status check waits for it).
export async function discoverOpenCodeModelCatalog({command="opencode",cwd=process.cwd(),env=process.env,serverUrl=null,readText,onServerStart=null}={}){
  const [{createOpencodeClient},{createOpencodeClient:createOpencodeV2Client}]=await loadOpenCodeClients();
  const starting=startServer({command,cwd,env,serverUrl});onServerStart?.(starting);
  const server=await starting;
  const client=createOpencodeClient(openCodeClientOptions(server,cwd)),v2Client=createOpencodeV2Client(openCodeClientOptions(server,cwd));
  try{
    const providers=checkedOpenCodeProviders(unwrap(await client.provider.list({query:{directory:cwd}}),"provider list"));
    const [preferences,inventory]=await Promise.all([openCodeModelPreferences({client,directory:cwd,env,localState:!serverUrl,readText}),openCodeInventory(client,v2Client,cwd)]);
    const catalog=connectedOpenCodeModels(providers,preferences);
    const ordered=catalog.preferred?[catalog.models.find(item=>item.id===catalog.preferred),...catalog.models.filter(item=>item.id!==catalog.preferred)].filter(Boolean):catalog.models;
    return {
      models:ordered.map(item=>item.id),
      metadata:ordered.map(item=>({
        id:item.id,name:item.name,provider:"opencode",agent:"OpenCode",upstreamProvider:item.providerName,
        ...(item.context?{contextWindow:item.context}:{}),
        ...(item.variants.length?{reasoningEfforts:item.variants,defaultReasoningEffort:openCodeStartingVariant(item.providerID,item.variants)}:{}),
      })),
      preferred:catalog.preferred,
      connectedProviders:Array.isArray(providers.connected)?providers.connected.map(String):[],
      inventory:{commands:inventory.commands,skills:inventory.skills,agents:openCodePrimaryAgents(inventory.agents)},
      ...(inventory.pending.length?{pending:inventory.pending}:{}),
      source:"live-connected",
    };
  }finally{
    server.close?.();
    await cleanupWithin(client?.instance?.dispose?.({query:{directory:cwd}}),1500);
  }
}

export function openCode2ModelId(model){
  const providerID=String(model?.providerID||"").trim(),modelID=String(model?.modelID||model?.id||"").trim();
  if(!providerID)return modelID;
  return modelID?`${providerID}/${modelID}`:"";
}
function openCode2Variants(model){return (Array.isArray(model?.variants)?model.variants:[]).map(item=>String(item?.id||"").trim()).filter(value=>OPENCODE_VARIANT.test(value))}
// ---- OpenCode 2's model list, read until it holds still
// A cold OpenCode 2 server may answer the first reads of its model list from a catalog it is still loading. So the list counts once
// two usable answers in a row list the same models (modelCensus says what "the same" covers). The wait gives up at whichever comes
// first, timeoutMs after it began or settleMs after the first usable answer, and then keeps the newest usable answer (or, without
// one, the last answer) as not settled. A read that fails keeps the newest usable answer in the same way, and fails the wait when
// there is none yet. Trebell's own values: two answers, the least that can show the list stopped changing (each further one would
// add a read to every cold start); intervalMs 300 ms between reads, so two that agree are a little further apart than 2.1.2's
// quarter second; settleMs 6 s, 2.1.2's 5 s and a fifth more, which at that spacing still holds twenty reads; timeoutMs 15 s.
const blankIfMissing=value=>value===undefined||value===null?"":String(value);
// What two answers must agree on: how many times each model is listed, a model being its provider and id, its name, whether it is
// enabled (a model without the flag is) and its variants' ids in sorted order. Neither the list's order nor its variants' order counts.
function modelCensus(models){
  const census=new Map();
  for(const model of models){
    const variantIds=(Array.isArray(model?.variants)?model.variants:[]).map(variant=>blankIfMissing(variant?.id)).sort();
    const description=JSON.stringify([blankIfMissing(model?.providerID),blankIfMissing(model?.id),blankIfMissing(model?.name),model?.enabled!==false,variantIds]);
    census.set(description,(census.get(description)??0)+1);
  }
  return census;
}
const sameCensus=(earlier,later)=>earlier.size===later.size&&[...earlier].every(([description,count])=>later.get(description)===count);
// One wait's state. take(answer) weighs the next answer and gives the wait's result once it is over (null: read again); failed(error)
// gives the result after a read that threw.
function modelListSettling({timeoutMs,settleMs,requiredModel}){
  const needed=String(requiredModel||"").trim();
  let giveUpAt=Date.now()+timeoutMs,newestUsable=null,censusBefore=null;
  // Usable: some models, and the one the session must have among them.
  const usable=answer=>{
    const models=answer?.data;
    return Array.isArray(models)&&models.length>0&&(needed===""||models.some(model=>openCode2ModelId(model)===needed));
  };
  return {
    take(answer){
      const census=usable(answer)?modelCensus(answer.data):null;
      if(census&&censusBefore&&sameCensus(censusBefore,census))return {...answer,settled:true};
      if(census){
        if(!newestUsable)giveUpAt=Math.min(giveUpAt,Date.now()+settleMs);
        newestUsable=answer;
      }
      censusBefore=census;
      return Date.now()<giveUpAt?null:{...(newestUsable??answer),settled:false};
    },
    failed(error){
      if(!newestUsable)throw error;
      return {...newestUsable,settled:false};
    },
  };
}
export async function waitForOpenCode2Models(client,location,{timeoutMs=15_000,settleMs=6_000,intervalMs=300,requiredModel=null}={}){
  const settling=modelListSettling({timeoutMs,settleMs,requiredModel});
  for(;;){
    let answer;
    try{answer=await client.model.list({location})}catch(error){return settling.failed(error)}
    const over=settling.take(answer);
    if(over)return over;
    await new Promise(resume=>setTimeout(resume,intervalMs));
  }
}
export async function discoverOpenCode2ModelCatalog({command="opencode",cwd=process.cwd(),env=process.env,serverUrl=null,onServerStart=null}={}){
  const {OpenCode:OpenCode2}=await loadOpenCode2Client();
  const starting=startOpenCode2Server({command,cwd,env,serverUrl});onServerStart?.(starting);
  const server=await starting,client=createOpenCode2Client(OpenCode2,server),location={directory:cwd};
  try{
    await openCode2ServerInfo(client);
    const [modelResult,providerResult,defaultResult,commands,skills,agents]=await Promise.all([
      waitForOpenCode2Models(client,location),
      client.provider.list({location}).catch(()=>({data:[]})),
      client.model.default({location}).catch(()=>({data:null})),
      ...openCode2InventoryReads(client,location),
    ]);
    const providerNames=new Map((providerResult?.data||[]).map(provider=>[String(provider.id),trimmedText(provider.name)||String(provider.id)]));
    const rows=(Array.isArray(modelResult?.data)?modelResult.data:[]).filter(model=>model?.enabled!==false).map(model=>{
      const id=openCode2ModelId(model),variants=openCode2Variants(model),providerID=String(model.providerID||"");
      return {id,providerID,name:trimmedText(model.name)||id,providerName:providerNames.get(providerID)||providerID,context:Number(model.limit?.context)||0,variants};
    }).filter(item=>item.id);
    const preferred=openCode2ModelId(defaultResult?.data)||rows[0]?.id||null,ordered=preferred?[rows.find(item=>item.id===preferred),...rows.filter(item=>item.id!==preferred)].filter(Boolean):rows;
    const pending=[...(rows.length&&modelResult?.settled===false?["models"]:[]),...pendingLists({commands,skills,agents})];
    return {
      models:ordered.map(item=>item.id),
      metadata:ordered.map(item=>({id:item.id,name:item.name,provider:"opencode",agent:"OpenCode",upstreamProvider:item.providerName,...(item.context?{contextWindow:item.context}:{}),...(item.variants.length?{reasoningEfforts:item.variants,defaultReasoningEffort:openCodeStartingVariant(item.providerID,item.variants)}:{})})),
      preferred,
      connectedProviders:[...new Set(ordered.map(item=>item.providerID).filter(Boolean))],
      inventory:{commands:commands||[],skills:skills||[],agents:openCode2PrimaryAgents(agents||[])},
      // A model list that was still changing when the wait ended is pending too: a later read lists the rest.
      ...(pending.length?{pending}:{}),
      source:"live-connected-v2",
    };
  }finally{server.close?.()}
}
// OpenCode 2's commands, skills and agents (each a list, or null while pending: openCodeListWithin, which listMs bounds).
export function openCode2InventoryReads(client,location,{listMs=COMMAND_LIST_TIMEOUT_MS}={}){
  return [client.command,client.skill,client.agent].map(api=>openCodeListWithin(()=>api.list({location}).then(result=>result?.data),listMs));
}
// OpenCode 2 names an agent by its id.
export function openCode2PrimaryAgents(agents=[]){return openCodePrimaryAgents(agents.map(agent=>({...agent,name:agent?.name||agent?.id})))}

function permissionResponse(decision){return decision==="acceptForSession"?"always":decision==="accept"?"once":"reject"}
const PERMISSION_MODE_NAMES=Object.freeze({"read-only":"Read only",supervised:"Supervised",edits:"Auto-accept edits",auto:"Auto",full:"Full access"});
// A reject without a message is OpenCode's stop: it ends the whole run, which only a Stop (cancel) means. Any other refusal goes with
// its reason, which OpenCode hands the model as the tool's answer, so the turn carries on and the model can say what it could not do.
// unanswered: the window stopped waiting for the person's answer.
export function openCodeRefusal(decision,{disposition=null,mode=null,action="",resources=[]}={}){
  if(["accept","acceptForSession","cancel"].includes(decision))return null;
  const what=`The ${openCodeRequestName(action,resources)}`;
  const reason=disposition==="deny"?`${what} was refused: this thread is in Trebell's ${PERMISSION_MODE_NAMES[normalizePermissionMode(mode)]} mode.`:decision==="unanswered"?`${what} was not answered in time, so it was declined.`:`${what} was declined.`;
  return {reason,note:reason+" Do not retry it; continue without it, and tell the user what it would need."};
}
// A permission request by its action and what it is for: "shell request (npm test)".
export function openCodeRequestName(action="",resources=[]){
  const shown=(Array.isArray(resources)?resources:[]).map(String).filter(Boolean).slice(0,3);
  return `${String(action||"tool")} request`+(shown.length?` (${shown.join(", ")})`:"");
}

export async function configureOpenCodeMcpServers(client,{cwd,servers=[]}={}){
  if(!client?.mcp?.add)return [];
  const results=[];
  for(const server of Array.isArray(servers)?servers:[]){
    if(!server?.name||!server?.config)continue;
    try{
      const response=unwrap(await client.mcp.add({query:{directory:cwd},body:{name:String(server.name),config:server.config}}),`MCP ${server.name}`),status=response?.[server.name]||null;
      results.push({name:String(server.name),configured:true,status});
    }catch(error){results.push({name:String(server.name),configured:false,error:String(error?.message||error).slice(0,2000)})}
  }
  return results;
}

export function openCodePermissionDisposition(mode,type){
  return permissionDisposition(mode,normalizePermissionKind(type),{readOnlyAllowsRead:false});
}

// A session's permission rules are the only thing that keeps an OpenCode tool from running unasked: OpenCode has no sandbox. It
// reads the agent's rules and then the session's, and the last rule whose permission and pattern match decides ("*" matches all).
// A tool whose last "*" rule denies it is left out of the model's request, and OpenCode Zen's free tier refuses a request without
// the shell or read tool ("OpenCode's free tier can only be used from within OpenCode"), so no mode denies those two in the session.
//
// OpenCode's permission keys, from its permissions page and the v2 PermissionConfig its SDK declares, each list sorted by key. A
// mode decides the guarded ones: shell commands, file changes, the network (a URL fetch, web and code search), paths outside the
// project, and one call repeated three times over. OpenCode answers rules for distinct keys independently, so their order in a run
// changes no decision.
const GUARDED_KEYS=Object.freeze(["bash","codesearch","doom_loop","edit","external_directory","webfetch","websearch"]);
// The rest run unasked in every mode: reading and searching the project, language-server queries, skills, subagents, the todo list
// (todoread is the separate read tool of earlier OpenCode releases) and questions to the person.
const FREE_KEYS=Object.freeze(["glob","grep","list","lsp","question","read","skill","task","todoread","todowrite"]);
const ruleMaker=action=>(permission,pattern="*")=>({permission,pattern,action});
const allowRule=ruleMaker("allow"),askRule=ruleMaker("ask"),denyRule=ruleMaker("deny");
// Each mode that asks, as the layers its rules are built from, in order:
// - forSubagents: the gated tools a subagent may not run. A subagent's (task tool's) session starts with only the parent's deny
//   and folder rules, and nobody can be asked there: in supervised mode it gets none of these tools, in edits mode only edits, in
//   read only no commands either. Auto lets Trebell answer every request, so nothing is held back there.
// - inSession: how the session itself answers each gated tool, "ask" or "deny", or nothing, which leaves it to "*" (ask). Read only
//   removes edits, searches beyond the workspace and other folders, and asks for commands, which its policy then refuses unasked;
//   a URL fetch is a read and asks through "*".
// - secrets: how a read of a .env file is answered (a .env.example is always read).
// - editsRun: whether edits run unasked.
const ASKING_MODES=Object.freeze({
  supervised:{forSubagents:()=>true,inSession:()=>"ask",secrets:"ask",editsRun:false},
  edits:{forSubagents:tool=>tool!=="edit",inSession:()=>"ask",secrets:"ask",editsRun:true},
  auto:{forSubagents:()=>false,inSession:()=>"ask",secrets:"ask",editsRun:false},
  "read-only":{forSubagents:tool=>tool!=="webfetch",inSession:tool=>tool==="webfetch"?null:tool==="bash"?"ask":"deny",secrets:"deny",editsRun:false},
});
// Folder patterns as text, each once in the order first given, empty ones left out.
const folderPatterns=folders=>new Set((Array.isArray(folders)?folders:[]).map(String).filter(folder=>folder.length>0));
// mode: a Trebell permission mode. allowedTools: tool permission names that run unasked (Trebell's read-only repository MCP tools).
// trustedDirectories: folders outside the workspace that OpenCode's agents already allow (its tool-output and temporary folders,
// skill folders, the user's own), which the rule for other folders would otherwise take away. Full mode allows everything, other
// folders too, and needs neither.
export function openCodeSessionRules(mode,{allowedTools=[],trustedDirectories=[]}={}){
  const level=normalizePermissionMode(mode);
  if(level==="full")return [allowRule("*"),allowRule("external_directory")];
  const layers=ASKING_MODES[level]??ASKING_MODES.supervised,rules=[];
  for(const tool of GUARDED_KEYS)if(layers.forSubagents(tool))rules.push(denyRule(tool));
  rules.push(askRule("*"));
  for(const tool of GUARDED_KEYS){const action=layers.inSession(tool);if(action)rules.push(ruleMaker(action)(tool))}
  for(const tool of [...FREE_KEYS,...(Array.isArray(allowedTools)?allowedTools:[])])rules.push(allowRule(tool));
  const secretRule=ruleMaker(layers.secrets);
  rules.push(secretRule("read","*.env"),secretRule("read","*.env.*"),allowRule("read","*.env.example"));
  if(layers.editsRun)rules.push(allowRule("edit"));
  for(const folder of folderPatterns(trustedDirectories))rules.push(allowRule("external_directory",folder));
  return rules;
}
const sameRule=(left,right)=>left?.permission===right?.permission&&left?.pattern===right?.pattern&&left?.action===right?.action;
// OpenCode adds the rules of a session update after the ones the session has. Rules whose last entries already are these change nothing.
export function openCodeRulesEndWith(current=[],rules=[]){
  const have=Array.isArray(current)?current:[];
  return rules.length>0&&have.length>=rules.length&&rules.every((rule,index)=>sameRule(have[have.length-rules.length+index],rule));
}
// A subagent's session, once it exists, gets the parent's whole rule list, then the rules OpenCode gave that agent itself (no todo
// list or nested tasks, say), which must stay last to keep deciding. OpenCode started the subagent's session with the parent's deny
// and folder rules followed by the agent's own; the inherited ones are in the parent's list already and are not repeated.
const ruleIdentity=rule=>JSON.stringify([rule?.permission,rule?.pattern,rule?.action]);
export function openCodeSubagentRules(rulesOfParent=[],openCodeRules=[]){
  const parent=Array.isArray(rulesOfParent)?rulesOfParent:[],inherited=new Set();
  for(const rule of parent)if(rule?.action==="deny"||rule?.permission==="external_directory")inherited.add(ruleIdentity(rule));
  const agentOwn=(Array.isArray(openCodeRules)?openCodeRules:[]).filter(rule=>!inherited.has(ruleIdentity(rule)));
  return [...parent,...agentOwn];
}
// The folders OpenCode's agents allow outside the workspace, sorted: OpenCode lists its skill folders in no set order, and a session
// reopened by another server must get the same rules, or they would be appended again.
export function openCodeTrustedDirectories(agents=[]){
  const patterns=new Set();
  for(const agent of Array.isArray(agents)?agents:[])for(const rule of Array.isArray(agent?.permission)?agent.permission:[]){
    if(rule?.permission==="external_directory"&&rule.action==="allow"&&typeof rule.pattern==="string"&&rule.pattern&&rule.pattern!=="*")patterns.add(rule.pattern);
  }
  return [...patterns].sort();
}
// A message that is "/name" or "/name arguments" asks for a command: the name runs from the "/" to the first space or line break
// and holds no other "/", and the arguments are what follows that space, from its first other character (empty without one).
// Anything else is a plain message (null).
export function openCodeSlashCommand(text){
  const message=String(text??"");
  if(message[0]!=="/")return null;
  const gap=message.search(/\s/),name=gap<0?message.slice(1):message.slice(1,gap);
  if(!name||name.includes("/"))return null;
  return {name,arguments:gap<0?"":message.slice(gap).trimStart()};
}

// OpenCode message IDs, as OpenCode makes its own (packages/opencode/src/id/id.ts, Identifier.create, at v1.3.15): "msg_", then a
// 48-bit clock (milliseconds * 0x1000 + a counter, the higher bits dropped) as six bytes in hex, then 14 base62 characters, its ID
// length of 26 less those 12 digits. OpenCode orders a session's messages and forks by comparing these IDs, so a client ID must
// sort after every message the session has. Trebell names each user message itself, which gives a turn its rewind point before
// OpenCode answers.
const OPENCODE_ID_RANDOM_LENGTH=14;
const BASE62_DIGITS="0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
// Random base62 characters, each as likely as the others: a byte picks one only below 248 (four times 62), the rest are drawn again.
function randomBase62(count){
  let text="";
  while(text.length<count)for(const byte of randomBytes(count))if(byte<248&&text.length<count)text+=BASE62_DIGITS[byte%62];
  return text;
}
export function openCodeMessageTime(id){
  const match=/^msg_([0-9a-f]{12})/.exec(String(id||""));
  return match?BigInt("0x"+match[1]):null;
}
export function openCodeMessageId(clock){
  const sixBytes=Buffer.alloc(6);
  sixBytes.writeUIntBE(Number(BigInt.asUintN(48,BigInt(clock))),0,6);
  return "msg_"+sixBytes.toString("hex")+randomBase62(OPENCODE_ID_RANDOM_LENGTH);
}
// A fork gives every copied message a new ID. A turn's rewind point moves to its copy; a turn whose message OpenCode never stored (the
// request failed before it arrived) moves to the copy of the next message after it, or past every copy when there is none.
export function remapOpenCodeMessageId(id,{messageIds=[],tailId=null}={}){
  const value=String(id||"");if(!value)return id;
  const pairs=Array.isArray(messageIds)?messageIds:[];
  const exact=pairs.find(([source])=>source===value);if(exact)return exact[1];
  let next=null;for(const pair of pairs)if(pair[0]>value&&(!next||pair[0]<next[0]))next=pair;
  return next?next[1]:(tailId||id);
}
export function remapOpenCodeTurns(turns=[],mapping={}){
  const move=value=>value?remapOpenCodeMessageId(value,mapping):value;
  return (Array.isArray(turns)?turns:[]).map(turn=>{
    if(!turn||typeof turn!=="object")return turn;
    const next={...turn};
    if(turn.providerMessageId)next.providerMessageId=move(turn.providerMessageId);
    if(Array.isArray(turn.items))next.items=turn.items.map(item=>item&&typeof item==="object"&&item.providerMessageId?{...item,providerMessageId:move(item.providerMessageId)}:item);
    return next;
  });
}

// OpenCode 1.x's read tool wraps what it read in tags, a line each: <path>, <type> (file or directory), then the file's numbered
// lines between <content> and </content>, or the folder's entries between <entries> and </entries>. A read row shows what was read,
// followed by whatever OpenCode wrote after the closing tag (a system reminder with a folder's instructions, say). Output in any
// other shape (OpenCode 2's own read output, plain text, a wrapping cut short) is shown as it is.
export function unwrapOpenCodeRead(output){
  if(typeof output!=="string")return output;
  const pathLine=lineAt(output,0);
  if(pathLine.next<0||!namesAPath(textOf(output,pathLine)))return output;
  const typeLine=lineAt(output,pathLine.next);
  const kind=typeLine.next<0?null:READ_KINDS.get(textOf(output,typeLine));
  const read=kind==="file"?fileLines(output,typeLine.next):kind==="directory"?folderEntries(output,typeLine.next):null;
  return read?read.text+output.slice(read.after):output;
}
// The line that starts at `start`: where its text ends (before its line break, "\n" or "\r\n") and where the next line starts, or -1
// for the last line, which has no break (a "\r" at the very end of the output is part of its text).
function lineAt(text,start){
  const feed=text.indexOf("\n",start);
  if(feed<0)return {start,end:text.length,next:-1};
  return {start,end:feed>start&&text[feed-1]==="\r"?feed-1:feed,next:feed+1};
}
const textOf=(text,line)=>text.slice(line.start,line.end);
const READ_KINDS=new Map([["<type>file</type>","file"],["<type>directory</type>","directory"]]);
// "<path>", then a path of at least one character with no carriage return in it, then "</path>".
const namesAPath=line=>line.length>"<path></path>".length&&line.startsWith("<path>")&&line.endsWith("</path>")&&!line.includes("\r");
// The text from `from` to the line break before the first line after `first` that is exactly `closingTag`, and where the output
// goes on after that tag; null when no line closes it.
function upToClosingLine(text,first,from,closingTag){
  for(let previous=first,start=first.next;start>=0;){
    const line=lineAt(text,start);
    if(textOf(text,line)===closingTag)return {text:text.slice(from,previous.end),after:line.start+closingTag.length};
    previous=line;start=line.next;
  }
  return null;
}
// A folder: "<entries>" alone on its line, the entries on the lines after it, then "</entries>" on a line of its own.
function folderEntries(text,start){
  const opening=lineAt(text,start);
  if(opening.next<0||textOf(text,opening)!=="<entries>")return null;
  const first=lineAt(text,opening.next);
  return upToClosingLine(text,first,first.start,"</entries>");
}
// A file: "<content>", the file's lines (from the next line when the tag stands alone, else right after the tag), then "</content>"
// on a line of its own; a numbered line that holds the tag ("2: </content> literal") does not end the file. An empty file can close
// on the line right after a lone "<content>".
function fileLines(text,start){
  const opening=lineAt(text,start),openingText=textOf(text,opening);
  if(!openingText.startsWith("<content>"))return null;
  if(openingText!=="<content>")return upToClosingLine(text,opening,opening.start+"<content>".length,"</content>");
  if(opening.next<0)return null;
  const first=lineAt(text,opening.next);
  return upToClosingLine(text,first,first.start,"</content>")??(textOf(text,first)==="</content>"?{text:"",after:first.start+"</content>".length}:null);
}

// A path as a tool's row names it: from the thread's folder when it is in it (as OpenCode titles its reads), whole when it is not. A
// Windows folder (on a drive or a share) holds the path whichever separators and case the model wrote it with, as Windows reads it.
function folderPath(path,cwd){
  const file=String(path||"").trim(),root=String(cwd||"").replace(/[\\/]+$/,"");
  if(!root||file.length<=root.length+1||!"\\/".includes(file[root.length]))return file;
  const head=file.slice(0,root.length),windows=/^(?:[a-z]:|[\\/]{2})/i.test(root),same=value=>value.replace(/\\/g,"/").toLowerCase();
  return head===root||(windows&&same(head)===same(root))?file.slice(root.length+1):file;
}
// A tool call's row title: what it does, the file or folder a read reads, how many questions a question asks (as OpenCode titles it once
// they are answered), and OpenCode's own title of a command or another tool.
export function openCodeToolTitle(tool,{title:stateTitle="",input=null,cwd=""}={}){
  const id=String(tool||"").toLowerCase();
  if(id==="read"){const path=folderPath(input?.filePath??input?.path,cwd);return path?`Read ${path}`:"Read file"}
  if(id==="question"){const asked=Array.isArray(input?.questions)?input.questions.length:0;return asked?`Asked ${asked} question${asked===1?"":"s"}`:"Ask a question"}
  if(id==="write")return "Write file";
  if(id==="edit"||id==="patch")return "Edit files";
  if(id==="bash"||id==="shell")return stateTitle&&stateTitle.length<120?stateTitle:"Run command";
  if(id==="grep"||id==="search")return "Search workspace";
  if(id==="glob")return "Find files";
  if(id==="webfetch"||id==="fetch")return "Fetch URL";
  return stateTitle&&stateTitle.length<120?stateTitle:String(tool||"Tool");
}
// What a question's row shows: each question OpenCode asked, then the answer it got once there are answers, and a note (why OpenCode
// refused the answer, or what it said when the answers are not known).
export function openCodeQuestionText(questions,answers=null,note=""){
  const lines=[];
  for(const [index,item] of (Array.isArray(questions)?questions:[]).entries()){
    lines.push(String(item?.question||item?.header||"").trim()||`Question ${index+1}`);
    if(Array.isArray(answers)){const answer=[answers[index]].flat().map(value=>String(value??"").trim()).filter(Boolean).join(", ");lines.push(answer?`Answer: ${answer}`:"No answer")}
  }
  if(note)lines.push(String(note));
  return lines.join("\n");
}
// A tool's ACP kind. OpenCode's own ACP server calls grep and glob searches and webfetch a fetch; list, codesearch and websearch only
// read too. The relay keeps a session whose harness ran a tool of another kind past the idle sweep (a command or a subagent can
// outlive its turn), so an OpenCode chat whose searches went out as "other" kept its `opencode serve` until the thread closed. A read,
// a search, a fetch and an other show the same tool row.
function toolKind(tool){
  const id=String(tool||"").toLowerCase();
  if(id==="bash"||id==="shell")return "execute";
  if(id==="edit"||id==="write")return "edit";
  if(id==="read"||id==="list")return "read";
  if(id==="grep"||id==="glob"||id==="search"||id==="codesearch")return "search";
  if(id==="webfetch"||id==="fetch"||id==="websearch")return "fetch";
  return "other";
}
const PERMISSION_LABELS=Object.freeze({edit:"Edit files",write:"Write file",bash:"Run command",read:"Read file",glob:"Find files",grep:"Search workspace",list:"List folder",webfetch:"Fetch URL",websearch:"Search the web",codesearch:"Search code",task:"Start a subtask",skill:"Load a skill",external_directory:"Use a folder outside the workspace",doom_loop:"Repeat the same tool call again"});
// OpenCode 1.x after 1.14 asks with permission.asked {permission, patterns, metadata, tool}; older versions sent permission.updated {type, title}.
function openCodePermissionTitle(request){
  const kind=String(request?.permission||"").trim(),patterns=(Array.isArray(request?.patterns)?request.patterns:[]).map(String).filter(Boolean);
  const label=PERMISSION_LABELS[kind]||kind||"OpenCode permission";
  return (patterns.length?`${label}: ${patterns.join(", ")}`:label).slice(0,300);
}

// OpenCode retries a failed provider call on its own schedule: up to five times in current 1.x releases, after the provider's
// retry-after when it sends one (for a spent quota that can be hours), and without a limit in older releases. Trebell waits for retries
// that come soon; a retry that is further away than this, or one past this many attempts, ends the turn with the provider's error.
export const OPENCODE_RETRY_LIMITS=Object.freeze({waitMs:120_000,attempts:5});
function describeWait(ms){
  const minutes=Math.round(ms/60_000);if(minutes<90)return `about ${Math.max(1,minutes)} minute${minutes===1?"":"s"}`;
  const hours=Math.round(ms/3_600_000);if(hours<48)return `about ${hours} hours`;
  return `about ${Math.round(ms/86_400_000)} days`;
}
export function openCodeRetryStop(status,{now=Date.now(),model=null,limits=OPENCODE_RETRY_LIMITS}={}){
  if(status?.type!=="retry")return null;
  const attempt=Math.max(0,Math.floor(Number(status.attempt)||0)),next=Number(status.next),wait=Number.isFinite(next)?Math.max(0,next-now):0;
  if(attempt<=limits.attempts&&wait<=limits.waitMs)return null;
  const reason=String(openCodeErrorText(status.message)||"The model provider request kept failing").replace(/[\s.]+$/,"");
  const target=model?` ${model}`:"";
  const plan=wait>limits.waitMs?`OpenCode would retry${target} only in ${describeWait(wait)}`:`OpenCode kept retrying${target} (attempt ${attempt})`;
  return `${reason}. ${plan}, so Trebell stopped the turn. Try again later or choose another model.`;
}
// A retry Trebell waits for is the turn's retry row (an `error` with willRetry, which reads recovered once the turn goes on), in the
// words of every harness that retries by itself (retry-notice.mjs): what failed, then the model OpenCode sends the request to again
// (a subagent's request is named as the subagent's), in how long, and which retry that is.
export function openCodeRetryNotice({message=null,model=null,retry=1,waitMs=0,subagent=false}={}){
  const failed=openCodeErrorText(message)||"The model provider request failed";
  const which=`retry ${Math.max(1,Math.floor(Number(retry)||1))}`,seconds=(Number(waitMs)||0)/1000;
  if(subagent)return `A subagent's model request failed: ${retryNotice({reason:failed,sender:"OpenCode",what:"it",seconds,which})}`;
  return retryNotice({reason:failed,sender:"OpenCode",what:`the request to ${model||"the model"}`,seconds,which});
}

// What Trebell does with an event of a subagent's (child) session that holds this session's turn until Trebell answers or stops it,
// by OpenCode's event type (@opencode-ai/sdk's types.gen.d.ts): a permission it asks for (permission.asked, or permission.updated
// before OpenCode 1.14), a question it asks, or a retry it schedules (a session.status whose status is of type retry).
const CHILD_SESSION_HOLDS=new Map([
  ["permission.asked","permission"],
  ["permission.updated","permission"],
  ["question.asked","question"],
  ["session.status","retry"],
]);
const PROMPT_STOPPED=Symbol("opencode-prompt-stopped");
// After Trebell stops a turn (cancel, close, or a retry it will not wait for), OpenCode normally answers the pending prompt at once with
// an aborted message. If it does not, the turn still ends after this grace period.
const OPENCODE_STOP_GRACE_MS=15_000;
const REPORTED_ERROR_MS=60_000;
// How long a command, skill or agent list may take: Trebell's own 12 s. OpenCode lists the prompts of every MCP server the project
// configures among its commands, so the list waits on the slowest of those servers, and one that has to start or reach a remote
// host first can take seconds. 2.1.2 waited 10 s; 12 s gives such a server a fifth more and never gives up sooner. It bounds:
// - the command, skill and agent lists a status check reads (one that takes longer stays pending, and a later read fills it in);
// - the agents a new OpenCode 1.x session waits for, whose rules name the session's trusted folders (agents that come later add
//   none); its commands and skills reach the composer whenever OpenCode lists them;
// - the command list a message starting with "/name" is looked up in before it is sent (a lookup that runs out sends it as text).
const COMMAND_LIST_TIMEOUT_MS=12_000;

export class OpenCodeAgentSession{
  constructor({command="opencode",cwd,env=process.env,serverUrl=null,permissionMode="supervised",onUpdate,onPermission,onQuestion,repositoryMcp=null,readStateFile=undefined}={}){
    this.command=command;this.cwd=cwd;this.env=env;this.serverUrl=serverUrl;this.permissionMode=normalizePermissionMode(permissionMode||"supervised");this.onUpdate=onUpdate;this.onPermission=onPermission;this.onQuestion=onQuestion;
    this.server=null;this.client=null;this.v2Client=null;this.sessionId=null;this.sessionSetup=null;this.initializeResult={agentCapabilities:{loadSession:true,sessionCapabilities:{fork:{},resume:{},close:{}}},agentInfo:{name:"OpenCode"}};
    this.model=null;this.modelMap=new Map();this.contextByModel=new Map();this.modelNames=new Map();this.modelVariants=new Map();this.variant=null;
    this.partText=new Map();this.closed=false;this.eventAbort=new AbortController();this.eventTask=null;
    this.messageRoles=new Map();this.repositoryMcp=repositoryMcp;this.repositoryMcpStatus=[];this.readStateFile=readStateFile;
    // The session's permission rules as OpenCode holds them, the folders its agents trust, and the newest message time seen (client
    // message IDs must sort after it).
    this.sessionPermission=[];this.trustedDirectories=[];this.messageClock=0n;
    this.activePrompt=null;this.reportedErrors=[];this.serverExit=null;
    // Session ID -> whether it is a subagent (child) session of this one. The IDs of the assistant's text and reasoning parts, whose
    // deltas are streamed, and the subagent sessions that already have this session's rules.
    this.subagentSessions=new Map();this.assistantTextParts=new Set();this.reasoningParts=new Set();this.subagentsGivenRules=new Set();
  }
  async start({providerSessionId=null,model=null}={}){
    const [{createOpencodeClient},{createOpencodeClient:createOpencodeV2Client}]=await loadOpenCodeClients();
    this.server=await startServer({command:this.command,cwd:this.cwd,env:this.env,serverUrl:this.serverUrl});
    // A session closed while its server started had no server to stop then, so it stops it now.
    if(this.closed){this.server.close?.();throw new Error("OpenCode was stopped while it started.")}
    this.server.child?.once?.("exit",(code,signal)=>{this.serverExit={code,signal}});
    this.client=createOpencodeClient(openCodeClientOptions(this.server,this.cwd));
    this.v2Client=createOpencodeV2Client(openCodeClientOptions(this.server,this.cwd));
    if(this.repositoryMcp)this.repositoryMcpStatus=await configureOpenCodeMcpServers(this.client,{cwd:this.cwd,servers:[{name:this.repositoryMcp.name,config:this.repositoryMcp.openCode}]});
    // The session's commands, skills and agents are read beside its setup. Only the agents hold its creation, for at most
    // COMMAND_LIST_TIMEOUT_MS:
    // their rules name the folders the session's rules keep allowed. The commands (OpenCode lists MCP prompts among them, which can take
    // long) and the skills reach the composer whenever OpenCode lists them.
    const reads=openCodeInventoryReads(this.client,this.v2Client,this.cwd,{listMs:null}),announce=openCodeListsAsListed(this,reads);
    const providers=checkedOpenCodeProviders(unwrap(await this.client.provider.list({query:{directory:this.cwd}}),"provider list"));
    let catalog=connectedOpenCodeModels(providers);
    for(const entry of catalog.models){
      this.modelMap.set(entry.id,{providerID:entry.providerID,modelID:entry.modelID});this.modelNames.set(entry.id,entry.name);this.modelVariants.set(entry.id,entry.variants);
      if(entry.context)this.contextByModel.set(entry.id,entry.context);
    }
    const requested=model&&toProviderModel(model,this.modelMap)?model:null;
    if(!requested)catalog=connectedOpenCodeModels(providers,await openCodeModelPreferences({client:this.client,directory:this.cwd,env:this.env,localState:!this.serverUrl,readText:this.readStateFile}));
    this.model=requested||catalog.preferred;
    // The agents' own rules name the folders they trust, which the session's rules keep allowed.
    this.trustedDirectories=openCodeTrustedDirectories(await reads.agents||[]);
    let info=null;
    if(providerSessionId){
      const found=await this.client.session.get({path:{id:providerSessionId},query:{directory:this.cwd}});
      // OpenCode answers a session it no longer has (deleted, or kept by another data folder) with 404: a lost session, which the
      // relay continues in one fresh session with the thread's earlier messages handed over. Any other failure is OpenCode's own.
      if(found?.response?.status===404)throw new HarnessSessionLostError(`OpenCode could not resume this conversation: ${openCodeErrorText(found.error)||"session not found"}`,{harness:"opencode",sessionId:providerSessionId});
      info=unwrap(found,"session get");
    }
    if(info){this.#useSession(info);await this.#applyPermissionRules()}
    else{
      // No title: OpenCode names the session from its first prompt only when it is created without one.
      const rules=this.#permissionRules();
      info=unwrap(await this.client.session.create({query:{directory:this.cwd},body:{permission:rules}}),"session create");
      this.#useSession(info,rules);
    }
    const availableModels=[...this.modelMap.keys()];if(this.model&&!availableModels.includes(this.model))availableModels.push(this.model);
    this.sessionSetup={sessionId:this.sessionId,models:{currentModelId:this.model,availableModels:availableModels.map(modelId=>({modelId,name:this.modelNames.get(modelId)||modelId}))},configOptions:[],modes:{currentModeId:"build",availableModes:[]},trebellRepositoryMcp:this.repositoryMcpStatus[0]||null};
    announce({status:{type:"idle"}});
    this.#startEvents();return {initialize:this.initializeResult,session:this.sessionSetup};
  }
  // The thread's permission mode, applied to the session's rules before the next prompt (a running turn keeps the rules it started with).
  async setPermissionMode(mode){
    this.permissionMode=normalizePermissionMode(mode||"supervised");
    if(this.client&&this.sessionId)await this.#applyPermissionRules();
    return this.permissionMode;
  }
  // The composer's reasoning level: an OpenCode variant, sent only with a model that has it.
  setReasoningEffort(value){this.variant=typeof value==="string"&&value.trim()?value.trim():null;return this.variant}
  // onDelivered: told once OpenCode has recorded the prompt with the Trebell context beside it (a slash command sends the user's
  // attachments only, so it never tells).
  async prompt(parts,{agent=null,onDelivered=null}={}){
    const given=Array.isArray(parts)?parts:[];
    const bodyParts=openCodeBodyParts(given);
    const selected=toProviderModel(this.model,this.modelMap),modelId=selected?`${selected.providerID}/${selected.modelID}`:null;
    const variant=this.variant&&(this.modelVariants.get(modelId)||[]).includes(this.variant)?this.variant:null;
    // A message steered into the turn is sent with the turn's model, agent, level and instructions.
    const options={...(selected?{model:selected}:{}),...(agent?{agent}:{}),...(variant?{variant}:{}),system:runtimeInstructions({harness:"OpenCode",model:this.model})};
    // Trebell names the user message, so the turn's rewind point is known even when OpenCode never answers.
    const messageID=this.#nextMessageId(),turn=this.#beginPrompt(modelId,options);
    const cancelled={stopReason:"cancelled",providerMessageId:messageID,assistantMessageId:null,raw:null};
    let response;
    try{
      const command=await this.#slashCommand(given);
      // OpenCode has the prompt once it records the user message under Trebell's ID (its message.updated event), or answers it.
      if(!command&&typeof onDelivered==="function"){let told=false;turn.messageID=messageID;turn.delivered=()=>{if(told)return;told=true;try{onDelivered()}catch{}}}
      if(turn.cancelled||turn.stopError)response=PROMPT_STOPPED;
      else{
        const query={directory:this.cwd},path={id:this.sessionId};
        // A slash command runs as OpenCode's own command: its template, agent and model come from the command, with the
        // user's text after the command as its arguments and only their attachments as parts. An attachment OpenCode gets as a line
        // instead (a document without text, audio, video) and a document's line naming its text follow the arguments, so none drops
        // out of the command unsaid.
        const lines=command?openCodeBodyParts(given.filter(part=>part?.type==="resource_link")).filter(part=>part.type==="text").map(part=>part.text):[];
        const request=command
          ?this.client.session.command({path,query,body:{messageID,command:command.name,arguments:[command.arguments,...lines].filter(Boolean).join("\n\n"),...(modelId?{model:modelId}:{}),...(agent?{agent}:{}),...(variant?{variant}:{}),parts:bodyParts.filter(part=>part.type==="file")},fetch:openCodeLongRequestFetch})
          :this.client.session.prompt({path,query,body:{messageID,...options,parts:bodyParts},fetch:openCodeLongRequestFetch});
        request.catch(()=>{});turn.sent();
        response=await Promise.race([request,turn.stopped]);
        // OpenCode answers every prompt of a busy session once its loop ends, all with the loop's last message. A steered message that
        // came as the loop was ending starts the next loop, which the turn waits for too. The last answer is the turn's.
        for(let index=0;index<turn.steers.length&&response!==PROMPT_STOPPED&&!response?.error&&!response?.data?.info?.error;index++){
          const answer=await Promise.race([turn.steers[index].request.catch(error=>({transportError:error})),turn.stopped]);
          if(answer===PROMPT_STOPPED||turn.cancelled||turn.stopError){response=PROMPT_STOPPED;break}
          if(answer?.data)response=answer;else this.#steerRefused(answer);
        }
      }
    }catch(error){response={transportError:error}}
    finally{turn.done=true;turn.sent();clearTimeout(turn.timer)}
    if(response?.data)turn.delivered?.();
    try{
      if(turn.stopError)throw Object.assign(turn.stopError,{providerMessageId:messageID});
      if(response===PROMPT_STOPPED)return cancelled;
      if(response?.transportError){if(turn.cancelled)return cancelled;throw this.#failure(turn,turn.sessionError||this.#transportText(response.transportError),messageID)}
      if(response?.error){
        if(turn.cancelled)return cancelled;
        // OpenCode's own reason (its session.error event) says more than a generic server error, and can arrive just after it.
        const answer=openCodeErrorText(response.error);
        if(!turn.sessionError&&(!answer||GENERIC_SERVER_ERROR.test(answer)))await this.#lateSessionError(turn);
        throw this.#failure(turn,turn.sessionError||answer||"OpenCode rejected the request",messageID);
      }
    }finally{if(this.activePrompt===turn)this.activePrompt=null}
    // The answer of a steered turn is to its last message; the turn's rewind point stays at its first.
    const result=response?.data,info=result?.info||{},providerMessageId=turn.steers.length?messageID:info.parentID||messageID;
    this.#noteMessage(info.id,"assistant");this.#noteMessage(providerMessageId,"user");
    if(info.error){
      if(turn.cancelled||info.error?.name==="MessageAbortedError")return {...cancelled,providerMessageId,assistantMessageId:info.id||null,raw:result};
      // OpenCode keeps the failed turn's messages, so the error carries their IDs (a rewind point before or at this turn).
      throw Object.assign(this.#failure(turn,openCodeErrorText(info.error)||turn.sessionError||"OpenCode model request failed",providerMessageId),{assistantMessageId:info.id||null});
    }
    const responseTextParts=(result?.parts||[]).filter(part=>part.type==="text");
    const full=responseTextParts.map(part=>part.text||"").join("");
    const emitted=responseTextParts.map(part=>this.partText.get(part.id)||"").join("");
    if(full&&full!==emitted){const suffix=full.startsWith(emitted)?full.slice(emitted.length):full;this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:suffix}}})}
    const tokens=info.tokens||{};if(tokens.input!=null){const modelId=`${info.providerID||selected?.providerID||""}/${info.modelID||selected?.modelID||""}`;this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"usage_update",used:Number(tokens.input||0)+Number(tokens.output||0)+Number(tokens.reasoning||0),size:this.contextByModel.get(modelId)||0,cost:info.cost!=null?{amount:info.cost,currency:"USD"}:null,usage:{input_tokens:Number(tokens.input||0),output_tokens:Number(tokens.output||0),reasoning_tokens:Number(tokens.reasoning||0),cache_read_input_tokens:Number(tokens.cache?.read||0),cache_write_input_tokens:Number(tokens.cache?.write||0)}}})}
    // A session error during a turn that still finished is not lost: it is shown once the turn is done.
    if(turn.sessionError&&!this.#recentlyReported(turn.sessionError)){this.#remember(turn.sessionError);this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"runtime_error",message:turn.sessionError}})}
    return {stopReason:"end_turn",providerMessageId,assistantMessageId:info.id||null,raw:result};
  }
  // A message sent while a turn runs joins it: it goes into the busy session, whose loop takes it at its next
  // step, and the turn ends once it is answered.
  async steer(parts){
    const turn=this.activePrompt,ended=()=>this.activePrompt!==turn||turn.done||turn.cancelled||turn.stopError;
    if(!turn||ended())throw new Error("OpenCode has no running turn to steer.");
    const bodyParts=openCodeBodyParts(Array.isArray(parts)?parts:[]);
    if(!bodyParts.length)throw new Error("There is nothing to add to OpenCode's running turn: the message has no text and no attachment.");
    // The turn's own message is sent first, so the steered one follows it.
    await turn.started;
    if(ended())throw new Error("The OpenCode turn ended before the message could join it.");
    const messageID=this.#nextMessageId();this.#noteMessage(messageID,"user");
    const request=this.client.session.prompt({path:{id:this.sessionId},query:{directory:this.cwd},body:{messageID,...turn.options,parts:bodyParts},fetch:openCodeLongRequestFetch});
    request.catch(()=>{});turn.steers.push({messageID,request});
    return {accepted:true,pending:0,providerMessageId:messageID};
  }
  async setModel(model){if(toProviderModel(model,this.modelMap))this.model=model;return {modelId:this.model}}
  async cancel(){
    this.#stopPrompt(this.activePrompt);
    if(this.client&&this.sessionId)await this.client.session.abort({path:{id:this.sessionId},query:{directory:this.cwd}}).catch(()=>{});
  }
  // A copy of the whole conversation. The result maps each message to its copy, so the forked thread's turns keep
  // their rewind points.
  async fork(){
    this.#assertIdle("forking");
    const source=await this.#messages(this.sessionId);
    const info=unwrap(await this.client.session.fork({path:{id:this.sessionId},query:{directory:this.cwd},body:{}}),"session fork");
    const copied=await this.#messages(info.id);
    if(copied.length!==source.length||copied.some((message,index)=>message?.info?.role!==source[index]?.info?.role))throw new Error("OpenCode did not copy this conversation into the fork as it is.");
    return {...info,sessionId:info.id,...this.#copyMapping(source,copied)};
  }
  // Rewinds the conversation to just before the user message `messageID`: OpenCode copies the messages before
  // it into a new session, which this session continues in. Files are left as they are: Trebell restores them itself, from the
  // checkpoint the app offers. OpenCode's session.revert would also undo the files changed since that message.
  async rewind(messageID){
    this.#assertIdle("rewinding");
    const boundary=String(messageID||"");
    if(!openCodeMessageTime(boundary))throw Object.assign(new Error(`OpenCode could not rewind to this turn: ${boundary||"it"} is not an OpenCode message ID.`),{code:"OPENCODE_REWIND_TARGET_MISSING"});
    const messages=await this.#messages(this.sessionId);
    // OpenCode keeps the messages whose IDs sort before the boundary. A turn whose message OpenCode never stored has nothing after it to
    // drop when it is the last one; the session then stays as it is.
    const kept=messages.filter(message=>String(message?.info?.id||"")<boundary);
    if(kept.length===messages.length)return {sessionId:this.sessionId,messageIds:[],tailId:null};
    const info=unwrap(await this.client.session.fork({path:{id:this.sessionId},query:{directory:this.cwd},body:{messageID:boundary}}),"session fork");
    const retained=await this.#messages(info.id);
    if(retained.length!==kept.length||retained.some((message,index)=>message?.info?.role!==kept[index]?.info?.role))throw new Error("OpenCode did not keep the conversation up to this turn, so Trebell did not rewind it.");
    // A fork has no rules of its own: it gets this mode's rules before the thread continues in it.
    const permission=await this.#updateRules(info.id,info.permission);
    this.#useSession({...info,permission});
    return {sessionId:info.id,...this.#copyMapping(kept,retained)};
  }
  async compact(){const selected=toProviderModel(this.model,this.modelMap);if(!selected)throw new Error("Select a model before compacting");return unwrap(await this.client.session.summarize({path:{id:this.sessionId},query:{directory:this.cwd},body:{providerID:selected.providerID,modelID:selected.modelID},fetch:openCodeLongRequestFetch}),"session summarize")}
  async close(){
    if(this.closed)return;
    this.closed=true;
    // A prompt still waiting ends as cancelled now rather than when the server goes away.
    this.#stopPrompt(this.activePrompt,{graceMs:0});
    this.eventAbort.abort();
    if(this.client&&this.sessionId)await cleanupWithin(this.client.session.abort({path:{id:this.sessionId},query:{directory:this.cwd}}),750);
    // Stop the Trebell-owned server before best-effort SDK disposal. Some
    // OpenCode versions keep the event stream / instance-dispose request open,
    // which used to leave a hidden opencode serve process behind after a
    // harness switch or app shutdown.
    this.server?.close?.();
    await cleanupWithin(this.client?.instance?.dispose?.({query:{directory:this.cwd}}),750);
    await Promise.race([this.eventTask||Promise.resolve(),new Promise(resolve=>setTimeout(resolve,1000))]).catch(()=>{});
  }

  #beginPrompt(model,options){
    let release,sent;const stopped=new Promise(resolve=>{release=()=>resolve(PROMPT_STOPPED)}),started=new Promise(resolve=>{sent=resolve});
    const turn={model,options,stopped,release,started,sent,steers:[],timer:null,done:false,cancelled:false,stopError:null,sessionError:null,awaitingError:false,sessionErrorArrived:null};
    this.activePrompt=turn;return turn;
  }
  // OpenCode refused a steered message, or lost it as its loop ended. The turn goes on, and the user learns the message was not taken.
  #steerRefused(answer){
    const text=answer?.transportError?this.#transportText(answer.transportError):openCodeErrorText(answer?.error)||"OpenCode rejected the request";
    this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"runtime_error",message:`OpenCode did not take the message sent during the turn: ${text}`}});
  }
  // Waits briefly for OpenCode's session.error after a prompt it answered with a generic error.
  async #lateSessionError(turn){
    if(turn.sessionError)return;
    let timer;turn.awaitingError=true;
    await new Promise(resolve=>{turn.sessionErrorArrived=resolve;timer=setTimeout(resolve,LATE_SESSION_ERROR_MS);timer.unref?.()});
    clearTimeout(timer);turn.awaitingError=false;turn.sessionErrorArrived=null;
  }
  #assertIdle(action){if(this.activePrompt)throw new Error(`Stop the running OpenCode turn before ${action} this thread.`)}
  #nextMessageId(){
    const now=BigInt.asUintN(48,BigInt(Date.now())*0x1000n+1n);
    this.messageClock=now>this.messageClock?now:this.messageClock+1n;
    return openCodeMessageId(this.messageClock);
  }
  #noteMessage(id,role=null){
    if(!id)return;
    if(role)this.messageRoles.set(id,role);
    const time=openCodeMessageTime(id);if(time!=null&&time>this.messageClock)this.messageClock=time;
  }
  async #messages(sessionId){
    const messages=unwrap(await this.client.session.messages({path:{id:sessionId},query:{directory:this.cwd}}),"session messages");
    return Array.isArray(messages)?messages:[];
  }
  // Source message ID -> its copy, in the source's order, and an ID past every copy for a turn OpenCode never stored.
  #copyMapping(source,copies){
    for(const message of copies)this.#noteMessage(message?.info?.id);
    return {messageIds:source.map((message,index)=>[String(message?.info?.id||""),String(copies[index]?.info?.id||"")]).filter(([from,to])=>from&&to),tailId:this.#nextMessageId()};
  }
  #useSession(info,rules=null){
    if(this.sessionId&&this.sessionId!==info.id){this.messageRoles.clear();this.partText.clear();this.assistantTextParts.clear();this.reasoningParts.clear();this.subagentSessions.clear();this.subagentsGivenRules.clear()}
    this.sessionId=info.id;
    this.sessionPermission=Array.isArray(info.permission)?info.permission:Array.isArray(rules)?rules:[];
    if(this.sessionSetup)this.sessionSetup.sessionId=info.id;
  }
  #permissionRules(){
    return openCodeSessionRules(this.permissionMode,{allowedTools:this.repositoryMcp?.name?[`${this.repositoryMcp.name}_*`]:[],trustedDirectories:this.trustedDirectories});
  }
  // A session that has other rules (one Trebell resumes, forks or rewinds into, or one whose mode changed) gets this mode's rules after
  // them, which then decide. Rules that already end the session's list are not sent again.
  async #updateRules(sessionId,current,rules=this.#permissionRules()){
    if(openCodeRulesEndWith(current,rules))return current;
    const updated=unwrap(await this.client.session.update({path:{id:sessionId},query:{directory:this.cwd},body:{permission:rules}}),"session permission update");
    return Array.isArray(updated?.permission)?updated.permission:[...(Array.isArray(current)?current:[]),...rules];
  }
  async #applyPermissionRules(){this.sessionPermission=await this.#updateRules(this.sessionId,this.sessionPermission)}
  // A subagent's session started with only the parent's deny and folder rules; it gets the whole policy for its later runs.
  async #applyChildRules(childId){
    const id=String(childId||"");if(!id||id===this.sessionId||this.subagentsGivenRules.has(id)||!this.client)return;
    this.subagentsGivenRules.add(id);
    try{
      const child=unwrap(await this.client.session.get({path:{id},query:{directory:this.cwd}}),"session get");
      if(String(child?.parentID||"")!==this.sessionId)return;
      this.subagentSessions.set(id,true);
      await this.#updateRules(id,child.permission,openCodeSubagentRules(this.#permissionRules(),child.permission));
    }catch{this.subagentsGivenRules.delete(id)}
  }
  // A message starting with "/name" runs OpenCode's command of that name, looked up in a list read fresh within
  // COMMAND_LIST_TIMEOUT_MS; a name OpenCode does not list, or a list that did not come in time, stays a message. Only the user's
  // own text counts, not the working context Trebell adds before it.
  async #slashCommand(parts){
    const own=parts.filter(part=>part?.[NATIVE_PROMPT_PROVENANCE]?.kind!=="working_context");
    const asked=openCodeSlashCommand(own.filter(part=>part?.type==="text").map(part=>String(part.text||"")).join("\n").trim());
    if(!asked)return null;
    let timer;
    const commands=await Promise.race([
      Promise.resolve(this.client.command.list({query:{directory:this.cwd}})).then(result=>unwrap(result,"command list")||[]),
      new Promise(resolve=>{timer=setTimeout(()=>resolve([]),COMMAND_LIST_TIMEOUT_MS);timer.unref?.()}),
    ]).catch(()=>[]).finally(()=>clearTimeout(timer));
    const command=(Array.isArray(commands)?commands:[]).find(entry=>entry?.name===asked.name);
    return command?{name:command.name,arguments:asked.arguments}:null;
  }
  // Without an error the turn was cancelled (by the user or a close); with one, Trebell stopped it and reports why.
  #stopPrompt(turn,{error=null,graceMs=OPENCODE_STOP_GRACE_MS}={}){
    if(!turn||turn.done)return;
    if(!turn.cancelled&&!turn.stopError){if(error)turn.stopError=error;else turn.cancelled=true}
    if(graceMs===0){clearTimeout(turn.timer);turn.release();return}
    if(!turn.timer){turn.timer=setTimeout(turn.release,graceMs);turn.timer.unref?.()}
  }
  #transportText(error){
    if(this.serverExit&&!this.closed)return `the OpenCode server stopped${this.serverExit.code!=null?` (exit code ${this.serverExit.code})`:""} before it replied`;
    const code=error?.cause?.code||error?.code,message=String(error?.message||error||"the connection to OpenCode failed");
    return code&&!message.includes(code)?`${message} (${code})`:message;
  }
  // One clear error per failed turn: the message names the model, and the matching session.error event is not shown a second time. It
  // carries the turn's user message ID, its rewind point.
  #failure(turn,detail,providerMessageId=null){
    const text=String(detail||"").trim()||"the request failed";
    this.#remember(text);
    return Object.assign(new Error(`OpenCode could not get a reply${turn.model?` from ${turn.model}`:""}: ${text}`),providerMessageId?{providerMessageId}:{});
  }
  #remember(text){const now=Date.now();this.reportedErrors=[...this.reportedErrors.filter(item=>item.until>now),{text,until:now+REPORTED_ERROR_MS}].slice(-20)}
  // The same error also comes with the class name of OpenCode's exception in front of it ("ProviderModelNotFoundError: ...").
  #recentlyReported(text){const now=Date.now();this.reportedErrors=this.reportedErrors.filter(item=>item.until>now);return this.reportedErrors.some(item=>item.text===text||text.endsWith(": "+item.text)||item.text.endsWith(": "+text))}
  // A retry in a subagent's session holds this turn as well; that session is stopped together with this one.
  #retryScheduled(status,sessionID=this.sessionId){
    const turn=this.activePrompt;if(!turn||turn.done||turn.cancelled||turn.stopError)return;
    const own=sessionID===this.sessionId,reason=openCodeRetryStop(status,{model:own?turn.model:null});
    // OpenCode 1.x counts its retries from 1; next is when it sends the request again.
    if(!reason){this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"runtime_error",willRetry:true,message:openCodeRetryNotice({message:status?.message,model:own?turn.model:null,retry:status?.attempt,waitMs:Number(status?.next)-Date.now(),subagent:!own})}});return}
    this.#stopPrompt(turn,{error:new Error(own?reason:`A subagent's model request failed: ${reason}`)});
    for(const id of own?[this.sessionId]:[sessionID,this.sessionId])void Promise.resolve(this.client?.session?.abort?.({path:{id},query:{directory:this.cwd}})).catch(()=>{});
  }

  #startEvents(){
    this.eventTask=(async()=>{
      try{
        const result=await this.client.event.subscribe({query:{directory:this.cwd},signal:this.eventAbort.signal,sseMaxRetryAttempts:0});
        for await(const event of result.stream){
          if(this.closed)break;
          // One event that cannot be handled must not end the stream, or every later permission request would go unanswered.
          try{await this.#event(event)}catch(error){if(!this.closed)try{this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"runtime_error",message:error?.message||String(error)}})}catch{}}
        }
      }catch(error){if(!this.closed)this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"runtime_error",message:error?.message||String(error)}})}
    })();
  }
  async #permission(type,p){
    const asked=type==="permission.asked",kind=String((asked?p.permission:p.type)||""),requestID=String(p.id||"");
    const options=[{optionId:"once",name:"Allow once",kind:"allow_once"},{optionId:"always",name:"Always allow",kind:"allow_always"},{optionId:"reject",name:"Reject",kind:"reject_once"}];
    const disposition=openCodePermissionDisposition(this.permissionMode,kind);let decision="decline";
    // What the mode allows is answered once. OpenCode keeps an "always" answer in its server's approvals, which outrank every session
    // rule, so a grant made automatically in Auto would still run those commands and edits unasked after a switch to Supervised (and,
    // on a shared server, in its other sessions). Only the user's own "Always allow" saves one.
    if(disposition==="allow")decision="accept";
    else if(disposition==="ask"&&this.onPermission){
      const toolCall=asked
        ?{title:openCodePermissionTitle(p),toolCallId:p.tool?.callID||requestID,rawInput:{...(p.metadata||{}),patterns:Array.isArray(p.patterns)?p.patterns:[]},kind:normalizePermissionKind(kind)}
        :{title:p.title,toolCallId:p.callID||requestID,rawInput:p.metadata,kind:normalizePermissionKind(kind)};
      // A request that never got an answer is refused: OpenCode still needs a reply, and goes on. One the relay stopped waiting for is
      // refused saying it was not answered in time, not that the person declined it; one whose wait ended otherwise (the app closing) is
      // declined.
      decision=await Promise.resolve().then(()=>this.onPermission({method:"permission",params:{toolCall,permissionType:kind,options}})).then(value=>value||"decline",error=>isUserResponseTimeout(error)?"unanswered":"decline");
    }
    const response=permissionResponse(decision),refusal=openCodeRefusal(decision,{disposition,mode:this.permissionMode,action:kind,resources:p.patterns});
    // OpenCode waits for this reply before the tool runs, so an unanswered request would hold the turn forever.
    if(asked){
      const replied=await Promise.resolve(this.v2Client?.permission?.reply?.({requestID,directory:this.cwd,reply:response,...(refusal?{message:refusal.note}:{})})).then(result=>Boolean(result)&&!result.error,()=>false);
      if(replied)return;
    }
    await this.client.postSessionIdPermissionsPermissionId({path:{id:String(p.sessionID||this.sessionId),permissionID:requestID},query:{directory:this.cwd},body:{response}}).catch(()=>{});
  }
  // OpenCode's task tool runs a subagent in a child session of this one. The subagent's permission requests, questions and retries hold
  // this session's turn, so they are handled here, as OpenCode's own TUI does for the sessions under the one it shows.
  async #isSubagentSession(id){
    const key=String(id||"");if(!key||key===this.sessionId||!this.client)return false;
    if(this.subagentSessions.has(key))return this.subagentSessions.get(key);
    let current=key;
    for(let depth=0;depth<8;depth++){
      const result=await Promise.resolve(this.client.session.get({path:{id:current},query:{directory:this.cwd}})).catch(()=>null);
      if(!result?.data||result.error)return false;
      const parent=String(result.data.parentID||"");
      if(parent&&(parent===this.sessionId||this.subagentSessions.get(parent)===true)){this.subagentSessions.set(key,true);return true}
      if(!parent)break;
      current=parent;
    }
    // Only a settled answer is kept: a lookup that failed is tried again on the session's next request.
    this.subagentSessions.set(key,false);return false;
  }
  // OpenCode's question tool waits for an answer. Questions go to Trebell's question prompt; without an answer the request is dismissed
  // so the model carries on instead of waiting forever. A question whose custom flag is false takes only its options (OpenCode's
  // default lets the person type an answer of their own too).
  async #question(p){
    const requestID=String(p.id||""),questions=Array.isArray(p.questions)?p.questions:[];
    let answers=null;
    if(this.onQuestion&&questions.length){
      const input={questions:questions.map((item,index)=>({id:`q${index+1}`,header:String(item?.header||""),question:String(item?.question||""),multiSelect:Boolean(item?.multiple),...(item?.custom===false?{allowCustomAnswer:false}:{}),options:(Array.isArray(item?.options)?item.options:[]).map(option=>({label:String(option?.label||""),description:String(option?.description||"")}))}))};
      try{
        const reply=await this.onQuestion({toolName:"question",input});
        answers=input.questions.map(question=>{const value=reply?.[question.id];return (Array.isArray(value)?value:value==null?[]:[value]).map(item=>String(item??"").trim()).filter(Boolean)});
      }catch{answers=null}
    }
    const answered=Array.isArray(answers)&&answers.some(item=>item.length);
    await Promise.resolve(answered?this.v2Client?.question?.reply?.({requestID,directory:this.cwd,answers}):this.v2Client?.question?.reject?.({requestID,directory:this.cwd})).catch(()=>{});
  }
  async #event(event){
    const p=event?.properties||{};
    const held=p.sessionID&&p.sessionID!==this.sessionId?CHILD_SESSION_HOLDS.get(event.type):undefined;
    if(held&&(held!=="retry"||p.status?.type==="retry")){
      if(!(await this.#isSubagentSession(p.sessionID)))return;
      if(held==="question")return await this.#question(p);
      if(held==="retry")return this.#retryScheduled(p.status,p.sessionID);
      return await this.#permission(event.type,p);
    }
    if(p.sessionID&&p.sessionID!==this.sessionId&&p.info?.sessionID!==this.sessionId)return;
    if(event.type==="message.updated"){
      if(p.info?.sessionID===this.sessionId&&p.info?.id)this.#noteMessage(p.info.id,p.info.role||null);
      const turn=this.activePrompt;if(turn?.delivered&&p.info?.sessionID===this.sessionId&&p.info?.role==="user"&&p.info?.id===turn.messageID)turn.delivered();
      return;
    }
    // OpenCode 1.x streams a text or reasoning part as message.part.delta events between the part's first update (empty) and its last
    // (the full text). Reasoning is the model's thinking, not its reply; each reasoning part is a thought of its own (its id is the
    // thought's message id).
    if(event.type==="message.part.delta"){
      if(p.field!=="text"||typeof p.delta!=="string"||!p.delta)return;
      const sessionUpdate=this.assistantTextParts.has(p.partID)?"agent_message_chunk":this.reasoningParts.has(p.partID)?"agent_thought_chunk":null;if(!sessionUpdate)return;
      this.partText.set(p.partID,(this.partText.get(p.partID)||"")+p.delta);
      this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate,content:{type:"text",text:p.delta},...(sessionUpdate==="agent_thought_chunk"?{messageId:p.partID}:{})}});
      return;
    }
    if(event.type==="message.part.updated"){
      const part=p.part;if(!part||part.sessionID!==this.sessionId)return;
      let role=this.messageRoles.get(part.messageID);
      if(!role){
        try{
          const message=unwrap(await this.client.session.message({path:{id:this.sessionId,messageID:part.messageID},query:{directory:this.cwd}}),"session message");
          role=message?.info?.role||null;if(role)this.messageRoles.set(part.messageID,role);
        }catch{}
      }
      if(role!=="assistant")return;
      if(part.type==="text"||part.type==="reasoning"){
        (part.type==="text"?this.assistantTextParts:this.reasoningParts).add(part.id);
        // The part's full text decides what is new, so text already streamed through message.part.delta is not sent twice.
        const previous=this.partText.get(part.id)||"",text=typeof part.text==="string"?part.text:null;
        const delta=text!==null&&text.startsWith(previous)?text.slice(previous.length):typeof p.delta==="string"?p.delta:text||"";
        this.partText.set(part.id,text??previous+delta);
        if(part.type==="reasoning")this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"agent_thought_chunk",content:{type:"text",text:delta},messageId:part.id}});
        else if(delta)this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:delta}}});
      }else if(part.type==="tool"){
        const status=part.state?.status==="running"?"in_progress":part.state?.status==="completed"?"completed":part.state?.status==="error"?"failed":"pending";
        // A read's row opens to what it read, and a question's to what was asked and answered (textOutput), not to the item's JSON.
        const state=part.state||{},input=state.input||{},read=part.tool==="read",question=part.tool==="question"&&Array.isArray(input.questions);
        const answers=Array.isArray(state.metadata?.answers)?state.metadata.answers:null;
        const output=read?unwrapOpenCodeRead(state.output):question?openCodeQuestionText(input.questions,answers,state.status==="error"?state.error:answers?"":state.output):state.output;
        const update={sessionUpdate:state.status==="pending"?"tool_call":"tool_call_update",toolCallId:part.callID||part.id,title:openCodeToolTitle(part.tool,{title:state.title,input,cwd:this.cwd}),kind:toolKind(part.tool),status,rawInput:input,rawOutput:output||state.error||null,...(read||question?{textOutput:true}:{})};
        this.onUpdate?.({sessionId:this.sessionId,update});
        // The task tool names the subagent's session once it has created it.
        if(part.tool==="task"&&part.state?.metadata?.sessionId)await this.#applyChildRules(part.state.metadata.sessionId);
      }else if(part.type==="subtask")this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"tool_call",toolCallId:part.id,title:part.description||`Subtask · ${part.agent}`,kind:"other",status:"in_progress",rawInput:{prompt:part.prompt,agent:part.agent}}});
      else if(part.type==="step-finish")this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"usage_update",used:Number(part.tokens?.input||0)+Number(part.tokens?.output||0)+Number(part.tokens?.reasoning||0),size:this.contextByModel.get(this.model)||0,cost:{amount:Number(part.cost||0),currency:"USD"},usage:{input_tokens:Number(part.tokens?.input||0),output_tokens:Number(part.tokens?.output||0),reasoning_tokens:Number(part.tokens?.reasoning||0),cache_read_input_tokens:Number(part.tokens?.cache?.read||0),cache_write_input_tokens:Number(part.tokens?.cache?.write||0)}}});
    }
    // A cancelled todo is no work left to do, and a plan step has no cancelled status: it is left out of the plan rather than shown as
    // pending.
    else if(event.type==="todo.updated")this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"plan",entries:(p.todos||[]).filter(todo=>todo?.status!=="cancelled").map(todo=>({content:todo.content,status:todo.status,priority:todo.priority}))}});
    else if((event.type==="permission.asked"||event.type==="permission.updated")&&p.sessionID===this.sessionId)await this.#permission(event.type,p);
    else if(event.type==="question.asked"&&p.sessionID===this.sessionId)await this.#question(p);
    else if(event.type==="session.error"&&(!p.sessionID||p.sessionID===this.sessionId)){
      // An aborted message is always Trebell's own stop, and a prompt in flight reports its failure itself when OpenCode answers it.
      if(p.error?.name==="MessageAbortedError")return;
      const text=openCodeErrorText(p.error)||"OpenCode session error",turn=this.activePrompt;
      if(turn&&(!turn.done||turn.awaitingError)){if(!turn.sessionError){turn.sessionError=text;turn.sessionErrorArrived?.()}return}
      if(this.#recentlyReported(text))return;
      this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"runtime_error",message:text}});
    }
    else if(event.type==="session.diff"&&p.sessionID===this.sessionId)this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"diff",diff:p.diff||[]}});
    else if(event.type==="session.status"&&p.sessionID===this.sessionId){
      this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"session_info_update",status:p.status}});
      if(p.status?.type==="retry")this.#retryScheduled(p.status);
    }
  }
}
