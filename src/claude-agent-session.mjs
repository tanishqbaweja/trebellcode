import { randomUUID } from "node:crypto";
import { deleteSession, forkSession, getSessionInfo, getSessionMessages, query, renameSession } from "@anthropic-ai/claude-agent-sdk";
import { claudeCapabilities, claudeModelCatalog } from "./claude-capabilities.mjs";
import { fileUriPath } from "./file-uri.mjs";
import { normalizePermissionMode, permissionDisposition } from "./permission-policy.mjs";
import { runtimeInstructions } from "./runtime-instructions.mjs";
import { resolveWindowsCommandShim } from "./windows-command-shim.mjs";

// One long-lived streaming-input Claude Code query per thread, as T3 Code's ClaudeAdapterV2 runs it: every prompt is an SDK
// user message offered to the live process (so steering, interrupts and background tasks work), and the process is replaced
// only when its launch policy (permission mode, tools, model, effort, agent) changes, after Stop, rewind or idle release.
export const CLAUDE_READ_ONLY_TOOLS=Object.freeze(["Read","Glob","Grep"]);
export const CLAUDE_IDLE_RELEASE_MS=30*60_000;
export const CLAUDE_MAX_IDLE_PIN_MS=4*60*60_000;
export const CLAUDE_PLAN_CAPTURED="The client captured your proposed plan. Stop here and wait for the user's feedback or implementation request in a later turn.";
export const CLAUDE_BACKGROUND_WORK_BLOCKS_CHANGE="Claude is still running background agents or commands, and this model or setting change would end them. Wait for them to finish (or ask Claude to stop them), or keep the current model and settings, then send the message again.";
export const CLAUDE_USAGE_LIMIT_HINT="Claude usage limit reached. Send the message again once the limit resets.";
const CLAUDE_EFFORTS=new Set(["low","medium","high","xhigh","max"]);
const CLAUDE_IMAGE_TYPES=new Set(["image/gif","image/jpeg","image/png","image/webp"]);
const CLAUDE_INTERRUPT_TIMEOUT_MS=10_000;
const CLAUDE_CLOSE_TIMEOUT_MS=5_000;
const CLAUDE_USAGE_LIMIT_WINDOWS=Object.freeze({five_hour:"5-hour",seven_day:"7-day",seven_day_opus:"7-day Opus",seven_day_sonnet:"7-day Sonnet",seven_day_overage_included:"7-day model",overage:"overage"});
// API errors Claude Code does not retry, whose own error message names the problem (an unknown model, a bad request, an
// account or billing issue): that message is the turn's error, not "Claude gave up after repeated API errors."
const CLAUDE_EXPLAINED_API_ERRORS=new Set(["invalid_request","model_not_found","billing_error","oauth_org_not_allowed","account_on_hold","verification_required","cloud_credential_error"]);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sdkPermissionMode(mode,collaborationMode="default"){
  if(collaborationMode==="plan")return "plan";
  if(mode==="full")return "bypassPermissions";
  if(mode==="auto")return "auto";
  if(mode==="edits")return "acceptEdits";
  if(mode==="read-only")return "dontAsk";
  return "default";
}

// The launch policy as T3 Code's claudeRuntimeQueryPolicyForRuntimePolicy builds it: read-only offers only the read tools
// (and pre-approves them, so dontAsk denies everything else without asking).
export function claudeQueryPolicy(mode,collaborationMode="default"){
  const permissionMode=sdkPermissionMode(mode,collaborationMode),readOnly=mode==="read-only";
  return {
    permissionMode,
    tools:readOnly?[...CLAUDE_READ_ONLY_TOOLS]:{type:"preset",preset:"claude_code"},
    ...(readOnly?{allowedTools:[...CLAUDE_READ_ONLY_TOOLS]}:{}),
    ...(permissionMode==="bypassPermissions"?{allowDangerouslySkipPermissions:true}:{}),
  };
}

function sdkModel(model){const value=String(model||"").trim();return value&&value!=="default"?value:undefined}
function readOnlyTool(name){return new Set(["Read","Glob","Grep","WebSearch","WebFetch","LS","TodoRead"]).has(String(name))}
function editTool(name){return new Set(["Edit","Write","MultiEdit","NotebookEdit","TodoWrite"]).has(String(name))}
function toolKind(name){
  const value=String(name||"").toLowerCase();
  if(["read","glob","grep","ls"].some(x=>value.includes(x)))return "read";
  if(["edit","write","notebook"].some(x=>value.includes(x)))return "edit";
  if(["bash","shell","powershell"].some(x=>value.includes(x)))return "execute";
  if(value.includes("web")||value.includes("fetch"))return "fetch";
  return "other";
}
function toolTitle(block){return toolKind(block?.name)==="execute"&&typeof block?.input?.command==="string"&&block.input.command.trim()?block.input.command:String(block?.name||"Tool")}
function toolResultText(content){
  if(typeof content==="string")return content;
  if(Array.isArray(content))return content.map(item=>item?.type==="text"?String(item.text||""):"").filter(Boolean).join("\n");
  return content==null?"":JSON.stringify(content);
}
function usageTotal(usage={}){
  return Number(usage.input_tokens||0)+Number(usage.cache_creation_input_tokens||0)+Number(usage.cache_read_input_tokens||0)+Number(usage.output_tokens||0);
}
function echoedUuids(message){
  if(Array.isArray(message?.user_message_uuids))return message.user_message_uuids.filter(value=>typeof value==="string");
  return typeof message?.user_message_uuid==="string"?[message.user_message_uuid]:[];
}
function isAbortResult(result){return result?.terminal_reason==="aborted_streaming"||result?.terminal_reason==="aborted_tools"}
function withTimeout(promise,ms){
  let timer;
  return Promise.race([Promise.resolve(promise),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error("timed out")),ms);timer.unref?.()})]).finally(()=>clearTimeout(timer));
}
// Resolves with abortedValue once the SDK aborts the tool request (Stop), instead of waiting on a prompt nobody will answer.
function untilAborted(promise,signal,abortedValue){
  if(!signal)return Promise.resolve(promise);
  if(signal.aborted)return Promise.resolve(abortedValue);
  return new Promise((resolve,reject)=>{
    const onAbort=()=>resolve(abortedValue);
    signal.addEventListener("abort",onAbort,{once:true});
    Promise.resolve(promise).then(value=>{signal.removeEventListener("abort",onAbort);resolve(value)},error=>{signal.removeEventListener("abort",onAbort);reject(error)});
  });
}

