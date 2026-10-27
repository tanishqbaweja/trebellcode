import { resolve } from "node:path";
import { acpToolFrame } from "./acp-tool-state.mjs";
import { fileUriPath } from "./file-uri.mjs";
import { HarnessSessionLostError } from "./harness-session-lost.mjs";
import { MuseHost, MUSE_SHUTDOWN_TIMEOUT_MS, MUSE_STARTUP_TIMEOUT_MS, loadMuseSdk, museLaunchPlan, museServeArgs, museSessionPolicy, museWorkspaceRoot } from "./muse-host.mjs";
import { resolveMuseReasoningEffort } from "./muse-model-catalog.mjs";
import { MUSE_REASONING_EFFORTS } from "./model-reasoning-effort.mjs";
import { NATIVE_PROMPT_PROVENANCE } from "./native-request-metrics.mjs";
import { normalizePermissionMode } from "./permission-policy.mjs";
import { runtimeInstructions } from "./runtime-instructions.mjs";

// Muse Code sessions and turns over the Muse Session Protocol (T3 Code's MuseAdapter): a session is started or resumed on Trebell's
// own host (muse-host.mjs), each prompt is a turn/start the turn's id is minted for, and Muse's item events come back as the
// ACP-shaped updates the relay reads (replies, reasoning summaries, commands, file edits, web searches).

export const MUSE_REQUEST_TIMEOUT_MS=30_000;
export const MUSE_INTERRUPT_TIMEOUT_MS=30_000;
// Muse takes at most this many characters of a person's own words in an answer (userInput/answer's freeText and note).
export const MUSE_FREE_TEXT_LIMIT=500;
// How often Trebell asks the person again about one approval or question whose answer Muse would not take.
const MUSE_ASK_ATTEMPTS=3;
// How many settled approvals and questions a session remembers, so a late copy of one is not asked again.
const MUSE_SETTLED_LIMIT=500;
export const MUSE_SIGNED_OUT_MESSAGE="Muse Code is signed out. Sign in with muse login, then send the message again.";
export const MUSE_VIEW_GAP_MESSAGE="Muse Code dropped some of this conversation's updates before they reached Trebell, so Trebell stopped it. The next message starts it again.";
// Meta's provider refuses "none"; the rest are MSP's efforts.
const MUSE_EFFORTS=new Set(MUSE_REASONING_EFFORTS);
// The model choice that lets Muse pick: the catalog's default row (T3 MUSE_DEFAULT_MODEL); the word itself never goes to Muse.
const MUSE_DEFAULT_MODEL="default";
// Items with rows of their own elsewhere (todo lists, questions, workflows) unless they failed, and Muse's housekeeping: the user's
// own message, the reminder children every model step runs, and compactions (group M5).
const OWN_ROW_TOOLS=new Set(["write_todos","request_user_input","workflow"]);
const SKIPPED_KINDS=new Set(["userMessage","reminderChild","compaction"]);
const ACTIONS=Object.freeze({
  "session/start":"start the session","session/resume":"resume this conversation","session/setApprovalMode":"set the session's approval mode",
  "session/setModel":"switch to the thread's model",
  "turn/start":"start the turn","turn/steer":"take the message into the running turn","turn/interrupt":"stop the turn",
  "approval/decide":"take Trebell's answer to its request","userInput/cancel":"take Trebell's answer to its question",
  "userInput/answer":"take the answer to its question",
});

function text(value){return typeof value==="string"?value:value==null?"":String(value)}
function wait(ms){let timer;const promise=new Promise(resolve=>{timer=setTimeout(resolve,ms);timer?.unref?.()});return {promise,cancel:()=>clearTimeout(timer)}}
async function within(promise,ms){const timer=wait(ms);try{return await Promise.race([Promise.resolve(promise).then(()=>true,()=>true),timer.promise.then(()=>false)])}finally{timer.cancel()}}

// Prompt parts for turn/start and turn/steer: text as it is, images as base64 with their media type, and any other attachment as
// a line naming the file it was saved to. An input with neither text nor an image is refused.
export function museInputParts(parts=[]){
  const out=[];
  for(const part of Array.isArray(parts)?parts:[]){
    if(part?.type==="text"){const value=text(part.text);if(value)out.push({type:"text",text:value})}
    else if(part?.type==="image"&&part.data)out.push({type:"image",base64Data:text(part.data),mediaType:text(part.mimeType||part.mime_type)||"image/png"});
    else if(part?.type==="resource_link"&&part.uri)out.push({type:"text",text:`Attached file: ${fileUriPath(part.uri)??text(part.uri)}`});
  }
  if(!out.some(part=>part.type==="image"||part.text.trim()))throw new Error("Muse Code needs text or an image to start a turn.");
  return out;
}

// What Muse's transcript shows for the turn: the person's own words, without Trebell's working context or runtime notes.
export function museDisplayText(parts=[]){
  const list=Array.isArray(parts)?parts:[];
  const own=list.map(part=>part?.[NATIVE_PROMPT_PROVENANCE]?.userParts).find(Array.isArray);
  const words=(own||list.filter(part=>part?.type==="text").map(part=>text(part.text))).join("\n").trim();
  return words||(list.some(part=>part?.type==="image")?"Attached image":"");
}

export function museToolStatus(item={}){
  if(item.status==="inProgress")return "in_progress";
  if(item.status==="completed"&&!(item.kind==="compaction"&&item.outcome&&item.outcome!=="compacted"))return "completed";
  return "failed";
}

function jsonObject(value){
  if(typeof value!=="string"||!value.trim())return null;
  try{const parsed=JSON.parse(value);return parsed&&typeof parsed==="object"&&!Array.isArray(parsed)?parsed:null}catch{return null}
}
function webHits(value){
  const results=jsonObject(value)?.results;if(!Array.isArray(results))return null;
  return results.filter(hit=>hit&&typeof hit==="object").map(({url,title,snippet})=>({
    ...(typeof url==="string"&&url.trim()?{url:url.trim()}:{}),...(typeof title==="string"&&title.trim()?{title:title.trim()}:{}),...(typeof snippet==="string"&&snippet?{snippet}:{}),
  }));
}
function hitsText(results){return results.map(hit=>[hit.title&&hit.url?`${hit.title} (${hit.url})`:hit.title||hit.url||"",hit.snippet||""].filter(Boolean).join("\n")).filter(Boolean).join("\n\n")}

