import { lstat, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, extname, join, resolve, relative, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { AcpClient, defaultAcpClientCapabilities } from "./acp-client.mjs";
import { acpApplyValue, acpConfigChoices, acpConfigSelect, acpReadOnlyMode, acpSetupWithConfigOptions, acpSetupWithValue } from "./acp-session-config.mjs";
import { cursorEffortOption, cursorEffortValue, cursorFastOption, cursorSwitchValue, GROK_INITIALIZE_META } from "./acp-model-catalog.mjs";
import { acpToolFrame, mergeAcpToolUpdate } from "./acp-tool-state.mjs";
import { CursorTransportFailure } from "./cursor-transport-failure.mjs";
import { normalizeModelOptionValues } from "./model-options.mjs";
import { NATIVE_PROMPT_PROVENANCE } from "./native-request-metrics.mjs";
import { normalizePermissionKind, normalizePermissionMode, permissionDisposition } from "./permission-policy.mjs";
import { runtimeHarnessLabel, runtimeInstructions } from "./runtime-instructions.mjs";

// Generic ACP session used for Cursor, Grok Build, Antigravity and remote-environment OpenCode,
// aligned with T3 Code's AcpSessionRuntime and its Cursor/Grok/Antigravity flavors.

const CANCELLED=Symbol("cancelled");
// Updates that describe the session rather than a turn; they pass while a session starts or loads.
const METADATA_UPDATES=new Set(["available_commands_update","config_option_update","current_mode_update","session_info_update"]);
// Grok and Antigravity resume without replaying history; the rest load (T3 resumeMethod).
const RESUME_FIRST=new Set(["grok","antigravity"]);
// The model ids Trebell used before real model lists; they mean "the harness's current model".
const MODEL_ALIASES={grok:"grok-build",cursor:"cursor-default",antigravity:"antigravity-default"};
const TOOL_STATE_LIMIT=1000;
const GROK_CANCEL_META=Object.freeze({cancelTrigger:"ctrl_c"});
const GROK_TASK_PROMPT_PREFIX="task-completed-";
const GROK_RATE_LIMIT_CODE=-32003;
// After Grok's prompt_complete, how long to wait for the session/prompt answer that carries the detail.
const GROK_COMPLETION_GRACE_MS=3000;
const GROK_STOP_WAIT_MS=15_000;
const GROK_ALLOW_EDITS_SESSION="allow-edits-session";
// T3 hides these: permission changes go through Trebell, and context prints nothing over ACP.
const GROK_HIDDEN_COMMANDS=new Set(["always-approve","context"]);
const GROK_SESSION_NOTIFICATIONS=new Set(["x.ai/session_notification","_x.ai/session_notification","_x.ai/session/update"]);
const GROK_PROMPT_COMPLETE=new Set(["x.ai/session/prompt_complete","_x.ai/session/prompt_complete"]);
export const GROK_USAGE_LIMIT_MESSAGE="Grok usage limit reached. Try again later.";
export const GROK_EMPTY_PLAN="# No plan written yet\n\n(The agent exited plan mode without writing a plan.)";
export const GROK_PLAN_FEEDBACK="The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn.";

function inside(root,candidate){
  const rel=relative(resolve(root),resolve(candidate));
  return rel===""||(!rel.startsWith("..")&&!isAbsolute(rel));
}

function boundedPath(root,path){
  const candidate=resolve(path);
  if(!inside(root,candidate))throw Object.assign(new Error(`Path is outside the active workspace: ${path}`),{code:-32602});
  return candidate;
}

// T3 AntigravityClientFiles: a path the harness asks for resolves through links, its last part included, before it is
// checked against the session's roots (the workspace and Trebell's attachments folder), so a link inside the workspace
// cannot read or write through to a file outside them. A missing file (a new write) is checked by its nearest existing
// folder; an entry that exists but does not resolve, like a dangling link, is refused rather than written through.
async function clientFilePath(roots,path){
  const requested=resolve(String(path??""));
  const outside=()=>Object.assign(new Error(`Path is outside the active workspace: ${path}`),{code:-32602});
  const exists=entry=>lstat(entry).then(()=>true,()=>false);
  let real=null,folder=requested;const missing=[];
  while(real===null){
    try{real=join(await realpath(folder),...missing)}
    catch(error){
      if(error?.code!=="ENOENT"||await exists(folder)||dirname(folder)===folder)throw outside();
      missing.unshift(basename(folder));folder=dirname(folder);
    }
  }
  const realRoots=await Promise.all(roots.map(root=>realpath(root).catch(()=>resolve(root))));
  if(!realRoots.some(root=>inside(root,real)))throw outside();
  return real;
}

function text(value){return String(value??"").trim()}

// T3 buildAntigravityPrompt: a UTF-8 text attachment goes to Antigravity as embedded content (it advertises embeddedContext),
// up to 1 MiB a file and 50 MiB a message. Antigravity 1.2.1 refuses to open any path outside its workspace folders, even one
// granted with additionalDirectories, so a pasted text or an uploaded file in Trebell's attachments folder is unreadable as a
// link. Other files stay links.
const ANTIGRAVITY_TEXT_EXTENSIONS=new Set([".txt",".md",".mdx",".json",".jsonl",".yaml",".yml",".toml",".xml",".csv",".tsv",".js",".jsx",".mjs",".cjs",".ts",".tsx",".html",".css",".scss",".less",".py",".rs",".go",".java",".kt",".swift",".c",".h",".cc",".cpp",".hpp",".cs",".rb",".php",".sh",".bash",".zsh",".sql",".graphql",".svelte",".vue",".log",".diff",".patch",".ini",".conf"]);
const ANTIGRAVITY_TEXT_MIME={".json":"application/json",".jsonl":"application/jsonl",".md":"text/markdown",".mdx":"text/markdown",".html":"text/html",".css":"text/css",".csv":"text/csv",".xml":"application/xml",".yaml":"application/yaml",".yml":"application/yaml"};
const ANTIGRAVITY_MAX_TEXT_ATTACHMENT_BYTES=1024*1024,ANTIGRAVITY_MAX_EMBEDDED_BYTES=50*1024*1024;
export async function antigravityPromptParts(parts){
  const out=[];let total=0;
  for(const part of Array.isArray(parts)?parts:[]){
    const uri=String(part?.type==="resource_link"?part.uri||"":"");
    // Trebell writes file links as file://<path> (agent-relay acpPrompt).
    const path=/^file:\/\//i.test(uri)?resolve(uri.replace(/^file:\/\//i,"")):null,extension=path?extname(path).toLowerCase():"";
    let embedded=null;
    if(path&&ANTIGRAVITY_TEXT_EXTENSIONS.has(extension)){
      const info=await stat(path).catch(()=>null);
      if(info?.isFile()&&info.size<=ANTIGRAVITY_MAX_TEXT_ATTACHMENT_BYTES&&total+info.size<=ANTIGRAVITY_MAX_EMBEDDED_BYTES){
        const bytes=await readFile(path).catch(()=>null);let decoded=null;
        try{decoded=bytes&&bytes.length<=ANTIGRAVITY_MAX_TEXT_ATTACHMENT_BYTES?new TextDecoder("utf-8",{fatal:true}).decode(bytes):null}catch{}
        if(decoded!==null&&!decoded.includes("\0")){total+=bytes.length;embedded={type:"resource",resource:{uri:pathToFileURL(path).href,mimeType:ANTIGRAVITY_TEXT_MIME[extension]||"text/plain",text:decoded}}}
      }
    }
    out.push(embedded||part);
  }
  return out;
}

// The client services each harness is offered, as T3 offers them: ACP agents run their own file and shell tools behind
// their own permission requests. Only Antigravity reads and writes files through the client (T3 AntigravityAcpSupport);
// no harness gets the client's terminal (Grok would run its whole command line through it as the program). Cursor lists
// base model ids with per-model options only for clients that can show them.
export function acpClientCapabilities(runtime){
  const capabilities={...defaultAcpClientCapabilities(),terminal:false};
  if(runtime==="antigravity")return capabilities;
  const own={...capabilities,fs:{readTextFile:false,writeTextFile:false}};
  return runtime==="cursor"?{...own,_meta:{parameterizedModelPicker:true}}:own;
}
function offeredClientService(capabilities,method){
  if(method==="fs/read_text_file")return capabilities?.fs?.readTextFile===true;
  if(method==="fs/write_text_file")return capabilities?.fs?.writeTextFile===true;
  if(String(method).startsWith("terminal/"))return capabilities?.terminal===true;
  return true;
}
function selected(optionId){return {outcome:{outcome:"selected",optionId}}}
const CANCELLED_OUTCOME=Object.freeze({outcome:Object.freeze({outcome:"cancelled"})});
function optionOfKind(options,kind,optionId=undefined){
  return (Array.isArray(options)?options:[]).find(option=>option?.kind===kind&&text(option.optionId)&&(optionId===undefined||text(option.optionId)===optionId))?.optionId||null;
}

// The agent's allow-once answer when Trebell's policy allows the request; allow-always only when the
// agent offers no allow-once, because an always answer can outlive the session (Grok saves it for
// the whole project). A denial uses reject-once for the same reason (T3 selectAutoApprovedPermissionOption).
export function acpPermissionChoice(options=[],mode="supervised",kind=null,policyInput={}){
  const disposition=permissionDisposition(mode,normalizePermissionKind(kind),{readOnlyAllowsRead:false,...policyInput});
  if(disposition==="allow")return optionOfKind(options,"allow_once")||optionOfKind(options,"allow_always");
  if(disposition==="deny")return optionOfKind(options,"reject_once");
  return null;
}

// Maps the user's decision to the request's option. Grok's only session-scoped answer is its
// "allow all edits this session" option; its other always-allow rows are saved for the project.
export function acpDecisionOption(runtime,options=[],decision="decline"){
  if(decision==="acceptForSession")return runtime==="grok"
    ?optionOfKind(options,"allow_always",GROK_ALLOW_EDITS_SESSION)||optionOfKind(options,"allow_once")
    :optionOfKind(options,"allow_always")||optionOfKind(options,"allow_once");
  if(decision==="accept")return optionOfKind(options,"allow_once");
  if(decision==="decline")return optionOfKind(options,"reject_once");
  return null;
}

function securityWarning(option){
  const warning=option?._meta?.["agy.security.warning"];
  const value=text(warning?.message)||text(warning?.title);
  return value.length>512?value.slice(0,509)+"...":value;
}

// The approval choices a request can honor, in T3's wording for each harness (grokApprovalOptions,
// antigravityApprovalOptions); other agents keep their own option names.
export function acpApprovalOptions(runtime,options=[]){
  const list=Array.isArray(options)?options:[];
  const find=(kind,optionId=undefined)=>list.find(option=>option?.kind===kind&&text(option.optionId)&&(optionId===undefined||text(option.optionId)===optionId));
  if(runtime==="grok")return [
    {decision:"cancel",label:"Cancel"},
    ...(find("reject_once")?[{decision:"decline",label:"Decline"}]:[]),
    ...(find("allow_always",GROK_ALLOW_EDITS_SESSION)?[{decision:"acceptForSession",label:"Allow all edits this session"}]:[]),
    ...(find("allow_once")?[{decision:"accept",label:"Approve"}]:[]),
  ];
  if(runtime==="antigravity"){
    const always=find("allow_always"),warning=always?securityWarning(always):"";
    return [
      ...(find("allow_once")?[{decision:"accept",label:"Allow once"}]:[]),
      ...(always?[{decision:"acceptForSession",label:"Allow for this thread",...(warning?{warning}:{})}]:[]),
      ...(find("reject_once")?[{decision:"decline",label:"Deny"}]:[]),
      {decision:"cancel",label:"Cancel"},
    ];
  }
  const once=find("allow_once"),always=find("allow_always"),reject=find("reject_once");
  return [
    ...(reject?[{decision:"decline",label:text(reject.name)||"Deny"}]:[]),
    ...(always?[{decision:"acceptForSession",label:text(always.name)||"Allow always"}]:[]),
    ...(once?[{decision:"accept",label:text(once.name)||"Allow once"}]:[]),
    {decision:"cancel",label:"Cancel"},
  ];
}

// fs/read_text_file: the file as it is unless a range is asked for; ranges split on "\n" only so
// Windows line endings survive (T3 AntigravityClientFiles).
export function acpFileSlice(content,line=null,limit=null){
  const source=String(content??"");
  if(line==null&&limit==null)return source;
  const lines=source.split("\n"),start=Math.max(0,(Number(line)||1)-1);
  const end=limit==null?lines.length:Math.min(lines.length,start+Math.max(0,Number(limit)||0));
  return lines.slice(start,end).join("\n");
}

// ACP availableCommands as composer slash commands.
export function acpCommandsFromAvailable(list=[],runtime=null){
  const out=[],seen=new Set();
  for(const entry of Array.isArray(list)?list:[]){
    const name=text(entry?.name).replace(/^\/+/,"");
    if(!name||seen.has(name)||(runtime==="grok"&&GROK_HIDDEN_COMMANDS.has(name)))continue;
    seen.add(name);
    const description=text(entry?.description),hint=text(entry?.input?.hint);
    out.push({name,...(description?{description}:{}),...(hint?{input:{hint}}:{})});
  }
  return out;
}

// A harness runs a slash command only when the message starts with it (Grok: "other commands must start the message"), and
// T3 sends the user's text as the whole prompt. The relay puts Trebell's working context before the user's text, so when that
// text starts with a command the harness lists, the user's parts go alone, without the context or the runtime notes. A lone
// slash text (the relay's /compact) is always sent as a command. Returns the parts to send, or null for an ordinary prompt.
export function acpSlashCommandPrompt(parts=[],commandNames=new Set()){
  const list=Array.isArray(parts)?parts:[];
  const user=list.filter(part=>part?.[NATIVE_PROMPT_PROVENANCE]?.kind!=="working_context");
  const value=text(user.find(part=>part?.type==="text")?.text);
  if(!/^\/[A-Za-z]/.test(value))return null;
  if(list.length===1)return user;
  return commandNames.has(value.slice(1).split(/\s/)[0])?user:null;
}

// The agent's modes (OpenCode's primary agents) as composer agents.
export function acpModeAgents(setup){
  return acpConfigSelect(setup,"mode").choices.map(choice=>{
    const description=choice.description||(choice.name!==choice.value?choice.name:"");
    return {name:choice.value,...(description?{description}:{})};
  });
}

function grokAnswerValues(answer){
  return (Array.isArray(answer)?answer:[answer]).map(value=>typeof value==="string"?value.trim():"").filter(Boolean);
}

// T3 makeXAiAskUserQuestionResponse: answers keyed by question text with the chosen option labels;
// free text goes to annotations as notes under the "Other" label.
export function grokQuestionResponse(questions=[],answers={}){
  const out={},annotations={};
  for(const question of Array.isArray(questions)?questions:[]){
    const questionText=String(question?.question||"");
    const values=grokAnswerValues(answers[question?.id??questionText]??answers[questionText]);
    if(!values.length)continue;
    const byLabel=new Map((question?.options||[]).map(option=>[String(option?.label||""),option]));
    const labels=values.filter(value=>byLabel.has(value)),notes=values.filter(value=>!byLabel.has(value));
    const preview=question?.multiSelect===true?"":labels.map(label=>text(byLabel.get(label)?.preview)).find(Boolean)||"";
    out[questionText]=labels.length?labels:["Other"];
    if(preview||notes.length)annotations[questionText]={...(preview?{preview}:{}),...(notes.length?{notes:notes.join("\n")}:{})};
  }
  return {outcome:"accepted",answers:out,...(Object.keys(annotations).length?{annotations}:{})};
}

function unwrapGrokParams(raw){
  return raw&&typeof raw==="object"&&typeof raw.method==="string"&&raw.params&&typeof raw.params==="object"?raw.params:raw;
}

function boundedDetail(value){
  const detail=typeof value==="string"?value.trim():value&&typeof value==="object"?text(value.message||value.error||""):"";
  return detail.length>1500?detail.slice(0,1497)+"...":detail;
}

// Grok settles a failed prompt with prompt_complete (stopReason rate_limit or error) before or
// with its session/prompt error (T3 xAiPromptFailure).
export function grokCompletionFailure(notice){
  const reason=text(notice?.stopReason);
  if(reason==="rate_limit"){
    const detail=boundedDetail(notice?.agentResult);
    return Object.assign(new Error(detail?`${GROK_USAGE_LIMIT_MESSAGE}\n${detail}`:GROK_USAGE_LIMIT_MESSAGE),{code:GROK_RATE_LIMIT_CODE,usageLimit:true});
  }
  if(reason==="error"){
    const detail=boundedDetail(notice?.agentResult);
    return Object.assign(new Error(detail||"Grok ended the turn with an error."),{code:-32603});
  }
  return null;
}

export function grokPromptError(error,notice=null){
  const message=text(error?.message);
  if(error?.code===GROK_RATE_LIMIT_CODE||text(notice?.stopReason)==="rate_limit"){
    const detail=message&&message.toLowerCase()!=="rate limited"?boundedDetail(message):boundedDetail(notice?.agentResult);
    return Object.assign(new Error(detail?`${GROK_USAGE_LIMIT_MESSAGE}\n${detail}`:GROK_USAGE_LIMIT_MESSAGE),{code:GROK_RATE_LIMIT_CODE,usageLimit:true,...(error?.data!==undefined?{data:error.data}:{})});
  }
  return grokCompletionFailure(notice)||error;
}

function requestedModel(runtime,model){
  const id=text(model);
  if(!id||id===MODEL_ALIASES[runtime])return null;
  // Cursor's parameterized picker uses base ids; older ids carried their options in brackets.
  return runtime==="cursor"?id.replace(/\[.*$/,"")||null:id;
}

export class AcpAgentSession{
  constructor({runtime,command,args=[],cwd,processCwd=null,env=process.env,terminals,permissionMode="supervised",onUpdate,onPermission,onQuestion=null,onElicitation,onWakeTurn=null,argsForPermission=null,runTempRoot=null,version="0.0.0",spawnProcess=null,remoteIo=null,mcpServers=[],attachmentsDir=null}={}){
    this.runtime=runtime;this.command=command;this.args=[...(args||[])];this.cwd=remoteIo?String(cwd||remoteIo.root||"/"):resolve(cwd||process.cwd());this.env=env;this.terminals=terminals;
    // Trebell saves pasted text and uploads outside the workspace. Antigravity checks every path against its own allowed
    // folders, so T3 grants it the attachments folder (additionalDirectories) and serves its client files there too.
    this.attachmentsDir=runtime==="antigravity"&&!remoteIo&&text(attachmentsDir)?resolve(attachmentsDir):null;
    this.permissionMode=normalizePermissionMode(permissionMode);this.onUpdate=onUpdate;this.onPermission=onPermission;this.onQuestion=onQuestion;this.onElicitation=onElicitation;this.onWakeTurn=onWakeTurn;this.version=version;
    this.argsForPermission=typeof argsForPermission==="function"?argsForPermission:null;this.runTempRoot=runTempRoot||null;
    this.spawnProcess=spawnProcess;this.remoteIo=remoteIo;this.processCwd=processCwd?resolve(processCwd):null;
    this.mcpServers=Array.isArray(mcpServers)?mcpServers.map(server=>({...server,args:[...(server.args||[])],env:(server.env||[]).map(item=>({...item}))})):[];
    this.client=null;this.sessionId=null;this.initializeResult=null;this.sessionSetup=null;this.terminalIds=new Set();this.model=null;
    this.runtimeContextSent=false;
    this.remoteTerminals=new Map();
    this.label=runtimeHarnessLabel(runtime);
    this.dead=false;this.deadError=null;this.closing=false;this.starting=false;this.loading=false;
    this.activePrompt=null;this.wake=null;this.userWaits=new Set();this.tools=new Map();this.todos=new Map();
    this.reasoningEffort=null;this.grokEffort=null;this.grokEffortSet=false;this.defaultMode=null;
    this.serviceTier=undefined;this.modelOptions={};this.collaborationMode="default";
    this.grokCompletions=new Map();
    // The slash commands the harness lists (initialize or available_commands_update), by name.
    this.commandNames=new Set();
  }

  get busy(){return Boolean(this.activePrompt||this.wake)}

  async start({providerSessionId=null,model=null,reasoningEffort=undefined}={}){
    const client=new AcpClient({command:this.command,args:this.args,cwd:this.processCwd||this.cwd,env:this.env,spawnProcess:this.spawnProcess,runTempRoot:this.runTempRoot,onRequest:(method,params)=>this.#clientRequest(method,params)});
    this.client=client;this.dead=false;this.deadError=null;this.starting=true;
    if(reasoningEffort!==undefined)this.setReasoningEffort(reasoningEffort);
    client.on("sessionUpdate",params=>{if(this.client===client)this.#sessionUpdate(params)});
    client.on("notification",message=>{if(this.client===client)this.#notification(message)});
    client.on("protocolWarning",warning=>this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"protocol_warning",...warning}}));
    client.on("terminated",error=>{
      if(this.client!==client)return;
      this.dead=true;this.deadError=error;this.#cancelUserWaits();this.#finishWake("cancelled");
      this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"runtime_error",message:error.message}});
    });
    try{
      await client.start();
      this.initializeResult=await client.initialize({version:this.version,timeoutMs:this.runtime==="antigravity"?90_000:30_000,capabilities:this.#clientCapabilities(),meta:this.runtime==="grok"?GROK_INITIALIZE_META:null});
      let setup;
      // The folder is granted before the first upload lands in it, so it must exist for the harness to accept it.
      if(this.attachmentsDir)await mkdir(this.attachmentsDir,{recursive:true}).catch(()=>{});
      if(providerSessionId)setup=await this.#resume(client,String(providerSessionId));
      else{
        setup=await client.createSession({cwd:this.cwd,mcpServers:this.mcpServers,additionalDirectories:this.#additionalDirectories()});
        this.sessionId=text(setup?.sessionId)||null;
        if(!this.sessionId)throw new Error(`${this.label} did not create a session`);
      }
      this.sessionSetup={...(setup&&typeof setup==="object"?setup:{}),sessionId:this.sessionId};
      this.grokEffort=this.runtime==="grok"?text(this.#grokModelMeta(acpConfigSelect(this.sessionSetup,"model").current).reasoningEffort).toLowerCase()||null:null;
      this.grokEffortSet=false;
      this.defaultMode=acpConfigSelect(this.sessionSetup,"mode").current;
    }finally{this.starting=false}
    this.runtimeContextSent=false;
    await this.#applyModel(model);
    this.#emitInventory();
    return {initialize:this.initializeResult,session:this.sessionSetup};
  }

  // T3 keeps the id it asked for: session/load and session/resume answers carry no sessionId.
  // A conversation that cannot be resumed is an error, never a silent new session.
  async #resume(client,sessionId){
    const caps=this.initializeResult?.agentCapabilities||{},canLoad=caps.loadSession===true,canResume=caps.sessionCapabilities?.resume!=null;
    const method=canResume&&(RESUME_FIRST.has(this.runtime)||!canLoad)?"resume":canLoad?"load":null;
    if(!method)throw new Error(`${this.label} could not resume this conversation: it offers neither session/load nor session/resume.`);
    this.sessionId=sessionId;this.loading=true;
    try{
      const additionalDirectories=this.#additionalDirectories();
      return method==="resume"
        ?await client.resumeSession({sessionId,cwd:this.cwd,mcpServers:this.mcpServers,additionalDirectories})
        :await client.loadSession({sessionId,cwd:this.cwd,mcpServers:this.mcpServers,additionalDirectories});
    }catch(error){
      throw Object.assign(new Error(`${this.label} could not resume this conversation: ${error?.message||error}`),{code:error?.code,cause:error});
    }finally{this.loading=false}
  }

  #clientCapabilities(){return acpClientCapabilities(this.runtime)}
  #additionalDirectories(){return this.attachmentsDir?[this.attachmentsDir]:[]}
  #clientFileRoots(){return [this.cwd,...this.#additionalDirectories()]}

  #modelLabel(){
    const model=text(this.model);if(!model)return null;
    return acpConfigSelect(this.sessionSetup,"model").choices.find(choice=>choice.value===model)?.name||model;
  }

  async prompt(content,{messageId=null,agent=undefined}={}){
    if(!this.client||!this.sessionId)throw new Error("ACP session is not started");
    if(this.dead)throw this.deadError||new Error(`${this.label} stopped`);
    this.#finishWake("end_turn");
    await this.#applyMode(agent);
    await this.#applyEffort();
    // A harness slash command goes alone: Trebell's context or runtime notes beside it would make it an ordinary prompt.
    const given=Array.isArray(content)?content:[],commandParts=acpSlashCommandPrompt(given,this.commandNames),command=Boolean(commandParts);
    const parts=this.runtime==="antigravity"&&!this.remoteIo?await antigravityPromptParts(commandParts||given):[...(commandParts||given)];
    if(!this.runtimeContextSent&&!command)parts.push({type:"text",text:runtimeInstructions({harness:this.label,model:this.#modelLabel()})});
    let markDone;const done=new Promise(resolve=>{markDone=resolve});
    const active={promptId:this.runtime==="grok"?randomUUID():null,cancelled:false,transport:this.runtime==="cursor"?new CursorTransportFailure():null,done};
    this.activePrompt=active;
    try{
      const result=this.runtime==="grok"?await this.#grokPrompt(parts,active,messageId):await this.client.prompt(this.sessionId,parts,{messageId});
      if(!command)this.runtimeContextSent=true;
      // Cursor streams a lost backend connection as the reply and ends the turn normally (T3 CursorTransportFailure).
      const failure=active.transport?.failure;
      if(failure&&result?.stopReason!=="cancelled")throw Object.assign(new Error(failure),{code:"CURSOR_TRANSPORT_FAILURE"});
      return result;
    }catch(error){
      if(active.cancelled&&(this.dead||!this.client||this.client.closed))return {stopReason:"cancelled"};
      throw error;
    }finally{
      if(this.activePrompt===active)this.activePrompt=null;
      markDone();
    }
  }

  // Races session/prompt against Grok's own completion signals, keyed by the prompt id Trebell sends.
  #grokPrompt(parts,active,messageId){
    const promptId=active.promptId;
    return new Promise((resolve,reject)=>{
      let notice=null,timer=null,done=false;
      const finish=(ok,value)=>{if(done)return;done=true;clearTimeout(timer);this.grokCompletions.delete(promptId);ok?resolve(value):reject(value)};
      this.grokCompletions.set(promptId,complete=>{
        if(notice)return;notice=complete;
        timer=setTimeout(()=>{const failure=grokCompletionFailure(notice);failure?finish(false,failure):finish(true,{stopReason:text(notice.stopReason)||"end_turn"})},GROK_COMPLETION_GRACE_MS);
        timer.unref?.();
      });
      this.client.prompt(this.sessionId,parts,{messageId,meta:{promptId,requestId:promptId}}).then(
        result=>{const failure=notice?grokCompletionFailure(notice):null;failure?finish(false,failure):finish(true,result)},
        error=>finish(false,grokPromptError(error,notice)),
      );
    });
  }

  // Stop: answer every waiting approval or question as cancelled, then session/cancel. Grok gets
  // its Ctrl+C marker and a restart once the turn settles, so its background tasks end too (T3).
  cancel(){
    if(!this.client||!this.sessionId)return;
    const active=this.activePrompt;if(active)active.cancelled=true;
    this.#cancelUserWaits();
    try{this.client.cancel(this.sessionId,this.runtime==="grok"?GROK_CANCEL_META:null)}catch{}
    if(this.runtime==="grok"){this.#finishWake("cancelled");void this.#stopAfterCancel(active,this.client)}
  }

  async #stopAfterCancel(active,client){
    if(active)await Promise.race([active.done,new Promise(resolve=>{const timer=setTimeout(resolve,GROK_STOP_WAIT_MS);timer.unref?.()})]);
    if(this.client!==client||this.closing||client.closed)return;
    this.dead=true;this.deadError=Object.assign(new Error(`${this.label} was stopped`),{code:"ACP_STOPPED"});
    await client.stop().catch(()=>{});
  }

  setPermissionMode(mode){this.permissionMode=normalizePermissionMode(mode)}
  // Cursor and Grok take the permission mode as launch arguments; a different mode needs a new process.
  needsRelaunch(mode){
    if(!this.argsForPermission)return false;
    return JSON.stringify(this.argsForPermission(normalizePermissionMode(mode)))!==JSON.stringify(this.args);
  }
  setReasoningEffort(effort){this.reasoningEffort=text(effort).toLowerCase()||null}
  // The composer's speed for Cursor's Fast switch: "fast" turns it on, anything else (Standard) off. Until a turn names one,
  // Cursor keeps the switch as it is.
  setServiceTier(tier){this.serviceTier=text(tier).toLowerCase()==="fast"?"fast":null}
  // The model settings the user picked in the composer (Cursor's context size or thinking switch), by option id; a setting
  // with no pick stays as Cursor has it.
  setModelOptions(options){this.modelOptions=normalizeModelOptionValues(options)}
  // The composer's Plan mode for Cursor (T3 interactionMode): a Plan turn runs in Cursor's plan mode, any other in its agent mode.
  setCollaborationMode(mode){this.collaborationMode=text(mode).toLowerCase()==="plan"?"plan":"default"}

  async setModel(model){
    if(!this.client||!this.sessionId)throw new Error("ACP session is not started");
    if(this.dead)throw this.deadError||new Error(`${this.label} stopped`);
    await this.#applyModel(model);
    return {model:this.model};
  }
  async setMode(mode){this.sessionSetup=await acpApplyValue(this.client,this.sessionId,this.sessionSetup,"mode",mode);return {mode}}
  async setConfigOption(id,value){
    const result=await this.client?.setConfigOption(this.sessionId,id,value);
    if(Array.isArray(result?.configOptions))this.sessionSetup=acpSetupWithConfigOptions(this.sessionSetup,result.configOptions);
    return result;
  }

  // The model a thread runs on, per harness (T3 applyGrokAcpModelSelection, ACP-era
  // applyCursorAcpModelSelection, applyAntigravityAcpModelSelection, generic setModel).
  async #applyModel(requested){
    const current=acpConfigSelect(this.sessionSetup,"model");
    if(this.runtime==="grok"){
      const target=requestedModel("grok",requested)||current.current;
      if(!target){this.model=null;return}
      const effort=this.#grokEffortFor(target),changed=target!==current.current,effortChanged=Boolean(effort)&&effort!==this.grokEffort;
      if(changed||effortChanged){
        try{await this.client.setModel(this.sessionId,target,effort?{reasoningEffort:effort}:null)}
        catch(error){throw Object.assign(new Error(`${this.label} could not switch to model '${target}': ${error?.message||error}`),{code:error?.code})}
        this.sessionSetup=acpSetupWithValue(this.sessionSetup,"model",target);
        this.grokEffort=effort||(changed?text(this.#grokModelMeta(target).reasoningEffort).toLowerCase()||null:this.grokEffort);
        this.grokEffortSet=Boolean(effort&&this.reasoningEffort);
      }
      this.model=target;return;
    }
    if(this.runtime==="cursor"){
      // Cursor saves its model globally, so every session pins the thread's model, Auto ("default") when none.
      const target=requestedModel("cursor",requested)||"default";
      if(current.choices.length&&!current.choices.some(choice=>choice.value===target))throw new Error(`Cursor model '${target}' is not available for this account. Select an available model.`);
      try{this.sessionSetup=await acpApplyValue(this.client,this.sessionId,this.sessionSetup,"model",target)}
      catch(error){throw Object.assign(new Error(`${this.label} could not switch to model '${target}': ${error?.message||error}`),{code:error?.code})}
      this.model=acpConfigSelect(this.sessionSetup,"model").current||target;
      await this.#applyCursorOptions();
      return;
    }
    if(this.runtime==="antigravity"){
      const target=requestedModel("antigravity",requested);
      if(!target){this.model=current.current;return}
      if(!current.choices.some(choice=>choice.value===target))throw new Error(`Antigravity model '${target}' is unavailable for this Google account. Select an available model.`);
      try{this.sessionSetup=await acpApplyValue(this.client,this.sessionId,this.sessionSetup,"model",target)}
      catch(error){throw Object.assign(new Error(`${this.label} could not switch to model '${target}': ${error?.message||error}`),{code:error?.code})}
      this.model=target;return;
    }
    const target=text(requested);
    if(!target||target===current.current){this.model=current.current||target||null;return}
    if(current.choices.length&&!current.choices.some(choice=>choice.value===target))throw new Error(`${this.label} does not offer the model '${target}'. Select an available model.`);
    try{this.sessionSetup=await acpApplyValue(this.client,this.sessionId,this.sessionSetup,"model",target)}
    catch(error){throw Object.assign(new Error(`${this.label} could not switch to model '${target}': ${error?.message||error}`),{code:error?.code})}
    this.model=acpConfigSelect(this.sessionSetup,"model").current||target;
  }

  #grokModelMeta(modelId){
    const model=(this.sessionSetup?.models?.availableModels||[]).find(item=>item?.modelId===modelId);
    return model?._meta&&typeof model._meta==="object"?model._meta:{};
  }
  // The effort a Grok turn runs with: the chosen one when the model offers it; with none chosen, the model's own default
  // once Trebell has changed it in this session (otherwise Grok keeps what it runs with).
  #grokEffortFor(modelId){
    const offered=(this.#grokModelMeta(modelId).reasoningEfforts||[]).map(item=>({value:text(typeof item==="string"?item:item?.value??item?.id).toLowerCase(),isDefault:item?.default===true||item?.isDefault===true}));
    const effort=this.reasoningEffort;
    if(effort)return offered.some(item=>item.value===effort)?effort:null;
    return this.grokEffortSet?offered.find(item=>item.isDefault)?.value||null:null;
  }

  async #applyEffort(){
    if(!this.sessionSetup)return;
    if(this.runtime==="grok"&&this.model&&(this.reasoningEffort||this.grokEffortSet))return this.#applyModel(this.model);
    if(this.runtime==="cursor")return this.#applyCursorOptions();
  }

  // Cursor's per-model options after its model (T3 resolveCursorAcpConfigUpdates): the effort option (effort, reasoning or
  // reasoning_effort) when an effort is chosen, the Fast switch once a turn has named a speed, and each other setting the
  // user picked (context, thinking) by its id, when the model offers it.
  async #applyCursorOptions(){
    const options=()=>this.sessionSetup?.configOptions;
    const effort=this.reasoningEffort,effortOption=effort?cursorEffortOption(options()):null;
    if(effortOption){
      const value=acpConfigChoices(effortOption).find(choice=>(cursorEffortValue(choice.value)||cursorEffortValue(choice.name))===effort)?.value;
      if(value)await this.#setCursorOption(effortOption,value,"effort");
    }
    const fastOption=this.serviceTier!==undefined?cursorFastOption(options()):null;
    if(fastOption){
      const value=cursorSwitchValue(fastOption,this.serviceTier==="fast");
      if(value!==undefined)await this.#setCursorOption(fastOption,value,"Fast");
    }
    for(const [id,picked] of Object.entries(this.modelOptions)){
      const list=options()||[],option=list.find(entry=>text(entry?.id)===id);
      if(!option||option===cursorEffortOption(list)||option===cursorFastOption(list))continue;
      const lower=picked.toLowerCase(),choices=acpConfigChoices(option);
      const value=option.type==="boolean"?(lower==="true"?true:lower==="false"?false:undefined)
        :(choices.find(choice=>choice.value===picked)||choices.find(choice=>choice.value.toLowerCase()===lower))?.value;
      if(value!==undefined)await this.#setCursorOption(option,value,id);
    }
  }

  async #setCursorOption(option,value,label){
    if(String(option.currentValue??"")===String(value))return;
    try{await this.setConfigOption(option.id,value)}
    catch(error){throw Object.assign(new Error(`${this.label} could not set ${text(option.name)||label} to ${value}: ${error?.message||error}`),{code:error?.code})}
    // An answer without the option list still means the value took effect.
    const updated=(this.sessionSetup?.configOptions||[]).find(entry=>text(entry?.id)===text(option.id));
    if(updated&&String(updated.currentValue??"")!==String(value))this.sessionSetup={...this.sessionSetup,configOptions:(this.sessionSetup.configOptions||[]).map(entry=>entry===updated?{...entry,currentValue:value}:entry)};
  }

  // The mode each turn runs in: Antigravity's from the access level (T3 antigravityPermissionMode), Cursor's from the
  // composer's Plan mode (T3: plan or agent), OpenCode's from the chosen agent, with Read only forcing the harness's
  // read-only mode.
  #targetMode(agent){
    const {choices}=acpConfigSelect(this.sessionSetup,"mode");if(!choices.length||this.runtime==="grok")return null;
    const offered=value=>{const wanted=text(value).toLowerCase();return wanted?choices.find(choice=>choice.value===text(value))?.value||choices.find(choice=>choice.value.toLowerCase()===wanted)?.value||null:null};
    if(this.runtime==="antigravity")return offered(this.permissionMode==="full"?"yolo":this.permissionMode==="edits"?"auto_edit":"default");
    if(this.permissionMode==="read-only"){
      const readOnly=acpReadOnlyMode(this.runtime,this.sessionSetup);
      if(!readOnly)throw new Error(`${this.label} does not offer a read-only mode, so the turn was not sent.`);
      return readOnly;
    }
    if(this.runtime==="cursor"){
      if(this.collaborationMode!=="plan")return offered("agent")||this.defaultMode;
      const plan=offered("plan");
      if(!plan)throw new Error(`${this.label} does not offer a plan mode, so the turn was not sent.`);
      return plan;
    }
    const chosen=agent?offered(agent):null;
    if(chosen)return chosen;
    return offered(this.runtime==="cursor"?"agent":this.runtime==="opencode"?"build":"")||this.defaultMode;
  }

  async #applyMode(agent){
    if(!this.sessionSetup)return;
    const target=this.#targetMode(agent);if(!target)return;
    if(acpConfigSelect(this.sessionSetup,"mode").current===target)return;
    try{this.sessionSetup=await acpApplyValue(this.client,this.sessionId,this.sessionSetup,"mode",target)}
    catch(error){throw Object.assign(new Error(`${this.label} could not switch to its ${target} mode, so the turn was not sent: ${error?.message||error}`),{code:error?.code})}
  }

  #rememberCommands(commands){this.commandNames=new Set(commands.map(command=>command.name));return commands}

  #emitInventory(){
    if(this.runtime==="grok"){
      const available=this.initializeResult?._meta?.availableCommands;
      if(Array.isArray(available))this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"available_commands_update",availableCommands:available,commands:this.#rememberCommands(acpCommandsFromAvailable(available,"grok"))}});
    }
    // OpenCode's primary agents are its modes; Cursor's modes follow the composer's Plan mode and Read only instead.
    if(this.runtime==="opencode"){
      const agents=acpModeAgents(this.sessionSetup);
      if(agents.length)this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"config_option_update",configOptions:this.sessionSetup?.configOptions||[],agents}});
    }
  }

  #sessionUpdate(params){
    const update=params?.update&&typeof params.update==="object"?params.update:{},type=text(update.sessionUpdate);
    if(params?._meta?.isReplay===true)return;
    // A load replays the conversation; only session metadata passes while starting or loading (T3).
    if((this.starting||this.loading)&&!METADATA_UPDATES.has(type))return;
    if(type==="config_option_update"&&Array.isArray(update.configOptions))this.sessionSetup=acpSetupWithConfigOptions(this.sessionSetup,update.configOptions);
    if(type==="current_mode_update"&&text(update.currentModeId))this.sessionSetup=acpSetupWithValue(this.sessionSetup,"mode",text(update.currentModeId));
    // Grok answers a finished background task in a turn of its own, tagged task-completed-*.
    const promptId=params?._meta?.promptId;
    if(this.runtime==="grok"&&!this.activePrompt&&typeof promptId==="string"&&promptId.startsWith(GROK_TASK_PROMPT_PREFIX)&&this.wake?.promptId!==promptId){this.#finishWake("end_turn");this.#beginWake(promptId)}
    if(this.activePrompt?.transport&&type==="agent_message_chunk"&&update.content?.type==="text")this.activePrompt.transport.push(update.content.text);
    this.onUpdate?.(this.#decorate(params,update,type));
  }

  #decorate(params,update,type){
    if(type==="tool_call"||type==="tool_call_update"){
      const id=text(update.toolCallId);if(!id)return params;
      const merged=mergeAcpToolUpdate(this.tools.get(id),update);
      this.tools.delete(id);this.tools.set(id,merged);
      if(this.tools.size>TOOL_STATE_LIMIT)this.tools.delete(this.tools.keys().next().value);
      return {...params,update:{...acpToolFrame(merged),sessionUpdate:type}};
    }
    if(type==="available_commands_update")return {...params,update:{...update,commands:this.#rememberCommands(acpCommandsFromAvailable(update.availableCommands,this.runtime))}};
    if(type==="config_option_update"&&this.runtime==="opencode")return {...params,update:{...update,agents:acpModeAgents(this.sessionSetup)}};
    return params;
  }

  #notification(message){
    const method=text(message?.method),params=message?.params||{};
    if(method==="elicitation/complete"){this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"elicitation_complete",elicitationId:params.elicitationId||null}});return}
    // Cursor's todo list also arrives as a notification (T3's ACP-era adapter handles it as one).
    if(this.runtime==="cursor"&&method==="cursor/update_todos"){this.#emitTodos(params?.todos,params?.merge===true);return}
    if(this.runtime!=="grok")return;
    if(GROK_PROMPT_COMPLETE.has(method)){
      if(params.sessionId&&params.sessionId!==this.sessionId)return;
      this.grokCompletions.get(text(params.promptId))?.({promptId:text(params.promptId),stopReason:params.stopReason,agentResult:params.agentResult});
      return;
    }
    if(!GROK_SESSION_NOTIFICATIONS.has(method)||(params.sessionId&&params.sessionId!==this.sessionId))return;
    const update=params.update||{},kind=text(update.sessionUpdate);
    if(kind==="model_changed"){
      const model=text(update.model_id||update.modelId),effort=text(update.reasoning_effort||update.reasoningEffort).toLowerCase();
      if(model){this.sessionSetup=acpSetupWithValue(this.sessionSetup,"model",model);this.model=model}
      if(effort)this.grokEffort=effort;
      return;
    }
    if(kind!=="turn_completed")return;
    const promptId=text(update.prompt_id||update.promptId),stopReason=text(update.stop_reason||update.stopReason);
    if(promptId.startsWith(GROK_TASK_PROMPT_PREFIX)){if(this.wake?.promptId===promptId)this.#finishWake(stopReason||"end_turn");return}
    if(promptId)this.grokCompletions.get(promptId)?.({promptId,stopReason,agentResult:update.agent_result??update.agentResult});
  }

  #beginWake(promptId){
    let finish;const promise=new Promise(resolve=>{finish=resolve});
    this.wake={promptId,finish};
    try{this.onWakeTurn?.(promise)}catch{}
  }
  #finishWake(stopReason="end_turn"){
    const wake=this.wake;if(!wake)return;
    this.wake=null;wake.finish({stopReason});
  }

  // A wait on the user that Stop, a dead process or close() answers as cancelled.
  #waitForUser(start){
    let cancel;const cancelled=new Promise(resolve=>{cancel=()=>resolve(CANCELLED)});
    this.userWaits.add(cancel);
    return Promise.race([Promise.resolve().then(start),cancelled]).finally(()=>this.userWaits.delete(cancel));
  }
  #cancelUserWaits(){for(const cancel of [...this.userWaits])cancel();this.userWaits.clear()}

  // Asks the user through the relay's question prompt; null when dismissed or cancelled.
  async #ask(questions){
    if(typeof this.onQuestion!=="function")return null;
    const result=await this.#waitForUser(()=>this.onQuestion({input:{questions}}));
    if(result===CANCELLED||!result||typeof result!=="object"||!Object.keys(result).length)return null;
    const out={};
    for(const [id,value] of Object.entries(result))out[id]=(Array.isArray(value)?value:[value]).map(item=>text(item)).filter(Boolean);
    return out;
  }

  async #permission(params){
    const options=Array.isArray(params?.options)?params.options:[],toolCall=params?.toolCall||{};
    // Antigravity asks its multiple-choice questions through the permission method (T3 AntigravityProtocol).
    if(this.runtime==="antigravity"&&text(toolCall.toolCallId).startsWith("interaction_"))return this.#antigravityQuestion(params,options);
    const kind=toolCall.kind??params?.kind??null;
    // In Grok's Auto mode Grok decides routine actions itself; whatever it asks about goes to the user (T3).
    const askUser=this.runtime==="grok"&&this.permissionMode==="auto";
    const automatic=askUser?null:acpPermissionChoice(options,this.permissionMode,kind,{action:toolCall.title||"session/request_permission",rawInput:toolCall.rawInput||params,workspace:this.cwd});
    if(automatic)return selected(automatic);
    const decision=await this.#waitForUser(()=>this.onPermission?.({method:"session/request_permission",params,options,askUser,approvalOptions:acpApprovalOptions(this.runtime,options)}));
    const optionId=decision===CANCELLED?null:acpDecisionOption(this.runtime,options,decision||"decline");
    return optionId?selected(optionId):CANCELLED_OUTCOME;
  }

  async #antigravityQuestion(params,options){
    const choices=options.filter(option=>text(option?.optionId));
    if(!choices.length)return CANCELLED_OUTCOME;
    const id=text(params.toolCall.toolCallId),label=option=>text(option.name)||text(option.optionId);
    const answers=await this.#ask([{id,header:"Question",question:text(params.toolCall.title)||"Choose an option.",multiSelect:false,options:choices.map(option=>({label:label(option),description:""}))}]);
    const value=answers?.[id]?.[0];
    if(!value)return CANCELLED_OUTCOME;
    const exact=choices.find(option=>option.optionId===value);if(exact)return selected(exact.optionId);
    const labelled=choices.filter(option=>label(option)===value);
    return labelled.length===1?selected(labelled[0].optionId):CANCELLED_OUTCOME;
  }

  // Shows a plan the agent proposed (Cursor create_plan, Grok exit_plan_mode) as part of the turn's reply.
  #emitPlanText(markdown){
    const body=text(markdown);if(!body)return;
    this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"\n\n"+body+"\n"}}});
  }

  #emitTodos(todos,merge){
    if(!merge)this.todos.clear();
    for(const [index,todo] of (Array.isArray(todos)?todos:[]).entries()){
      const content=text(todo?.content)||text(todo?.title),id=text(todo?.id)||content||`todo-${index}`;
      if(!content&&!this.todos.has(id))continue;
      const status=todo?.status==="completed"?"completed":todo?.status==="in_progress"||todo?.status==="inProgress"?"in_progress":"pending";
      this.todos.set(id,{content:content||this.todos.get(id).content,status});
    }
    this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"plan",entries:[...this.todos.values()]}});
  }

  async #cursorAskQuestion(params){
    const list=Array.isArray(params?.questions)?params.questions:[];
    const questions=list.map((question,index)=>({id:text(question?.id)||`q${index+1}`,header:text(params?.title)||"Question",question:text(question?.prompt)||"Choose an option.",multiSelect:question?.allowMultiple===true,options:(question?.options||[]).map(option=>({label:text(option?.label)||text(option?.id),description:""}))}));
    if(!questions.length)return {outcome:{outcome:"skipped",reason:"No questions were asked"}};
    const answers=await this.#ask(questions);
    if(!answers)return {outcome:{outcome:"cancelled"}};
    const chosen=[],notes=[];
    for(const [index,question] of list.entries()){
      const id=questions[index].id,values=answers[id]||[];
      const ids=(question?.options||[]).filter(option=>values.includes(text(option?.label)||text(option?.id))||values.includes(text(option?.id))).map(option=>option.id);
      if(ids.length)chosen.push({questionId:question.id??id,selectedOptionIds:ids});
      else if(values.length)notes.push(`${questions[index].question}: ${values.join(", ")}`);
    }
    if(chosen.length)return {outcome:{outcome:"answered",answers:chosen}};
    return {outcome:{outcome:"skipped",reason:notes.length?`The user answered: ${notes.join("; ")}`:"The user skipped the questions"}};
  }

  async #grokAskUserQuestion(raw){
    const params=unwrapGrokParams(raw),list=Array.isArray(params?.questions)?params.questions:[];
    const questions=list.map((question,index)=>({
      id:String(question?.id??question?.question??`q${index+1}`),header:"Question",question:text(question?.question)||"Provide input",multiSelect:question?.multiSelect===true,
      options:(question?.options||[]).length?question.options.map(option=>({label:String(option?.label||""),description:String(option?.description||option?.label||"")})):[{label:"OK",description:"Continue"}],
    }));
    if(!questions.length)return {outcome:"cancelled"};
    const answers=await this.#ask(questions);
    return answers?grokQuestionResponse(list,answers):{outcome:"cancelled"};
  }

  async #writeAllowed(params){
    if(this.permissionMode==="read-only")return false;
    // Antigravity gates every write behind session/request_permission already (T3 AntigravityClientFiles).
    if(this.runtime==="antigravity")return true;
    const options=[{kind:"allow_once",optionId:"allow",name:"Allow"},{kind:"reject_once",optionId:"reject",name:"Reject"}];
    const automatic=acpPermissionChoice(options,this.permissionMode,"edit",{action:"Write file",rawInput:params,workspace:this.cwd,requestedPath:params.path});
    if(automatic)return automatic==="allow";
    const decision=await this.#waitForUser(()=>this.onPermission?.({method:"fs/write_text_file",params,options,approvalOptions:acpApprovalOptions(this.runtime,options)}));
    return decision!==CANCELLED&&acpDecisionOption(this.runtime,options,decision||"decline")==="allow";
  }

  async close(){
    this.closing=true;this.#cancelUserWaits();this.#finishWake("cancelled");
    for(const [id,entry] of this.remoteTerminals){try{entry.child.kill("SIGTERM")}catch{}this.remoteTerminals.delete(id)}
    for(const id of this.terminalIds)await this.terminals?.close(id).catch(()=>{});
    this.terminalIds.clear();
    if(this.client&&this.sessionId&&!this.dead&&!this.client.closed)await this.client.closeSession(this.sessionId).catch(()=>{});
    await this.client?.stop().catch(()=>{});
  }

  async #clientRequest(method,params){
    // A file or terminal request the harness was not offered is refused, as T3 refuses it; the harness does that work itself
    // (OpenCode's ACP server, for one, also writes an approved edit through the client and writes it itself when refused).
    if(!offeredClientService(this.#clientCapabilities(),method))throw Object.assign(new Error(`${this.label} was not offered ${method} by Trebell; it runs its own file and shell tools`),{code:-32601});
    if(method==="fs/read_text_file"){
      const content=this.remoteIo?await this.remoteIo.readText(params.path):await readFile(await clientFilePath(this.#clientFileRoots(),params.path),"utf8");
      return {content:acpFileSlice(content,params.line??null,params.limit??null)};
    }
    if(method==="fs/write_text_file"){
      if(!await this.#writeAllowed(params))throw Object.assign(new Error("File write was denied"),{code:-32000});
      if(this.remoteIo){await this.remoteIo.writeText(params.path,String(params.content??""));return {}}
      const path=await clientFilePath(this.#clientFileRoots(),params.path);
      await mkdir(dirname(path),{recursive:true});
      await writeFile(path,String(params.content??""),"utf8");
      return {};
    }
    if(method==="session/request_permission")return this.#permission(params);
    if(method==="session/elicitation"||method==="elicitation/create"){
      const result=await this.#waitForUser(()=>this.onElicitation?.({method,params}));
      return result&&result!==CANCELLED?result:{action:"cancel"};
    }
    if(this.runtime==="grok"&&(method==="x.ai/ask_user_question"||method==="_x.ai/ask_user_question"))return this.#grokAskUserQuestion(params);
    if(this.runtime==="grok"&&(method==="x.ai/exit_plan_mode"||method==="_x.ai/exit_plan_mode")){
      this.#emitPlanText(text(unwrapGrokParams(params)?.planContent)||GROK_EMPTY_PLAN);
      return {outcome:"abandoned",feedback:GROK_PLAN_FEEDBACK};
    }
    if(this.runtime==="cursor"){
      if(method==="cursor/ask_question")return this.#cursorAskQuestion(params);
      if(method==="cursor/create_plan"){
        this.#emitPlanText(text(params?.plan)||"# Plan\n\n(Cursor did not supply plan text.)");
        if(Array.isArray(params?.todos)&&params.todos.length)this.#emitTodos(params.todos,false);
        return {outcome:{outcome:"accepted"}};
      }
      if(method==="cursor/update_todos"){this.#emitTodos(params?.todos,params?.merge===true);return {}}
      if(method==="cursor/task"||method==="cursor/generate_image")return {};
    }
    if(method==="terminal/create"){
      const options=[{kind:"allow_once",optionId:"allow",name:"Allow"},{kind:"reject_once",optionId:"reject",name:"Reject"}];
      const toolCall={title:String(params.command||"Run command"),toolCallId:params.toolCallId||null,rawInput:{command:params.command,args:params.args,cwd:params.cwd||this.cwd},kind:"execute"};
      let selectedOption=acpPermissionChoice(options,this.permissionMode,"execute",{action:String(params.command||"Run command"),rawInput:toolCall.rawInput,workspace:this.cwd,requestedPath:params.cwd||this.cwd});
      if(!selectedOption){
        const decision=await this.#waitForUser(()=>this.onPermission?.({method,params:{...params,toolCall},options,approvalOptions:acpApprovalOptions(this.runtime,options)}));
        selectedOption=decision===CANCELLED?null:acpDecisionOption(this.runtime,options,decision||"decline");
      }
      if(selectedOption!=="allow")throw Object.assign(new Error("Terminal command was denied"),{code:-32000});
      if(this.remoteIo){
        const id=`remote-terminal-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
        const child=this.remoteIo.spawn({command:String(params.command||""),args:Array.isArray(params.args)?params.args:[],cwd:params.cwd||this.cwd});
        const entry={child,buffer:"",running:true,exitCode:null,signal:null,waiters:[]};this.remoteTerminals.set(id,entry);
        const append=chunk=>{entry.buffer=(entry.buffer+String(chunk)).slice(-2*1024*1024)};child.stdout?.on("data",append);child.stderr?.on("data",append);
        child.once("exit",(code,signal)=>{entry.running=false;entry.exitCode=code;entry.signal=signal;for(const resolve of entry.waiters.splice(0))resolve({exitCode:code,signal})});
        this.terminalIds.add(id);return {terminalId:id};
      }
      if(!this.terminals)throw new Error("Terminal service is unavailable");
      const cwd=params.cwd?boundedPath(this.cwd,params.cwd):this.cwd;
      const env=Object.fromEntries((params.env||[]).map(item=>[String(item.name),String(item.value)]));
      const session=await this.terminals.create({cwd,name:`${this.runtime} agent`,shell:String(params.command||""),args:Array.isArray(params.args)?params.args:[],env});
      this.terminalIds.add(session.id);
      return {terminalId:session.id};
    }
    if(method==="terminal/output"){
      if(this.remoteIo){const session=this.remoteTerminals.get(params.terminalId);if(!session)throw Object.assign(new Error("Terminal not found"),{code:-32002});return {output:session.buffer||"",truncated:false,...(!session.running?{exitStatus:{exitCode:session.exitCode??0,signal:session.signal??null}}:{})}}
      const session=this.terminals?.snapshot(params.terminalId);
      if(!session)throw Object.assign(new Error("Terminal not found"),{code:-32002});
      return {output:session.buffer||"",truncated:false,...(!session.running?{exitStatus:{exitCode:session.exitCode??0,signal:null}}:{})};
    }
    if(method==="terminal/wait_for_exit"){
      if(this.remoteIo){const session=this.remoteTerminals.get(params.terminalId);if(!session)throw Object.assign(new Error("Terminal not found"),{code:-32002});if(!session.running)return {exitCode:session.exitCode??null,signal:session.signal??null};return await new Promise(resolve=>session.waiters.push(resolve))}
      const result=await this.terminals?.waitForExit(params.terminalId,{timeoutMs:30*60_000});
      return {exitCode:result?.exitCode??null,signal:result?.signal??null};
    }
    if(method==="terminal/kill"){
      if(this.remoteIo){const session=this.remoteTerminals.get(params.terminalId);if(session){try{session.child.kill("SIGTERM")}catch{}this.remoteTerminals.delete(params.terminalId)}this.terminalIds.delete(params.terminalId);return {}}
      await this.terminals?.close(params.terminalId);this.terminalIds.delete(params.terminalId);return {};
    }
    if(method==="terminal/release"){
      if(this.remoteIo){const session=this.remoteTerminals.get(params.terminalId);if(session?.running){try{session.child.kill("SIGTERM")}catch{}}this.remoteTerminals.delete(params.terminalId);this.terminalIds.delete(params.terminalId);return {}}
      await this.terminals?.close(params.terminalId);this.terminalIds.delete(params.terminalId);return {};
    }
    throw Object.assign(new Error(`Unsupported ACP client request: ${method}`),{code:-32601});
  }
}
