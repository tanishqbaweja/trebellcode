import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { claudeCapabilities, claudeModelCatalog } from "./claude-capabilities.mjs";
import { linkedFileLine } from "./prompt-attachments.mjs";
import { HarnessSessionLostError } from "./harness-session-lost.mjs";
import { normalizePermissionMode, permissionDisposition } from "./permission-policy.mjs";
import { runtimeInstructions } from "./runtime-instructions.mjs";
import { redactSecretText } from "./secret-redactor.mjs";
import { SessionRefusalError } from "./session-refusal.mjs";
import { resolveWindowsCommandShim } from "./windows-command-shim.mjs";

// The Claude Agent SDK loads with the first session that starts, not with the server (budget B25).
let claudeAgentSdk=null;
const loadClaudeAgentSdk=()=>claudeAgentSdk??=import("@anthropic-ai/claude-agent-sdk");

// One long-lived streaming-input Claude Code query per thread: every prompt is an SDK
// user message offered to the live process (so steering, interrupts and background tasks work), and the process is replaced
// only when its launch policy (permission mode, tools, model, effort, agent) changes, after Stop, rewind or idle release.
export const CLAUDE_READ_ONLY_TOOLS=Object.freeze(["Read","Glob","Grep"]);
export const CLAUDE_IDLE_RELEASE_MS=30*60_000;
// How long a turn's background agents and commands keep the idle Claude Code process: Trebell's own choice, eight hours, the same as
// Muse Code's hold (muse-agent-session MUSE_MAX_IDLE_PIN_MS) for the same reason. The process is closed when the hold ends, which
// stops any of that work still running, so the hold outlasts a working day's quiet work and the four hours 2.1.2 gave; a process
// whose work's end never arrived is kept that long.
export const CLAUDE_MAX_IDLE_PIN_MS=8*60*60_000;
export const CLAUDE_PLAN_CAPTURED="Trebell Code has shown your plan to the user. Stop here: the user answers with feedback, or asks you to carry it out, in a later turn.";
// A change of model or settings needs a new Claude Code process, which ends the background agents and commands of the one it replaces.
export const CLAUDE_BACKGROUND_WORK_BLOCKS_CHANGE="Changing the model or settings now would restart Claude Code and end the background agents and commands Claude is still running. Let them finish or ask Claude to stop them, or keep the current model and settings, then send the message again.";
// Nothing the person changed: Claude switched itself to Plan, and Claude Code refuses to leave it while its background work pins the process.
// Work that never ends by itself (a watcher) would hold every message back until the process is released, up to CLAUDE_MAX_IDLE_PIN_MS
// (8 hours): Edit from here
// on the refused message ends the process, and the work with it (rewindConversation closes it), and gives the message back to send.
export const CLAUDE_PLAN_STUCK="Claude Code could not leave the Plan mode Claude switched to, and restarting it would end the background agents or commands it is still running. Wait for them to finish, then send the message again. To end them now, choose Edit from here on this message and send it again.";
export const CLAUDE_USAGE_LIMIT_HINT="Claude Code has used up its usage allowance. Try the message again when it resets.";
const CLAUDE_THREAD_TOO_LONG="Claude Code ended the turn: this thread has grown past the model's context window. Compact it with /compact, or continue in a new thread.";
// What the model reads as the outcome of a tool call the person did not let run (the deny message of a PermissionResult).
const CLAUDE_CALL_DENIED="The user denied this tool call in Trebell Code, so it did not run.";
const CLAUDE_CALL_CANCELLED="The approval for this tool call was cancelled in Trebell Code before the user answered, so it did not run.";
const CLAUDE_QUESTIONS_UNANSWERED="The user closed these questions in Trebell Code without answering them.";
// How long Claude Code has to answer the registration of a thread's MCP servers, which the SDK gives no deadline. Claude Code's
// environment variable reference says it gives a server up to 30 s to start (MCP_TIMEOUT, default 30000) and starts local (stdio)
// servers three at a time (MCP_SERVER_CONNECTION_BATCH_SIZE, default 3). Trebell's own 2 minutes is four such rounds, twelve local
// servers that each take their whole time, where 2.1.2's 90 s held nine; a registration that runs out fails the prompt saying so.
const MCP_ANSWER_BOUND_MS=120_000;
export const CLAUDE_MCP_REGISTRATION_TIMED_OUT=`Claude Code did not finish connecting this thread's MCP servers within ${MCP_ANSWER_BOUND_MS/60_000} minutes. Send the message again; if it keeps timing out, check the MCP servers in Settings.`;
// How long a steer holds its message, counted from the steer, while the root turn's foreground subagents move to the background:
// Trebell's own 8 s. Claude Code moves them at once when it can, and the person's message waits no longer than that when it cannot.
const STEER_HOLD_MS=8_000;
// The tools that run a subagent (Agent, called Task before).
const CLAUDE_SUBAGENT_TOOLS=new Set(["Agent","Task"]);
// Claude Code's task tools (on by default where the model supports them, or with CLAUDE_CODE_ENABLE_TODO_TOOLS=1): their results keep
// one task list per Claude session, the root's and its subagents' alike, shown as the thread's plan as a TodoWrite list is.
const CLAUDE_TASK_TOOLS=new Set(["TaskCreate","TaskUpdate","TaskList"]);
// The states a task or a to-do shows in the plan.
const TASK_STATES=new Set(["pending","in_progress","completed"]);
export const CLAUDE_COMPACT_FAILED="Claude Code could not compact its context.";
// What the row of a background task says when its Claude Code ended first (Stop, Edit from here, its release or its exit), which ends it.
const CLAUDE_TASK_STOPPED="Claude Code stopped before this finished.";
const CLAUDE_EFFORTS=new Set(["low","medium","high","xhigh","max"]);
const CLAUDE_IMAGE_TYPES=new Set(["image/gif","image/jpeg","image/png","image/webp"]);
const CLAUDE_INTERRUPT_TIMEOUT_MS=10_000;
const CLAUDE_CLOSE_TIMEOUT_MS=5_000;
// How long a killed Claude Code has to exit before a stalled resumed conversation is not opened again: a killed process ends at
// once, so it gets as long as a close does.
const CLAUDE_EXIT_CONFIRM_MS=CLAUDE_CLOSE_TIMEOUT_MS;
// The end of a Claude Code's stderr Trebell keeps, as the SDK keeps 2,048 characters of its own processes'.
const CLAUDE_STDERR_TAIL=4096;
// API errors Claude Code does not retry, whose own error message names the problem (an unknown model, a bad request, an
// account or billing issue): that message is the turn's error, not the sentence for an API that failed again and again.
const CLAUDE_EXPLAINED_API_ERRORS=new Set(["invalid_request","model_not_found","billing_error","oauth_org_not_allowed","account_on_hold","verification_required","cloud_credential_error"]);
// Whether a message id has the form of a UUID (hexadecimal groups of 8, 4, 4, 4 and 12 characters), which Claude Code takes as the
// uuid of the user message it carries.
const UUID_GROUP_LENGTHS=[8,4,4,4,12],HEX_DIGITS=/^[0-9a-f]+$/i;
function hasUuidForm(value){
  const groups=String(value).split("-");
  return groups.length===UUID_GROUP_LENGTHS.length&&groups.every((group,index)=>group.length===UUID_GROUP_LENGTHS[index]&&HEX_DIGITS.test(group));
}
// What Claude Code prints, and exits on, when it is asked to resume a session it has no transcript for.
const CLAUDE_NO_CONVERSATION=/No conversation found with session ID/i;

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
// A tool result's content as text: a string as it is, the text blocks of a list one per line, anything else as JSON.
function toolResultText(content){
  if(content===null||content===undefined)return "";
  if(typeof content==="string")return content;
  if(!Array.isArray(content))return JSON.stringify(content);
  const lines=[];
  for(const item of content){const line=item?.type==="text"?String(item.text||""):"";if(line)lines.push(line)}
  return lines.join("\n");
}
function usageTotal(usage={}){
  return Number(usage.input_tokens||0)+Number(usage.cache_creation_input_tokens||0)+Number(usage.cache_read_input_tokens||0)+Number(usage.output_tokens||0);
}
const tokens=value=>Math.max(0,Math.round(Number(value))||0);
// The counters of one request's usage, the first three of which add up to the prompt it sent.
const REQUEST_COUNTERS=Object.freeze(["input_tokens","cache_creation_input_tokens","cache_read_input_tokens","output_tokens"]);
const PROMPT_COUNTERS=REQUEST_COUNTERS.slice(0,3);
function promptSize(usage){
  let size=0;
  for(const counter of PROMPT_COUNTERS)size+=tokens(usage?.[counter]);
  return size;
}
// A message_delta reports its message so far: each counter it gives a value for is the request's now, and every counter it leaves
// out (or null) stays as message_start gave it.
function withDelta(requestUsage,delta){
  const next={...requestUsage};
  for(const counter of REQUEST_COUNTERS){const value=delta[counter];if(value!==null&&value!==undefined)next[counter]=value}
  return next;
}
// What an assistant snapshot's usage makes of the open root request (null: nothing). The snapshot repeats its request's
// message_start usage: for a message the stream did not report it opens that request; for the open one whose prompt the stream gave
// as zeros (as some proxies do) its own prompt is taken, with the larger of the two output counts.
function requestFromSnapshot(open,messageId,usage){
  if(!open||open.id!==messageId)return {id:messageId,usage:{...usage}};
  if(!open.usage||promptSize(open.usage)>0||promptSize(usage)<=0)return null;
  const outputTokens=Math.max(tokens(usage.output_tokens),tokens(open.usage.output_tokens));
  return {...open,usage:{...usage,output_tokens:outputTokens}};
}
// The tokens of a turn's root requests so far, which its result's main-loop usage gives once it ends.
function summedUsage(requests){
  const sum={input_tokens:0,cache_creation_input_tokens:0,cache_read_input_tokens:0,output_tokens:0};
  for(const usage of requests.values())for(const key of Object.keys(sum))sum[key]+=tokens(usage?.[key]);
  return sum;
}
// The context meter's reading of one request: its prompt, as the relay's last request.
function contextReading(usage){
  const input=promptSize(usage),output=tokens(usage?.output_tokens);
  return {totalTokens:input+output,inputTokens:input,cachedInputTokens:tokens(usage?.cache_read_input_tokens),cacheWriteInputTokens:tokens(usage?.cache_creation_input_tokens),outputTokens:output};
}