// One Muse item as an ACP tool update, as T3's museToolPresentation maps it: Muse's shell and the person's own shell commands run
// as commands with their output and exit code; a write, edit or patch with a file is a file edit with its exact old and new text
// (an ACP diff) or Muse's patch; a web search lists its hits and a fetched page its text; anything else is a tool row with its
// arguments. Muse's tool arguments are model-written JSON, which may not parse while they stream.
export function museToolUpdate(item={}){
  const args=jsonObject(item.args),arg=(...keys)=>{for(const key of keys)if(typeof args?.[key]==="string")return args[key];return undefined};
  const tool=text(item.tool||item.kind)||"tool",status=museToolStatus(item);
  const name=item.kind==="subagent"?item.objective||item.role||"Muse agent":item.kind==="workflow"?item.entryId||"Workflow":tool;
  const detail=status==="failed"?item.failureReason||`Muse Code reported ${item.status||"a failure"}.`:"";
  const body=item.visibleOutput??item.result?.summary??item.text??(Array.isArray(item.summary)?item.summary.join("\n"):undefined)??item.finalSummary??item.fallbackText??item.objective??"";
  const output=detail?[detail,text(body)].filter(Boolean).join("\n"):text(body);
  const base={toolCallId:text(item.itemId),status};
  if(item.kind==="userShell"||/shell|bash|exec_command/i.test(text(item.tool))){
    const command=item.commandText??arg("command","cmd")??item.args??"";
    // Muse's own shell answers with a record of the run ({command, exit_code, output, ...}), which carries the output and exit code.
    const record=jsonObject(item.visibleOutput),run=record&&typeof record.output==="string"?{...record,output:detail?[detail,record.output].filter(Boolean).join("\n"):record.output}:null;
    return {...base,kind:"execute",title:text(command)||tool,rawInput:args||{command:text(command)},rawOutput:run||output,...(Number.isInteger(item.exitCode)?{exitCode:item.exitCode}:{})};
  }
  if(item.kind==="toolCall"&&/write|edit|patch/i.test(tool)){
    const path=arg("file_path","path","filePath")?.trim();
    if(path){
      const oldText=arg("old_string","old_str","oldStr","oldText"),newText=arg("new_string","new_str","newStr","newText","content"),patch=arg("diff","patch","diffStr");
      return {
        ...base,kind:"edit",title:detail?`${tool}: ${detail}`:tool,rawInput:args,rawOutput:output,locations:[{path}],
        content:newText!==undefined?[{type:"diff",path,...(oldText!==undefined?{oldText}:{}),newText}]:[],
        ...(newText===undefined&&patch!==undefined?{changes:[{path,kind:"update",diff:patch}]}:{}),
      };
    }
  }
  if(item.kind==="toolCall"&&/web|browse|fetch/i.test(tool)){
    const query=arg("query","url","pattern")?.trim(),url=arg("url")?.trim();
    const hits=item.tool==="web_search"&&!detail?webHits(text(body)):null;
    const results=hits??(output?[{...(url?{url}:{}),snippet:output}]:[]);
    return {...base,kind:"fetch",title:query?`${tool}: ${query}`:tool,rawInput:args||{},rawOutput:{...(query?{query}:{}),results},content:results.length?[{type:"content",content:{type:"text",text:hitsText(results)}}]:[]};
  }
  return {...base,kind:"other",title:detail?`${name}: ${detail}`:name,rawInput:args||(item.args?{args:text(item.args)}:{}),rawOutput:output};
}

