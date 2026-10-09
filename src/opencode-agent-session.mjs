import { createServer as createNetServer } from "node:net";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { Readable } from "node:stream";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { createOpencodeClient as createOpencodeV2Client } from "@opencode-ai/sdk/v2";
import spawn from "cross-spawn";
import { normalizePermissionKind, permissionDisposition } from "./permission-policy.mjs";
import { runtimeInstructions } from "./runtime-instructions.mjs";

const MIME={".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".gif":"image/gif",".webp":"image/webp",".pdf":"application/pdf",".mp3":"audio/mpeg",".wav":"audio/wav",".m4a":"audio/mp4",".md":"text/markdown",".json":"application/json",".txt":"text/plain"};

// OpenCode errors arrive as {name,data:{message}}, {message} or, from a server that is not OpenCode's JSON API, as a web page.
const OPENCODE_ERROR_TEXT=Object.freeze({MessageOutputLengthError:"The reply reached the model's output limit before it finished",MessageAbortedError:"The request was stopped"});
function openCodeErrorText(error){
  if(error==null)return "";
  if(typeof error==="string"){const text=error.trim();return !text||text.startsWith("<")?"":text.slice(0,2000)}
  const message=[error?.data?.message,error?.message].find(value=>typeof value==="string"&&value.trim());
  if(message)return message.trim();
  const name=String(error?.name||"").trim();
  return OPENCODE_ERROR_TEXT[name]||(name?`OpenCode reported ${name}`:"");
}
function unwrap(result,label="OpenCode request"){
  if(result?.error)throw new Error(openCodeErrorText(result.error)||`${label} failed`);
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
async function startServer({command="opencode",cwd,env=process.env,serverUrl=null}={}){
  if(serverUrl)return {url:serverUrl,close(){}};
  const port=await freePort();const args=["serve","--hostname=127.0.0.1",`--port=${port}`];
  const child=spawn(command,args,{cwd,env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
  // Only the recent output is kept: it is just for startup errors, and the server lives as long as the session.
  let output="";const keep=chunk=>{output=(output+String(chunk)).slice(-8192)};
  try{
    const url=await new Promise((resolve,reject)=>{
      let settled=false;const timer=setTimeout(()=>finish(new Error(`OpenCode server did not start. ${startupLog(output)}`)),15_000);
      const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value)};
      child.stdout?.on("data",chunk=>{keep(chunk);const match=output.match(SERVER_LISTENING);if(match)finish(null,match[1])});
      child.stderr?.on("data",keep);child.once("error",error=>finish(error));child.once("exit",code=>finish(new Error(`OpenCode server exited with code ${code}. ${startupLog(output)}`)));
    });
    return {url,child,close(){stopProcessTree(child)}};
  }catch(error){
    // A server that did not come up (a timeout, or a version Trebell cannot talk to) is not left running.
    stopProcessTree(child);throw error;
  }
}
export const startOpenCodeServer=startServer;

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
export function connectedOpenCodeModels(providers={},{configured=null,recent=[]}={}){
  const connected=new Set(Array.isArray(providers?.connected)?providers.connected.map(String):[]),models=[];
  const visible=(Array.isArray(providers?.all)?providers.all:[]).filter(provider=>!connected.size||connected.has(String(provider.id)));
  for(const provider of visible)for(const entry of Object.values(provider.models||{}))models.push({id:`${provider.id}/${entry.id}`,providerID:String(provider.id),modelID:String(entry.id),context:Number(entry.limit?.context)||0});
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

export async function discoverOpenCodeModelCatalog({command="opencode",cwd=process.cwd(),env=process.env,serverUrl=null,readText}={}){
  const server=await startServer({command,cwd,env,serverUrl});
  const client=createOpencodeClient({baseUrl:server.url,directory:cwd});
  try{
    const providers=checkedOpenCodeProviders(unwrap(await client.provider.list({query:{directory:cwd}}),"provider list"));
    const catalog=connectedOpenCodeModels(providers,await openCodeModelPreferences({client,directory:cwd,env,localState:!serverUrl,readText}));
    const ordered=catalog.preferred?[catalog.models.find(item=>item.id===catalog.preferred),...catalog.models.filter(item=>item.id!==catalog.preferred)].filter(Boolean):catalog.models;
    return {
      models:ordered.map(item=>item.id),
      metadata:ordered.map(item=>({id:item.id,provider:"opencode",agent:"OpenCode",upstreamProvider:item.providerID,...(item.context?{contextWindow:item.context}:{})})),
      preferred:catalog.preferred,
      connectedProviders:Array.isArray(providers.connected)?providers.connected.map(String):[],
      source:"live-connected",
    };
  }finally{
    server.close?.();
    await cleanupWithin(client?.instance?.dispose?.({query:{directory:cwd}}),1500);
  }
}

function permissionResponse(decision){return decision==="acceptForSession"?"always":decision==="accept"?"once":"reject"}

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

function toolTitle(tool,stateTitle){
  const id=String(tool||"").toLowerCase();
  if(id==="read")return "Read file";
  if(id==="write")return "Write file";
  if(id==="edit"||id==="patch")return "Edit files";
  if(id==="bash"||id==="shell")return stateTitle&&stateTitle.length<120?stateTitle:"Run command";
  if(id==="grep"||id==="search")return "Search workspace";
  if(id==="glob")return "Find files";
  if(id==="webfetch"||id==="fetch")return "Fetch URL";
  return stateTitle&&stateTitle.length<120?stateTitle:String(tool||"Tool");
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

// Events of a subagent's (child) session that hold this session's turn until Trebell answers or stops them.
const SUBAGENT_EVENTS=new Set(["permission.asked","permission.updated","question.asked","session.status"]);
const PROMPT_STOPPED=Symbol("opencode-prompt-stopped");
// After Trebell stops a turn (cancel, close, or a retry it will not wait for), OpenCode normally answers the pending prompt at once with
// an aborted message. If it does not, the turn still ends after this grace period.
const OPENCODE_STOP_GRACE_MS=15_000;
const REPORTED_ERROR_MS=60_000;

export class OpenCodeAgentSession{
  constructor({command="opencode",cwd,env=process.env,serverUrl=null,permissionMode="supervised",onUpdate,onPermission,onQuestion,repositoryMcp=null,readStateFile=undefined}={}){
    this.command=command;this.cwd=cwd;this.env=env;this.serverUrl=serverUrl;this.permissionMode=permissionMode;this.onUpdate=onUpdate;this.onPermission=onPermission;this.onQuestion=onQuestion;
    this.server=null;this.client=null;this.v2Client=null;this.sessionId=null;this.sessionSetup=null;this.initializeResult={agentCapabilities:{loadSession:true,sessionCapabilities:{fork:{},resume:{},close:{}}},agentInfo:{name:"OpenCode"}};
    this.model=null;this.modelMap=new Map();this.contextByModel=new Map();this.partText=new Map();this.closed=false;this.eventAbort=new AbortController();this.eventTask=null;
    this.messageRoles=new Map();this.repositoryMcp=repositoryMcp;this.repositoryMcpStatus=[];this.readStateFile=readStateFile;
    // Trebell's own message ID for a turn -> the user message ID OpenCode gave it (OpenCode names its messages itself).
    this.providerMessageIds=new Map();this.activePrompt=null;this.reportedErrors=[];this.serverExit=null;
    // Session ID -> whether it is a subagent (child) session of this one. The IDs of the assistant's text parts, whose deltas are streamed.
    this.subagentSessions=new Map();this.assistantTextParts=new Set();
  }
  async start({providerSessionId=null,model=null}={}){
    this.server=await startServer({command:this.command,cwd:this.cwd,env:this.env,serverUrl:this.serverUrl});
    this.server.child?.once?.("exit",(code,signal)=>{this.serverExit={code,signal}});
    this.client=createOpencodeClient({baseUrl:this.server.url,directory:this.cwd});
    this.v2Client=createOpencodeV2Client({baseUrl:this.server.url,directory:this.cwd});
    if(this.repositoryMcp)this.repositoryMcpStatus=await configureOpenCodeMcpServers(this.client,{cwd:this.cwd,servers:[{name:this.repositoryMcp.name,config:this.repositoryMcp.openCode}]});
    const providers=checkedOpenCodeProviders(unwrap(await this.client.provider.list({query:{directory:this.cwd}}),"provider list"));
    let catalog=connectedOpenCodeModels(providers);
    for(const entry of catalog.models){this.modelMap.set(entry.id,{providerID:entry.providerID,modelID:entry.modelID});if(entry.context)this.contextByModel.set(entry.id,entry.context)}
    const requested=model&&toProviderModel(model,this.modelMap)?model:null;
    if(!requested)catalog=connectedOpenCodeModels(providers,await openCodeModelPreferences({client:this.client,directory:this.cwd,env:this.env,localState:!this.serverUrl,readText:this.readStateFile}));
    this.model=requested||catalog.preferred;
    let info=null;
    if(providerSessionId)info=unwrap(await this.client.session.get({path:{id:providerSessionId},query:{directory:this.cwd}}),"session get");
    if(!info)info=unwrap(await this.client.session.create({query:{directory:this.cwd},body:{title:"Trebell task"}}),"session create");
    this.sessionId=info.id;
    const availableModels=[...this.modelMap.keys()];if(this.model&&!availableModels.includes(this.model))availableModels.push(this.model);
    this.sessionSetup={sessionId:this.sessionId,models:{currentModelId:this.model,availableModels:availableModels.map(modelId=>({modelId,name:modelId}))},configOptions:[],modes:{currentModeId:"build",availableModes:[]},trebellRepositoryMcp:this.repositoryMcpStatus[0]||null};
    const [commands,skills,agents]=await Promise.all([
      this.client.command.list({directory:this.cwd}).then(result=>unwrap(result,"command list")||[]).catch(()=>[]),
      this.v2Client.app.skills({directory:this.cwd}).then(result=>unwrap(result,"skill list")||[]).catch(()=>[]),
      this.client.app.agents({directory:this.cwd}).then(result=>unwrap(result,"agent list")||[]).catch(()=>[]),
    ]);
    this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"session_info_update",commands,skills,agents:agents.filter(agent=>!agent.hidden),status:{type:"idle"}}});
    this.#startEvents();return {initialize:this.initializeResult,session:this.sessionSetup};
  }
  async prompt(parts,{messageId=null,agent=null}={}){
    const bodyParts=parts.map(part=>{
      if(part.type==="text")return {type:"text",text:String(part.text||"")};
      if(part.type==="image")return {type:"file",mime:part.mimeType||"image/png",url:`data:${part.mimeType||"image/png"};base64,${part.data}`};
      if(part.type==="resource_link"){
        const path=String(part.uri||"").replace(/^file:\/\//,"");return {type:"file",mime:MIME[extname(path).toLowerCase()]||"text/plain",filename:part.name||undefined,url:part.uri};
      }
      return {type:"text",text:JSON.stringify(part)};
    });
    const selected=toProviderModel(this.model,this.modelMap),turn=this.#beginPrompt(selected?`${selected.providerID}/${selected.modelID}`:null);
    const cancelled={stopReason:"cancelled",providerMessageId:null,assistantMessageId:null,raw:null};
    let response;
    try{
      // No messageID: OpenCode accepts only message IDs it generated ("msg_" plus a time-ordered part it compares and decodes), so it names
      // the user message itself and returns that ID as the reply's parentID, which is what revert needs. Trebell's own ID maps to it below.
      const request=this.client.session.prompt({path:{id:this.sessionId},query:{directory:this.cwd},body:{...(selected?{model:selected}:{}),...(agent?{agent}:{}),system:runtimeInstructions({harness:"OpenCode",model:this.model}),parts:bodyParts},fetch:openCodeLongRequestFetch});
      request.catch(()=>{});
      response=await Promise.race([request,turn.stopped]);
    }catch(error){response={transportError:error}}
    finally{turn.done=true;clearTimeout(turn.timer);if(this.activePrompt===turn)this.activePrompt=null}
    if(turn.stopError)throw turn.stopError;
    if(response===PROMPT_STOPPED)return cancelled;
    if(response?.transportError){if(turn.cancelled)return cancelled;throw this.#failure(turn,turn.sessionError||this.#transportText(response.transportError))}
    if(response?.error){if(turn.cancelled)return cancelled;throw this.#failure(turn,openCodeErrorText(response.error)||turn.sessionError||"OpenCode rejected the request")}
    const result=response?.data,info=result?.info||{};
    if(info.id)this.messageRoles.set(info.id,"assistant");
    if(info.parentID){this.messageRoles.set(info.parentID,"user");if(messageId)this.providerMessageIds.set(String(messageId),info.parentID)}
    if(info.error){
      if(turn.cancelled||info.error?.name==="MessageAbortedError")return {...cancelled,providerMessageId:info.parentID||null,assistantMessageId:info.id||null,raw:result};
      // OpenCode keeps the failed turn's messages, so the error carries their IDs (a rewind point before or at this turn).
      throw Object.assign(this.#failure(turn,openCodeErrorText(info.error)||turn.sessionError||"OpenCode model request failed"),{providerMessageId:info.parentID||null,assistantMessageId:info.id||null});
    }
    const responseTextParts=(result?.parts||[]).filter(part=>part.type==="text");
    const full=responseTextParts.map(part=>part.text||"").join("");
    const emitted=responseTextParts.map(part=>this.partText.get(part.id)||"").join("");
    if(full&&full!==emitted){const suffix=full.startsWith(emitted)?full.slice(emitted.length):full;this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:suffix}}})}
    const tokens=info.tokens||{};if(tokens.input!=null){const modelId=`${info.providerID||selected?.providerID||""}/${info.modelID||selected?.modelID||""}`;this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"usage_update",used:Number(tokens.input||0)+Number(tokens.output||0)+Number(tokens.reasoning||0),size:this.contextByModel.get(modelId)||0,cost:info.cost!=null?{amount:info.cost,currency:"USD"}:null,usage:{input_tokens:Number(tokens.input||0),output_tokens:Number(tokens.output||0),reasoning_tokens:Number(tokens.reasoning||0),cache_read_input_tokens:Number(tokens.cache?.read||0),cache_write_input_tokens:Number(tokens.cache?.write||0)}}})}
    // A session error during a turn that still finished is not lost: it is shown once the turn is done.
    if(turn.sessionError&&!this.#recentlyReported(turn.sessionError)){this.#remember(turn.sessionError);this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"runtime_error",message:turn.sessionError}})}
    return {stopReason:"end_turn",providerMessageId:info.parentID||null,assistantMessageId:info.id||null,raw:result};
  }
  async setModel(model){if(toProviderModel(model,this.modelMap))this.model=model;return {modelId:this.model}}
  async cancel(){
    this.#stopPrompt(this.activePrompt);
    if(this.client&&this.sessionId)await this.client.session.abort({path:{id:this.sessionId},query:{directory:this.cwd}}).catch(()=>{});
  }
  async fork(){return unwrap(await this.client.session.fork({path:{id:this.sessionId},query:{directory:this.cwd},body:{}}),"session fork")}
  // Takes OpenCode's message ID (what Trebell stores for a turn) or Trebell's own ID for a turn prompted in this session.
  async revert(messageID){
    const target=this.providerMessageIds.get(String(messageID??""))||messageID;
    const info=unwrap(await this.client.session.revert({path:{id:this.sessionId},query:{directory:this.cwd},body:{messageID:target}}),"session revert");
    // For a message its session does not have, OpenCode returns the session unchanged instead of an error. A forked session gives every
    // copied message a new ID, so a forked thread's earlier turns are not in it. Trebell must not then drop turns that OpenCode, and the
    // files, still keep.
    if(info&&typeof info==="object"&&info.id&&!info.revert?.messageID)throw Object.assign(new Error(`OpenCode could not rewind to this turn: its session has no message ${target} (in a forked thread, OpenCode gives the copied messages new IDs).`),{code:"OPENCODE_REWIND_TARGET_MISSING"});
    return info;
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

  #beginPrompt(model){
    let release;const stopped=new Promise(resolve=>{release=()=>resolve(PROMPT_STOPPED)});
    const turn={model,stopped,release,timer:null,done:false,cancelled:false,stopError:null,sessionError:null};
    this.activePrompt=turn;return turn;
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
  // One clear error per failed turn: the message names the model, and the matching session.error event is not shown a second time.
  #failure(turn,detail){
    const text=String(detail||"").trim()||"the request failed";
    this.#remember(text);
    return new Error(`OpenCode could not get a reply${turn.model?` from ${turn.model}`:""}: ${text}`);
  }
  #remember(text){const now=Date.now();this.reportedErrors=[...this.reportedErrors.filter(item=>item.until>now),{text,until:now+REPORTED_ERROR_MS}].slice(-20)}
  #recentlyReported(text){const now=Date.now();this.reportedErrors=this.reportedErrors.filter(item=>item.until>now);return this.reportedErrors.some(item=>item.text===text)}
  // A retry in a subagent's session holds this turn as well; that session is stopped together with this one.
  #retryScheduled(status,sessionID=this.sessionId){
    const turn=this.activePrompt;if(!turn||turn.done||turn.cancelled||turn.stopError)return;
    const own=sessionID===this.sessionId,reason=openCodeRetryStop(status,{model:own?turn.model:null});if(!reason)return;
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
    if(disposition==="allow")decision=this.permissionMode==="full"||this.permissionMode==="auto"?"acceptForSession":"accept";
    else if(disposition==="ask"&&this.onPermission){
      const toolCall=asked
        ?{title:openCodePermissionTitle(p),toolCallId:p.tool?.callID||requestID,rawInput:{...(p.metadata||{}),patterns:Array.isArray(p.patterns)?p.patterns:[]},kind:normalizePermissionKind(kind)}
        :{title:p.title,toolCallId:p.callID||requestID,rawInput:p.metadata,kind:normalizePermissionKind(kind)};
      // A request that never got an answer (the approval timed out, or the app disconnected) is refused: OpenCode still needs a reply.
      decision=await Promise.resolve().then(()=>this.onPermission({method:"permission",params:{toolCall,permissionType:kind,options}})).then(value=>value||"decline",()=>"decline");
    }
    const response=permissionResponse(decision);
    // OpenCode waits for this reply before the tool runs, so an unanswered request would hold the turn forever.
    if(asked){
      const replied=await Promise.resolve(this.v2Client?.permission?.reply?.({requestID,directory:this.cwd,reply:response})).then(result=>Boolean(result)&&!result.error,()=>false);
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
  // so the model carries on instead of waiting forever.
  async #question(p){
    const requestID=String(p.id||""),questions=Array.isArray(p.questions)?p.questions:[];
    let answers=null;
    if(this.onQuestion&&questions.length){
      const input={questions:questions.map((item,index)=>({id:`q${index+1}`,header:String(item?.header||""),question:String(item?.question||""),multiSelect:Boolean(item?.multiple),options:(Array.isArray(item?.options)?item.options:[]).map(option=>({label:String(option?.label||""),description:String(option?.description||"")}))}))};
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
    if(p.sessionID&&p.sessionID!==this.sessionId&&SUBAGENT_EVENTS.has(event.type)&&(event.type!=="session.status"||p.status?.type==="retry")){
      if(!(await this.#isSubagentSession(p.sessionID)))return;
      if(event.type==="question.asked")return await this.#question(p);
      if(event.type==="session.status")return this.#retryScheduled(p.status,p.sessionID);
      return await this.#permission(event.type,p);
    }
    if(p.sessionID&&p.sessionID!==this.sessionId&&p.info?.sessionID!==this.sessionId)return;
    if(event.type==="message.updated"){
      if(p.info?.sessionID===this.sessionId&&p.info?.id&&p.info?.role)this.messageRoles.set(p.info.id,p.info.role);
      return;
    }
    // OpenCode 1.x streams a text part as message.part.delta events between the part's first update (empty) and its last (the full text).
    if(event.type==="message.part.delta"){
      if(p.field!=="text"||typeof p.delta!=="string"||!p.delta||!this.assistantTextParts.has(p.partID))return;
      this.partText.set(p.partID,(this.partText.get(p.partID)||"")+p.delta);
      this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:p.delta}}});
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
      if(part.type==="text"){
        this.assistantTextParts.add(part.id);
        // The part's full text decides what is new, so text already streamed through message.part.delta is not sent twice.
        const previous=this.partText.get(part.id)||"",text=typeof part.text==="string"?part.text:null;
        const delta=text!==null&&text.startsWith(previous)?text.slice(previous.length):typeof p.delta==="string"?p.delta:text||"";
        this.partText.set(part.id,text??previous+delta);
        if(delta)this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:delta}}});
      }else if(part.type==="reasoning")this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"agent_thought_chunk",content:{type:"text",text:""}}});
      else if(part.type==="tool"){
        const status=part.state?.status==="running"?"in_progress":part.state?.status==="completed"?"completed":part.state?.status==="error"?"failed":"pending";
        const update={sessionUpdate:part.state?.status==="pending"?"tool_call":"tool_call_update",toolCallId:part.callID||part.id,title:toolTitle(part.tool,part.state?.title),kind:part.tool==="bash"||part.tool==="shell"?"execute":part.tool==="edit"||part.tool==="write"?"edit":part.tool==="read"?"read":"other",status,rawInput:part.state?.input||{},rawOutput:part.state?.output||part.state?.error||null};
        this.onUpdate?.({sessionId:this.sessionId,update});
      }else if(part.type==="subtask")this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"tool_call",toolCallId:part.id,title:part.description||`Subtask · ${part.agent}`,kind:"other",status:"in_progress",rawInput:{prompt:part.prompt,agent:part.agent}}});
      else if(part.type==="step-finish")this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"usage_update",used:Number(part.tokens?.input||0)+Number(part.tokens?.output||0)+Number(part.tokens?.reasoning||0),size:this.contextByModel.get(this.model)||0,cost:{amount:Number(part.cost||0),currency:"USD"},usage:{input_tokens:Number(part.tokens?.input||0),output_tokens:Number(part.tokens?.output||0),reasoning_tokens:Number(part.tokens?.reasoning||0),cache_read_input_tokens:Number(part.tokens?.cache?.read||0),cache_write_input_tokens:Number(part.tokens?.cache?.write||0)}}});
    }else if(event.type==="todo.updated")this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"plan",entries:(p.todos||[]).map(todo=>({content:todo.content,status:todo.status,priority:todo.priority}))}});
    else if((event.type==="permission.asked"||event.type==="permission.updated")&&p.sessionID===this.sessionId)await this.#permission(event.type,p);
    else if(event.type==="question.asked"&&p.sessionID===this.sessionId)await this.#question(p);
    else if(event.type==="session.error"&&(!p.sessionID||p.sessionID===this.sessionId)){
      // An aborted message is always Trebell's own stop, and a prompt in flight reports its failure itself when OpenCode answers it.
      if(p.error?.name==="MessageAbortedError")return;
      const text=openCodeErrorText(p.error)||"OpenCode session error",turn=this.activePrompt;
      if(turn&&!turn.done){if(!turn.sessionError)turn.sessionError=text;return}
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
