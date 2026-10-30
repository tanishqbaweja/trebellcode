import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { claudeCapabilities, claudeModelCatalog } from "./claude-capabilities.mjs";
import { fileUriPath } from "./file-uri.mjs";
import { textExtractedTo } from "./prompt-attachments.mjs";
import { HarnessSessionLostError } from "./harness-session-lost.mjs";
import { normalizePermissionMode, permissionDisposition } from "./permission-policy.mjs";
import { runtimeInstructions } from "./runtime-instructions.mjs";
import { redactSecretText } from "./secret-redactor.mjs";
import { SessionRefusalError } from "./session-refusal.mjs";
import { resolveWindowsCommandShim } from "./windows-command-shim.mjs";

// One long-lived streaming-input Claude Code query per thread: every prompt is an SDK
// user message offered to the live process (so steering, interrupts and background tasks work), and the process is replaced
// only when its launch policy (permission mode, tools, model, effort, agent) changes, after Stop, rewind or idle release.
export const CLAUDE_READ_ONLY_TOOLS=Object.freeze(["Read","Glob","Grep"]);
export const CLAUDE_IDLE_RELEASE_MS=30*60_000;
export const CLAUDE_MAX_IDLE_PIN_MS=4*60*60_000;
export const CLAUDE_PLAN_CAPTURED="Trebell Code has shown your plan to the user. Stop here: the user answers with feedback, or asks you to carry it out, in a later turn.";
export const CLAUDE_BACKGROUND_WORK_BLOCKS_CHANGE="Claude is still running background agents or commands, and this model or setting change would end them. Wait for them to finish (or ask Claude to stop them), or keep the current model and settings, then send the message again.";
// Nothing the person changed: Claude switched itself to Plan, and Claude Code refuses to leave it while its background work pins the process.
// Work that never ends by itself (a watcher) would hold every message back until the process is released, up to 4 hours: Edit from here
// on the refused message ends the process, and the work with it (rewindConversation closes it), and gives the message back to send.
export const CLAUDE_PLAN_STUCK="Claude Code could not leave the Plan mode Claude switched to, and restarting it would end the background agents or commands it is still running. Wait for them to finish, then send the message again. To end them now, choose Edit from here on this message and send it again.";
export const CLAUDE_USAGE_LIMIT_HINT="Claude usage limit reached. Send the message again once it resets.";
export const CLAUDE_CONTEXT_FULL="Claude Code stopped: this thread no longer fits the model's context window. Run /compact, or start a new thread.";
export const CLAUDE_MCP_REGISTRATION_TIMED_OUT="Claude Code did not finish connecting this thread's MCP servers within 90 seconds. Send the message again; if it keeps timing out, check the MCP servers in Settings.";
// The SDK sets no deadline for setMcpServers, and Claude Code waits up to 30 s for each server.
const CLAUDE_MCP_REGISTRATION_TIMEOUT_MS=90_000;
// A steer waits at most this long, from its request, for the subagents the root turn runs in the foreground to move to the background.
const CLAUDE_STEER_BACKGROUND_MS=5_000;
// The tools that run a subagent (Agent, called Task before).
const CLAUDE_SUBAGENT_TOOLS=new Set(["Agent","Task"]);
// Claude Code's task tools (on by default where the model supports them, or with CLAUDE_CODE_ENABLE_TODO_TOOLS=1): their results keep
// one task list per Claude session, the root's and its subagents' alike, shown as the thread's plan as a TodoWrite list is.
const CLAUDE_TASK_TOOLS=new Set(["TaskCreate","TaskUpdate","TaskList"]);
const CLAUDE_TASK_STATUSES=new Set(["pending","in_progress","completed"]);
export const CLAUDE_COMPACT_FAILED="Claude Code could not compact its context.";
// What the row of a background task says when its Claude Code ended first (Stop, Edit from here, its release or its exit), which ends it.
const CLAUDE_TASK_STOPPED="Claude Code stopped before this finished.";
const CLAUDE_EFFORTS=new Set(["low","medium","high","xhigh","max"]);
const CLAUDE_IMAGE_TYPES=new Set(["image/gif","image/jpeg","image/png","image/webp"]);
const CLAUDE_INTERRUPT_TIMEOUT_MS=10_000;
const CLAUDE_CLOSE_TIMEOUT_MS=5_000;
// How long a killed Claude Code has to exit before a stalled resumed conversation is not opened again.
const CLAUDE_EXIT_CONFIRM_MS=10_000;
// The end of a Claude Code's stderr Trebell keeps, as the SDK keeps 2,048 characters of its own processes'.
const CLAUDE_STDERR_TAIL=4096;
const CLAUDE_USAGE_LIMIT_WINDOWS=Object.freeze({five_hour:"5-hour",seven_day:"7-day",seven_day_opus:"7-day Opus",seven_day_sonnet:"7-day Sonnet",seven_day_overage_included:"7-day model",overage:"overage"});
// API errors Claude Code does not retry, whose own error message names the problem (an unknown model, a bad request, an
// account or billing issue): that message is the turn's error, not "Claude Code stopped after the API kept failing."
const CLAUDE_EXPLAINED_API_ERRORS=new Set(["invalid_request","model_not_found","billing_error","oauth_org_not_allowed","account_on_hold","verification_required","cloud_credential_error"]);
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// What Claude Code prints, and exits on, when it is asked to resume a session it has no transcript for.
const CLAUDE_NO_CONVERSATION=/No conversation found with session ID/i;
// The Claude Agent SDK loads with the first session that starts, not with the server (budget B25).
let claudeAgentSdk=null;
const loadClaudeAgentSdk=()=>claudeAgentSdk??=import("@anthropic-ai/claude-agent-sdk");

function sdkPermissionMode(mode,collaborationMode="default"){
  if(collaborationMode==="plan")return "plan";
  if(mode==="full")return "bypassPermissions";
  if(mode==="auto")return "auto";
  if(mode==="edits")return "acceptEdits";
  if(mode==="read-only")return "dontAsk";
  return "default";
}

// The launch policy: read-only offers only the read tools
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
  // TodoWrite writes a to-do list, not a file.
  if(value==="todowrite")return "other";
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
const tokens=value=>Math.max(0,Math.round(Number(value))||0);
// The prompt a request sent: its input and cache tokens.
function promptTokens(usage){return tokens(usage?.input_tokens)+tokens(usage?.cache_creation_input_tokens)+tokens(usage?.cache_read_input_tokens)}
// A message_delta's usage counts its message so far: a field it leaves null or out keeps message_start's.
function mergedUsage(current,delta){
  return {...current,input_tokens:delta.input_tokens??current.input_tokens,cache_creation_input_tokens:delta.cache_creation_input_tokens??current.cache_creation_input_tokens??null,cache_read_input_tokens:delta.cache_read_input_tokens??current.cache_read_input_tokens??null,output_tokens:delta.output_tokens??current.output_tokens};
}
// The tokens of a turn's root requests so far, which its result's main-loop usage gives once it ends.
function summedUsage(requests){
  const sum={input_tokens:0,cache_creation_input_tokens:0,cache_read_input_tokens:0,output_tokens:0};
  for(const usage of requests.values())for(const key of Object.keys(sum))sum[key]+=tokens(usage?.[key]);
  return sum;
}
// The context meter's reading of one request: its prompt, as the relay's last request.
function contextReading(usage){
  const input=promptTokens(usage),output=tokens(usage?.output_tokens);
  return {totalTokens:input+output,inputTokens:input,cachedInputTokens:tokens(usage?.cache_read_input_tokens),cacheWriteInputTokens:tokens(usage?.cache_creation_input_tokens),outputTokens:output};
}