// The decision a Muse approval choice applies (T3 museApprovalDecision): approved once is Allow once, approvedForSession (or a rule
// for the session) Allow for this session, a rule saved for the workspace Always allow, denied (or a rule that keeps it out)
// Reject, and abort Cancel. A decision Muse adds later has none, and is never offered.
export function museApprovalDecision(choice={}){
  switch(text(choice?.decision)){
    case "approved":return "accept";
    case "approvedForSession":return "acceptForSession";
    case "approvedPolicyAmendment":return choice.scope==="session"?"acceptForSession":choice.scope==="localPersistent"?"acceptAlways":null;
    case "denied":case "deniedPolicyAmendment":return "decline";
    case "abort":return "cancel";
    default:return null;
  }
}
// Muse's choice for each decision, the narrowest grant first: once, then the session, then saved, and a choice without a rule before
// one that saves a rule (T3 museApprovalChoices). Shell approvals offer abort as their Reject, so abort also declines one that has
// no denied choice.
export function museApprovalChoices(choices=[]){
  const chosen=new Map(),rank=choice=>(choice.scope==="once"?0:choice.scope==="session"?2:4)+(/PolicyAmendment$/.test(text(choice.decision))?1:0);
  for(const choice of Array.isArray(choices)?choices:[]){
    if(!choice||typeof choice.choiceId!=="string"||!choice.choiceId)continue;
    const decision=museApprovalDecision(choice),previous=decision?chosen.get(decision):null;
    if(decision&&(!previous||rank(choice)<rank(previous)))chosen.set(decision,choice);
  }
  if(!chosen.has("decline")&&chosen.has("cancel"))chosen.set("decline",chosen.get("cancel"));
  return chosen;
}
// The approval card's buttons: Muse's own choices in its order and words (Allow once, Always allow in this workspace: touch ...,
// Reject); an abort that is also the Reject shows once.
export function museApprovalOptions(choices=[]){
  const chosen=museApprovalChoices(choices),decline=chosen.get("decline")?.choiceId;
  return [...chosen].filter(([decision,choice])=>decision!=="cancel"||choice.choiceId!==decline).map(([decision,choice])=>({decision,label:text(choice.label).trim()||decision}));
}
// The subjects Muse names (an approval's subject.kind); Trebell's policy answers no other kind for the person.
const MUSE_SUBJECTS=new Set(["shell","fileAccess","network","unixSocket","process","tool"]);
// What a Muse approval asks, as the relay's approval card and Trebell's policy read it (T3 publishRequest): a shell stage is a command
// and a file read a read, other file access an edit, a network host network and anything else a tool; its title is the command,
// path, host or target, else the tool.
export function museApprovalToolCall(params={}){
  const subject=params.subject&&typeof params.subject==="object"?params.subject:{},kind=text(subject.kind);
  const title=[subject.command,subject.path,subject.host,subject.target,params.toolName,subject.toolName].map(value=>text(value).trim()).find(Boolean)||"Muse Code requests permission";
  const rawInput=kind==="shell"?{command:text(subject.command)}
    :kind==="fileAccess"?{path:text(subject.path),access:text(subject.access)||"write"}
    :kind==="network"?{host:text(subject.host),...(Number.isInteger(subject.port)?{port:subject.port}:{}),...(subject.protocol?{protocol:text(subject.protocol)}:{})}
    :{...(subject.target?{target:text(subject.target)}:{}),...(typeof params.rawArgs==="string"?{args:params.rawArgs}:{})};
  const policyKind=kind==="shell"?"execute":kind==="fileAccess"?(subject.access==="read"?"read":"edit"):kind==="network"?"network":"other";
  return {toolCallId:text(params.toolCallId||params.itemId||params.approvalId),title,kind:policyKind,rawInput};
}
// Muse's questions as the relay's question dialog asks them (T3 publishRequest): the header, question and options, several choices
// for a multiple-selection question, and the person's own words for every one, as Muse takes a free-text answer to any question.
// notes: what an answer to a question lacked, said beside it when Trebell asks again.
export function museQuestions(questions=[],notes={}){
  return (Array.isArray(questions)?questions:[]).filter(question=>question&&typeof question.id==="string"&&question.id).map(question=>{
    const asked=text(question.question).trim()||text(question.header).trim()||"Muse Code asks a question.",note=text(notes?.[question.id]).trim();
    return {id:question.id,header:text(question.header).trim()||"Question",question:note?`${asked} (${note})`:asked,multiSelect:question.selection?.mode==="multiple",allowCustomAnswer:true,
      options:(Array.isArray(question.options)?question.options:[]).filter(option=>typeof option?.label==="string"&&option.label).map(option=>({label:option.label,description:text(option.description)}))};
  });
}
// The person's answers as userInput/answer takes them (T3 respondToRuntimeRequest): the options chosen, by their exact labels, one
// for a single-selection question and within its bounds for a multiple one, and the person's own words as the free-text answer, or
// as a note beside the choices, of at most 500 characters. An answer Muse would refuse says why, by its question.
export function museUserInputAnswers(questions=[],answers={}){
  const out=[];
  for(const question of Array.isArray(questions)?questions:[]){
    if(!question||typeof question.id!=="string"||!question.id)continue;
    const raw=answers?.[question.id],values=[...new Set((Array.isArray(raw)?raw:raw==null?[]:[raw]).map(value=>text(value).trim()).filter(Boolean))];
    const labels=new Set((Array.isArray(question.options)?question.options:[]).map(option=>option?.label).filter(label=>typeof label==="string"));
    const selected=values.filter(value=>labels.has(value)),own=values.filter(value=>!labels.has(value)).join("\n"),multiple=question.selection?.mode==="multiple";
    const refuse=message=>({error:{questionId:question.id,message}});
    if(!selected.length&&!own)return refuse("Answer this question to go on.");
    if(own.length>MUSE_FREE_TEXT_LIMIT)return refuse(`Muse Code takes at most ${MUSE_FREE_TEXT_LIMIT} characters of your own words; the last answer had ${own.length}.`);
    const min=Number.isInteger(question.selection?.minSelections)?question.selection.minSelections:1,max=Number.isInteger(question.selection?.maxSelections)?question.selection.maxSelections:Infinity;
    if(!multiple&&selected.length>1)return refuse("Choose one option.");
    if(multiple&&selected.length&&selected.length<min)return refuse(`Choose at least ${min} options.`);
    if(multiple&&selected.length>max)return refuse(`Choose at most ${max} ${max===1?"option":"options"}.`);
    out.push({questionId:question.id,...(selected.length?multiple?{selectedLabels:selected}:{selectedLabel:selected[0]}:{}),...(own?selected.length?{note:own}:{freeText:own}:{})});
  }
  return {answers:out};
}
// A turn the subscription quota stopped (T3 93ea95cf4 usageLimits.ts): Muse types it with error.quota, and a refusal relayed without
// one is a 429 that names the quota or a usage limit. A plain 429 rate limit stays an ordinary failure.
export function museUsageLimited(error={},message=""){
  return Boolean(error?.quota&&typeof error.quota==="object")||(/\b429\b/.test(text(message))&&/quota|usage limit/i.test(text(message)));
}
const MUSE_NAMED_RESET=/\bresets at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))/i;
// The latest instant a JavaScript Date holds.
const LATEST_DATE_MS=8.64e15;
// When the limit lifts: the latest future reset among the used-up windows of Muse's last usage report (the 5-hour window and the
// week, at 100% or more), the quota's own reset, and a "resets at <time>" in the refusal; null when none is known.
export function museUsageLimitResetAt(usage,nowMs=Date.now(),{quota=null,message=""}={}){
  const named=text(message).match(MUSE_NAMED_RESET)?.[1];
  const resets=[...[usage?.window,usage?.weekly].map(window=>window&&window.usedPercent>=100?window.resetsAtMs:undefined),quota?.resetsAtMs,named===undefined?undefined:Date.parse(named)]
    .filter(ms=>typeof ms==="number"&&Number.isFinite(ms)&&ms>nowMs&&ms<=LATEST_DATE_MS);
  return resets.length?new Date(Math.max(...resets)).toISOString():null;
}
// What a turn the limit stopped says, with the reset in the person's own time when Muse gave one.
export function museUsageLimitMessage(resetAt=null){
  const at=resetAt?new Date(resetAt):null;
  return at&&!Number.isNaN(at.getTime())
    ?`Muse Code usage limit reached. Send the message again after it resets at ${at.toLocaleString(undefined,{dateStyle:"medium",timeStyle:"short"})}.`
    :"Muse Code usage limit reached. Send the message again once it resets.";
}
// Muse's usage report (usage/changed, account-wide): when the host saw it, the tier, and the current window's and the week's
// verbatim percentages (over 100 past the quota) with their resets; null for a report Trebell cannot read.
export function museSubscriptionUsage(params={}){
  const number=value=>typeof value==="number"&&Number.isFinite(value)&&value>=0,stamp=value=>number(value)&&value>0&&value<=LATEST_DATE_MS;
  const window=params?.window,weekly=params?.weekly;
  if(!stamp(params?.observedAtMs)||typeof params?.tier!=="string")return null;
  if(!window||typeof window!=="object"||!number(window.usedPercent)||!(number(window.windowDurationMins)&&window.windowDurationMins>0)||!stamp(window.resetsAtMs))return null;
  if(!weekly||typeof weekly!=="object"||!number(weekly.usedPercent)||!stamp(weekly.resetsAtMs))return null;
  return {observedAtMs:params.observedAtMs,tier:params.tier,window:{usedPercent:window.usedPercent,windowDurationMins:window.windowDurationMins,resetsAtMs:window.resetsAtMs},weekly:{usedPercent:weekly.usedPercent,resetsAtMs:weekly.resetsAtMs}};
}
// turn/retryScheduled: Muse retries the turn's model request itself and the turn goes on, so its retry row says so in Trebell's
// words (T3's Muse retry notice); null for a notice Trebell cannot read.
export function museRetryNotice(params={}){
  const whole=value=>Number.isInteger(value)&&value>=1,delay=params?.retryDelayMs,reason=text(params?.reason).replace(/\s+/g," ").trim();
  if(!text(params?.turnId)||!whole(params?.nextAttempt)||!whole(params?.maxAttempts)||!reason||!(typeof delay==="number"&&Number.isFinite(delay)&&delay>=0))return null;
  return `Muse Code is trying again in ${Math.max(1,Math.round(delay/1000))} s (attempt ${params.nextAttempt} of ${params.maxAttempts}): ${reason}`;
}
const requirementKey=requirement=>JSON.stringify(requirement??null);