// A field of a to-do or a task tool's input or result as text: a string that is not blank, trimmed, else undefined. These shapes are
// no typed SDK contract, so anything else reads as missing.
function filled(record,key){
  if(!record||typeof record!=="object")return undefined;
  const value=record[key];
  if(typeof value!=="string")return undefined;
  return value.trim()||undefined;
}
// A TodoWrite's list as plan entries.
export function claudeTodoEntries(input){
  return (Array.isArray(input?.todos)?input.todos:[]).flatMap(todo=>{
    const content=filled(todo,"content");
    return content?[{content,status:TASK_STATES.has(todo.status)?todo.status:"pending"}]:[];
  });
}

// Claude Code's task tools keep one list per Claude session. Each task is {content: its subject, status}, by its id.
// A task record (a TaskList row, a file of Claude Code's own list) as {id, task}, or null when it lacks an id, a subject or a state
// the plan shows.
function shownTask(record){
  const id=filled(record,"id"),content=filled(record,"subject");
  if(!id||!content||!TASK_STATES.has(record.status))return null;
  return {id,task:{content,status:record.status}};
}
// What Claude Code answers a TaskCreate with, in text: "Task #<id> created successfully: <subject>".
const CREATED_LEAD="Task #",CREATED_WORDS=" created successfully: ";
function createdFromText(text){
  const line=text.trim();
  if(!line.startsWith(CREATED_LEAD))return null;
  const rest=line.slice(CREATED_LEAD.length),idEnd=rest.search(/\s/);
  if(idEnd<1||!rest.startsWith(CREATED_WORDS,idEnd))return null;
  const subject=rest.slice(idEnd+CREATED_WORDS.length).trim();
  return subject?{id:rest.slice(0,idEnd),subject}:null;
}
// The task a TaskCreate made, from its structured result (the subject the call asked for when the result names none) or its text.
function createdTask(input,result){
  if(typeof result==="string")return createdFromText(result);
  const made=result&&typeof result==="object"?result.task:undefined;
  const id=filled(made,"id"),subject=filled(made,"subject")??filled(input,"subject");
  return id&&subject?{id,subject}:null;
}
// Whether Claude Code says a TaskUpdate went through: its structured result does unless it says success false; its text does only
// as its own "Updated task #..." line (any other text is why it refused).
function updateWentThrough(result){
  if(typeof result==="string")return result.trim().startsWith("Updated task #");
  return !(result&&typeof result==="object"&&result.success===false);
}
// A TaskUpdate that went through changes the task it names (by the input's taskId, else the result's): status "deleted" drops it,
// otherwise a subject that is not blank and a known status replace the task's.
function afterUpdate(tasks,input,result){
  if(!updateWentThrough(result))return null;
  const id=filled(input,"taskId")??filled(result,"taskId"),task=id===undefined?undefined:tasks.get(id);
  if(!task)return null;
  if(input?.status==="deleted")return new Map(Array.from(tasks).filter(([key])=>key!==id));
  const changed={content:filled(input,"subject")??task.content,status:TASK_STATES.has(input?.status)?input.status:task.status};
  const same=changed.content===task.content&&changed.status===task.status;
  return same?null:new Map(tasks).set(id,changed);
}
// TaskList's structured list is the whole list: it replaces the one kept, unless both are empty. Its text is not read.
function afterListing(tasks,result){
  const rows=result&&typeof result==="object"?result.tasks:undefined;
  if(!Array.isArray(rows))return null;
  const next=new Map();
  for(const row of rows){const shown=shownTask(row);if(shown)next.set(shown.id,shown.task)}
  return next.size===0&&tasks.size===0?null:next;
}
// The list after a task tool's call went through, as a new Map, or null when the call changed nothing the plan shows.
// result: the tool's structured result, or its text, which is all a subagent's call returns.
export function claudeTaskList(tasks,name,input,result){
  switch(name){
    case "TaskList":return afterListing(tasks,result);
    case "TaskCreate":{
      const made=createdTask(input,result);
      return made?new Map(tasks).set(made.id,{content:made.subject,status:"pending"}):null;
    }
    case "TaskUpdate":return afterUpdate(tasks,input,result);
    default:return null;
  }
}
// Claude Code's own list for a session on disk: one file a task in the list's folder, named by the task's number, which Claude Code
// writes before the call's result comes. Tasks in number order; null when the folder cannot be listed. Its own bookkeeping tasks
// (metadata._internal) and whatever is no task (a directory, a file cut short, its .highwatermark) are left out.
const TASK_FILE=/^(\d+)\.json$/;
function readJsonFile(path){try{return JSON.parse(readFileSync(path,"utf8"))}catch{return null}}
function bookkeepingTask(record){
  const metadata=record.metadata;
  return metadata!==undefined&&(!metadata||typeof metadata!=="object"||Boolean(metadata._internal));
}
export function readClaudeTaskStore(folder){
  let entries;
  try{entries=readdirSync(folder)}catch{return null}
  const numbered=[];
  for(const entry of entries){const match=TASK_FILE.exec(entry);if(match)numbered.push({entry,number:Number(match[1])})}
  numbered.sort((a,b)=>a.number-b.number);
  const tasks=new Map();
  for(const {entry} of numbered){
    const record=readJsonFile(join(folder,entry));
    const shown=record&&typeof record==="object"&&!bookkeepingTask(record)?shownTask(record):null;
    if(shown)tasks.set(shown.id,shown.task);
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
// expands a slash command or skill only from the last text block, so the user's own text stays last. A linked file gets Trebell's
// attachment line (linkedFileLine): its path, and for a document the file its text was extracted to as well.
export function claudeUserContent(parts=[]){
  const images=[],texts=[],links=[];
  for(const part of Array.isArray(parts)?parts:[]){
    if(part?.type==="image"){
      const mimeType=String(part.mimeType||part.mime_type||"").trim().toLowerCase();
      if(!CLAUDE_IMAGE_TYPES.has(mimeType))throw new Error(`Claude Code takes PNG, JPEG, GIF and WebP images, not '${mimeType||"unknown"}'.`);
      images.push({type:"image",source:{type:"base64",media_type:mimeType,data:String(part.data||"")}});
    }else if(part?.type==="resource_link")links.push({type:"text",text:linkedFileLine(part)});
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

// The permission updates that grant "Allow for this session" (PermissionUpdate[]). What Claude Code suggested is granted as it
// suggested it, but for this session only: never written to the user, project or local settings it named. When it suggested
// nothing, the grant is a session rule that allows the tool.
export function claudeSessionGrant(toolName,suggestions){
  const suggested=Array.isArray(suggestions)?suggestions:[];
  if(suggested.length===0)return [{type:"addRules",rules:[{toolName}],behavior:"allow",destination:"session"}];
  return suggested.map(update=>({...update,destination:"session"}));
}
// Claude Code's own text for a request (its prompt sentence, subtitle, reason or ask rule) can carry its renderer's terminal escapes.
function plainText(value){return typeof value==="string"?stripVTControlCharacters(value).trim():""}
// A notice's text as the result that repeats it gives it.
function noticeKey(value){return plainText(String(value??"")).replace(/\s+/g," ")}

// The approval card's text.
// Claude Code's tools name what a call acts on in one of these input fields (sdk-tools.d.ts): the command of Bash, PowerShell and
// Monitor, the file of Read, Write and Edit, the notebook of NotebookEdit, the folder of Glob and Grep. The first with text is it.
const ACTED_ON=Object.freeze(["command","file_path","notebook_path","path"]);
// The card shows at most this much of a command or path, of a tool's input or of Claude Code's reason; a cut text ends in "...".
const CARD_TEXT_MAX=500;
// Between the tool's command or path and Claude Code's own sentence, as Trebell separates parts of a line elsewhere.
const CARD_PART_GAP=" · ";
function bounded(text,max){return text.length>max?`${text.slice(0,max-3)}...`:text}
function actedOn(input){return ACTED_ON.map(field=>filled(input,field)).find(Boolean)??""}
// A tool's input as JSON; nothing for one JSON cannot write (a BigInt).
function inputJson(input){
  try{return JSON.stringify(input??{})??""}catch{return ""}
}
// What the card says is to be approved. Claude Code's sentence (its title, else its subtitle, else its reason) stands alone when it
// names the command or path; otherwise the tool and the command or path come first, since Claude Code's sentence for a command can
// be the model's own description of it ("Run node one-liner printing trebell-tour"); with neither, the tool's input shows.
function approvalSubject(tool,target,sentence,input){
  if(!target)return sentence||`${tool}: ${bounded(inputJson(input),CARD_TEXT_MAX)}`;
  if(sentence.includes(target))return sentence;
  const named=`${tool}: ${bounded(target,CARD_TEXT_MAX)}`;
  return sentence?named+CARD_PART_GAP+sentence:named;
}
// The card's text: the subject, then why Claude Code asks (its decisionReason) in parentheses, unless the subject says it already.
export function claudePermissionPrompt(toolName,input,options={}){
  const reason=bounded(plainText(options?.decisionReason),CARD_TEXT_MAX);
  const sentence=[options?.title,options?.description].map(plainText).find(Boolean)||reason;
  const subject=approvalSubject(String(toolName||"Tool"),actedOn(input),sentence,input);
  if(!reason||subject.includes(reason))return subject;
  return `${subject} (${reason})`;
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

// Usage windows (the SDK's SDKRateLimitInfo, sent in a rate_limit_event).
// A window's type, as the turn keeps its windows by it.
const windowType=info=>info?.rateLimitType||"unknown";
// The statuses that let requests through, of a window and of the account's extra usage alike.
const PASSING=new Set(["allowed","allowed_warning"]);
// Whether the account's extra usage takes over once a window is used up: it may be used, or it is in use.
function extraUsageCovers(info){return [info.isUsingOverage,info.overageInUse].includes(true)||PASSING.has(info.overageStatus)}
// Whether a window lets requests through again: its own status passes, or the extra usage covers it.
function windowPasses(info){return extraUsageCovers(info)||PASSING.has(info.status)}
// How a notice names a window. A type names the window's span, and a weekly window's type can add what it covers: one model's use,
// or the extra usage as well. "overage" is the extra usage itself. Any other type is the account's usage allowance.
const SOME_ALLOWANCE="its usage allowance",WEEKLY_LEAD="seven_day_";
const SPAN_NAMES=new Map([["overage","its extra usage"],["five_hour","its five-hour allowance"],["seven_day","its weekly allowance"]]);
const WEEKLY_COVERS=new Map([["opus","its weekly Opus allowance"],["sonnet","its weekly Sonnet allowance"],["overage_included","its weekly allowance, extra usage included"]]);
function allowanceName(type){
  if(typeof type!=="string")return SOME_ALLOWANCE;
  const covers=type.startsWith(WEEKLY_LEAD)?WEEKLY_COVERS.get(type.slice(WEEKLY_LEAD.length)):undefined;
  return SPAN_NAMES.get(type)??covers??SOME_ALLOWANCE;
}
const MINUTE_MS=60_000,MOST_MINUTES=30*24*60;
// A wait in words: whole hours, then the minutes left over, each only when there are some ("45 min", "2 h", "1 h 30 min").
function spokenWait(minutes){
  const hours=Math.trunc(minutes/60),leftOver=minutes-hours*60;
  const hourWords=hours?`${hours} h`:"",minuteWords=leftOver||!hours?`${leftOver} min`:"";
  return hourWords&&minuteWords?`${hourWords} ${minuteWords}`:hourWords||minuteWords;
}
// The wait until a reset at resetsAt (Unix seconds), in whole minutes rounded up, as words, or null: no reset given, one already
// past, or one more than 30 days off, which is no wait worth stating (a missing or odd reset reads as NaN and fails the test).
function waitFor(resetsAt,nowMs){
  const atMs=Number(resetsAt)*1000,minutes=Math.ceil((atMs-nowMs)/MINUTE_MS);
  const stated=atMs>0&&minutes>=1&&minutes<=MOST_MINUTES;
  return stated?spokenWait(minutes):null;
}
// The notice of a turn Claude Code holds back on a used-up window: which allowance, and how long until it resets when that is known.
export function claudeUsagePauseNotice(info={},nowMs=Date.now()){
  const wait=waitFor(info?.resetsAt,nowMs);
  return `Claude Code has used up ${allowanceName(info?.rateLimitType)}. The turn waits until it resets${wait?`, in ${wait}`:""}.`;
}
// The error of a turn that ended on used-up windows (their rate_limit_info). A message can go through only once every one of them
// has reset, so the wait is until the latest reset, and it is given only when each window says when it resets. Only a single window
// is named.
export function claudeUsageLimitHint(limits=[],nowMs=Date.now()){
  let latest=null;
  for(const info of limits){
    const resetsAt=Number(info?.resetsAt);
    if(!Number.isFinite(resetsAt)||resetsAt<=0)return CLAUDE_USAGE_LIMIT_HINT;
    latest=latest===null?resetsAt:Math.max(latest,resetsAt);
  }
  const wait=latest===null?null:waitFor(latest,nowMs);
  if(!wait)return CLAUDE_USAGE_LIMIT_HINT;
  const name=limits.length>1?SOME_ALLOWANCE:allowanceName(limits[0]?.rateLimitType);
  return `Claude Code has used up ${name}. Try the message again when it resets, in ${wait}.`;
}
// The window a message says Claude Code refused, or null. A rate_limit_event carries it; so does a reply the limit blocked (an
// assistant frame with the rate_limit error), in its api_error_params, which Claude Code sends each time while it holds back an
// unchanged event. A window the extra usage covers is not refused.
export function claudeRefusedWindow(message){
  let info=null;
  switch(message?.type){
    case "rate_limit_event":info=message.rate_limit_info;break;
    case "assistant":if(message.error==="rate_limit")info=message.api_error_params?.rate_limit_info;break;
  }
  const refused=info!==null&&typeof info==="object"&&info.status==="rejected"&&!extraUsageCovers(info);
  return refused?info:null;
}
// Whether usage-limit evidence (a refused window, or the API's own rate_limit error) names a finished turn's failure. Never without
// evidence, and only while the result agrees: it ends for a reason a limit gives (an API error, a blocking limit, or none), and a
// success carries no API status but 429.
export function claudeLimitHolds(result,evidence){
  if(!evidence)return false;
  const reason=result?.terminal_reason;
  if(reason!==undefined&&reason!==null&&reason!=="api_error"&&reason!=="blocking_limit")return false;
  if(result?.subtype!=="success")return true;
  return [undefined,null,429].includes(result.api_error_status);
}

export function claudeSignedOutMessage(configDir=""){
  const home=String(configDir||"").trim();
  return `Claude Code could not authenticate. Run \`claude auth login\`${home?` with CLAUDE_CONFIG_DIR set to "${home}"`:""}, then send the message again, or set this profile to run on the Anthropic API key in Agents & models.`;
}

// Why a turn failed, from the result that ended it (the SDK's SDKResultMessage).
const CLAUDE_API_GAVE_UP="Claude Code ended the turn after its requests to the Claude API failed again and again.";
const CLAUDE_TURN_ERROR="Claude Code ended the turn with an error.";
// What each end reason (terminal_reason) says, given the turn's evidence (a sign-in or usage-limit failure) and the API's own words
// for a request it refused. Claude Code also ends a turn with blocking_limit once the context window is full (after an invalid_request
// reply saying "Prompt is too long"), which is no limit of the account's unless the evidence says so. A reason not listed says nothing.
const END_REASON_WORDS=new Map([
  ["api_error",({evidence,apiWords})=>evidence||apiWords||CLAUDE_API_GAVE_UP],
  ["blocking_limit",({evidence})=>evidence||CLAUDE_THREAD_TOO_LONG],
  ["prompt_too_long",()=>CLAUDE_THREAD_TOO_LONG],
  ["rapid_refill_breaker",()=>"Claude Code ended the turn: compacting gave no lasting room, as the context filled up again at once."],
  ["model_error",()=>"Claude Code ended the turn because the model returned an error."],
  ["image_error",()=>"Claude Code ended the turn because an image in this thread could not be read."],
  ["malformed_tool_use_exhausted",()=>"Claude Code ended the turn: the model's tool calls were still malformed after every retry."],
  ["structured_output_retry_exhausted",()=>"Claude Code ended the turn: the model never gave the structured output it was asked for."],
  ["budget_exhausted",()=>"Claude Code ended the turn when it reached its token budget."],
  ["tool_deferred_unavailable",()=>"Claude Code could not pick a deferred tool call up again, as that tool is no longer there."],
  ["turn_setup_failed",()=>"Claude Code failed while it set this turn up."],
]);
function endReasonWords(reason,context){
  const words=END_REASON_WORDS.get(reason);
  return words?words(context):null;
}
// The text of an assistant error frame that explains its own failure (see CLAUDE_EXPLAINED_API_ERRORS), or null, with the secrets the
// API's words can repeat redacted as in the result's "API Error: …".
export function claudeExplainedApiError(message){
  if(!CLAUDE_EXPLAINED_API_ERRORS.has(message?.error))return null;
  const blocks=Array.isArray(message.message?.content)?message.message.content:[];
  const text=blocks.map(block=>block?.type==="text"?String(block.text||"").trim():"").filter(Boolean).join("\n");
  return text?redactApiErrorText(text)||null:null;
}
// The errors a result lists that are worth showing: entries with text, without Claude Code's own diagnostics ("[ede_diagnostic] ..."),
// which are telemetry.
const DIAGNOSTIC_LEAD="[ede_diagnostic]";
const worthShowing=entry=>typeof entry==="string"&&!entry.startsWith(DIAGNOSTIC_LEAD)&&entry.trim().length>0;
function listedErrors(result){
  if(!Array.isArray(result?.errors))return [];
  return result.errors.filter(worthShowing);
}

// Quoted JSON keys of secrets ({"token":"…"}, {"client_secret":"…"}) an API's error text can repeat, whose values the shared redactor's
// key=value form does not reach.
const QUOTED_SECRET_VALUE=/(["'])([\w-]*(?:token|secret|password|passwd|api[_-]?key|credential|authorization|cookie))\1(\s*:\s*)(["'])(?:\\.|(?!\4)[^\\])*\4/gi;
function redactApiErrorText(text){return redactSecretText(String(text).replace(QUOTED_SECRET_VALUE,"$1$2$1$3$4[redacted]$4"),{trim:true})}

// What an API status on a success result says, where it says more than the end reason: an overloaded API (HTTP 529), or one holding
// requests back (HTTP 429).
function apiStatusWords(status){
  switch(status){
    case 529:return "The Claude API is overloaded right now (HTTP 529). Wait a moment, then send the message again.";
    case 429:return "The Claude API is limiting how fast requests come in (HTTP 429). Wait a little, then send the message again.";
    default:return null;
  }
}
// The API's own words for a request it refused, as a success result that ended on an API error repeats them ("API Error: 400 ..."):
// secrets redacted first, then at most API_WORDS_MAX characters. null for any other text.
const API_WORDS_MAX=600;
function apiOwnWords(result){
  if(result.terminal_reason!=="api_error")return null;
  const text=String(result.result||"");
  if(!text.trim().startsWith("API Error:"))return null;
  return bounded(redactApiErrorText(text),API_WORDS_MAX);
}
// The first of the candidates with text (each a text, or a function giving one), or null.
function firstSaid(...candidates){
  for(const candidate of candidates){const text=typeof candidate==="function"?candidate():candidate;if(text)return text}
  return null;
}
// Why a turn failed as the person reads it, or null when it did not. knownCause: the turn's sign-in or usage-limit failure;
// explainedError: the text of a reply that explained its own API error (claudeExplainedApiError).
// A result that is no success failed: its own listed error says why, else its end reason, else its subtype. A success failed only
// when it says so: its API status or end reason gives the verdict, and one marked is_error falls back on its listed error, then that
// verdict, the evidence, the explained error and its own text.
export function claudeResultFailure(result,{knownCause=null,explainedError=null}={}){
  if(!result)return null;
  const ownError=()=>listedErrors(result)[0];
  if(result.subtype!=="success"){
    const subtype=result.subtype?`Claude Code ended the turn with an error (${result.subtype}).`:CLAUDE_TURN_ERROR;
    return firstSaid(ownError,()=>endReasonWords(result.terminal_reason,{evidence:knownCause,apiWords:explainedError}),subtype);
  }
  const verdict=()=>apiStatusWords(result.api_error_status)||endReasonWords(result.terminal_reason,{evidence:knownCause,apiWords:explainedError||apiOwnWords(result)});
  if(!result.is_error)return firstSaid(verdict);
  return firstSaid(ownError,verdict,knownCause,explainedError,String(result.result||"").trim(),CLAUDE_TURN_ERROR);
}

// A turn that ended with no error message of its own: its listed errors say it was interrupted or cancelled.
const STOP_WORDS=/interrupt|cancel/i;
function endedByStop(result){
  if(!result||result.subtype==="success"||!Array.isArray(result.errors))return false;
  return STOP_WORDS.test(result.errors.join("\n"));
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
      const promptUuid=hasUuidForm(messageId||"")?String(messageId):randomUUID();
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
    // background first, for at most 8 s from the steer, and its result comes in later, in a turn of its own.
    await this.#parkForegroundSubagents(live);
    // A turn that ended meanwhile takes no steer: the message would start a turn nobody sent.
    if(turn.settled||live.closed)throw new Error("Claude Code has no running turn to steer.");
    const uuid=randomUUID();
    turn.uuids.add(uuid);turn.steered=true;turn.steers.push(parts);
    live.input.push({type:"user",message:{role:"user",content},parent_tool_use_id:null,priority:"now",uuid});
    return {accepted:true,pending:0};
  }
  // Settles once every foreground subagent of the root turn has moved to the background, or STEER_HOLD_MS after it is called. Claude
  // Code refuses a move while background tasks are turned off (CLAUDE_CODE_DISABLE_BACKGROUND_TASKS), and the steer goes all the same.
  #parkForegroundSubagents(live){
    const moves=Array.from(live.foregroundSubagents,callId=>this.#moveToBackground(live,callId));
    if(!moves.length)return Promise.resolve();
    return new Promise(settle=>{
      const hold=setTimeout(settle,STEER_HOLD_MS);hold.unref?.();
      Promise.all(moves).then(()=>{clearTimeout(hold);settle()});
    });
  }
  // Asks Claude Code once to move a subagent call to the background: while that move is open, a later steer waits on the same one
  // instead of asking again. The move settles with Claude Code's answer, false when it refused, and is then forgotten.
  #moveToBackground(live,callId){
    const open=live.subagentMoves.get(callId);
    if(open)return open;
    const move=new Promise(settle=>queueMicrotask(()=>{
      let answer;
      try{answer=live.query.backgroundTasks(callId)}catch{answer=false}
      Promise.resolve(answer).then(settle,()=>settle(false));
    }));
    live.subagentMoves.set(callId,move);
    move.then(()=>{if(live.subagentMoves.get(callId)===move)live.subagentMoves.delete(callId)});
    return move;
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
    const pending=this.capabilities?.load?.({...this.#probeInput(),withPlanUsage:false});
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
      // next to an administrator's managed-mcp.json. They go over stdin once it runs (#sendMcpServers).
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
    if(await this.#sendMcpServers(live))return live;
    return this.#afterRegistrationStall(live,runtime,key,{reopen,opening});
  }
  // A process that did not answer the registration in time is closed, and the SDK's close is given a little time to end it. A resumed
  // conversation then opens once more, and only once the stalled process has exited, so two Claude Codes never resume one transcript
  // at once; a new one does not, since its id may already name a transcript the closed process started. Stop or close meanwhile opens
  // nothing: the closed process is the prompt's answer, which ends it as Stop asked.
  async #afterRegistrationStall(live,runtime,key,{reopen,opening}){
    await this.#closeLive(live);
    await withTimeout(Promise.resolve().then(()=>runtime.return()),CLAUDE_CLOSE_TIMEOUT_MS).catch(()=>{});
    const halted=()=>Boolean(opening?.stopped||live.stopped||this.closed);
    if(halted())return live;
    const gone=reopen&&Boolean(live.resumed)&&await this.#confirmExit(live.proc);
    if(halted())return live;
    if(!gone)throw new Error(CLAUDE_MCP_REGISTRATION_TIMED_OUT);
    return this.#openLive(key,{reopen:false,opening});
  }
  // Starts each Claude Code of a query (this machine's, or a remote one through spawnProcess) and notes when it exits.
  #spawner(proc){
    const keepStderrTail=chunk=>{proc.stderrTail=(proc.stderrTail+chunk).slice(-CLAUDE_STDERR_TAIL)};
    const start=options=>this.spawnProcess?this.spawnProcess(options):spawnLocalClaudeCode(options,{spawnChild:this.spawnChild,onStderr:keepStderrTail});
    return options=>{
      const child=start(options);
      proc.child=child;
      proc.exit=new Promise(resolve=>{
        const done=()=>{proc.exited=true;resolve()};
        if(child.exitCode!=null||child.signalCode!=null)done();else child.once("exit",done);
      });
      return child;
    };
  }
  // Whether the stalled process has exited: one still running after the SDK's close is killed, and has CLAUDE_EXIT_CONFIRM_MS to exit.
  // A query that started no process has nothing to confirm.
  #confirmExit(proc){
    if(!proc?.child)return Promise.resolve(false);
    if(proc.exited)return Promise.resolve(true);
    try{proc.child.kill("SIGKILL")}catch{}
    return new Promise(settle=>{
      const wait=setTimeout(()=>settle(false),CLAUDE_EXIT_CONFIRM_MS);wait.unref?.();
      proc.exit.then(()=>{clearTimeout(wait);settle(true)});
    });
  }
  // Gives the running Claude Code the thread's MCP servers, Trebell's in-process ones among them, before its first prompt, so their
  // tools are there when the turn starts. The whole map goes each time, as setMcpServers replaces the set Claude Code has. Settles true
  // once Claude Code answers, with an error too (its init lists each server with its status, and the error, which can repeat a
  // server's headers, is not kept), or once its process ended first; false when neither came within MCP_ANSWER_BOUND_MS.
  #sendMcpServers(live){
    const servers={...this.mcpServers};
    if(Object.keys(servers).length===0)return Promise.resolve(true);
    return new Promise(settle=>{
      const bound=setTimeout(()=>settle(false),MCP_ANSWER_BOUND_MS);bound.unref?.();
      const answered=()=>{clearTimeout(bound);settle(true)};
      Promise.resolve().then(()=>live.query.setMcpServers(servers)).then(answered,answered);
      Promise.resolve(live.pump).then(answered,answered);
    });
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
      // Background work pins the process for up to eight hours (CLAUDE_MAX_IDLE_PIN_MS).
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
      const reason=(result?listedErrors(result)[0]:null)||String(turn.queryError?.message||"").replace(/^Claude Code returned an error result:\s*/,"")||"Claude Code could not resume the conversation at that point.";
      const previous=this.#rewindOrigins.get(fork);
      if(previous){this.sessionId=previous.sessionId;this.startedOnce=previous.startedOnce;this.pendingFork=previous.pendingFork}
      else{this.startedOnce=false;this.pendingFork=null}
      return turn.reject(Object.assign(new Error(reason),{code:"CLAUDE_REWIND_REJECTED",claudeFork:{...fork}}));
    }
    if(turn.cancelRequested||isAbortResult(result)||endedByStop(result))return turn.resolve({stopReason:"cancelled",...ids,raw});
    // Claude Code that has no transcript for the session it was asked to resume says so and exits before it starts the session
    // or answers: a lost session, which the relay continues once in a fresh one (startFresh) with the earlier messages handed over.
    // What was steered into the turn meanwhile went to this query, which ran none of it, so the error carries it on (steered).
    if(live?.resumed&&!live.sawInit&&!turn.emittedText){
      const said=[String(turn.queryError?.message||""),...(result?listedErrors(result):[])].find(text=>CLAUDE_NO_CONVERSATION.test(text));
      if(said)return turn.reject(Object.assign(new HarnessSessionLostError(`Claude Code could not resume this conversation: ${said.replace(/^Claude Code returned an error result:\s*/,"")}`,{harness:"claude",sessionId:live.resumed}),{steered:[...turn.steers]}));
    }
    // A turn the process started is in the transcript even when it failed: its ids let a later turn be edited.
    const failedIds=live?.sawInit&&turn.echoed?ids:{};
    if(!result){
      const message=String(turn.queryError?.message||"").replace(/^Claude Code returned an error result:\s*/,"");
      return turn.reject(Object.assign(new Error(message||"Claude Code ended without a result message"),failedIds));
    }
    const {limitReached,evidence}=this.#turnEvidence(turn,result);
    // Claude Code ends a /compact whose compaction failed with a success result. compact()'s fails with Claude Code's reason, so the relay
    // never reports it compacted; a /compact sent as a message fails once the usage limit stopped it, and otherwise
    // the session's status says why.
    const compactFailed=turn.compactFailure&&(turn.compact||(limitReached&&result.local_command==="compact"))?turn.compactFailure.message||evidence||CLAUDE_COMPACT_FAILED:null;
    const failure=claudeResultFailure(result,{knownCause:evidence,explainedError:turn.apiErrorText})||compactFailed;
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

  // What a finished turn's own evidence says failed it: a sign-in failure, else a usage limit its result agrees with, worded with the
  // wait of the windows it ran into: those Claude Code refused, then the one a blocked reply repeated when its type is not among them.
  #turnEvidence(turn,result){
    if(turn.authFailure)return {limitReached:false,evidence:claudeSignedOutMessage(this.helperSharesRuntime?"":this.env.CLAUDE_CONFIG_DIR)};
    if(!claudeLimitHolds(result,turn.rejectedLimits.size>0||turn.rateLimited))return {limitReached:false,evidence:null};
    const ranInto=[...turn.rejectedLimits.values()],blocked=turn.blockedLimit;
    if(blocked&&!turn.rejectedLimits.has(windowType(blocked)))ranInto.push(blocked);
    return {limitReached:true,evidence:claudeUsageLimitHint(ranInto)};
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
    if(ran)this.#applyTaskCall(call,structured!==undefined?structured:toolResultText(block.content));
  }
  // A task tool call that went through changes its Claude session's list, which goes to the thread whole, as its plan. For a session
  // this process has not followed yet (Trebell restarted, or the thread's session started again) Claude Code's own list is read from
  // disk once, which already holds the call's change, so an update keeps every task; a TaskList that brings its whole list needs none.
  // When the call changes nothing, the list read from disk is still the plan.
  #applyTaskCall(call,result){
    const sessionId=this.sessionId,known=this.taskLists.get(sessionId);
    const bringsList=call.name==="TaskList"&&Array.isArray(result&&typeof result==="object"?result.tasks:undefined);
    const onDisk=this.taskLists.has(sessionId)||bringsList?null:this.#diskTaskList(sessionId);
    const shown=claudeTaskList(known||onDisk||new Map(),call.name,call.input,result)||onDisk;
    this.taskLists.set(sessionId,shown||known||null);
    if(shown)this.#emit({sessionUpdate:"plan",entries:Array.from(shown.values(),task=>({...task}))});
  }
  // Claude Code's own list for a session, in its Claude home's tasks folder: the list CLAUDE_CODE_TASK_LIST_ID names (a shared one),
  // else the session's, in a folder named with ASCII letters, digits, "_" and "-" only. Read only where Claude Code runs on this machine.
  #diskTaskList(sessionId){
    if(this.spawnProcess||!sessionId)return null;
    const env=this.env||{},configured=String(env.CLAUDE_CONFIG_DIR||"").trim();
    const home=configured?resolve(this.cwd||".",configured):join(homedir(),".claude");
    const list=String(env.CLAUDE_CODE_TASK_LIST_ID||"").trim()||String(sessionId);
    return readClaudeTaskStore(join(home,"tasks",list.replace(/[^\w-]/g,"-")));
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
    if(type==="rate_limit_event"){this.#windowEvent(message);return}
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
      if(message.error){this.#apiErrorFrame(turn,message);return}
      // A reply that went through: what an earlier error frame said no longer names the turn's failure.
      Object.assign(turn,{rateLimited:false,apiErrorText:null,blockedLimit:null});
      if(message.uuid)turn.cursor=message.uuid;
      this.#usageFromSnapshot(live,turn,message.message);
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
      const open=this.request,delta=event.usage;
      if(open?.usage&&delta&&typeof delta==="object"){open.usage=withDelta(open.usage,delta);this.#requestUsage(live,turn)}
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
  #usageFromSnapshot(live,turn,body){
    const usage=body?.usage;
    if(!usage||typeof usage!=="object"||body.model==="<synthetic>")return;
    const request=requestFromSnapshot(this.request,body.id||null,usage);
    if(!request)return;
    this.request=request;this.#requestUsage(live,turn);
  }
  // One root request's usage as the context meter reads it: its prompt is the context, which usage without input never is (some proxies
  // send zeros), and its tokens join the turn's so far, the total until the turn's result gives it. A turn's first request ends the
  // reading of the turn before, whose cost its own result brings.
  #requestUsage(live,turn){
    const request=this.request,usage=request?.usage;if(!usage||promptSize(usage)<=0)return;
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
  // A rate_limit_event while a turn runs. A window Claude Code refused pauses the turn: the turn keeps it, by its type, as evidence
  // of a usage limit, and says so. Once that window lets requests through again, or the extra usage covers it, it no longer counts.
  #windowEvent(message){
    const turn=this.turn&&!this.turn.settled?this.turn:null,info=message.rate_limit_info;
    if(!turn||!info)return;
    const refused=claudeRefusedWindow(message);
    if(refused){turn.rejectedLimits.set(windowType(refused),refused);this.#announceLimit(turn,refused)}
    else if(windowPasses(info))turn.rejectedLimits.delete(windowType(info));
  }
  // A synthetic API-error frame of the root turn. Its kind marks a sign-in failure or a rate limit; an error Claude Code explains keeps
  // its words. A reply the limit blocked repeats the rejected window, so a quick retry still says when it resets: that window is the
  // turn's evidence only until a later reply goes through, unlike a window Claude Code itself rejected (#windowEvent).
  #apiErrorFrame(turn,message){
    const kind=message.error;
    if(kind==="authentication_failed")turn.authFailure=true;
    turn.rateLimited=kind==="rate_limit";
    turn.apiErrorText=claudeExplainedApiError(message);
    turn.blockedLimit=claudeRefusedWindow(message);
    if(turn.blockedLimit)this.#announceLimit(turn,turn.blockedLimit);
  }
  // A usage-limit notice, a finished row of the turn, once per window and reset time.
  #announceLimit(turn,info){
    const said=[windowType(info),info.resetsAt??"unknown"].join(":");
    if(turn.announcedLimits.has(said))return;
    turn.announcedLimits.add(said);
    this.#emit({sessionUpdate:"tool_call",toolCallId:["usage-limit",turn.id,said].join(":"),title:claudeUsagePauseNotice(info),kind:"other",status:"completed",rawInput:{},rawOutput:info});
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
      if(!mapped)return {behavior:"deny",message:CLAUDE_QUESTIONS_UNANSWERED,toolUseID};
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
      const updates=claudeSessionGrant(toolName,options?.suggestions);
      // The rules also hold for every later process of this thread (after Stop, a model change or idle release).
      for(const update of updates){
        if(update?.type==="addRules"&&update.behavior==="allow")for(const rule of update.rules||[]){const text=permissionRuleText(rule);if(text)this.sessionAllowRules.add(text)}
        if(update?.type==="addDirectories")for(const directory of update.directories||[])if(directory)this.additionalDirectories.add(String(directory));
      }
      return {behavior:"allow",updatedInput:input,toolUseID,decisionClassification:"user_permanent",updatedPermissions:updates};
    }
    if(decision==="accept")return {behavior:"allow",updatedInput:input,toolUseID,decisionClassification:"user_temporary"};
    if(decision==="cancel")return {behavior:"deny",message:CLAUDE_CALL_CANCELLED,toolUseID,decisionClassification:"user_reject",interrupt:true};
    return {behavior:"deny",message:CLAUDE_CALL_DENIED,toolUseID,decisionClassification:"user_reject"};
  }
}