class MessageQueue{
  constructor(){this.items=[];this.waiters=[];this.done=false}
  push(item){if(this.done)return false;const waiter=this.waiters.shift();if(waiter)waiter({value:item,done:false});else this.items.push(item);return true}
  end(){this.done=true;for(const waiter of this.waiters.splice(0))waiter({value:undefined,done:true})}
  [Symbol.asyncIterator](){
    return {
      next:()=>this.items.length?Promise.resolve({value:this.items.shift(),done:false}):this.done?Promise.resolve({value:undefined,done:true}):new Promise(resolve=>this.waiters.push(resolve)),
      return:()=>{this.end();return Promise.resolve({value:undefined,done:true})},
    };
  }
}

// SDK user message content: images (png, jpeg, gif and webp only, as T3 Code allows) first, then the text blocks. Claude Code
// expands a slash command or skill only from the last text block, so the user's own text stays last.
export function claudeUserContent(parts=[]){
  const images=[],texts=[],links=[];
  for(const part of Array.isArray(parts)?parts:[]){
    if(part?.type==="image"){
      const mimeType=String(part.mimeType||part.mime_type||"").trim().toLowerCase();
      if(!CLAUDE_IMAGE_TYPES.has(mimeType))throw new Error(`Unsupported Claude image attachment type '${mimeType||"unknown"}'`);
      images.push({type:"image",source:{type:"base64",media_type:mimeType,data:String(part.data||"")}});
    }else if(part?.type==="resource_link")links.push({type:"text",text:`Attached file: ${fileUriPath(part.uri)??String(part.uri||"")}`});
    else if(part?.type==="text"){const text=String(part.text||"");if(text)texts.push({type:"text",text})}
    else if(part)texts.push({type:"text",text:JSON.stringify(part)});
  }
  const last=texts.pop();
  return [...images,...texts,...links,...(last?[last]:[])];
}

// AskUserQuestion answers keyed by question text with string values (multi-select labels joined), as the tool expects.
// Trebell's question form keys answers by question id (q1..qN); no answer at all means the user cancelled.
export function claudeQuestionAnswers(questions=[],answers=null){
  if(!answers||typeof answers!=="object")return null;
  const out={};
  (Array.isArray(questions)?questions:[]).forEach((question,index)=>{
    const text=String(question?.question||"").trim();if(!text)return;
    const raw=answers[String(question?.id||`q${index+1}`)]??answers[text];
    const value=Array.isArray(raw)?raw.filter(item=>typeof item==="string"&&item.trim()).join(", "):typeof raw==="string"?raw:raw==null?"":String(raw);
    if(value.trim())out[text]=value;
  });
  return Object.keys(out).length?out:null;
}

// "Allow for session" as T3 Code's toSessionPermissionUpdates: the CLI's suggestions scoped to this session, or a rule
// allowing the tool when it suggested none.
export function claudeSessionPermissionUpdates(toolName,suggestions){
  const updates=(Array.isArray(suggestions)?suggestions:[]).map(suggestion=>({...suggestion,destination:"session"}));
  return updates.length?updates:[{type:"addRules",rules:[{toolName}],behavior:"allow",destination:"session"}];
}
// The approval prompt as T3 Code's ClaudeAdapter builds it: the CLI's own prompt sentence, else the tool with its command, path
// or input, so the person sees what they approve.
export function claudePermissionPrompt(toolName,input,options={}){
  const own=[options?.title,options?.description,options?.decisionReason].find(value=>typeof value==="string"&&value.trim())?.trim()||null;
  const name=String(toolName||"Tool"),field=keys=>{for(const key of keys){const value=input?.[key];if(typeof value==="string"&&value.trim())return value.trim()}return null};
  const target=field(["command","cmd","script"])??field(["file_path","path","filename","fileName"]);
  // The command or path itself is always shown (T3 summarizeClaudeToolRequest): Claude Code's sentence for a shell command can be
  // the model's own description of it ("Run node one-liner printing trebell-tour"), which follows it when it adds something.
  if(target!=null){
    const action=`${name}: ${target.slice(0,400)}`;
    return !own?action:own.includes(target)?own:`${action} — ${own}`;
  }
  if(own)return own;
  let serialized="";try{serialized=JSON.stringify(input??{})??""}catch{serialized=""}
  return serialized.length<=400?`${name}: ${serialized}`:`${name}: ${serialized.slice(0,397)}...`;
}
function permissionRuleText(rule){
  const name=String(rule?.toolName||"").trim();if(!name)return null;
  const content=typeof rule?.ruleContent==="string"?rule.ruleContent:"";
  return content?`${name}(${content})`:name;
}

function formatWait(ms){
  const total=Math.ceil(ms/60_000),hours=Math.floor(total/60),minutes=total%60;
  return hours===0?`${total}m`:minutes===0?`${hours}h`:`${hours}h ${minutes}m`;
}
export function describeClaudeUsageLimit(info={},nowMs=Date.now()){
  const label=CLAUDE_USAGE_LIMIT_WINDOWS[info?.rateLimitType]||null;
  const resetsAt=Number(info?.resetsAt),waitMs=Number.isFinite(resetsAt)&&resetsAt>0?resetsAt*1000-nowMs:NaN;
  const wait=waitMs>0&&waitMs<=30*24*60*60_000?formatWait(waitMs):null;
  return `Claude usage limit reached. This turn is paused until the ${label?label+" ":""}limit resets${wait?` in ${wait}`:""}.`;
}

export function claudeSignedOutMessage(configDir=""){
  const home=String(configDir||"").trim();
  return `Claude Code could not authenticate. Run \`claude auth login\`${home?` with CLAUDE_CONFIG_DIR set to "${home}"`:""}, then send the message again. For API-key authentication, check this profile's configured credentials.`;
}