export class MuseAgentSession{
  // modelCatalog: the list Muse Code's status check read ({models, metadata, preferred}, museModelCatalog), or null, which the
  // thread's model and Thinking level are resolved against before each turn. env: the profile's (AgentRuntimeManager.childEnv), and
  // approvedEnvironmentKeys the names its profile approves (a META_API_KEY reaches Muse only with its name there, museEnvironment).
  constructor({command="muse",cwd,env=undefined,approvedEnvironmentKeys=[],permissionMode="supervised",onUpdate,onPermission=null,onQuestion=null,version="0.0.0",modelCatalog=()=>null,spawnFn=undefined,platform=process.platform,loadSdk=loadMuseSdk,stopTree=undefined,startupTimeoutMs=MUSE_STARTUP_TIMEOUT_MS,shutdownTimeoutMs=MUSE_SHUTDOWN_TIMEOUT_MS,requestTimeoutMs=MUSE_REQUEST_TIMEOUT_MS,interruptTimeoutMs=MUSE_INTERRUPT_TIMEOUT_MS}={}){
    this.command=command;this.cwd=resolve(cwd||process.cwd());this.env=env;this.permissionMode=normalizePermissionMode(permissionMode||"supervised");
    this.onUpdate=onUpdate;this.onPermission=onPermission;this.onQuestion=onQuestion;this.version=version;this.modelCatalog=modelCatalog;
    this.hostOptions={spawnFn,platform,stopTree,startupTimeoutMs,shutdownTimeoutMs,approvedEnvironmentKeys};this.platform=platform;this.loadSdk=loadSdk;
    this.requestTimeoutMs=requestTimeoutMs;this.interruptTimeoutMs=interruptTimeoutMs;
    this.args=museServeArgs(this.permissionMode);this.launched=null;this.host=null;this.connection=null;this.initializeResult=null;this.sessionSetup=null;
    this.sessionId=null;this.model=null;this.wantedModel=null;this.reasoningEffort=null;this.turnRoot=null;
    this.dead=false;this.deadError=null;this.closed=false;this.activePrompt=null;
    // The approvals and questions Muse asked and has not settled ("approval:<id>", "question:<id>"), and the ones it settled.
    this.requests=new Map();this.settledRequests=new Set();
    // Muse's last readable usage report (usage/changed), which a turn the quota stopped reads its reset from.
    this.subscriptionUsage=null;
  }

  get busy(){return Boolean(this.activePrompt)}
  // A new host can take the conversation up again unless this one keeps its sessions in memory only.
  get resumable(){return Boolean(this.initializeResult)&&this.initializeResult.sessionDurability!=="ephemeral"}
  setPermissionMode(mode){this.permissionMode=normalizePermissionMode(mode||"supervised");return this.permissionMode}
  // A mode's launch flags, permission profile and approval mode are fixed when its host launches (museLaunchPlan), so a mode with
  // another plan needs a new host, which resumes the conversation (T3: runtime policy changes require a fresh Muse host).
  needsRelaunch(mode){return JSON.stringify(museLaunchPlan(mode))!==JSON.stringify(this.launched?.plan||museLaunchPlan(this.permissionMode))}
  setReasoningEffort(effort){const value=text(effort).trim().toLowerCase();this.reasoningEffort=MUSE_EFFORTS.has(value)?value:null;return this.reasoningEffort}

  #catalog(){try{const catalog=typeof this.modelCatalog==="function"?this.modelCatalog():this.modelCatalog;return catalog&&typeof catalog==="object"?catalog:null}catch{return null}}
  // A model id as Muse takes it: "default" is the catalog's default row, or none (Muse's own) while the list is unknown.
  #resolveModel(model){const value=text(model).trim();return value===MUSE_DEFAULT_MODEL?this.#catalog()?.preferred||null:value||null}
  // The thread's model (T3's session/setModel {model:{modelId, providerId:'meta'}}): sent at once while no turn runs, and otherwise
  // before the next turn, as for a resumed session on another model. A model Muse refuses fails with its reason and leaves the
  // session's model as it was.
  async setModel(model){
    const previous=this.wantedModel;this.wantedModel=this.#resolveModel(model);
    if(this.connection&&this.sessionId&&!this.dead&&!this.activePrompt)try{await this.#applyModel()}catch(error){this.wantedModel=previous;throw error}
    return this.model;
  }
  async #applyModel(){
    const modelId=this.wantedModel;if(!modelId||modelId===this.model)return;
    await this.#command("session/setModel",{sessionId:this.sessionId,model:{modelId,providerId:"meta"}});
    this.model=modelId;
  }
  // The level the turn runs at, against the thread's model in the catalog (resolveMuseReasoningEffort).
  #turnEffort(){return resolveMuseReasoningEffort(this.#catalog()?.metadata?.find?.(row=>row?.id===this.model)||null,this.reasoningEffort)}

