// One activity row per harness item, the same row live and restored from history: what a step is called, its status and the
// output it streamed. A turn's activity card lists every item that is not a message, a thought or a session handoff (the
// conversation shows those itself); plans, turn diffs, auto reviews and notices are live-only rows, not items.
import { activityItemStatus } from "./activity-details.js";
import { dynamicToolLabel } from "./tool-activity.js";

const MESSAGE_ITEM_TYPES=new Set(["userMessage","agentMessage","reasoning","sessionHandoff"]);
// What a restored (or sealed) row keeps: a command's output its last part, other text its first, a list its first entries.
export const RESTORED_TEXT_LIMIT=16_384;
export const RESTORED_LIST_LIMIT=200;
const RESTORED_DEPTH=8;

// Claude Code's TodoWrite as the relay stored it before Claude's lists showed as the turn's plan only: a file change that names no file,
// with the list as its input. A to-do list is no step of its turn, unless it failed, which reads as the failed TodoWrite call a new one
// shows; a thread recorded then keeps those items.
const storedTodoWrite=item=>item?.type==="fileChange"&&Array.isArray(item.rawInput?.todos)&&!item.changes?.length&&!item.rawInput.file_path&&!item.rawInput.notebook_path;

export function isCardItem(item){
  return Boolean(item&&typeof item==="object")&&!MESSAGE_ITEM_TYPES.has(item.type)&&!(storedTodoWrite(item)&&item.status!=="failed");
}

// turnId: the turn the item belongs to, so the rows of a turn stay its own (ids are only unique inside a turn).
export function activityRow(item={},{turnId=null}={}){
  if(storedTodoWrite(item))item={type:"dynamicToolCall",id:item.id,namespace:"agent",tool:"TodoWrite",arguments:item.rawInput,status:item.status,contentItems:null,success:item.status==="failed"?false:null,durationMs:null,locations:[],rawOutput:item.rawOutput};
  const type=item.type||"tool";
  let title=item.title||item.name||item.description||"Agent activity";
  if(type==="plan")title="Plan";
  if(type==="commandExecution")title=Array.isArray(item.command)?item.command.join(" "):(item.command||"Running command");
  if(type==="fileChange")title="Editing files";
  if(type==="mcpToolCall")title=(item.server?item.server+" / ":"")+(item.tool||item.name||"MCP tool");
  // The relay files every harness (ACP) tool under the placeholder namespace "agent" with the harness's own title, which is
  // shown as is (as T3 does). Native's and Codex's dynamic tools have no title: they are named by what they do, the T3 way.
  if(type==="dynamicToolCall")title=item.namespace&&item.namespace!=="agent"?dynamicToolLabel(item)||item.namespace+" / "+(item.tool||"Dynamic tool"):item.tool||"Dynamic tool";
  if(type==="collabAgentToolCall")title="Collaboration · "+String(item.tool||"agent task").replace(/([a-z])([A-Z])/g,"$1 $2").toLowerCase();
  if(type==="subAgentActivity")title="Subagent · "+(item.kind||"activity");
  if(type==="webSearch")title=item.query||"Searching the web";
  if(type==="reasoning")title="Reasoning";
  if(type==="imageView")title="Viewing image";
  if(type==="imageGeneration")title="Generating image";
  // A compaction that ended reads as thread/compacted names it.
  if(type==="contextCompaction")title=activityItemStatus(item)==="done"?"Context compacted":"Compacting context";
  if(type==="enteredReviewMode")title="Reviewing changes";
  if(type==="exitedReviewMode")title="Finished review";
  // A command's output, or the text a Trebell tool answered with (Native's repository searches answer with their hits
  // grouped by file) or a harness's tool whose item says its output is text (textOutput: an OpenCode read's lines, a question's
  // answers), which the expanded row shows as written instead of inside the item's JSON.
  const output=type==="commandExecution"?String(item.aggregatedOutput??item.output??"")
    :type==="dynamicToolCall"&&(item.textOutput||String(item.namespace||"").startsWith("trebell_"))&&typeof item.rawOutput==="string"?item.rawOutput:"";
  // Codex and the relay mark a running item "inProgress"; the timeline calls it running, as plan steps already do. A command
  // that exited non-zero reads as failed whichever harness ran it.
  const status=activityItemStatus(item);
  return {id:item.id||crypto.randomUUID(),kind:type,title:String(title).split("\n")[0].slice(0,160),status,raw:item,output,turnId:turnId==null?null:String(turnId),fromItem:true};
}