function terminalResultError(reason,failureHint){
  switch(reason){
    case "api_error":return failureHint||"Claude gave up after repeated API errors.";
    case "malformed_tool_use_exhausted":return "Claude gave up after repeated malformed tool calls.";
    case "budget_exhausted":return "Claude stopped: the turn's token budget was exhausted.";
    case "structured_output_retry_exhausted":return "Claude could not produce the requested structured output.";
    case "tool_deferred_unavailable":return "Claude could not resume a deferred tool call: the tool is no longer available.";
    case "turn_setup_failed":return "Claude could not start the turn.";
    case "blocking_limit":return "Claude stopped: a usage limit blocked the request.";
    case "rapid_refill_breaker":return "Claude stopped: the context refilled too quickly after compaction.";
    case "prompt_too_long":return "Claude stopped: the prompt exceeds the model's context window.";
    case "image_error":return "Claude stopped: an image in the conversation could not be processed.";
    case "model_error":return "Claude stopped: the model returned an error.";
    default:return null;
  }
}
// The text of an assistant error frame that explains its own failure (see CLAUDE_EXPLAINED_API_ERRORS), or null.
export function claudeExplainedApiError(message){
  if(!CLAUDE_EXPLAINED_API_ERRORS.has(message?.error))return null;
  const blocks=Array.isArray(message.message?.content)?message.message.content:[];
  return blocks.map(block=>block?.type==="text"?String(block.text||"").trim():"").filter(Boolean).join("\n")||null;
}
// "[ede_diagnostic] ..." entries are CLI-internal telemetry and never the error to show.
function userFacingErrors(result){return (Array.isArray(result?.errors)?result.errors:[]).filter(error=>typeof error==="string"&&error.trim()&&!error.startsWith("[ede_diagnostic]"))}

// The user-facing failure of a result, or null when the turn succeeded (T3 Code's providerFailureFromResult).
export function claudeResultFailure(result,{failureHint=null}={}){
  if(!result)return null;
  const success=result.subtype==="success";
  const listed=success&&!result.is_error?null:userFacingErrors(result)[0]||null;
  const structured=success&&result.api_error_status===529?"Claude API is overloaded (529). Try again shortly."
    :success&&result.api_error_status===429?"Claude API rate limit reached. Try again later."
    :terminalResultError(result.terminal_reason,failureHint);
  if(!success)return listed||structured||`Claude Code turn failed: ${result.subtype||"unknown error"}`;
  if(!result.is_error&&!structured)return null;
  return listed||structured||failureHint||String(result.result||"").trim()||"Claude Code turn failed.";
}

// A turn that ended without an error message of its own reads as interrupted or cancelled from its listed errors (T3 Code's
// terminalStatusFromResult).
function isStoppedResult(result){
  if(!result||result.subtype==="success")return false;
  const text=(Array.isArray(result.errors)?result.errors:[]).join("\n").toLowerCase();
  return text.includes("interrupt")||text.includes("cancel");
}
// Inventory sources, weakest first: the machine-wide capability probe, the probe of this thread's folder, the live query.
const INVENTORY_MACHINE=1,INVENTORY_WORKSPACE=2,INVENTORY_LIVE=3;

export class ClaudeAgentSession{
  // Each rewind's pending fork, mapped to the conversation it left (restored when Claude Code rejects the fork).
  #rewindOrigins;
  constructor({command="claude",cwd=process.cwd(),env=process.env,permissionMode:mode="supervised",onUpdate,onPermission,onQuestion,onWakeTurn=null,version="0.0.0",spawnProcess=null,capabilityScope="",autoCompactWindow=null,forkFromSessionId=null,resumeSessionAt=null,persistedTurns=null,mcpServers={},sdk=null,capabilities=undefined,idleReleaseMs=CLAUDE_IDLE_RELEASE_MS}={}){
    this.command=command;this.cwd=cwd;this.env=env;this.permissionMode=normalizePermissionMode(mode);this.onUpdate=onUpdate;this.onPermission=onPermission;this.onQuestion=onQuestion;this.onWakeTurn=onWakeTurn;this.version=version;this.spawnProcess=spawnProcess;
    // Remote environments share one executable name and Claude home, so their capability probes are kept apart by environment.
    this.capabilityScope=spawnProcess?String(capabilityScope||""):"";
    this.autoCompactWindow=Number.isInteger(Number(autoCompactWindow))&&Number(autoCompactWindow)>=100_000&&Number(autoCompactWindow)<=1_000_000?Number(autoCompactWindow):null;
    this.mcpServers=mcpServers&&typeof mcpServers==="object"?{...mcpServers}:{};
    this.sdk=sdk||{query,getSessionInfo,forkSession,renameSession,getSessionMessages,deleteSession};
    // The shared capability cache probes the real CLI; an injected SDK (tests) brings its own or none.
    this.capabilities=capabilities!==undefined?capabilities:(sdk?null:claudeCapabilities);
    this.idleReleaseMs=Math.max(1,Number(idleReleaseMs)||CLAUDE_IDLE_RELEASE_MS);
    this.helperSharesRuntime=!this.spawnProcess&&String(this.env.CLAUDE_CONFIG_DIR||"")===String(process.env.CLAUDE_CONFIG_DIR||"");
    this.sessionId=null;this.model=null;this.reasoningEffort=null;this.serviceTier=null;this.collaborationMode="default";this.agent=null;
    this.closed=false;this.startedOnce=false;this.persistedTurns=persistedTurns;this.promptOpening=false;
    // A fork or rewind that has not run yet: the first query resumes the source at the cursor into this session's new id.
    this.pendingFork=forkFromSessionId?{sourceSessionId:forkFromSessionId,targetSessionId:null,resumeSessionAt:resumeSessionAt||null}:null;
    this.live=null;this.turn=null;this.idleTimer=null;this.tools=new Map();
    this.sessionAllowRules=new Set();this.additionalDirectories=new Set();this.inventory={};this.inventoryRank=0;this.#rewindOrigins=new WeakMap();
    this.initializeResult={agentCapabilities:{loadSession:true,sessionCapabilities:{fork:{},resume:{},close:{}}},agentInfo:{name:"Claude Code"}};
    this.sessionSetup=null;
  }