  async start({providerSessionId=null,model=null,reasoningEffort=undefined}={}){
    if(reasoningEffort!==undefined)this.setReasoningEffort(reasoningEffort);
    const plan=museLaunchPlan(this.permissionMode);this.args=plan.args;this.launched={mode:this.permissionMode,plan};
    const host=new MuseHost({...Object.fromEntries(Object.entries(this.hostOptions).filter(([,value])=>value!==undefined)),command:this.command,args:this.args,cwd:this.cwd,env:this.env,
      onWarning:message=>this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"protocol_warning",message}})});
    this.host=host;this.dead=false;this.deadError=null;
    await host.start({version:this.version,loadSdk:this.loadSdk});
    if(this.closed){await host.close();throw new Error("Muse Code was stopped while it started.")}
    const connection=host.connection;this.connection=connection;this.initializeResult=host.initializeResult;
    connection.onNotification(frame=>{if(this.host===host)this.#notification(frame)});
    connection.onServerRequest(request=>this.#serverRequest(host,request));
    connection.onProtocolError(error=>{if(this.host===host)this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"protocol_warning",message:`Muse Code sent a frame Trebell could not read: ${error?.message||error}`}})});
    this.#watch(host);
    try{
      const [workspaceRoot,turnRoot]=await Promise.all([museWorkspaceRoot(this.cwd,{platform:this.platform,verbatim:false}),museWorkspaceRoot(this.cwd,{platform:this.platform})]);
      this.turnRoot=turnRoot;
      const modelId=this.#resolveModel(model);this.wantedModel=modelId;
      const sessionId=providerSessionId?text(providerSessionId):connection.mintCommandId();
      this.sessionId=sessionId;
      const result=providerSessionId?await this.#resume(sessionId):await this.#command("session/start",{sessionId,workspaceRoot,providerId:"meta",...(modelId?{modelId}:{}),approvalMode:plan.approvalMode,permissionProfile:plan.permissionProfile});
      if(result?.session?.sessionId!==sessionId)throw new Error("Muse Code answered with another session than the one Trebell asked for.");
      this.model=text(result.session.modelId)||modelId;
      this.sessionSetup={sessionId,models:{currentModelId:this.model,availableModels:this.model?[{modelId:this.model,name:this.model}]:[]},configOptions:[],modes:{currentModeId:"default",availableModes:[]}};
      return {initialize:this.initializeResult,session:this.sessionSetup};
    }catch(error){
      // The host has no session of Trebell's then; a resume that found none closes nothing on Muse's side.
      this.dead=true;this.deadError=error;await host.close().catch(()=>{});
      throw error;
    }
  }

  // A saved conversation is resumed with its mode's profile asked for again, then its approval mode set (a resume replays the mode
  // it had); one Muse no longer has is a lost session, which the relay continues in a fresh one with the thread's earlier messages
  // handed over.
  async #resume(sessionId){
    const {permissionProfile,approvalMode}=this.launched?.plan||museSessionPolicy(this.permissionMode);
    try{
      const result=await this.#command("session/resume",{sessionId,excludeItems:true,permissionProfile});
      await this.#command("session/setApprovalMode",{sessionId,mode:approvalMode});
      return result;
    }catch(error){
      if(error?.kind==="sessionNotFound"||error?.kind==="notFound")throw new HarnessSessionLostError(error.message,{harness:"muse",sessionId,code:error.code,cause:error.cause||error});
      throw error;
    }
  }

  // An MSP command, bounded at requestTimeoutMs: turn/start keeps the SDK's retries of an overloaded host, every other command is
  // sent once. A host that does not answer in time is stopped, and the session is dead.
  async #command(method,params,{commandId=undefined,retries=false}={}){
    const connection=this.connection;if(!connection)throw new Error("Muse Code session is not started.");
    const timer=wait(this.requestTimeoutMs);
    try{
      const answer=await Promise.race([
        connection.command(method,params,{...(commandId?{commandId}:{}),...(retries?{}:{maxAttempts:1})}).then(result=>({result}),error=>({error})),
        timer.promise.then(()=>({timeout:true})),
      ]);
      if(answer.timeout){
        const message=`Muse Code did not answer within ${Math.round(this.requestTimeoutMs/1000)} seconds when asked to ${ACTIONS[method]||method}, so Trebell stopped it.`;
        this.#lose(message,{stop:true});
        throw Object.assign(new Error(message),{code:"MUSE_REQUEST_TIMEOUT"});
      }
      if(answer.error){
        const error=answer.error,reason=this.dead&&this.deadError?this.deadError.message:error?.message||String(error);
        throw Object.assign(new Error(`Muse Code could not ${ACTIONS[method]||method}: ${reason}`),{code:error?.code,kind:error?.kind,cause:error});
      }
      return answer.result;
    }finally{timer.cancel()}
  }

  // onDelivered: told once Muse has admitted the turn (its turn/start answer), so the prompt with Trebell's context beside it is in
  // Muse's conversation. The turn's id is minted first, so the events Muse sends for it before that answer are its own.
  async prompt(parts,{onDelivered=null}={}){
    if(!this.connection||!this.sessionId)throw new Error("Muse Code session is not started.");
    if(this.dead)throw this.deadError||new Error("Muse Code stopped.");
    if(this.activePrompt)throw new Error("Muse Code already has a running turn.");
    const input=museInputParts(parts),displayText=museDisplayText(parts);
    const turn=this.#newTurn(this.connection.mintCommandId());this.activePrompt=turn;
    try{
      let ack;
      try{
        // The thread's model first, when the session runs another (T3 sends session/setModel before turn/start).
        await this.#applyModel();
        const reasoningEffort=this.#turnEffort();
        ack=await this.#command("turn/start",{
          sessionId:this.sessionId,
          // Muse takes no system context, so Trebell's runtime notes lead the turn's input.
          input:[{type:"text",text:runtimeInstructions({harness:"Muse Code",model:this.model})},...input],
          ...(displayText?{displayText}:{}),
          // Each turn names the folder: a resumed session keeps the roots it had.
          workspaceRoots:[this.turnRoot],ifBusy:"queue",...(reasoningEffort?{reasoningEffort}:{}),
        },{commandId:turn.turnId,retries:true});
        if(ack?.turnId!==turn.turnId)throw new Error("Muse Code took the message into another turn than the one Trebell started.");
      }catch(error){
        turn.admit(false);
        // A host that went away under the request ends the turn with its own reason, its exit, which follows moments later.
        if(await within(this.connection.closed,50))await within(turn.done,2500);
        turn.fail(error);
        return await turn.done;
      }
      turn.admit(true);
      if(typeof onDelivered==="function")try{onDelivered()}catch{}
      return await turn.done;
    }finally{if(this.activePrompt===turn)this.activePrompt=null}
  }

  #newTurn(turnId){
    let settle,fail,admit;
    const done=new Promise((resolve,reject)=>{settle=resolve;fail=reject});
    const admitted=new Promise(resolve=>{admit=resolve});
    const turn={turnId,stopRequested:false,settled:false,items:new Map(),sent:new Map(),tools:new Set(),lastMessage:null,done,admitted,admit};
    turn.settle=value=>{if(turn.settled)return;turn.settled=true;this.#endTurn(turn,false);settle(value)};
    turn.fail=error=>{if(turn.settled)return;turn.settled=true;this.#endTurn(turn,true);fail(error)};
    done.catch(()=>{});
    return turn;
  }
  // A turn's end settles what it left open (T3 finish): a failed turn's running tools end failed, and the approvals and questions
  // asked in it go, cards and dialogs included, since Muse settles them with the turn. A workflow child's approval outlives it.
  #endTurn(turn,failed){
    if(failed)for(const item of turn.items.values())if(item.status==="inProgress"&&turn.tools.has(item.itemId))this.onUpdate?.({sessionId:this.sessionId,update:{...acpToolFrame(museToolUpdate({...item,status:"failed",failureReason:text(item.failureReason)||"The turn ended before this finished."})),sessionUpdate:"tool_call_update"}});
    this.#withdrawRequests(entry=>!entry.child);
  }

  // A message sent while the turn runs goes into that turn (turn/steer names the turn it is meant for), once Muse has admitted it.
  async steer(parts){
    const turn=this.activePrompt;
    if(!this.connection||!turn||turn.settled)throw new Error("Muse Code has no running turn to steer.");
    const input=museInputParts(parts);
    if(!(await turn.admitted)||turn.settled)throw new Error("Muse Code has no running turn to steer.");
    const ack=await this.#command("turn/steer",{sessionId:this.sessionId,expectedTurnId:turn.turnId,input});
    if(ack?.turnId!==turn.turnId)throw new Error("Muse Code took the message into another turn than the running one.");
    return {accepted:true,pending:0,providerMessageId:null};
  }

  // Stop: turn/interrupt for the running turn once Muse has admitted it, then its turn/completed. A host that does not confirm
  // the stop within interruptTimeoutMs is stopped itself, and the next message starts it again.
  // The turn's own approvals and questions go at once: Muse settles them as it stops the turn, so none is answered for the person.
  async cancel(){
    const turn=this.activePrompt;if(!turn||turn.settled)return;
    turn.stopRequested=true;this.#withdrawRequests(entry=>!entry.child);
    if(!(await turn.admitted)||turn.settled)return;
    try{await this.#command("turn/interrupt",{sessionId:this.sessionId,turnId:turn.turnId})}catch{}
    if(turn.settled)return;
    const timer=wait(this.interruptTimeoutMs);
    const confirmed=await Promise.race([turn.done.then(()=>true,()=>true),timer.promise.then(()=>false)]).finally(()=>timer.cancel());
    if(confirmed)return;
    turn.settle({stopReason:"cancelled",interrupted:true,providerMessageId:null});
    this.#lose(`Muse Code did not confirm within ${Math.round(this.interruptTimeoutMs/1000)} seconds that the turn stopped, so Trebell stopped Muse Code.`,{stop:true,quiet:true});
  }

  async close(){
    if(this.closed)return;this.closed=true;
    const turn=this.activePrompt;if(turn){turn.stopRequested=true;turn.settle({stopReason:"cancelled",interrupted:true,providerMessageId:null})}
    this.#withdrawRequests();
    await this.host?.close().catch(()=>{});
  }

  // The host ending on its own (its exit, or its connection closing first) ends the running turn with Muse's reason once, and
  // leaves the session dead: the next message starts a new host. A host whose connection closed but whose process runs on is stopped.
  #watch(host){
    const lost=message=>{if(this.host===host&&!this.closed&&!host.closing)this.#lose(message,{stop:true})};
    host.exited.then(exit=>lost(host.exitMessage(exit)));
    host.connection.closed.then(async()=>{
      const timer=wait(2000);
      await Promise.race([host.exited,timer.promise]).finally(()=>timer.cancel());
      lost(host.exit?host.exitMessage(host.exit):"Muse Code closed its connection to Trebell unexpectedly.");
    });
  }
  // Every approval and question the host asked goes with it, a workflow child's too.
  #lose(message,{stop=false,quiet=false}={}){
    if(this.dead||this.closed)return;
    this.dead=true;this.deadError=Object.assign(new Error(message),{code:"MUSE_HOST_LOST"});
    const turn=this.activePrompt;
    if(turn&&!turn.settled){if(turn.stopRequested)turn.settle({stopReason:"cancelled",interrupted:true,providerMessageId:null});else turn.fail(this.deadError)}
    else if(!quiet)this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"runtime_error",message}});
    this.#withdrawRequests();
    if(stop)void this.host?.close().catch(()=>{});
  }

  // Muse sends a pending approval or question both as a notification and as a server request, answered with the presentation
  // receipt {}; Trebell's answer goes out as a command of its own (approval/decide, userInput/answer or userInput/cancel).
  async #serverRequest(host,request){
    const params=request?.params||{};
    if(this.host===host&&params.sessionId===this.sessionId){
      if(request.method==="approval/request"){this.#approvalEvent("approval/requested",params);return {}}
      if(request.method==="userInput/request"){this.#questionEvent("userInput/requested",params);return {}}
    }
    throw new host.sdk.MspError({code:-32601,message:`method not found: ${request?.method}`,data:{kind:"methodNotFound",retryable:false}});
  }

  // An approval of this session, routed by its session, a workflow child's too (T3 handleRequestEvent): asked once however many copies
  // of it come (the request, its notification, a re-send), an update keeps its latest stage and choices, and the stage after the one
  // decided (a staged shell command's next command) is asked in turn. An update of one Trebell never saw, and any copy of one Muse
  // has settled, asks nothing.
  #approvalEvent(method,params){
    const id=text(params.approvalId);if(!id)return;
    const key="approval:"+id;
    if(method==="approval/resolved"||params.change?.kind==="alreadyTerminal")return this.#settleRequest(key);
    if(this.settledRequests.has(key))return;
    const known=this.requests.get(key);
    if(known){known.params={...known.params,...params};return void this.#approve(known)}
    if(method!=="approval/requested")return;
    const entry={key,kind:"approval",id,params:{...params},child:Boolean(params.subagentOrigin),ask:null,deciding:false,decided:null,automatic:null,attempts:0};
    this.requests.set(key,entry);void this.#approve(entry);
  }
  // Who answers the approval's current stage: nobody once it is decided, while Muse settles it or moves it to its next stage. In Full
  // access a workflow child's stage is answered Allow once without asking, as Muse does not pass allowAll on to workflow children
  // (T3 d81afa0a6, a752363b1); it is shown only when Muse refuses that answer, and never once Muse has settled it. Every other stage
  // goes to Trebell's policy and the approval card.
  async #approve(entry){
    if(this.requests.get(entry.key)!==entry||entry.ask||entry.deciding)return;
    const stage=requirementKey(entry.params.currentRequirementId);
    if(entry.decided===stage)return;
    if(entry.child&&this.launched?.plan.approvalMode==="allowAll"&&entry.automatic!==stage){
      entry.automatic=stage;
      const outcome=await this.#decide(entry,"accept");
      if(outcome==="taken")return this.#approve(entry);
      if(outcome==="settled"||this.requests.get(entry.key)!==entry)return;
    }
    return this.#askApproval(entry,{askUser:entry.automatic===stage});
  }
  // Asks the stage through the relay, as an ACP harness's request is asked: Trebell's policy answers what it allows or denies, and
  // the person the rest, on the approval card with Muse's own choices. askUser: only the person answers. So it is in Auto, whose
  // reviewer (':auto-review') has cleared what it could, as in Grok's Auto; for a protected write, a subject Trebell does not know,
  // and a stage with no Allow once to answer for the person with. A card Muse settles meanwhile is withdrawn (signal); a window that
  // never answers declines, rather than leave Muse waiting.
  async #askApproval(entry,{askUser=false}={}){
    const params=entry.params,choices=museApprovalChoices(params.availableChoices);
    if(typeof this.onPermission!=="function")return this.#answerApproval(entry,"decline");
    const ask=new AbortController();entry.ask=ask;
    let decision="decline";
    try{
      decision=await this.onPermission({
        method:"approval/requested",params:{toolCall:museApprovalToolCall(params)},
        options:(Array.isArray(params.availableChoices)?params.availableChoices:[]).filter(choice=>choice?.choiceId).map(choice=>({optionId:text(choice.choiceId),name:text(choice.label),kind:text(choice.decision)})),
        askUser:askUser||this.launched?.plan.permissionProfile===":auto-review"||params.protectedWrite===true||!MUSE_SUBJECTS.has(text(params.subject?.kind))||!choices.has("accept"),
        approvalOptions:museApprovalOptions(params.availableChoices),signal:ask.signal,
      });
    }catch{decision="decline"}
    finally{if(entry.ask===ask)entry.ask=null}
    if(ask.signal.aborted||this.requests.get(entry.key)!==entry)return;
    return this.#answerApproval(entry,decision);
  }
  // The answer for the stage asked. Cancel (a card the relay withdrew as its thread stopped, a workflow child's among them) is
  // Muse's abort, or its Reject. A decision Muse refuses, or no longer offers once a later stage came, is asked again on the card, a
  // few times at most; a stage that cannot be declined stops the turn rather than leave it waiting.
  async #answerApproval(entry,decision){
    const choices=museApprovalChoices(entry.params.availableChoices);
    const wanted=decision==="cancel"&&!choices.has("cancel")?"decline":["accept","acceptForSession","acceptAlways","decline","cancel"].includes(decision)?decision:"decline";
    const outcome=await this.#decide(entry,wanted);
    if(outcome==="taken")return this.#approve(entry);
    if(outcome==="settled"||this.requests.get(entry.key)!==entry)return;
    if(outcome==="missing"&&(wanted==="decline"||wanted==="cancel"))return void this.cancel();
    if(++entry.attempts>=MUSE_ASK_ATTEMPTS)return;
    return this.#askApproval(entry,{askUser:true});
  }
  // Sends the decision for the approval's current stage (approval/decide names its latest requirement), recorded first: Muse can
  // settle the approval before it acknowledges the command (T3 decideApproval). taken: Muse took it; missing: Muse does not offer it;
  // settled: Muse had settled the approval already; refused: Muse refused it.
  async #decide(entry,decision){
    const requirement=entry.params.currentRequirementId,choice=museApprovalChoices(entry.params.availableChoices).get(decision);
    if(!choice)return "missing";
    const stage=requirementKey(requirement);entry.decided=stage;entry.deciding=true;
    try{await this.#command("approval/decide",{sessionId:this.sessionId,approvalId:entry.id,requirementId:requirement,choiceId:choice.choiceId});return "taken"}
    catch(error){
      if(entry.decided===stage)entry.decided=null;
      return error?.kind==="approvalAlreadyResolved"||error?.kind==="approvalNotFound"?"settled":"refused";
    }finally{entry.deciding=false}
  }

  // A question (T3 publishRequest): asked once in Trebell's question dialog however many copies of it come, and withdrawn when Muse
  // settles it (userInput/settled).
  #questionEvent(method,params){
    const id=text(params.userInputId);if(!id)return;
    const key="question:"+id;
    if(method==="userInput/settled")return this.#settleRequest(key);
    if(this.settledRequests.has(key)||this.requests.has(key))return;
    const entry={key,kind:"question",id,params:{...params},child:false,ask:null,attempts:0};
    this.requests.set(key,entry);void this.#askQuestion(entry);
  }
  // The answers go back as userInput/answer (T3 respondToRuntimeRequest), a dialog the person closes as userInput/cancel. An answer
  // Muse would refuse, or refuses, is asked again saying what it lacked, a few times at most.
  async #askQuestion(entry,notes={}){
    const params=entry.params,questions=museQuestions(params.questions,notes);
    if(!questions.length||typeof this.onQuestion!=="function")return this.#cancelQuestion(entry,questions.length?"Trebell Code had no window to ask the user in. Continue without the answer.":"The question had nothing to ask.");
    const ask=new AbortController();entry.ask=ask;
    let answers=null;
    try{answers=await this.onQuestion({toolName:text(params.toolName)||"request_user_input",input:{questions},signal:ask.signal})}catch{answers=null}
    finally{if(entry.ask===ask)entry.ask=null}
    if(ask.signal.aborted||this.requests.get(entry.key)!==entry)return;
    if(!answers||typeof answers!=="object"||!Object.keys(answers).length)return this.#cancelQuestion(entry,"The user closed the question without answering. Continue without the answer.");
    const built=museUserInputAnswers(params.questions,answers);
    if(built.error)return ++entry.attempts>=MUSE_ASK_ATTEMPTS?this.#cancelQuestion(entry,`The user's answer could not be sent: ${built.error.message} Continue without the answer.`):this.#askQuestion(entry,{[built.error.questionId]:built.error.message});
    try{await this.#command("userInput/answer",{sessionId:this.sessionId,userInputId:entry.id,answers:built.answers})}
    catch(error){
      if(this.dead||this.requests.get(entry.key)!==entry||error?.kind==="userInputAlreadySettled"||error?.kind==="userInputNotFound"||++entry.attempts>=MUSE_ASK_ATTEMPTS)return;
      return this.#askQuestion(entry,{[questions[0].id]:text(error?.cause?.message||error?.message)});
    }
  }
  async #cancelQuestion(entry,reason){
    if(this.requests.get(entry.key)!==entry)return;
    await this.#command("userInput/cancel",{sessionId:this.sessionId,userInputId:entry.id,reason}).catch(()=>{});
  }
  // Muse settled an approval (approval/resolved: the person's answer, its reviewer's or its policy's) or a question
  // (userInput/settled): its card or dialog goes, and a late copy of it is not asked again.
  #settleRequest(key){
    this.settledRequests.add(key);if(this.settledRequests.size>MUSE_SETTLED_LIMIT)this.settledRequests.delete(this.settledRequests.values().next().value);
    const entry=this.requests.get(key);if(!entry)return;
    this.requests.delete(key);entry.ask?.abort();
  }
  #withdrawRequests(which=()=>true){
    for(const entry of [...this.requests.values()])if(which(entry)){this.requests.delete(entry.key);entry.ask?.abort()}
  }

  #notification(frame){
    const method=text(frame?.method),params=frame?.params;
    if(!params||typeof params!=="object")return;
    // usage/changed is the account's, and names no session (T3).
    if(method==="usage/changed")return void this.#usageChanged(params);
    if(params.sessionId!==this.sessionId)return;
    // A gap in what Muse delivered: this host's account of the conversation can no longer be trusted (T3 view/gap).
    if(method==="view/gap")return void this.#lose(MUSE_VIEW_GAP_MESSAGE,{stop:true});
    if(method==="approval/requested"||method==="approval/updated"||method==="approval/resolved")return void this.#approvalEvent(method,params);
    if(method==="userInput/requested"||method==="userInput/settled")return void this.#questionEvent(method,params);
    const turn=this.activePrompt;if(!turn||turn.settled)return;
    if(method==="item/started"||method==="item/updated"||method==="item/completed")return this.#item(turn,params.item);
    if(method==="item/delta")return this.#delta(turn,params);
    if(method==="turn/retryScheduled"&&(!params.turnId||params.turnId===turn.turnId))return void this.#retryScheduled(params);
    if(method==="turn/completed"&&params.turnId===turn.turnId)return this.#completed(turn,params);
  }
  // The latest usage report a quota stop reads its reset from.
  #usageChanged(params){
    const usage=museSubscriptionUsage(params);
    if(usage)this.subscriptionUsage=usage;else this.#skipped("usage/changed","it names no readable usage windows");
  }
  // Muse retrying the turn's model request: the turn's retry row, as Native's wait for the network shows, and the turn goes on.
  #retryScheduled(params){
    const message=museRetryNotice(params);
    if(message)this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"runtime_error",willRetry:true,message}});
    else this.#skipped("turn/retryScheduled","it names no readable attempt, delay or reason");
  }
  // An informational notice Trebell cannot read is skipped with a log line, and the session goes on (T3 INFORMATIONAL_NOTIFICATIONS).
  #skipped(method,reason){this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:"protocol_warning",dropped:true,method,reason,message:`Trebell skipped Muse Code's ${method}: ${reason}.`}})}

  // Items keep their highest revision: an older one arriving late is ignored. Items of other turns are not this turn's.
  #item(turn,item){
    if(!item||typeof item!=="object"||!item.itemId)return;
    if(item.turnId&&item.turnId!==turn.turnId)return;
    const previous=turn.items.get(item.itemId);
    if(previous&&Number(previous.revision)>=Number(item.revision))return;
    const current={...item,...(Array.isArray(item.summary)?{summary:[...item.summary]}:{})};
    turn.items.set(item.itemId,current);this.#publish(turn,current);
  }
  // Deltas append to an open item by field: text to a reply, summary.N to part N of a reasoning summary, output to a command.
  #delta(turn,params){
    const item=turn.items.get(text(params.itemId));if(!item||item.status!=="inProgress")return;
    const field=text(params.field)||"text",delta=text(params.delta);if(!delta)return;
    if(field==="text")item.text=text(item.text)+delta;
    else if(field==="output"||field==="visibleOutput")item.visibleOutput=text(item.visibleOutput)+delta;
    else if(/^summary\.\d+$/.test(field)){const index=Number(field.slice(8));if(index>=100)return;const summary=[...(item.summary||[])];summary[index]=text(summary[index])+delta;item.summary=summary}
    else return;
    this.#publish(turn,item);
  }
  #publish(turn,item){
    if(SKIPPED_KINDS.has(item.kind))return;
    if(item.kind==="toolCall"&&OWN_ROW_TOOLS.has(item.tool)&&museToolStatus(item)!=="failed")return;
    if(item.kind==="agentMessage")return this.#stream(turn,item,"agent_message_chunk",text(item.text));
    // A reasoning item's summary parts, or the provider's own reasoning text where it sends that instead.
    if(item.kind==="reasoning")return this.#stream(turn,item,"agent_thought_chunk",(Array.isArray(item.summary)?item.summary:[]).map(text).filter(Boolean).join("\n\n")||text(item.text));
    const first=!turn.tools.has(item.itemId);turn.tools.add(item.itemId);
    this.onUpdate?.({sessionId:this.sessionId,update:{...acpToolFrame(museToolUpdate(item)),sessionUpdate:first?"tool_call":"tool_call_update"}});
  }
  // The text an item has that has not been sent yet: what a delta added, or on item/completed what the final text has beyond what
  // streamed. A later reply of the turn starts a paragraph of its own.
  #stream(turn,item,type,full){
    const sent=turn.sent.get(item.itemId)||"";
    if(sent&&!full.startsWith(sent))return;
    const chunk=full.slice(sent.length);if(!chunk)return;
    turn.sent.set(item.itemId,full);
    let value=chunk;
    if(type==="agent_message_chunk"){if(!sent&&turn.lastMessage&&turn.lastMessage!==item.itemId&&!/^\s*\n/.test(chunk))value="\n\n"+chunk;turn.lastMessage=item.itemId}
    this.onUpdate?.({sessionId:this.sessionId,update:{sessionUpdate:type,content:{type:"text",text:value},messageId:item.itemId}});
  }
  // turn/completed settles the prompt: completed ends the turn, cancelled is a stop (interrupted when the person asked for it), and
  // failed fails it with Muse's own error. A stop the subscription quota made says the Muse Code usage limit was reached and when it
  // resets (usageLimit, resetAt), as Claude Code's and Grok's limits do, Muse's own words kept as its detail; a turn Muse could not
  // run signed out says how to sign in.
  #completed(turn,params){
    const terminal=text(params.terminal);
    if(terminal==="completed")return turn.settle({stopReason:"end_turn",providerMessageId:null,raw:params});
    if(terminal==="cancelled")return turn.settle({stopReason:"cancelled",interrupted:turn.stopRequested,providerMessageId:null,raw:params});
    const error=params.error&&typeof params.error==="object"?params.error:{},detail=text(error.message)||text(params.reason),code=text(error.kind)||"MUSE_TURN_FAILED";
    if(museUsageLimited(error,detail)){
      const resetAt=museUsageLimitResetAt(this.subscriptionUsage,Date.now(),{quota:error.quota,message:detail});
      return turn.fail(Object.assign(new Error(museUsageLimitMessage(resetAt)),{code,usageLimit:true,resetAt,detail,raw:params}));
    }
    if(code==="authRequired")return turn.fail(Object.assign(new Error(MUSE_SIGNED_OUT_MESSAGE),{code,detail,raw:params}));
    turn.fail(Object.assign(new Error(detail||"Muse Code could not finish the turn."),{code,raw:params}));
  }
}
