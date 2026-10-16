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

export function isCardItem(item){
  return Boolean(item&&typeof item==="object")&&!MESSAGE_ITEM_TYPES.has(item.type);
}

// turnId: the turn the item belongs to, so the rows of a turn stay its own (ids are only unique inside a turn).
export function activityRow(item={},{turnId=null}={}){
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
  // grouped by file), which the expanded row shows as written instead of inside the item's JSON.
  const output=type==="commandExecution"?String(item.aggregatedOutput??item.output??"")
    :type==="dynamicToolCall"&&String(item.namespace||"").startsWith("trebell_")&&typeof item.rawOutput==="string"?item.rawOutput:"";
  // Codex and the relay mark a running item "inProgress"; the timeline calls it running, as plan steps already do. A command
  // that exited non-zero reads as failed whichever harness ran it.
  const status=activityItemStatus(item);
  return {id:item.id||crypto.randomUUID(),kind:type,title:String(title).split("\n")[0].slice(0,160),status,raw:item,output,turnId:turnId==null?null:String(turnId),fromItem:true};
}

// A step of a turn that has ended is not running any more: a harness that sends no status, a subtask stored as it started and
// a tool cut off by a stop all read done, as the live card marks them when the turn completes. Its title stays: a compaction still
// running when its turn ended (stopped, or failed) did not compact, so only one the thread's history stores (storedRow) reads so.
export function settledRow(row){
  return row?.status==="running"?{...row,status:"done"}:row;
}
// A stored step of a turn that has ended, read from the thread's history. Codex stores a compaction's item, with no status, only
// once the compaction is done, so it reads as compacted.
export function storedRow(row){
  const settled=settledRow(row);
  return settled!==row&&row.kind==="contextCompaction"?{...settled,title:"Context compacted"}:settled;
}

function cappedText(value){
  return value.length>RESTORED_TEXT_LIMIT?value.slice(0,RESTORED_TEXT_LIMIT)+"\n… "+(value.length-RESTORED_TEXT_LIMIT).toLocaleString("en-US")+" more characters":value;
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
// lists their first entries, so a long history holds bounded rows. The same row when nothing needed cutting.
export function restoredRow(row){
  if(!row||typeof row!=="object")return row;
  const text=typeof row.output==="string"?row.output:"";
  const output=text.length<=RESTORED_TEXT_LIMIT?row.output
    :row.kind==="commandExecution"?"… "+(text.length-RESTORED_TEXT_LIMIT).toLocaleString("en-US")+" earlier characters not shown\n"+text.slice(-RESTORED_TEXT_LIMIT)
    :cappedText(text);
  const raw=cappedValue(row.raw);
  return output===row.output&&raw===row.raw?row:{...row,output,raw};
}

// A live row after an item notification, shared by the live list and the per-turn record the card is sealed from, so the two
// never differ. started: the item as sent. progress: only a changed name, kind or status touches the row (output streams on
// its own). completed: the final item, with the output streamed for it when the item carries none.
export function mergeLiveRow(old,item,{phase="started",streamed=""}={}){
  if(phase==="started"||!old)return phase==="completed"?{...item,output:item.output||streamed||""}:item;
  if(phase==="progress"){
    if(old.title===item.title&&old.kind===item.kind&&old.status===item.status)return old;
    return {...old,...item,output:item.output||old.output};
  }
  return {...old,...item,output:item.output||streamed||old.output||""};
}