  async start({providerSessionId=null,model=null}={}){
    this.sessionId=providerSessionId||randomUUID();
    this.model=model||null;
    if(this.pendingFork){this.pendingFork.targetSessionId=this.sessionId;this.startedOnce=false}
    else if(providerSessionId){
      // A thread whose first prompt never ran (for example, started before a restart) has no transcript yet: its first
      // query creates the session under this id instead of resuming it. A thread with turns Claude recorded always resumes
      // (T3 Code resumes whenever the native thread has turns): were its transcript gone (Claude Code's cleanup removes old
      // ones), a fresh session would carry on silently without the conversation the thread shows; resuming fails the turn with
      // Claude's error instead.
      this.startedOnce=this.helperSharesRuntime
        ?this.persistedTurns===true||Boolean(await this.sdk.getSessionInfo(providerSessionId,{dir:this.cwd}).catch(()=>undefined))
        :this.persistedTurns!==false;
    }
    // Slash commands and agents are known before the first message (T3 Code's capability probe): the machine-wide probe the
    // model list already ran is shown at once, and this folder's own probe (project commands and agents) replaces it.
    const workspace=this.capabilities?.peek?.(this.#probeInput())||null;
    const machine=workspace?null:this.capabilities?.peek?.(this.#probeInput(null),{maxAgeMs:Infinity})||null;
    const catalog=claudeModelCatalog(workspace||machine);
    this.sessionSetup={sessionId:this.sessionId,models:{currentModelId:this.model,availableModels:catalog.metadata.map(row=>({modelId:row.id,name:row.name}))},configOptions:[],modes:{currentModeId:sdkPermissionMode(this.permissionMode,this.collaborationMode),availableModes:[]}};
    if(workspace)this.#publishProbe(workspace,INVENTORY_WORKSPACE);
    else{
      if(machine)this.#publishProbe(machine,INVENTORY_MACHINE);
      this.#loadInventory();
    }
    return {initialize:this.initializeResult,session:this.sessionSetup};
  }

  async prompt(parts,{messageId=null,agent=null}={}){
    if(this.closed)throw new Error("Claude session is closed");
    // A prompt still opening its query counts as running, so two prompts never share one turn.
    if(this.promptOpening||(this.turn&&!this.turn.settled))throw new Error("Claude Code is still running a turn. Stop it or wait for it to finish first.");
    const content=claudeUserContent(parts);
    this.promptOpening=true;
    try{
      this.agent=agent||null;
      const live=await this.#ensureLive();
      // Fresh for every offer: Claude acknowledges a prompt whose uuid its transcript already holds without running a turn.
      const promptUuid=UUID.test(String(messageId||""))?String(messageId):randomUUID();
      const turn=this.#newTurn({promptUuid,live});
      this.turn=turn;clearTimeout(this.idleTimer);
      live.input.push({type:"user",message:{role:"user",content},parent_tool_use_id:null,uuid:promptUuid});
      return turn.promise;
    }finally{this.promptOpening=false}
  }

  // Mid-turn input: a "now" priority user message the running turn takes up at once.
  async steer(parts){
    const turn=this.turn&&!this.turn.settled?this.turn:null,live=turn?.live;
    if(!turn||!live||live.closed)throw new Error("Claude Code has no running turn to steer.");
    const uuid=randomUUID();
    turn.uuids.add(uuid);turn.steered=true;
    live.input.push({type:"user",message:{role:"user",content:claudeUserContent(parts)},parent_tool_use_id:null,priority:"now",uuid});
    return {accepted:true,pending:0};
  }

  async setModel(model){this.model=model||null;return {modelId:this.model}}
  setPermissionMode(mode){this.permissionMode=normalizePermissionMode(mode);return this.permissionMode}
  setReasoningEffort(effort){const value=String(effort||"").trim().toLowerCase();this.reasoningEffort=CLAUDE_EFFORTS.has(value)?value:null;return this.reasoningEffort}
  setServiceTier(tier){this.serviceTier=String(tier||"").trim().toLowerCase()==="fast"?"fast":null;return this.serviceTier}
  setCollaborationMode(mode){this.collaborationMode=mode==="plan"?"plan":"default";return this.collaborationMode}

  // Stop, as T3 Code's interruptTurn: interrupt the running turn, then end the process (and with it any background work).
  async cancel(){
    const turn=this.turn&&!this.turn.settled?this.turn:null,live=this.live;
    if(turn)turn.cancelRequested=true;
    if(turn&&live&&!live.closed)await withTimeout(live.query.interrupt(),CLAUDE_INTERRUPT_TIMEOUT_MS).catch(()=>{});
    await this.#closeLive(live);
    if(turn&&!turn.settled)this.#finishTurn(turn);
  }
  async compact(){return this.prompt([{type:"text",text:"/compact"}])}
  async fork({upToMessageId=null}={}){
    const targetSessionId=randomUUID(),sourceSessionId=this.pendingFork?.sourceSessionId||this.sessionId;
    // A thread whose first prompt never ran has no transcript to copy: the fork starts its own conversation.
    if(!this.pendingFork&&!this.startedOnce)return {sessionId:targetSessionId,lazyFork:null};
    return {sessionId:targetSessionId,lazyFork:{sourceSessionId,targetSessionId,resumeSessionAt:upToMessageId||this.pendingFork?.resumeSessionAt||null}};
  }
  #requireHostSessionHelper(operation){
    if(!this.helperSharesRuntime)throw new Error(`Claude ${operation} is unavailable through the host session helper for this custom or remote Claude home.`);
  }
  async rename(name){this.#requireHostSessionHelper("rename");return this.sdk.renameSession(this.sessionId,name,{dir:this.cwd})}
  async history(){this.#requireHostSessionHelper("history");return this.sdk.getSessionMessages(this.sessionId,{dir:this.cwd,includeSystemMessages:false})}
  // Edit from here: the next query resumes the conversation at the kept turn's last assistant message into a new session id
  // (resumeSessionAt only); with no kept turn the thread starts a fresh session, as T3 Code's rollback to thread start does.
  async rewindConversation(upToMessageId){
    if(this.turn&&!this.turn.settled)throw new Error("Stop the running Claude Code turn before rewinding this thread.");
    await this.#closeLive();
    const previous={sessionId:this.sessionId,startedOnce:this.startedOnce,pendingFork:this.pendingFork};
    const sourceSessionId=this.pendingFork?.sourceSessionId||this.sessionId,targetSessionId=randomUUID();
    this.sessionId=targetSessionId;this.startedOnce=false;
    if(!upToMessageId){this.pendingFork=null;return {sessionId:targetSessionId,lazyFork:null}}
    this.pendingFork={sourceSessionId,targetSessionId,resumeSessionAt:upToMessageId};
    this.#rewindOrigins.set(this.pendingFork,previous);
    return {sessionId:targetSessionId,lazyFork:{...this.pendingFork}};
  }
  async close(){
    if(this.closed)return;this.closed=true;clearTimeout(this.idleTimer);
    const turn=this.turn&&!this.turn.settled?this.turn:null;if(turn)turn.cancelRequested=true;
    await this.#closeLive();
    if(turn&&!turn.settled)this.#finishTurn(turn);
  }
  async delete(){await this.close();this.#requireHostSessionHelper("delete");return this.sdk.deleteSession(this.sessionId,{dir:this.cwd})}

  #emit(update){this.onUpdate?.({sessionId:this.sessionId,update})}
  #probeInput(cwd=this.cwd){return {command:this.command,cwd,env:this.env,spawnProcess:this.spawnProcess,scope:this.capabilityScope}}
  #loadInventory(){
    // This folder's commands and agents only: plan usage is the model list's machine-wide probe's to read.
    const pending=this.capabilities?.load?.({...this.#probeInput(),includeUsage:false});
    pending?.then(probe=>this.#publishProbe(probe,INVENTORY_WORKSPACE),()=>{});
  }
  // A weaker source never replaces what a stronger one already published.
  #publishProbe(probe,rank){
    if(!probe||this.closed||rank<this.inventoryRank)return;
    this.inventoryRank=rank;
    this.#publishInventory({commands:probe.commands,agents:probe.agents,models:probe.models});
  }
  // The latest commands, agents, models and session facts, sent whole so the stored inventory is never replaced by a part.
  #publishInventory(patch={},extra={}){
    const next={...this.inventory};
    for(const [key,value] of Object.entries(patch))if(value!==undefined&&value!==null)next[key]=value;
    this.inventory=next;
    this.#emit({sessionUpdate:"session_info_update",...next,...extra});
  }

  #queryKey(){
    return JSON.stringify({
      ...claudeQueryPolicy(this.permissionMode,this.collaborationMode),
      model:sdkModel(this.model)||null,effort:this.reasoningEffort,fast:this.serviceTier==="fast",agent:this.agent||null,
      sessionId:this.sessionId,fork:this.pendingFork?.resumeSessionAt||null,
    });
  }
  async #ensureLive(){
    const key=this.#queryKey(),live=this.live;
    if(live&&!live.closed&&live.key===key){
      // Claude can switch its own mode (EnterPlanMode, a denied ExitPlanMode): put the process back in the thread's mode.
      if(live.permissionMode===live.openedPermissionMode)return live;
      try{await live.query.setPermissionMode(live.openedPermissionMode);live.permissionMode=live.openedPermissionMode;return live}
      catch{await this.#closeLive(live)}
    }else if(live&&!live.closed){
      // Background agents and shells run inside the CLI process: a new launch policy would end them.
      if(live.backgroundTasks.size)throw new Error(CLAUDE_BACKGROUND_WORK_BLOCKS_CHANGE);
      await this.#closeLive(live);
    }
    return this.#openLive(this.#queryKey());
  }
  #openLive(key){
    const input=new MessageQueue(),policy=claudeQueryPolicy(this.permissionMode,this.collaborationMode),fork=this.pendingFork;
    const allowRules=[...this.sessionAllowRules],directories=[...this.additionalDirectories];
    const settings={
      showThinkingSummaries:true,
      ...(this.serviceTier==="fast"?{fastMode:true}:{}),
      ...(this.autoCompactWindow?{autoCompactWindow:this.autoCompactWindow}:{}),
      ...(allowRules.length?{permissions:{allow:allowRules}}:{}),
    };
    const options={
      cwd:this.cwd,
      ...(sdkModel(this.model)?{model:sdkModel(this.model)}:{}),
      // A Windows .cmd shim cannot be spawned directly; the SDK runs a native binary or a .js entry itself.
      pathToClaudeCodeExecutable:this.spawnProcess?this.command:resolveWindowsCommandShim(this.command,{allowScripts:true}),
      env:{...this.env,CLAUDE_AGENT_SDK_CLIENT_APP:`trebell-code/${this.version}`},
      ...policy,
      canUseTool:(toolName,toolInput,toolOptions)=>this.#canUseTool(toolName,toolInput,toolOptions),
      enableFileCheckpointing:true,
      settingSources:["user","project","local"],
      systemPrompt:{type:"preset",preset:"claude_code",append:runtimeInstructions({harness:"Claude Code"})},
      mcpServers:this.mcpServers,
      ...(this.agent?{agent:this.agent}:{}),
      ...(this.reasoningEffort?{effort:this.reasoningEffort}:{}),
      thinking:{type:"adaptive",display:"summarized"},
      settings,
      ...(directories.length?{additionalDirectories:directories}:{}),
      includePartialMessages:true,
      ...(this.spawnProcess?{spawnClaudeCodeProcess:this.spawnProcess}:{}),
      ...(fork
        ?{resume:fork.sourceSessionId,forkSession:true,sessionId:this.sessionId,...(fork.resumeSessionAt?{resumeSessionAt:fork.resumeSessionAt}:{})}
        :this.startedOnce?{resume:this.sessionId}:{sessionId:this.sessionId}),
    };
    const runtime=this.sdk.query({prompt:input,options});
    const live={query:runtime,input,key,fork,closed:false,sawInit:false,echoes:false,costBase:0,backgroundTasks:new Map(),permissionMode:policy.permissionMode,openedPermissionMode:policy.permissionMode,pump:null};
    this.live=live;
    live.pump=this.#pump(live);
    Promise.resolve(runtime.initializationResult?.()).then(init=>{
      if(init&&this.live===live)this.#publishProbe(init,INVENTORY_LIVE);
    },()=>{});
    return live;
  }
  async #closeLive(live=this.live){
    if(!live)return;
    if(this.live===live)this.live=null;
    if(!live.closed){live.closed=true;live.input.end();try{live.query.close()}catch{}}
    await withTimeout(live.pump,CLAUDE_CLOSE_TIMEOUT_MS).catch(()=>{});
  }
  // Iterates the Query itself (its return() closes the transport), as T3 Code's claudeQueryMessages does.
  async #pump(live){
    let failure=null;
    try{for await(const message of {[Symbol.asyncIterator]:()=>live.query})this.#handle(live,message)}
    catch(error){failure=error}
    live.closed=true;live.input.end();live.backgroundTasks=new Map();
    if(this.live===live)this.live=null;
    const turn=this.turn;
    if(turn&&turn.live===live&&!turn.settled){turn.queryError=failure;this.#finishTurn(turn)}
  }
  #scheduleIdle(){
    clearTimeout(this.idleTimer);
    const live=this.live;if(!live||live.closed||this.closed)return;
    const since=Date.now();
    const tick=()=>{
      if(this.live!==live||live.closed||(this.turn&&!this.turn.settled))return;
      // Background work pins the process for up to four hours.
      if(live.backgroundTasks.size&&Date.now()-since<CLAUDE_MAX_IDLE_PIN_MS){this.idleTimer=setTimeout(tick,this.idleReleaseMs);this.idleTimer.unref?.();return}
      void this.#closeLive(live);
    };
    this.idleTimer=setTimeout(tick,this.idleReleaseMs);this.idleTimer.unref?.();
  }

  #newTurn({promptUuid=null,live,wake=false}){
    let resolve,reject;const promise=new Promise((res,rej)=>{resolve=res;reject=rej});
    return {
      id:randomUUID(),promptUuid,uuids:new Set(promptUuid?[promptUuid]:[]),live,wake,echoed:!promptUuid,cursor:null,steered:false,cancelRequested:false,
      result:null,queryError:null,cost:0,emittedText:false,separator:false,stream:null,textBlocks:new Map(),thoughtMessages:new Set(),
      authFailure:false,rateLimited:false,apiErrorText:null,rejectedLimits:new Set(),announcedLimits:new Set(),settled:false,promise,resolve,reject,
    };
  }
  // Output Claude produces on its own while no prompt runs (a background task or agent finished): a turn of its own.
  #beginWakeTurn(live){
    const turn=this.#newTurn({live,wake:true});
    this.turn=turn;clearTimeout(this.idleTimer);
    turn.promise.catch(()=>{});
    try{this.onWakeTurn?.(turn.promise)}catch{}
    return turn;
  }
  #finishTurn(turn){
    if(turn.settled)return;
    turn.settled=true;if(this.turn===turn)this.turn=null;
    const result=turn.result,live=turn.live,fork=live?.fork||null;
    const ids={providerMessageId:turn.cursor||turn.promptUuid||null,userMessageId:turn.promptUuid||null};
    const raw=result?{...result,total_cost_usd:turn.cost}:null;
    this.#scheduleIdle();
    // A fork or rewind whose process never started (its cursor or source was not found) is undone: a rewind returns to the
    // conversation it left, a fork of another thread starts its own conversation, and the error carries the fork so the relay
    // can restore the thread.
    if(fork&&!live.sawInit&&!turn.cancelRequested&&this.pendingFork===fork){
      const reason=(result?userFacingErrors(result)[0]:null)||String(turn.queryError?.message||"").replace(/^Claude Code returned an error result:\s*/,"")||"Claude Code could not resume the conversation at that point.";
      const previous=this.#rewindOrigins.get(fork);
      if(previous){this.sessionId=previous.sessionId;this.startedOnce=previous.startedOnce;this.pendingFork=previous.pendingFork}
      else{this.startedOnce=false;this.pendingFork=null}
      return turn.reject(Object.assign(new Error(reason),{code:"CLAUDE_REWIND_REJECTED",claudeFork:{...fork}}));
    }
    if(turn.cancelRequested||isAbortResult(result)||isStoppedResult(result))return turn.resolve({stopReason:"cancelled",...ids,raw});
    // A turn the process started is in the transcript even when it failed: its ids let a later turn be edited.
    const failedIds=live?.sawInit&&turn.echoed?ids:{};
    if(!result){
      const message=String(turn.queryError?.message||"").replace(/^Claude Code returned an error result:\s*/,"");
      return turn.reject(Object.assign(new Error(message||"Claude Code ended without a result message"),failedIds));
    }
    const usageLimited=!turn.authFailure&&(turn.rejectedLimits.size>0||turn.rateLimited)&&(result.subtype!=="success"||result.api_error_status==null||result.api_error_status===429)&&(result.terminal_reason==null||result.terminal_reason==="api_error"||result.terminal_reason==="blocking_limit");
    const failureHint=turn.authFailure?claudeSignedOutMessage(this.helperSharesRuntime?"":this.env.CLAUDE_CONFIG_DIR):usageLimited?CLAUDE_USAGE_LIMIT_HINT:turn.apiErrorText;
    const failure=claudeResultFailure(result,{failureHint});
    if(failure){
      // A process that failed to authenticate keeps its stale credentials: the next prompt starts a fresh one.
      if(turn.authFailure&&live)void this.#closeLive(live);
      return turn.reject(Object.assign(new Error(failure),{raw,...failedIds}));
    }
    if(!turn.emittedText&&result.result)this.#emitText(turn,String(result.result),null);
    return turn.resolve({stopReason:"end_turn",...ids,raw});
  }

  #emitText(turn,text,messageId){
    if(!text)return;
    const value=turn.separator&&turn.emittedText?"\n\n"+text:text;
    turn.separator=false;turn.emittedText=true;
    this.#emit({sessionUpdate:"agent_message_chunk",content:{type:"text",text:value},messageId:messageId||null});
  }
  #emitThought(text,messageId){if(text)this.#emit({sessionUpdate:"agent_thought_chunk",content:{type:"text",text},messageId:messageId||null})}
  #toolUse(block){
    if(!block?.id)return;
    const tool={title:toolTitle(block),kind:toolKind(block.name),rawInput:block.input};
    this.tools.set(block.id,tool);
    this.#emit({sessionUpdate:"tool_call",toolCallId:block.id,...tool,status:"in_progress"});
  }
  #toolResult(block){
    if(!block?.tool_use_id)return;
    const tool=this.tools.get(block.tool_use_id)||{title:"Tool",kind:"other",rawInput:{}};this.tools.delete(block.tool_use_id);
    this.#emit({sessionUpdate:"tool_call_update",toolCallId:block.tool_use_id,...tool,status:block.is_error?"failed":"completed",rawOutput:toolResultText(block.content)});
  }

  #handle(live,message){
    if(!message||typeof message!=="object")return;
    const type=message.type,subtype=message.subtype,root=!message.parent_tool_use_id;
    if(type==="system"&&(subtype==="init"||subtype==="status")&&message.permissionMode)live.permissionMode=message.permissionMode;
    if(type==="system"&&subtype==="init"){
      live.sawInit=true;this.sessionId=message.session_id||this.sessionId;this.startedOnce=true;
      if(live.fork&&this.pendingFork===live.fork){
        this.pendingFork=null;
        // The process now holds the materialized session: later prompts keep using it instead of reopening for the fork.
        live.key=JSON.stringify({...JSON.parse(live.key),sessionId:this.sessionId,fork:null});
        this.#emit({sessionUpdate:"claude_fork_materialized",fork:{...live.fork,targetSessionId:this.sessionId}});
      }
      const objects=list=>Array.isArray(list)&&list.some(item=>item&&typeof item==="object");
      this.#publishInventory({
        model:message.model,tools:message.tools||[],mcpServers:message.mcp_servers||[],capabilities:message.capabilities||[],
        ...(objects(this.inventory.commands)?{}:{commands:message.slash_commands||[]}),
        ...(objects(this.inventory.agents)?{}:{agents:message.agents||[]}),
      });
      return;
    }
    if(type==="system"&&subtype==="status"){this.#publishInventory({},{status:message.status??null,permissionMode:message.permissionMode,compactResult:message.compact_result});return}
    if(type==="system"&&subtype==="commands_changed"){if(Array.isArray(message.commands))this.#publishInventory({commands:message.commands});return}
    if(type==="system"&&subtype==="background_tasks_changed"){this.#backgroundTasks(live,message);return}
    if(type==="rate_limit_event"){this.#rateLimit(message);return}
    if(type==="tool_progress"){
      const id=message.tool_use_id||message.toolUseID||message.uuid,tool=this.tools.get(id);
      this.#emit({sessionUpdate:"tool_call_update",toolCallId:id,title:tool?.title||message.tool_name||"Tool",kind:tool?.kind||toolKind(message.tool_name),status:"in_progress",rawOutput:message});
      return;
    }
    if(!["assistant","stream_event","user","result"].includes(type))return;
    let turn=this.turn&&this.turn.live===live&&!this.turn.settled?this.turn:null;
    if(!turn){
      if(type==="result"||!root)return;
      turn=this.#beginWakeTurn(live);
    }
    // A result that answers another prompt (a turn Claude ran before this one) does not settle this turn.
    if(!turn.echoed){
      const echoed=echoedUuids(message);
      if(echoed.length){
        live.echoes=true;
        if(echoed.some(uuid=>turn.uuids.has(uuid)))turn.echoed=true;
        else if(type==="result"){this.#usage(live,null,message);return}
      }else if(type==="result"&&live.echoes&&message.origin&&message.origin.kind!=="human"){this.#usage(live,null,message);return}
    }
    if(type==="stream_event"){if(root)this.#streamEvent(turn,message.event||{});return}
    if(type==="assistant"){
      const blocks=Array.isArray(message.message?.content)?message.message.content:[];
      if(!root){for(const block of blocks)if(block?.type==="tool_use")this.#toolUse(block);return}
      // A synthetic API-error message: its text is the error the result reports, never an answer.
      if(message.error){
        turn.rateLimited=message.error==="rate_limit";if(message.error==="authentication_failed")turn.authFailure=true;
        turn.apiErrorText=claudeExplainedApiError(message);
        return;
      }
      turn.rateLimited=false;turn.apiErrorText=null;
      if(message.uuid)turn.cursor=message.uuid;
      const messageId=message.message?.id||null;
      for(const block of blocks){
        if(block?.type==="text"&&block.text)this.#snapshotText(turn,messageId,block.text,message.uuid);
        else if(block?.type==="thinking"&&block.thinking&&!turn.thoughtMessages.has(messageId))this.#emitThought(block.thinking,message.uuid);
        else if(block?.type==="tool_use")this.#toolUse(block);
      }
      return;
    }
    if(type==="user"){
      for(const block of Array.isArray(message.message?.content)?message.message.content:[])if(block?.type==="tool_result")this.#toolResult(block);
      return;
    }
    // A steered turn's aborted leg is followed by the result of the turn that takes the steering message up.
    if(turn.steered&&!turn.cancelRequested&&isAbortResult(message))return;
    this.#usage(live,turn,message);
    turn.result=message;
    this.#finishTurn(turn);
  }
  // Root token streaming: text and thinking deltas as they arrive; the per-block assistant snapshots then add only what the
  // stream did not already show.
  #streamEvent(turn,event){
    if(event.type==="message_start"){turn.stream={id:event.message?.id||null,blocks:new Map()};return}
    if(event.type==="content_block_start"){
      const kind=event.content_block?.type;
      if(kind==="text"){
        const record={text:"",consumed:false};turn.stream?.blocks.set(event.index,record);
        const id=turn.stream?.id;if(id){const list=turn.textBlocks.get(id)||[];list.push(record);turn.textBlocks.set(id,list)}
        turn.separator=turn.emittedText;
      }else if(kind==="thinking"&&turn.stream?.id)turn.thoughtMessages.add(turn.stream.id);
      return;
    }
    if(event.type==="content_block_delta"){
      if(event.delta?.type==="text_delta"&&event.delta.text){
        const record=turn.stream?.blocks.get(event.index);if(record)record.text+=event.delta.text;
        this.#emitText(turn,event.delta.text,turn.stream?.id);
      }else if(event.delta?.type==="thinking_delta"&&event.delta.thinking){
        if(turn.stream?.id)turn.thoughtMessages.add(turn.stream.id);
        this.#emitThought(event.delta.thinking,turn.stream?.id);
      }
      return;
    }
    if(event.type==="content_block_stop")turn.stream?.blocks.delete(event.index);
  }
  #snapshotText(turn,messageId,text,uuid){
    const record=(messageId?turn.textBlocks.get(messageId)||[]:[]).find(item=>!item.consumed);
    if(!record){turn.separator=turn.emittedText;return this.#emitText(turn,text,uuid)}
    record.consumed=true;
    if(text.startsWith(record.text))this.#emitText(turn,text.slice(record.text.length),uuid);
  }
  #usage(live,turn,result){
    const total=Number(result?.total_cost_usd);
    const cost=Number.isFinite(total)?Math.max(0,total-live.costBase):0;
    if(Number.isFinite(total))live.costBase=total;
    if(turn)turn.cost=cost;
    const used=usageTotal(result?.usage||{});
    if(used||cost)this.#emit({sessionUpdate:"usage_update",used,size:0,cost:{amount:cost,currency:"USD"},usage:result?.usage||null,modelUsage:result?.modelUsage||null});
  }
  #backgroundTasks(live,message){
    const next=new Map();
    for(const task of Array.isArray(message.tasks)?message.tasks:[])if(task?.task_id&&!task.ambient)next.set(task.task_id,task);
    for(const [id,task] of live.backgroundTasks)if(!next.has(id))this.#emit({sessionUpdate:"tool_call_update",toolCallId:id,title:task.description||task.task_type||"Background task",kind:"other",status:"completed",rawOutput:task});
    for(const [id,task] of next)if(!live.backgroundTasks.has(id))this.#emit({sessionUpdate:"tool_call_update",toolCallId:id,title:task.description||task.task_type||"Background task",kind:"other",status:"in_progress",rawOutput:task});
    live.backgroundTasks=next;
  }
  // A rejected usage window pauses the turn: say so once per window and reset time (T3 Code's usage-limit notice).
  #rateLimit(message){
    const info=message.rate_limit_info,turn=this.turn&&!this.turn.settled?this.turn:null;if(!info||!turn)return;
    const overage=info.overageStatus==="allowed"||info.overageStatus==="allowed_warning"||info.isUsingOverage===true||info.overageInUse===true;
    const limitType=info.rateLimitType||"unknown";
    if(info.status==="rejected"&&!overage){
      turn.rejectedLimits.add(limitType);
      const key=`${limitType}:${info.resetsAt??"unknown"}`;
      if(turn.announcedLimits.has(key))return;
      turn.announcedLimits.add(key);
      this.#emit({sessionUpdate:"tool_call",toolCallId:`usage-limit:${turn.id}:${key}`,title:describeClaudeUsageLimit(info),kind:"other",status:"completed",rawInput:{},rawOutput:info});
    }else if(info.status==="allowed"||info.status==="allowed_warning"||overage)turn.rejectedLimits.delete(limitType);
  }

  async #canUseTool(toolName,input,options={}){
    const toolUseID=options?.toolUseID;
    if(toolName==="AskUserQuestion"){
      const questions=Array.isArray(input?.questions)?input.questions:[];
      let answers=null;
      if(this.onQuestion&&questions.length){
        try{answers=await untilAborted(this.onQuestion({toolName,input,options}),options?.signal,null)}catch{answers=null}
      }
      const mapped=options?.signal?.aborted?null:claudeQuestionAnswers(questions,answers);
      if(!mapped)return {behavior:"deny",message:"User cancelled tool execution.",toolUseID};
      return {behavior:"allow",updatedInput:{questions:input.questions,answers:mapped},toolUseID};
    }
    if(toolName==="ExitPlanMode"){
      const plan=typeof input?.plan==="string"&&input.plan.trim()?input.plan.trim():null;
      if(plan){
        this.#emit({sessionUpdate:"plan_update",plan:{type:"markdown",content:plan}});
        const turn=this.turn&&!this.turn.settled?this.turn:null;
        if(turn){turn.separator=turn.emittedText;this.#emitText(turn,plan,toolUseID)}
      }
      return {behavior:"deny",message:CLAUDE_PLAN_CAPTURED,toolUseID};
    }
    const policyKind=editTool(toolName)?"edit":readOnlyTool(toolName)?"read":toolKind(toolName),disposition=permissionDisposition(this.permissionMode,policyKind,{action:toolName,rawInput:input,workspace:this.cwd});
    if(disposition==="allow")return {behavior:"allow",updatedInput:input,toolUseID};
    if(disposition==="deny")return {behavior:"deny",message:"Trebell read-only mode denied this tool.",toolUseID};
    const choices=[
      {optionId:"allow_once",name:"Allow once",kind:"allow_once"},
      {optionId:"allow_always",name:"Allow for this session",kind:"allow_always"},
      {optionId:"reject_once",name:"Reject",kind:"reject_once"},
    ];
    let decision="decline";
    try{
      decision=await untilAborted(this.onPermission?.({
        method:"claude/canUseTool",
        params:{toolCall:{title:options?.title||options?.displayName||toolName,toolCallId:toolUseID,rawInput:input,kind:toolKind(toolName)},toolName,input,prompt:claudePermissionPrompt(toolName,input,options)},
        options:choices,
      }),options?.signal,"cancel")||"decline";
    }catch{decision="decline"}
    if(decision==="acceptForSession"){
      const updates=claudeSessionPermissionUpdates(toolName,options?.suggestions);
      // The rules also hold for every later process of this thread (after Stop, a model change or idle release).
      for(const update of updates){
        if(update?.type==="addRules"&&update.behavior==="allow")for(const rule of update.rules||[]){const text=permissionRuleText(rule);if(text)this.sessionAllowRules.add(text)}
        if(update?.type==="addDirectories")for(const directory of update.directories||[])if(directory)this.additionalDirectories.add(String(directory));
      }
      return {behavior:"allow",updatedInput:input,toolUseID,decisionClassification:"user_permanent",updatedPermissions:updates};
    }
    if(decision==="accept")return {behavior:"allow",updatedInput:input,toolUseID,decisionClassification:"user_temporary"};
    return {behavior:"deny",message:decision==="cancel"?"User cancelled tool execution.":"User declined tool execution.",toolUseID,decisionClassification:"user_reject",...(decision==="cancel"?{interrupt:true}:{})};
  }
}