// A step of a turn that has ended is not running any more: a harness that sends no status, a subtask stored as it started and
// a tool cut off by a stop all read done, as the live card marks them when the turn completes, while a harness's call still pending
// as its turn completed never started, and says it did not run (notRun; a plan's pending steps are no items and stay). A call still
// pending as its turn was stopped or failed may have run (a harness may run a call it calls pending), and the relay has ended it stopped
// before the turn's end (agent-relay.mjs finishTurn). Its title stays: a compaction still running when its turn ended (stopped, or
// failed) did not compact, so only one the thread's history stores (storedRow) reads so. keepPast: the live window's turn end, which
// leaves a step of work that runs on past its turn (its item says runsPastTurn) for that work's own events.
export function settledRow(row,{keepPast=false}={}){
  if(keepPast&&row?.raw?.runsPastTurn)return row;
  return row?.status==="running"?{...row,status:"done"}:row?.fromItem&&row.status==="pending"?{...row,status:"notRun"}:row;
}
// A stored step of a turn that has ended, read from the thread's history. Codex stores a compaction's item, with no status, only
// once the compaction is done, so it reads as compacted. A step of work the thread's live session still follows past its turn (the
// read says stillRunning: a Muse Code workflow, its agents, a subagent or a command in the background) stays as it is, for the work's
// own later rows to settle.
export function storedRow(row){
  const settled=settledRow(row,{keepPast:row?.raw?.stillRunning===true});
  return settled!==row&&row.kind==="contextCompaction"?{...settled,title:"Context compacted"}:settled;
}

// A harness that retries its turn's request itself (an `error` notification with willRetry: Codex reconnecting its stream, Native
// waiting for the network) has not failed a step: the turn goes on. Its one row per turn says what it retries while it retries,
// and its output keeps the last retry's text, which the open row shows once the title no longer does.
export const RETRY_RECOVERED_TITLE="Recovered after retrying",RETRY_STOPPED_TITLE="Stopped while retrying";
export function retryRowId(turnId,threadId){
  return "retry-"+String(turnId??threadId??"");
}
export function retryActivityRow(notice,{turnId=null,threadId=null,raw=null}={}){
  return {id:retryRowId(turnId,threadId),kind:"retry",title:notice?.title||"Retrying",status:"running",output:notice?.message||"",raw,turnId:turnId==null?null:String(turnId)};
}
// A turn's retry row once the turn went on (any item of it, or its end): the request got through. One that ended while it still
// retried (stopped, or failed) says it stopped instead. Rows of other turns and retry rows already settled stay as they are, and
// the list is the same list when nothing changed.
export function settledRetryRows(rows,{turnId=null,outcome="recovered"}={}){
  let changed=false;
  const next=rows.map(row=>{
    if(row?.kind!=="retry"||row.status!=="running"||(turnId!=null&&row.turnId!=null&&row.turnId!==String(turnId)))return row;
    changed=true;
    return outcome==="stopped"?{...row,status:"stopped",title:RETRY_STOPPED_TITLE}:{...row,status:"done",title:RETRY_RECOVERED_TITLE};
  });
  return changed?next:rows;
}