// A task tool's field, read defensively: the tools' result shapes are no typed SDK contract.
const taskField=(value,key)=>value&&typeof value==="object"?value[key]:undefined;
const taskText=(value,key)=>{const field=taskField(value,key);return typeof field==="string"&&field.trim()?field.trim():undefined};
// A TodoWrite's list as plan entries.
export function claudeTodoEntries(input){
  return (Array.isArray(input?.todos)?input.todos:[]).flatMap(todo=>{
    const content=taskText(todo,"content");
    return content?[{content,status:CLAUDE_TASK_STATUSES.has(todo.status)?todo.status:"pending"}]:[];
  });
}
// The task list after a task tool's call went through, or null when it changed nothing it shows.
// result: the tool's structured result, or its text, all a subagent's call returns. TaskList's list replaces it; TaskCreate adds the
// task its result names ("Task #3 created successfully: <subject>"); TaskUpdate changes a task the list has from its input once
// Claude Code says it did ("Updated task #3 status"), and its "deleted" status drops it.
export function claudeTaskList(tasks,name,input,result){
  if(name==="TaskList"){
    const listed=taskField(result,"tasks");if(!Array.isArray(listed))return null;
    const next=new Map();
    for(const task of listed){const id=taskText(task,"id"),content=taskText(task,"subject"),status=taskField(task,"status");if(id&&content&&CLAUDE_TASK_STATUSES.has(status))next.set(id,{content,status})}
    return next.size||tasks.size?next:null;
  }
  if(name==="TaskCreate"){
    const said=typeof result==="string"?/^Task #(\S+) created successfully: (.+)$/s.exec(result.trim()):null,created=taskField(result,"task");
    const id=taskText(created,"id")??said?.[1],content=taskText(created,"subject")??said?.[2].trim()??taskText(input,"subject");
    return id&&content?new Map(tasks).set(id,{content,status:"pending"}):null;
  }
  if(name!=="TaskUpdate"||taskField(result,"success")===false||(typeof result==="string"&&!result.trim().startsWith("Updated task #")))return null;
  const id=taskText(input,"taskId")??taskText(result,"taskId"),task=id?tasks.get(id):undefined;if(!task)return null;
  if(input?.status==="deleted"){const next=new Map(tasks);next.delete(id);return next}
  const content=taskText(input,"subject")??task.content,status=CLAUDE_TASK_STATUSES.has(input?.status)?input.status:task.status;
  return content===task.content&&status===task.status?null:new Map(tasks).set(id,{content,status});
}
// The task list Claude Code keeps on disk for a session, one <n>.json a task in its folder, in its order,
// or null where there is no folder to read. Claude Code writes a call's change before its result comes. Its own internal tasks
// (metadata._internal) and files that are no task are left out.
export function readClaudeTaskStore(folder){
  let names;try{names=readdirSync(folder)}catch{return null}
  const tasks=new Map();
  for(const name of names.filter(name=>/^\d+\.json$/.test(name)).sort((a,b)=>parseInt(a,10)-parseInt(b,10))){
    let task;try{task=JSON.parse(readFileSync(join(folder,name),"utf8"))}catch{continue}
    const id=taskText(task,"id"),content=taskText(task,"subject"),status=taskField(task,"status"),metadata=taskField(task,"metadata");
    if(!id||!content||!CLAUDE_TASK_STATUSES.has(status)||(metadata!==undefined&&(!metadata||typeof metadata!=="object"||metadata._internal)))continue;
    tasks.set(id,{content,status});
  }
  return tasks;
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

// Claude Code started on this machine as the SDK starts it (hidden, its three streams piped), but by Trebell, which so sees it exit and
// keeps the end of its stderr (onStderr): the SDK's errors carry that end only for a process it started itself. Its exit reaches the
// SDK once stderr has closed, or 200 ms after, as with the SDK's own start, so the end is all there when the exit is reported.
function spawnLocalClaudeCode({command,args,cwd,env,signal},{spawnChild=spawn,onStderr}){
  const child=spawnChild(command,args,{cwd,env,signal,stdio:["pipe","pipe","pipe"],windowsHide:true});
  const exits=new EventEmitter();let code=null,signalCode=null,exited=false,drained=!child.stderr,sent=false,grace=null;
  const deliver=()=>{if(sent)return;sent=true;clearTimeout(grace);exits.emit("exit",code,signalCode)};
  if(child.stderr){child.stderr.setEncoding("utf8");child.stderr.on("data",onStderr);child.stderr.on("error",()=>{});child.stderr.once("close",()=>{drained=true;if(exited)deliver()})}
  child.once("exit",(exitCode,exitSignal)=>{exited=true;code=exitCode;signalCode=exitSignal;if(drained)deliver();else{grace=setTimeout(deliver,200);grace.unref?.()}});
  const target=event=>event==="exit"?exits:child;
  return {
    stdin:child.stdin,stdout:child.stdout,get killed(){return child.killed},get exitCode(){return child.exitCode},get signalCode(){return child.signalCode},
    kill:signal=>child.kill(signal),on:(event,listener)=>{target(event).on(event,listener)},once:(event,listener)=>{target(event).once(event,listener)},off:(event,listener)=>{target(event).off(event,listener)},
  };
}
// The SDK reports a process that ended by its exit and the end of its stderr; for one Trebell started, the end Trebell kept is added.
function withStderrTail(error,proc){
  const message=String(error?.message||"");
  if(!proc?.stderrTail||!/^Claude Code process (?:exited with code|terminated by signal)/.test(message)||message.includes(". stderr: "))return error;
  const tail=redactSecretText(stripVTControlCharacters(proc.stderrTail),{trim:true}).slice(-2048);
  return tail?Object.assign(new Error(`${message}. stderr: ${tail}`),{cause:error}):error;
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

// SDK user message content: images (png, jpeg, gif and webp only) first, then the text blocks. Claude Code
// expands a slash command or skill only from the last text block, so the user's own text stays last. A file is named by its path,
// and a document by the file its text was extracted to as well.
export function claudeUserContent(parts=[]){
  const images=[],texts=[],links=[];
  for(const part of Array.isArray(parts)?parts:[]){
    if(part?.type==="image"){
      const mimeType=String(part.mimeType||part.mime_type||"").trim().toLowerCase();
      if(!CLAUDE_IMAGE_TYPES.has(mimeType))throw new Error(`Unsupported Claude image attachment type '${mimeType||"unknown"}'`);
      images.push({type:"image",source:{type:"base64",media_type:mimeType,data:String(part.data||"")}});
    }else if(part?.type==="resource_link")links.push({type:"text",text:`Attached file: ${fileUriPath(part.uri)??String(part.uri||"")}${textExtractedTo(part)}`});
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

// "Allow for session": the CLI's suggestions scoped to this session, or a rule
// allowing the tool when it suggested none.
export function claudeSessionPermissionUpdates(toolName,suggestions){
  const updates=(Array.isArray(suggestions)?suggestions:[]).map(suggestion=>({...suggestion,destination:"session"}));
  return updates.length?updates:[{type:"addRules",rules:[{toolName}],behavior:"allow",destination:"session"}];
}
// Claude Code's own text for a request (its prompt sentence, subtitle, reason or ask rule) can carry its renderer's terminal escapes.
function plainText(value){return typeof value==="string"?stripVTControlCharacters(value).trim():""}
// A notice's text as the result that repeats it gives it.
function noticeKey(value){return plainText(String(value??"")).replace(/\s+/g," ")}
// The approval prompt: the CLI's own prompt sentence, else the tool with its command, path
// or input, so the person sees what they approve, then why Claude Code asks (its decisionReason) when the sentence does not say it.
export function claudePermissionPrompt(toolName,input,options={}){
  const reason=plainText(options?.decisionReason).slice(0,400),own=plainText(options?.title)||plainText(options?.description)||reason||null;
  const name=String(toolName||"Tool"),field=keys=>{for(const key of keys){const value=input?.[key];if(typeof value==="string"&&value.trim())return value.trim()}return null};
  const target=field(["command","cmd","script"])??field(["file_path","path","filename","fileName"]);
  let prompt=own;
  // The command or path itself is always shown: Claude Code's sentence for a shell command can be
  // the model's own description of it ("Run node one-liner printing trebell-tour"), which follows it when it adds something.
  if(target!=null){
    const action=`${name}: ${target.slice(0,400)}`;
    prompt=!own?action:own.includes(target)?own:`${action} — ${own}`;
  }else if(!own){
    let serialized="";try{serialized=JSON.stringify(input??{})??""}catch{serialized=""}
    prompt=serialized.length<=400?`${name}: ${serialized}`:`${name}: ${serialized.slice(0,397)}...`;
  }
  return reason&&!prompt.includes(reason)?`${prompt} (${reason})`:prompt;
}
// Every request Claude Code forwards in Full access is one it does not approve itself: an ask rule, or its own safety checks (an rm of
// a critical path, a read outside the folder). The card says so, and names the person's ask rule when one matched. In Plan mode (the
// composer's, or one Claude switched itself to) Claude Code asks for what Plan mode holds back, whatever the profile, so that is what
// the card says. A Full access thread whose Claude Code runs in another mode (liveMode: its settings turned bypass off, as an
// administrator's can) asks for what that mode holds back, and the card names that mode.
const CLAUDE_MODE_PROFILES=Object.freeze({default:"Supervised",acceptEdits:"Auto-accept edits",auto:"Auto"});
function claudeAskLead({fullAccess,planMode,liveMode,rule}){
  const bypass=fullAccess&&!planMode&&(!liveMode||liveMode==="bypassPermissions");
  const ruleText=plainText(permissionRuleText(rule)||"");
  if(ruleText)return bypass?`Claude Code asks even in Full access, as its ask rule ${ruleText} says`:`Claude Code asks, as its ask rule ${ruleText} says`;
  if(planMode)return "Claude Code asks in Plan mode";
  if(bypass)return "Claude Code asks even in Full access";
  if(!fullAccess)return null;
  const profile=CLAUDE_MODE_PROFILES[liveMode];
  return profile?`Claude Code asks, as it runs in ${profile} mode, not Full access`:"Claude Code asks, as it does not run in Full access";
}
// A request Claude Code wants decided once (a standing grant would allow more than it asks, or no stray key may approve it) offers
// no session choice: the card's own buttons, as the default card words them.
const CLAUDE_ONCE_OPTIONS=Object.freeze([{decision:"decline",label:"Deny"},{decision:"accept",label:"Allow once"}]);
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
// A turn's usage-limit error, with the wait when Claude Code said when each rejected window resets (the latest of them): limits
// are the rejected windows' rate_limit_info.
export function claudeUsageLimitHint(limits=[],nowMs=Date.now()){
  const resets=limits.map(info=>Number(info?.resetsAt)),waitMs=limits.length&&resets.every(value=>Number.isFinite(value)&&value>0)?Math.max(...resets)*1000-nowMs:NaN;
  if(!(waitMs>0&&waitMs<=30*24*60*60_000))return CLAUDE_USAGE_LIMIT_HINT;
  const label=limits.length===1?CLAUDE_USAGE_LIMIT_WINDOWS[limits[0]?.rateLimitType]||null:null;
  return `Claude usage limit reached. Send the message again once the ${label?label+" ":""}limit resets in ${formatWait(waitMs)}.`;
}
// The usage window a message says Claude Code rejected, or null: a rate_limit_event, or the window a reply the limit blocked repeats
// (api_error_params), which Claude Code sends each time while it throttles an unchanged event. An allowed
// overage takes over a rejected window, so it rejects nothing.
export function claudeRejectedLimit(message){
  const info=message?.type==="rate_limit_event"?message.rate_limit_info:message?.type==="assistant"&&message.error==="rate_limit"?message.api_error_params?.rate_limit_info:null;
  if(!info||typeof info!=="object"||info.status!=="rejected")return null;
  return info.overageStatus==="allowed"||info.overageStatus==="allowed_warning"||info.isUsingOverage===true||info.overageInUse===true?null:info;
}
// A turn Claude Code refused for a usage limit (a rejected window, or the API's rate_limit error) reads as a usage limit only while its
// result agrees: a 429 or no status, and an API error, a blocking limit or no reason.
export function claudeUsageLimited(result,limited){
  return Boolean(limited)&&(result?.subtype!=="success"||result?.api_error_status==null||result?.api_error_status===429)&&(result?.terminal_reason==null||result.terminal_reason==="api_error"||result.terminal_reason==="blocking_limit");
}

export function claudeSignedOutMessage(configDir=""){
  const home=String(configDir||"").trim();
  return `Claude Code could not authenticate. Run \`claude auth login\`${home?` with CLAUDE_CONFIG_DIR set to "${home}"`:""}, then send the message again, or set this profile to run on the Anthropic API key in Agents & models.`;
}

// failureHint: sign-in or usage-limit evidence; apiError: the API's own words for an api_error (an explained reply's text, or the
// result's "API Error: …"), which never names a blocking limit.
function terminalResultError(reason,failureHint,apiError=null){
  switch(reason){
    case "api_error":return failureHint||apiError||"Claude Code stopped after the API kept failing.";
    case "malformed_tool_use_exhausted":return "Claude Code stopped after its tool calls kept coming out malformed.";
    case "budget_exhausted":return "Claude Code stopped: this turn used up its token budget.";
    case "structured_output_retry_exhausted":return "Claude Code could not give the structured output asked for.";
    case "tool_deferred_unavailable":return "Claude Code could not go back to a deferred tool call, because that tool is gone.";
    case "turn_setup_failed":return "Claude Code could not start this turn.";
    // Claude Code also ends a turn on blocking_limit once the context window is full, after an invalid_request reply saying "Prompt is
    // too long": only sign-in or usage-limit evidence (the hint) names it otherwise.
    case "blocking_limit":return failureHint||CLAUDE_CONTEXT_FULL;
    case "rapid_refill_breaker":return "Claude Code stopped: the context filled up again right after compaction.";
    case "prompt_too_long":return CLAUDE_CONTEXT_FULL;
    case "image_error":return "Claude Code stopped: it could not read an image in this thread.";
    case "model_error":return "Claude Code stopped: the model answered with an error.";
    default:return null;
  }
}
// The text of an assistant error frame that explains its own failure (see CLAUDE_EXPLAINED_API_ERRORS), or null, with the secrets the
// API's words can repeat redacted as in the result's "API Error: …".
export function claudeExplainedApiError(message){
  if(!CLAUDE_EXPLAINED_API_ERRORS.has(message?.error))return null;
  const blocks=Array.isArray(message.message?.content)?message.message.content:[];
  const text=blocks.map(block=>block?.type==="text"?String(block.text||"").trim():"").filter(Boolean).join("\n");
  return text?redactApiErrorText(text)||null:null;
}
// "[ede_diagnostic] ..." entries are CLI-internal telemetry and never the error to show.
function userFacingErrors(result){return (Array.isArray(result?.errors)?result.errors:[]).filter(error=>typeof error==="string"&&error.trim()&&!error.startsWith("[ede_diagnostic]"))}

// Quoted JSON keys of secrets ({"token":"…"}, {"client_secret":"…"}) an API's error text can repeat, whose values the shared redactor's
// key=value form does not reach.
const QUOTED_SECRET_VALUE=/(["'])([\w-]*(?:token|secret|password|passwd|api[_-]?key|credential|authorization|cookie))\1(\s*:\s*)(["'])(?:\\.|(?!\4)[^\\])*\4/gi;
function redactApiErrorText(text){return redactSecretText(String(text).replace(QUOTED_SECRET_VALUE,"$1$2$1$3$4[redacted]$4"),{trim:true})}

// The user-facing failure of a result, or null when the turn succeeded. failureHint: a sign-in or
// usage-limit failure; explainedError: the text of a reply that explained its own API error (claudeExplainedApiError).
export function claudeResultFailure(result,{failureHint=null,explainedError=null}={}){
  if(!result)return null;
  const success=result.subtype==="success";
  const listed=success&&!result.is_error?null:userFacingErrors(result)[0]||null;
  // The API's own words for the request it refused ("API Error: 400 …"), secrets redacted and cut to 500 characters, when nothing
  // names the failure better.
  const apiError=success&&result.terminal_reason==="api_error"&&String(result.result||"").trim().startsWith("API Error:")?redactApiErrorText(result.result).slice(0,500):null;
  const structured=success&&result.api_error_status===529?"The Claude API is overloaded (529). Send the message again in a moment."
    :success&&result.api_error_status===429?"The Claude API rate limit was hit (429). Send the message again later."
    :terminalResultError(result.terminal_reason,failureHint,explainedError||apiError);
  if(!success)return listed||structured||`Claude Code turn failed: ${result.subtype||"unknown error"}`;
  if(!result.is_error&&!structured)return null;
  return listed||structured||failureHint||explainedError||String(result.result||"").trim()||"Claude Code turn failed.";
}

// A turn that ended without an error message of its own reads as interrupted or cancelled from its listed errors.
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
  constructor({command="claude",cwd=process.cwd(),env=process.env,permissionMode:mode="supervised",onUpdate,onPermission,onQuestion,onWakeTurn=null,version="0.0.0",spawnProcess=null,capabilityScope="",autoCompactWindow=null,forkFromSessionId=null,resumeSessionAt=null,persistedTurns=null,mcpServers={},sdk=null,capabilities=undefined,idleReleaseMs=CLAUDE_IDLE_RELEASE_MS,spawnChild=spawn}={}){
    this.command=command;this.cwd=cwd;this.env=env;this.permissionMode=normalizePermissionMode(mode);this.onUpdate=onUpdate;this.onPermission=onPermission;this.onQuestion=onQuestion;this.onWakeTurn=onWakeTurn;this.version=version;this.spawnProcess=spawnProcess;
    // How a Claude Code on this machine is started (node's spawn; tests pass their own).
    this.spawnChild=spawnChild;
    // Remote environments share one executable name and Claude home, so their capability probes are kept apart by environment.
    this.capabilityScope=spawnProcess?String(capabilityScope||""):"";
    this.autoCompactWindow=Number.isInteger(Number(autoCompactWindow))&&Number(autoCompactWindow)>=100_000&&Number(autoCompactWindow)<=1_000_000?Number(autoCompactWindow):null;
    this.mcpServers=mcpServers&&typeof mcpServers==="object"?{...mcpServers}:{};
    // The installed SDK is set once the session starts (#loadSdk); tests pass a scripted one.
    this.sdk=sdk||null;
    // The shared capability cache probes the real CLI; an injected SDK (tests) brings its own or none.
    this.capabilities=capabilities!==undefined?capabilities:(sdk?null:claudeCapabilities);
    this.idleReleaseMs=Math.max(1,Number(idleReleaseMs)||CLAUDE_IDLE_RELEASE_MS);
    this.helperSharesRuntime=!this.spawnProcess&&String(this.env.CLAUDE_CONFIG_DIR||"")===String(process.env.CLAUDE_CONFIG_DIR||"");
    this.sessionId=null;this.model=null;this.reasoningEffort=null;this.serviceTier=null;this.collaborationMode="default";this.agent=null;
    // opening: the prompt opening its process, which Stop and close mark stopped.
    this.closed=false;this.startedOnce=false;this.persistedTurns=persistedTurns;this.opening=null;
    // A fork or rewind that has not run yet: the first query resumes the source at the cursor into this session's new id.
    this.pendingFork=forkFromSessionId?{sourceSessionId:forkFromSessionId,targetSessionId:null,resumeSessionAt:resumeSessionAt||null}:null;
    this.live=null;this.turn=null;this.idleTimer=null;this.tools=new Map();
    // taskCalls: the task tool calls without a result yet, by id, and todoCalls the TodoWrite calls; taskLists: each Claude session's
    // task list, by its id.
    this.taskCalls=new Map();this.todoCalls=new Set();this.taskLists=new Map();
    // contextWindows: Claude Code's window for each model it ran (getContextUsage), asked once. meter: what the context meter last
    // showed (the total, its cost and the context, with the turns the total and the cost are of), and request the latest root
    // request's usage as its stream reports it.
    this.contextWindows=new Map();this.meter={usage:null,modelUsage:null,cost:null,context:null,turn:null,costTurn:null};this.request=null;
    this.sessionAllowRules=new Set();this.additionalDirectories=new Set();this.inventory={};this.inventoryRank=0;this.#rewindOrigins=new WeakMap();
    this.initializeResult={agentCapabilities:{loadSession:true,sessionCapabilities:{fork:{},resume:{},close:{}}},agentInfo:{name:"Claude Code"}};
    this.sessionSetup=null;
  }

  async start({providerSessionId=null,model=null}={}){
    await this.#loadSdk();
    this.sessionId=providerSessionId||randomUUID();
    this.model=model||null;
    if(this.pendingFork){this.pendingFork.targetSessionId=this.sessionId;this.startedOnce=false}
    else if(providerSessionId){
      // A thread whose first prompt never ran (for example, started before a restart) has no transcript yet: its first
      // query creates the session under this id instead of resuming it. A thread with turns Claude recorded resumes. Its transcript
      // can be gone (Claude Code's cleanup removes old ones):
      // where this process reads Claude's transcripts, that is a lost session (HarnessSessionLostError), and the relay continues
      // the thread in one fresh session with its earlier messages handed over, which the turn shows. Elsewhere Claude Code says
      // so when the turn's query opens (#finishTurn).
      if(this.helperSharesRuntime){
        const info=await Promise.resolve().then(()=>this.sdk.getSessionInfo(providerSessionId,{dir:this.cwd})).then(value=>({value}),()=>null);
        if(this.persistedTurns===true&&info&&!info.value)throw new HarnessSessionLostError(`Claude Code could not resume this conversation: it has no transcript for session ${providerSessionId}.`,{harness:"claude",sessionId:providerSessionId});
        this.startedOnce=this.persistedTurns===true||Boolean(info?.value);
      }else this.startedOnce=this.persistedTurns!==false;
    }
    // Slash commands and agents are known before the first message: the machine-wide probe the
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

  // The relay's one fresh session for a thread whose conversation Claude Code no longer has (it said so as the turn's query
  // opened): a new conversation under a new id, with this session's model and modes; its first query creates it.
  async startFresh(){
    await this.#closeLive();
    this.pendingFork=null;this.persistedTurns=false;this.startedOnce=false;
    return this.start({model:this.model});
  }

  // onDelivered: told once Claude Code has the prompt: queued to a process whose session started, or that process reporting its
  // session (init) after taking the prompt in. compact: the prompt is compact()'s /compact.
  async prompt(parts,{messageId=null,agent=null,onDelivered=null,compact=false}={}){
    // Trebell's own refusals (SessionRefusalError): Claude Code is not asked, so it did not fail.
    if(this.closed)throw new SessionRefusalError("Claude session is closed");
    // A prompt still opening its query counts as running, so two prompts never share one turn.
    if(this.opening||(this.turn&&!this.turn.settled))throw new SessionRefusalError("Claude Code is still running a turn. Stop it or wait for it to finish first.");
    const content=claudeUserContent(parts);
    // Stop or close while the prompt opens its process (registering the MCP servers, closing a process that stalled there or one whose
    // launch policy changed) can find no process and no turn: it marks the opening, and the prompt never reaches Claude Code.
    const opening={stopped:false};this.opening=opening;
    try{
      this.agent=agent||null;
      const live=await this.#ensureLive(opening);
      // Fresh for every offer: Claude acknowledges a prompt whose uuid its transcript already holds without running a turn.
      const promptUuid=UUID.test(String(messageId||""))?String(messageId):randomUUID();
      const turn=this.#newTurn({promptUuid,live});
      turn.onDelivered=typeof onDelivered==="function"?onDelivered:null;turn.compact=compact===true;
      this.turn=turn;clearTimeout(this.idleTimer);
      // A prompt that never reaches Claude Code (its opening stopped, or its process ended first) is in no transcript, so its turn ends
      // with no ids: an Edit from here would resume at one, and a later session start would take the thread for one Claude Code has.
      if(opening.stopped||!live||live.closed)turn.promptUuid=null;
      if(opening.stopped||!live){
        turn.cancelRequested=true;
        if(live&&!live.closed){live.stopped=true;await this.#closeLive(live)}
        if(!turn.settled)this.#finishTurn(turn);
        return turn.promise;
      }
      // A process that ended while it opened (it exited, or Stop or close ended it) ends the turn as its pump would have.
      if(live.closed){turn.cancelRequested=live.stopped;turn.queryError=live.failure;this.#finishTurn(turn);return turn.promise}
      live.input.push({type:"user",message:{role:"user",content},parent_tool_use_id:null,uuid:promptUuid});
      if(live.sawInit)this.#delivered(turn);
      return turn.promise;
    }finally{if(this.opening===opening)this.opening=null}
  }
  #delivered(turn){
    const notify=turn?.onDelivered;if(!notify)return;
    turn.onDelivered=null;try{notify()}catch{}
  }

  // Mid-turn input: a "now" priority user message the running turn takes up at once.
  async steer(parts){
    const turn=this.turn&&!this.turn.settled?this.turn:null,live=turn?.live;
    if(!turn||!live||live.closed)throw new Error("Claude Code has no running turn to steer.");
    const content=claudeUserContent(parts);
    // A "now" message cancels the root turn's running tool calls, a subagent it runs in the foreground among them: each moves to the
    // background first, for at most 5 s from the steer, and its result comes in later, in a turn of its own.
    await this.#backgroundSubagents(live);
    // A turn that ended meanwhile takes no steer: the message would start a turn nobody sent.
    if(turn.settled||live.closed)throw new Error("Claude Code has no running turn to steer.");
    const uuid=randomUUID();
    turn.uuids.add(uuid);turn.steered=true;turn.steers.push(parts);
    live.input.push({type:"user",message:{role:"user",content},parent_tool_use_id:null,priority:"now",uuid});
    return {accepted:true,pending:0};
  }
  // Claude Code refuses a move while background tasks are turned off (CLAUDE_CODE_DISABLE_BACKGROUND_TASKS), and the steer goes all the
  // same. A move an earlier steer asked for is waited on, not asked again.
  async #backgroundSubagents(live){
    const moves=[...live.foregroundSubagents].map(id=>{
      let move=live.subagentMoves.get(id);
      if(!move){move=Promise.resolve().then(()=>live.query.backgroundTasks(id)).catch(()=>false).finally(()=>live.subagentMoves.delete(id));live.subagentMoves.set(id,move)}
      return move;
    });
    if(moves.length)await withTimeout(Promise.allSettled(moves),CLAUDE_STEER_BACKGROUND_MS).catch(()=>{});
  }

  async setModel(model){this.model=model||null;return {modelId:this.model}}
  setPermissionMode(mode){this.permissionMode=normalizePermissionMode(mode);return this.permissionMode}
  setReasoningEffort(effort){const value=String(effort||"").trim().toLowerCase();this.reasoningEffort=CLAUDE_EFFORTS.has(value)?value:null;return this.reasoningEffort}
  setServiceTier(tier){this.serviceTier=String(tier||"").trim().toLowerCase()==="fast"?"fast":null;return this.serviceTier}
  setCollaborationMode(mode){this.collaborationMode=mode==="plan"?"plan":"default";return this.collaborationMode}

  // Stop: interrupt the running turn, then end the process (and with it any background work).
  async cancel(){
    const turn=this.turn&&!this.turn.settled?this.turn:null,live=this.live;
    if(this.opening)this.opening.stopped=true;
    if(turn)turn.cancelRequested=true;
    if(live)live.stopped=true;
    if(turn&&live&&!live.closed)await withTimeout(live.query.interrupt(),CLAUDE_INTERRUPT_TIMEOUT_MS).catch(()=>{});
    await this.#closeLive(live);
    if(turn&&!turn.settled)this.#finishTurn(turn);
  }
  // Rejects, with Claude Code's reason, when the compaction failed (#finishTurn), so the relay never reports it compacted.
  async compact(){return this.prompt([{type:"text",text:"/compact"}],{compact:true})}
  async fork({upToMessageId=null}={}){
    const targetSessionId=randomUUID(),sourceSessionId=this.pendingFork?.sourceSessionId||this.sessionId;
    // A thread whose first prompt never ran has no transcript to copy: the fork starts its own conversation.
    if(!this.pendingFork&&!this.startedOnce)return {sessionId:targetSessionId,lazyFork:null};
    return {sessionId:targetSessionId,lazyFork:{sourceSessionId,targetSessionId,resumeSessionAt:upToMessageId||this.pendingFork?.resumeSessionAt||null}};
  }
  #requireHostSessionHelper(operation){
    if(!this.helperSharesRuntime)throw new Error(`Claude ${operation} is unavailable through the host session helper for this custom or remote Claude home.`);
  }
  async #loadSdk(){return this.sdk||(this.sdk=await loadClaudeAgentSdk())}
  async rename(name){this.#requireHostSessionHelper("rename");return (await this.#loadSdk()).renameSession(this.sessionId,name,{dir:this.cwd})}
  async history(){this.#requireHostSessionHelper("history");return (await this.#loadSdk()).getSessionMessages(this.sessionId,{dir:this.cwd,includeSystemMessages:false})}
  // Edit from here: the next query resumes the conversation at the kept turn's last assistant message into a new session id
  // (resumeSessionAt only); with no kept turn the thread starts a fresh session.
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
    if(this.opening)this.opening.stopped=true;
    const turn=this.turn&&!this.turn.settled?this.turn:null;if(turn)turn.cancelRequested=true;
    if(this.live)this.live.stopped=true;
    await this.#closeLive();
    if(turn&&!turn.settled)this.#finishTurn(turn);
  }
  async delete(){await this.close();this.#requireHostSessionHelper("delete");return (await this.#loadSdk()).deleteSession(this.sessionId,{dir:this.cwd})}

  // turnKey: the turn that the row of work running on past its turn stays in (agent-relay handleUpdate keeps it there).
  #emit(update,turnKey=null){this.onUpdate?.({sessionId:this.sessionId,...(turnKey?{turnKey}:{}),update})}
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
  // opening: the prompt's (see prompt); null once Stop or close ended the opening before a process was started for it.
  async #ensureLive(opening=null){
    if(!this.sdk)await this.#loadSdk();
    const key=this.#queryKey(),live=this.live;
    if(live&&!live.closed&&live.key===key){
      // Claude can switch itself to Plan (EnterPlanMode, a denied ExitPlanMode): a process left there goes back to the mode it opened
      // in. Only Plan is undone: another mode is Claude Code's own answer to what was asked (Manual for Auto on a model without it,
      // or where an administrator turned bypass off), which asking again would only refuse.
      if(live.permissionMode!=="plan"||live.openedPermissionMode==="plan")return live;
      try{await live.query.setPermissionMode(live.openedPermissionMode);live.permissionMode=live.openedPermissionMode;return live}catch{}
      // Full access that cannot come back (bypass turned off since the process opened) leaves Plan for Manual.
      if(live.openedPermissionMode==="bypassPermissions"){try{await live.query.setPermissionMode("default");live.permissionMode="default";return live}catch{}}
      if(opening?.stopped)return null;
      // A process that cannot leave Plan is replaced, never while background work runs in it, which that would end.
      if(live.backgroundTasks.size)throw new SessionRefusalError(CLAUDE_PLAN_STUCK);
      await this.#closeLive(live);
    }else if(live&&!live.closed){
      // Background agents and shells run inside the CLI process: a new launch policy would end them.
      if(live.backgroundTasks.size)throw new SessionRefusalError(CLAUDE_BACKGROUND_WORK_BLOCKS_CHANGE);
      await this.#closeLive(live);
    }
    return this.#openLive(this.#queryKey(),{opening});
  }
  async #openLive(key,{reopen=true,opening=null}={}){
    if(opening?.stopped||this.closed)return null;
    // The process this query starts, as Trebell sees it: whether it exited, and the end of its stderr.
    const proc={child:null,exit:null,exited:false,stderrTail:""};
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
      // No mcpServers: the SDK would put every server but its own in-process ones on Claude Code's command line (--mcp-config), with
      // the env values the person set for them, where other local users can read them, and Claude Code exits at startup on that flag
      // next to an administrator's managed-mcp.json. They go over stdin once it runs (#registerMcpServers).
      ...(this.agent?{agent:this.agent}:{}),
      ...(this.reasoningEffort?{effort:this.reasoningEffort}:{}),
      thinking:{type:"adaptive",display:"summarized"},
      settings,
      ...(directories.length?{additionalDirectories:directories}:{}),
      includePartialMessages:true,
      spawnClaudeCodeProcess:this.#spawner(proc),
      ...(fork
        ?{resume:fork.sourceSessionId,forkSession:true,sessionId:this.sessionId,...(fork.resumeSessionAt?{resumeSessionAt:fork.resumeSessionAt}:{})}
        :this.startedOnce?{resume:this.sessionId}:{sessionId:this.sessionId}),
    };
    const runtime=this.sdk.query({prompt:input,options});
    // resumed: the session this query asked Claude Code to resume, which it may no longer have.
    // failure: what ended the process's messages; stopped: Stop or close ended it. foregroundSubagents: the root turn's subagent calls
    // that wait on their subagent (no result yet); subagentMoves: the moves to the background steers asked for, by call. id: what the
    // turn keys of its background tasks' rows start with (#taskRow).
    const live={id:randomUUID(),query:runtime,input,key,fork,proc,resumed:!fork&&this.startedOnce?this.sessionId:null,closed:false,sawInit:false,echoes:false,costBase:0,backgroundTasks:new Map(),foregroundSubagents:new Set(),subagentMoves:new Map(),permissionMode:policy.permissionMode,openedPermissionMode:policy.permissionMode,failure:null,stopped:false,pump:null};
    this.live=live;
    live.pump=this.#pump(live);
    Promise.resolve(runtime.initializationResult?.()).then(init=>{
      if(init&&this.live===live)this.#publishProbe(init,INVENTORY_LIVE);
    },()=>{});
    if(await this.#registerMcpServers(live))return live;
    // A process that did not connect them in time is closed, and the SDK's close waits a little for it to exit. A resumed conversation
    // then opens once more, only once the stalled process has exited, so two Claude Codes never resume one transcript at once; a new one
    // does not, since its id may already name a transcript the closed process started. Stop or close meanwhile
    // opens nothing: the closed process is the prompt's answer, which ends it as Stop asked.
    await this.#closeLive(live);
    await withTimeout(Promise.resolve().then(()=>runtime.return()),CLAUDE_CLOSE_TIMEOUT_MS).catch(()=>{});
    const stopped=()=>opening?.stopped||live.stopped||this.closed;
    const exited=reopen&&live.resumed&&!stopped()&&await this.#exited(proc);
    if(stopped())return live;
    if(exited)return this.#openLive(key,{reopen:false,opening});
    throw new Error(CLAUDE_MCP_REGISTRATION_TIMED_OUT);
  }
  // Starts each Claude Code of a query (this machine's, or a remote one through spawnProcess) and notes when it exits.
  #spawner(proc){
    return options=>{
      const child=this.spawnProcess?this.spawnProcess(options):spawnLocalClaudeCode(options,{spawnChild:this.spawnChild,onStderr:chunk=>{proc.stderrTail=(proc.stderrTail+chunk).slice(-CLAUDE_STDERR_TAIL)}});
      proc.child=child;
      proc.exit=new Promise(resolve=>{
        const done=()=>{proc.exited=true;resolve()};
        if(child.exitCode!=null||child.signalCode!=null)done();else child.once("exit",done);
      });
      return child;
    };
  }
  // True once the process has exited: one still running after the SDK's close is killed, and is given CLAUDE_EXIT_CONFIRM_MS to exit.
  async #exited(proc){
    if(!proc.child)return false;
    if(proc.exited)return true;
    try{proc.child.kill("SIGKILL")}catch{}
    return withTimeout(proc.exit,CLAUDE_EXIT_CONFIRM_MS).then(()=>true,()=>false);
  }
  // The thread's MCP servers, Trebell's in-process ones with them, before the first prompt, so their tools are there when the turn
  // starts. Every one goes each time: setMcpServers replaces the whole set Claude Code was given. False when Claude Code did not
  // answer in time (a process that ended first answers nothing more). Claude Code's init lists each server by name with its status;
  // the error setMcpServers gives for one it could not connect, which can repeat the server's headers, is not kept.
  async #registerMcpServers(live){
    const servers={...this.mcpServers};if(!Object.keys(servers).length)return true;
    const registered=Promise.resolve().then(()=>live.query.setMcpServers(servers)).catch(()=>null);
    return withTimeout(Promise.race([registered,live.pump]),CLAUDE_MCP_REGISTRATION_TIMEOUT_MS).then(()=>true,()=>false);
  }
  async #closeLive(live=this.live){
    if(!live)return;
    if(this.live===live)this.live=null;
    if(!live.closed){live.closed=true;live.input.end();try{live.query.close()}catch{}}
    await withTimeout(live.pump,CLAUDE_CLOSE_TIMEOUT_MS).catch(()=>{});
  }
  // Iterates the Query itself (its return() closes the transport).
  async #pump(live){
    let failure=null;
    try{for await(const message of {[Symbol.asyncIterator]:()=>live.query})this.#handle(live,message)}
    catch(error){failure=withStderrTail(error,live.proc)}
    live.closed=true;live.failure=failure;live.input.end();
    // Its background tasks end with it, each row in the turn it started in.
    for(const [id,task] of live.backgroundTasks)this.#taskRow(live,id,task,"failed");
    live.backgroundTasks=new Map();
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
      id:randomUUID(),promptUuid,uuids:new Set(promptUuid?[promptUuid]:[]),live,wake,echoed:!promptUuid,cursor:null,steered:false,steers:[],cancelRequested:false,
      result:null,queryError:null,cost:0,emittedText:false,separator:false,stream:null,textBlocks:new Map(),thoughtMessages:new Set(),
      authFailure:false,rateLimited:false,apiErrorText:null,rejectedLimits:new Map(),blockedLimit:null,announcedLimits:new Set(),settled:false,promise,resolve,reject,
      // requests: the usage of the turn's root requests, by message id.
      requests:new Map(),
      // notices: the texts of Claude Code's notices the turn showed; compact: compact() asked for it; compactFailure: its compaction's
      // latest status, once one failed ({message}).
      notices:new Set(),compact:false,compactFailure:null,
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
    // A turn that ended waits on no subagent call any more.
    live?.foregroundSubagents.clear();
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
    // Claude Code that has no transcript for the session it was asked to resume says so and exits before it starts the session
    // or answers: a lost session, which the relay continues once in a fresh one (startFresh) with the earlier messages handed over.
    // What was steered into the turn meanwhile went to this query, which ran none of it, so the error carries it on (steered).
    if(live?.resumed&&!live.sawInit&&!turn.emittedText){
      const said=[String(turn.queryError?.message||""),...(result?userFacingErrors(result):[])].find(text=>CLAUDE_NO_CONVERSATION.test(text));
      if(said)return turn.reject(Object.assign(new HarnessSessionLostError(`Claude Code could not resume this conversation: ${said.replace(/^Claude Code returned an error result:\s*/,"")}`,{harness:"claude",sessionId:live.resumed}),{steered:[...turn.steers]}));
    }
    // A turn the process started is in the transcript even when it failed: its ids let a later turn be edited.
    const failedIds=live?.sawInit&&turn.echoed?ids:{};
    if(!result){
      const message=String(turn.queryError?.message||"").replace(/^Claude Code returned an error result:\s*/,"");
      return turn.reject(Object.assign(new Error(message||"Claude Code ended without a result message"),failedIds));
    }
    const usageLimited=!turn.authFailure&&claudeUsageLimited(result,turn.rejectedLimits.size>0||turn.rateLimited);
    const limits=[...turn.rejectedLimits.values()],blocked=turn.blockedLimit;
    if(blocked&&!turn.rejectedLimits.has(blocked.rateLimitType||"unknown"))limits.push(blocked);
    const failureHint=turn.authFailure?claudeSignedOutMessage(this.helperSharesRuntime?"":this.env.CLAUDE_CONFIG_DIR):usageLimited?claudeUsageLimitHint(limits):null;
    // Claude Code ends a /compact whose compaction failed with a success result. compact()'s fails with Claude Code's reason, so the relay
    // never reports it compacted; a /compact sent as a message fails once the usage limit stopped it, and otherwise
    // the session's status says why.
    const compactFailed=turn.compactFailure&&(turn.compact||(usageLimited&&result.local_command==="compact"))?turn.compactFailure.message||failureHint||CLAUDE_COMPACT_FAILED:null;
    const failure=claudeResultFailure(result,{failureHint,explainedError:turn.apiErrorText})||compactFailed;
    if(failure){
      // A process that failed to authenticate keeps its stale credentials: the next prompt starts a fresh one. The kept capability probe
      // goes too, which would show the account and its plan usage for up to five minutes more.
      if(turn.authFailure){if(live)void this.#closeLive(live);this.capabilities?.drop?.(this.#probeInput(null))}
      return turn.reject(Object.assign(new Error(failure),{raw,...failedIds}));
    }
    // Claude Code repeats a notice that ended the prompt (a hook dropped it) as the result's text, which is no answer.
    if(!turn.emittedText&&result.result&&!turn.notices.has(noticeKey(result.result)))this.#emitText(turn,String(result.result),null);
    return turn.resolve({stopReason:"end_turn",...ids,raw});
  }

  #emitText(turn,text,messageId){
    if(!text)return;
    const value=turn.separator&&turn.emittedText?"\n\n"+text:text;
    turn.separator=false;turn.emittedText=true;
    this.#emit({sessionUpdate:"agent_message_chunk",content:{type:"text",text:value},messageId:messageId||null});
  }
  #emitThought(text,messageId){if(text)this.#emit({sessionUpdate:"agent_thought_chunk",content:{type:"text",text},messageId:messageId||null})}
  // live: the process whose root turn made the call; a subagent's own calls come without it.
  #toolUse(block,live=null){
    if(!block?.id)return;
    const tool={title:toolTitle(block),kind:toolKind(block.name),rawInput:block.input};
    this.tools.set(block.id,tool);
    if(live&&CLAUDE_SUBAGENT_TOOLS.has(String(block.name))&&block.input?.run_in_background!==true)live.foregroundSubagents.add(block.id);
    if(CLAUDE_TASK_TOOLS.has(String(block.name)))this.taskCalls.set(block.id,{name:String(block.name),input:block.input});
    // The root's TodoWrite list is the thread's plan; a subagent's is its own. Either edits no
    // file and is no step of the turn unless it failed (#toolResult), as with Muse Code's to-do list.
    if(block.name==="TodoWrite"){this.todoCalls.add(block.id);if(live)this.#emit({sessionUpdate:"plan",entries:claudeTodoEntries(block.input)});return}
    this.#emit({sessionUpdate:"tool_call",toolCallId:block.id,...tool,status:"in_progress"});
  }
  // structured: the tool's structured result (tool_use_result); meta: Claude Code's notes on the message's results (tool_result_meta).
  #toolResult(block,live=null,{structured,meta}={}){
    if(!block?.tool_use_id)return;
    live?.foregroundSubagents.delete(block.tool_use_id);
    const tool=this.tools.get(block.tool_use_id)||{title:"Tool",kind:"other",rawInput:{}};this.tools.delete(block.tool_use_id);
    // A TodoWrite that failed shows, as the call it is, once it ends.
    const todo=this.todoCalls.delete(block.tool_use_id);
    if(!todo||block.is_error)this.#emit({sessionUpdate:todo?"tool_call":"tool_call_update",toolCallId:block.tool_use_id,...tool,status:block.is_error?"failed":"completed",rawOutput:toolResultText(block.content)});
    // A task tool call that failed, or that never ran (cancelled), changed no task.
    const call=this.taskCalls.get(block.tool_use_id);if(!call)return;
    this.taskCalls.delete(block.tool_use_id);
    const ran=!block.is_error&&!(Array.isArray(meta)&&meta.some(item=>item?.id===block.tool_use_id&&item.non_execution_kind));
    if(ran)this.#taskTool(call,structured!==undefined?structured:toolResultText(block.content));
  }
  // A task tool's call that went through changes its Claude session's task list, which goes to the thread whole, as its plan. A session
  // this process has not followed yet (Trebell restarted, or the thread's session was started again) reads Claude Code's own list once
  // from disk, which already holds the change, unless TaskList's own list replaces it: an update then keeps every task.
  #taskTool(call,result){
    const id=this.sessionId,known=this.taskLists.get(id);
    const stored=this.taskLists.has(id)||(call.name==="TaskList"&&Array.isArray(taskField(result,"tasks")))?null:this.#storedTasks(id);
    const next=claudeTaskList(known||stored||new Map(),call.name,call.input,result)||stored;
    this.taskLists.set(id,next||known||null);
    if(next)this.#emit({sessionUpdate:"plan",entries:[...next.values()].map(task=>({...task}))});
  }
  // Claude Code's own list for the session, in its Claude home's tasks folder (CLAUDE_CODE_TASK_LIST_ID names a shared one), read only
  // where Claude Code runs on this machine.
  #storedTasks(sessionId){
    if(this.spawnProcess||!sessionId)return null;
    const configured=String(this.env?.CLAUDE_CONFIG_DIR||"").trim(),home=configured?resolve(this.cwd||".",configured):join(homedir(),".claude");
    const list=String(this.env?.CLAUDE_CODE_TASK_LIST_ID||"").trim()||String(sessionId);
    return readClaudeTaskStore(join(home,"tasks",list.replace(/[^a-zA-Z0-9_-]/g,"-")));
  }

  #handle(live,message){
    if(!message||typeof message!=="object")return;
    const type=message.type,subtype=message.subtype,root=!message.parent_tool_use_id;
    if(type==="system"&&(subtype==="init"||subtype==="status")&&message.permissionMode)live.permissionMode=message.permissionMode;
    if(type==="system"&&subtype==="init"){
      // Claude Code reports its mode at the start of every turn; the first report is the mode it opened in, which can be a fallback
      // from the one asked for.
      if(!live.sawInit&&message.permissionMode)live.openedPermissionMode=message.permissionMode;
      live.sawInit=true;this.sessionId=message.session_id||this.sessionId;this.startedOnce=true;
      if(typeof message.model==="string"&&message.model.trim())live.model=message.model.trim();
      if(this.turn?.live===live&&!this.turn.settled)this.#delivered(this.turn);
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
    if(type==="system"&&subtype==="status"){
      // Claude Code's reason for a compaction that failed goes with the result (provider-session-status.js shows it), and its turn keeps
      // it for the /compact that fails with it (#finishTurn).
      const compactError=message.compact_result==="failed"?redactApiErrorText(plainText(message.compact_error))||null:null,turn=this.#liveTurn(live);
      if(turn&&message.compact_result!==undefined)turn.compactFailure=message.compact_result==="failed"?{message:compactError}:null;
      this.#publishInventory({},{status:message.status??null,permissionMode:message.permissionMode,compactResult:message.compact_result,...(compactError?{compactError}:{})});
      return;
    }
    if(type==="system"&&subtype==="compact_boundary"){this.#compacted(live,message);return}
    if(type==="system"&&(subtype==="model_refusal_fallback"||(subtype==="informational"&&message.level!=="info"))){this.#notice(live,message);return}
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
    if(type==="stream_event"){if(root)this.#streamEvent(live,turn,message.event||{});return}
    if(type==="assistant"){
      const blocks=Array.isArray(message.message?.content)?message.message.content:[];
      if(!root){for(const block of blocks)if(block?.type==="tool_use")this.#toolUse(block);return}
      // A synthetic API-error message: its text is the error the result reports, never an answer.
      if(message.error){
        turn.rateLimited=message.error==="rate_limit";if(message.error==="authentication_failed")turn.authFailure=true;
        turn.apiErrorText=claudeExplainedApiError(message);
        // A reply the limit blocked repeats the rejected window, so a quick retry still says when it resets. It is the turn's evidence
        // only until a later reply goes through, unlike a window Claude Code itself rejected.
        turn.blockedLimit=claudeRejectedLimit(message);if(turn.blockedLimit)this.#announceLimit(turn,turn.blockedLimit);
        return;
      }
      turn.rateLimited=false;turn.apiErrorText=null;turn.blockedLimit=null;
      if(message.uuid)turn.cursor=message.uuid;
      this.#snapshotUsage(live,turn,message.message);
      const messageId=message.message?.id||null;
      for(const block of blocks){
        if(block?.type==="text"&&block.text)this.#snapshotText(turn,messageId,block.text,message.uuid);
        else if(block?.type==="thinking"&&block.thinking&&!turn.thoughtMessages.has(messageId))this.#emitThought(block.thinking,message.uuid);
        else if(block?.type==="tool_use")this.#toolUse(block,live);
      }
      return;
    }
    if(type==="user"){
      // A tool's structured result comes with a message that answers one call; a subagent's call returns only its text.
      const results=(Array.isArray(message.message?.content)?message.message.content:[]).filter(block=>block?.type==="tool_result");
      for(const block of results)this.#toolResult(block,live,{structured:results.length===1?message.tool_use_result:undefined,meta:message.tool_result_meta});
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
  #streamEvent(live,turn,event){
    if(event.type==="message_start"){
      turn.stream={id:event.message?.id||null,blocks:new Map()};
      // The request's usage, which its message_delta then completes; one that comes without it is not measured.
      const usage=event.message?.usage;
      this.request=usage&&typeof usage==="object"?{id:event.message?.id||null,usage:{...usage}}:null;
      if(this.request)this.#requestUsage(live,turn);
      return;
    }
    if(event.type==="message_delta"){
      if(this.request?.usage&&event.usage&&typeof event.usage==="object"){this.request.usage=mergedUsage(this.request.usage,event.usage);this.#requestUsage(live,turn)}
      return;
    }
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
  // An assistant snapshot repeats its request's message_start usage, which some proxies send as zeros: it reports a request the stream
  // did not, or fills in a prompt the stream left out. Claude Code's own <synthetic> frames measure no request.
  #snapshotUsage(live,turn,body){
    const usage=body?.usage;if(!usage||typeof usage!=="object"||body.model==="<synthetic>")return;
    const id=body.id||null,request=this.request;
    if(!request||request.id!==id){this.request={id,usage:{...usage}};this.#requestUsage(live,turn)}
    else if(request.usage&&promptTokens(request.usage)<=0&&promptTokens(usage)>0){request.usage={...usage,output_tokens:Math.max(tokens(usage.output_tokens),tokens(request.usage.output_tokens))};this.#requestUsage(live,turn)}
  }
  // One root request's usage as the context meter reads it: its prompt is the context, which usage without input never is (some proxies
  // send zeros), and its tokens join the turn's so far, the total until the turn's result gives it. A turn's first request ends the
  // reading of the turn before, whose cost its own result brings.
  #requestUsage(live,turn){
    const request=this.request,usage=request?.usage;if(!usage||promptTokens(usage)<=0)return;
    if(!turn.requests.size){this.meter.cost=null;this.meter.modelUsage=null}
    request.key??=request.id||randomUUID();turn.requests.set(request.key,usage);
    this.meter.usage=summedUsage(turn.requests);this.meter.context=contextReading(usage);this.meter.turn=turn;
    this.#emitMeter(live);
  }
  // A compaction leaves the request it ended stale, whose later deltas measure what it removed: the context is what it kept, once Claude
  // Code says how much.
  #compacted(live,message){
    if(this.request)this.request.usage=null;
    const kept=tokens(message.compact_metadata?.post_tokens);if(!kept)return;
    this.meter.context={totalTokens:kept,inputTokens:kept,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:0};
    this.#emitMeter(live);
  }
  // The result keeps its turn's usage and cost as the total (main-loop tokens, as its requests gave them); one that has no tokens (a
  // /compact's) leaves the total shown.
  #usage(live,turn,result){
    const total=Number(result?.total_cost_usd);
    const cost=Number.isFinite(total)?Math.max(0,total-live.costBase):0;
    if(Number.isFinite(total))live.costBase=total;
    if(turn)turn.cost=cost;
    const used=usageTotal(result?.usage||{});
    if(!used&&!cost)return;
    if(used){this.meter.usage=result.usage;this.meter.modelUsage=result.modelUsage||null;this.meter.turn=turn}
    this.meter.cost=cost;this.meter.costTurn=turn;
    this.#emitMeter(live);
  }
  // The context meter: the latest turn's tokens and its result's cost as the total, and the latest root request's prompt (or what a
  // compaction kept) as the context, against the window Claude Code measures this model's context by. Until the live turn's first
  // request (or its own result with tokens) the tokens are an earlier turn's: they still show, but carried tells the relay they are not
  // this turn's usage, and a cost goes with them only when it is this turn's own (a /compact's, or what background agents spent).
  #emitMeter(live){
    const {usage,modelUsage,context}=this.meter,size=context?this.#contextWindow(live)||0:0,turn=this.#liveTurn(live);
    const carried=Boolean(turn)&&this.meter.turn!==turn,cost=carried&&this.meter.costTurn!==turn?null:this.meter.cost;
    this.#emit({sessionUpdate:"usage_update",used:usageTotal(usage||{}),size,...(cost!=null?{cost:{amount:cost,currency:"USD"}}:{}),usage:usage||null,modelUsage:modelUsage||null,...(context?{context:{...context}}:{}),...(carried?{carried:true}:{})});
  }
  // The window of Claude Code's own context reading (its /context window: the model's, or the profile's autoCompactWindow below it),
  // asked once per model; the meter shows the percentage once it answers. A Claude Code that cannot say leaves the token count alone,
  // and a process that ended first leaves the question to the next one.
  #contextWindow(live){
    const model=String(live?.model||"");if(!model)return null;
    const known=this.contextWindows.get(model);if(known)return known.value;
    const entry={value:null};this.contextWindows.set(model,entry);
    Promise.resolve().then(()=>live.query.getContextUsage({detail:"summary"})).then(answer=>{
      entry.value=tokens(answer?.rawMaxTokens)||null;
      if(entry.value&&this.meter.context&&this.live===live&&!this.closed)this.#emitMeter(live);
    },()=>{if(live.closed&&this.contextWindows.get(model)===entry)this.contextWindows.delete(model)});
    return null;
  }
  #liveTurn(live){return this.turn&&this.turn.live===live&&!this.turn.settled?this.turn:null}
  // Claude Code's own notice (a hook's reason for dropping the prompt, a switch to the fallback model after a refusal), shown as a
  // finished row of its turn, as the usage-limit notice is; the result's text that repeats it is no answer.
  #notice(live,message){
    const turn=this.#liveTurn(live),text=plainText(message.content);if(!turn||!text)return;
    turn.notices.add(noticeKey(text));
    this.#emit({sessionUpdate:"tool_call",toolCallId:`claude-notice:${message.uuid||randomUUID()}`,title:text,kind:"other",status:"completed",rawInput:{},rawOutput:message});
  }
  // Claude Code's background tasks (its shells and agents in the background), listed whole on each change; an ambient one is no work
  // of the thread's. Each has a row that runs on past the turn it started in (runsPastTurn) and stays in that turn (turnKey), until
  // Claude Code no longer lists it, or its process ends (#pump), which ends it too. Meanwhile a read of the thread says it still runs
  // (followsWork), as Muse Code's work past its turn does.
  #backgroundTasks(live,message){
    const next=new Map();
    for(const task of Array.isArray(message.tasks)?message.tasks:[])if(task?.task_id&&!task.ambient)next.set(task.task_id,task);
    for(const [id,task] of live.backgroundTasks)if(!next.has(id))this.#taskRow(live,id,task,"completed");
    for(const [id,task] of next)if(!live.backgroundTasks.has(id))this.#taskRow(live,id,task,"in_progress");
    live.backgroundTasks=next;
  }
  #taskRow(live,id,task,status){
    const title=task.description||task.task_type||"Background task";
    this.#emit({sessionUpdate:"tool_call_update",toolCallId:id,title:status==="failed"?`${title}: ${CLAUDE_TASK_STOPPED}`:title,kind:"other",status,rawOutput:task,runsPastTurn:true},`${live.id}:${id}`);
  }
  // Whether the row of that id is of a background task this session's Claude Code still runs, which a read of the thread says still
  // runs (agent-relay withLiveWork).
  followsWork(id){const live=this.live;return Boolean(live&&!live.closed&&live.backgroundTasks.has(String(id||"")))}
  // A rejected usage window pauses the turn: say so once per window and reset time.
  #rateLimit(message){
    const info=message.rate_limit_info,turn=this.turn&&!this.turn.settled?this.turn:null;if(!info||!turn)return;
    const overage=info.overageStatus==="allowed"||info.overageStatus==="allowed_warning"||info.isUsingOverage===true||info.overageInUse===true;
    const limitType=info.rateLimitType||"unknown";
    if(info.status==="rejected"&&!overage){turn.rejectedLimits.set(limitType,info);this.#announceLimit(turn,info)}
    else if(info.status==="allowed"||info.status==="allowed_warning"||overage)turn.rejectedLimits.delete(limitType);
  }
  #announceLimit(turn,info){
    const key=`${info.rateLimitType||"unknown"}:${info.resetsAt??"unknown"}`;
    if(turn.announcedLimits.has(key))return;
    turn.announcedLimits.add(key);
    this.#emit({sessionUpdate:"tool_call",toolCallId:`usage-limit:${turn.id}:${key}`,title:describeClaudeUsageLimit(info),kind:"other",status:"completed",rawInput:{},rawOutput:info});
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
    if(disposition==="deny")return {behavior:"deny",message:"Trebell read-only mode denied this tool.",toolUseID};
    // What Claude Code forwards in Full access, in Plan mode (whatever plan mode does not allow) or for an ask rule in any mode (the
    // SDK's matchedAskRule: the person's own wish to be asked) is the person's to decide: askUser
    // keeps the relay from accepting it for Trebell's policy.
    const fullAccess=this.permissionMode==="full",rule=options?.matchedAskRule&&typeof options.matchedAskRule==="object"?options.matchedAskRule:null;
    const askUser=fullAccess||this.collaborationMode==="plan"||Boolean(rule);
    if(disposition==="allow"&&!askUser)return {behavior:"allow",updatedInput:input,toolUseID};
    const once=options?.suppressAlwaysAllowRule===true||options?.defaultToNo===true;
    const choices=[
      {optionId:"allow_once",name:"Allow once",kind:"allow_once"},
      ...(once?[]:[{optionId:"allow_always",name:"Allow for this session",kind:"allow_always"}]),
      {optionId:"reject_once",name:"Reject",kind:"reject_once"},
    ];
    const prompt=claudePermissionPrompt(toolName,input,options),liveMode=this.live?.permissionMode||null;
    const lead=claudeAskLead({fullAccess,planMode:this.collaborationMode==="plan"||liveMode==="plan",liveMode,rule});
    let decision="decline";
    try{
      decision=await untilAborted(this.onPermission?.({
        method:"claude/canUseTool",
        params:{toolCall:{title:plainText(options?.title)||plainText(options?.displayName)||toolName,toolCallId:toolUseID,rawInput:input,kind:toolKind(toolName)},toolName,input,prompt:lead?`${lead}: ${prompt}`:prompt},
        options:choices,
        ...(askUser?{askUser:true}:{}),
        ...(once?{approvalOptions:CLAUDE_ONCE_OPTIONS.map(option=>({...option}))}:{}),
      }),options?.signal,"cancel")||"decline";
    }catch{decision="decline"}
    // A request decided once is never granted for the session, whatever the answer asks.
    if(once&&decision==="acceptForSession")decision="accept";
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