// What a cut text keeps is a copy: a slice of a string keeps the whole string it was cut from in memory, so a row kept after its turn
// would hold all of a long output or diff while it shows only its cut. A text cut once is left as it was cut: cut again, it would
// count what the first cut left out wrongly.
const CUT_TAIL=/^\n… [\d,]+ more characters$/,CUT_HEAD=/^… ([\d,]+) earlier characters not shown\n/;
const copied=text=>JSON.parse(JSON.stringify(text));
function cappedText(value){
  if(value.length<=RESTORED_TEXT_LIMIT||CUT_TAIL.test(value.slice(RESTORED_TEXT_LIMIT)))return value;
  return copied(value.slice(0,RESTORED_TEXT_LIMIT)+"\n… "+(value.length-RESTORED_TEXT_LIMIT).toLocaleString("en-US")+" more characters");
}
function cutOutputEnd(text){
  const head=CUT_HEAD.exec(text);if(head&&text.length-head[0].length===RESTORED_TEXT_LIMIT)return text;
  return copied("… "+(text.length-RESTORED_TEXT_LIMIT).toLocaleString("en-US")+" earlier characters not shown\n"+text.slice(-RESTORED_TEXT_LIMIT));
}
// Whether a command's output goes on from what a row holds of it: all of it, or the end a kept row holds (cutOutputEnd), which the
// output has where the cut says it starts.
function continuesOutput(output,held){
  if(output.startsWith(held))return true;
  const head=CUT_HEAD.exec(held);
  return Boolean(head)&&output.startsWith(held.slice(head[0].length),Number(head[1].replace(/,/g,"")));
}
function cappedValue(value,depth=0){
  if(typeof value==="string")return cappedText(value);
  if(!value||typeof value!=="object"||depth>=RESTORED_DEPTH)return value;
  if(Array.isArray(value)){
    const kept=value.length>RESTORED_LIST_LIMIT?value.slice(0,RESTORED_LIST_LIMIT):value;let changed=kept!==value;
    const next=kept.map(entry=>{const capped=cappedValue(entry,depth+1);if(capped!==entry)changed=true;return capped});
    return changed?next:value;
  }
  let next=null;
  for(const [key,entry] of Object.entries(value)){const capped=cappedValue(entry,depth+1);if(capped!==entry){if(!next)next={...value};next[key]=capped}}
  return next||value;
}

// A row kept after its turn: a command's output keeps its end (where a failure shows), other text in the item its start, and
// lists their first entries, so a long history holds bounded rows. The same row when nothing needed cutting, a row kept already
// among them.
export function restoredRow(row){
  if(!row||typeof row!=="object")return row;
  const text=typeof row.output==="string"?row.output:"";
  const output=text.length<=RESTORED_TEXT_LIMIT?row.output
    :row.kind==="commandExecution"?cutOutputEnd(text)
    :cappedText(text);
  const raw=cappedValue(row.raw);
  return output===row.output&&raw===row.raw?row:{...row,output,raw};
}

// A live row after an item notification, shared by the live list and the per-turn record the card is sealed from, so the two
// never differ. started: the item as sent. progress: only a changed name, kind or status touches the row (output streams on
// its own), or a step that says from here that it runs on past its turn (runsPastTurn: a command Muse Code's report runs, which
// a message took over), so that its turn's end leaves it running, and what such a step says (a command Muse Code sent to the
// background), which outlasts the output its turn's end clears. Output that only goes on from the row's streams on its own, also from
// the end a kept row holds of a long one (restoredRow), so a command streaming past its turn does not replace its turn's card with each
// chunk. completed: the final item, with the output streamed for it when the item carries none.
export function mergeLiveRow(old,item,{phase="started",streamed=""}={}){
  if(phase==="started"||!old)return phase==="completed"?{...item,output:item.output||streamed||""}:item;
  if(phase==="progress"){
    const said=Boolean(item.raw?.runsPastTurn&&item.output)&&(!old.output||!continuesOutput(item.output,old.output));
    if(old.title===item.title&&old.kind===item.kind&&old.status===item.status&&!old.raw?.runsPastTurn===!item.raw?.runsPastTurn&&!said)return old;
    return {...old,...item,output:item.output||old.output};
  }
  return {...old,...item,output:item.output||streamed||old.output||""};
}
