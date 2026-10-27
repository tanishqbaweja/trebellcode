import { reasoningHistoryMessage } from "./reasoning-text.js";
import { splitCodexAttachmentText } from "./codex-turn-options.js";
import { withoutCodexGoalStart } from "../../src/codex-goal-start.mjs";

export function messageText(item){
  if(typeof item?.text==="string")return item.text;
  if(Array.isArray(item?.content))return item.content.map(entry=>entry?.text||entry?.input_text||"").join("");
  return "";
}

// A message the person sent, as its bubble shows it again: the files Codex names after its text (codexTurnInput) come off the text,
// and those its input carries as items (an image, audio or a file, as the agent relay keeps them) join them, so the message names
// the files that went with it as it did when it was sent; null for a message with neither text nor files. A Codex goal's first
// message reads as the objective the person typed (codex-goal-start.mjs).
const FILE_INPUTS=new Set(["localImage","localAudio","mention"]);
function userHistoryMessage(item,turnId,checkpointByTurn){
  const {text,paths}=splitCodexAttachmentText(messageText(item).trim());
  for(const entry of Array.isArray(item.content)?item.content:[])if(FILE_INPUTS.has(entry?.type)&&entry.path&&!String(entry.path).includes("://"))paths.push(String(entry.path));
  const attachments=[...new Set(paths)],shown=withoutCodexGoalStart(text.trim());
  return shown||attachments.length?{id:item.id,role:"user",text:shown,turnId,checkpointId:checkpointByTurn[turnId]?.id||null,...(attachments.length?{attachments}:{})}:null;
}

// The row a turn keeps when a fresh session took over a conversation its harness had lost (the relay's sessionHandoff item):
// what happened, in the relay's wording, in the turn where it happened. It is neither a reply nor a failure, so it has a role of
// its own ("handoff"); null for any other item.
export function sessionHandoffMessage(item,turnId){
  if(item?.type!=="sessionHandoff"||!turnId)return null;
  const harness=String(item.harness||"").trim()||"The harness",text=String(item.title||"").trim()||harness+" no longer had this conversation, so it continues in a new session.";
  return {id:item.id||"session-handoff-"+turnId,role:"handoff",text,turnId};
}

// A handoff row that comes live joins its turn after the rows the turn has (its message), as the turn stores it; once.
export function withSessionHandoff(messages=[],row){
  const list=Array.isArray(messages)?messages:[];
  if(!row?.id||list.some(message=>String(message?.id)===String(row.id)))return list;
  let at=list.length-1;while(at>=0&&String(list[at]?.turnId||"")!==String(row.turnId))at--;
  return at<0?[...list,row]:[...list.slice(0,at+1),row,...list.slice(at+1)];
}

export function historyFromTurns(turns=[],checkpointByTurn={}){
  const out=[];
  for(const turn of turns||[]){
    for(const item of turn?.items||[]){
      if(item?.type==="userMessage"){
        const message=userHistoryMessage(item,turn.id,checkpointByTurn);if(message)out.push(message);
      }else if(item?.type==="agentMessage"&&item.text?.trim()){
        out.push({id:item.id,role:"assistant",text:item.text,turnId:turn.id});
      }else if(item?.type==="reasoning"){
        const thought=reasoningHistoryMessage(item,turn.id);if(thought)out.push(thought);
      }else if(item?.type==="sessionHandoff"){
        const handoff=sessionHandoffMessage(item,turn.id);if(handoff)out.push(handoff);
      }
    }
  }
  return out;
}

export function historyFromItemEntries(entries=[],checkpointByTurn={}){
  const out=[];
  for(const entry of entries||[]){
    const turnId=entry?.turnId,item=entry?.item;
    if(!turnId||!item)continue;
    if(item.type==="userMessage"){
      const message=userHistoryMessage(item,turnId,checkpointByTurn);if(message)out.push(message);
    }else if(item.type==="agentMessage"&&item.text?.trim()){
      out.push({id:item.id,role:"assistant",text:item.text,turnId});
    }else if(item.type==="reasoning"){
      const thought=reasoningHistoryMessage(item,turnId);if(thought)out.push(thought);
    }else if(item.type==="sessionHandoff"){
      const handoff=sessionHandoffMessage(item,turnId);if(handoff)out.push(handoff);
    }
  }
  return out;
}

export function mergeHistoryMessages(earlier=[],current=[]){
  const seen=new Set();const merged=[];
  for(const message of [...(earlier||[]),...(current||[])]){
    const key=String(message?.id||`${message?.turnId||""}:${message?.role||""}:${message?.text||""}`);
    if(seen.has(key))continue;seen.add(key);merged.push(message);
  }
  return merged;
}

// A turn loaded on its own (a find hit older than the loaded pages) leads the list, apart from the newest pages until the turns
// between them load; the gap marker sits before the first message of the newest pages. A new detached turn replaces the last.
export function detachHistoryTurn(messages=[],detachedIds=[],found=[]){
  const drop=new Set([...(detachedIds||[]),...(found||[]).map(message=>message?.id)].map(String));
  return [...(found||[]),...(messages||[]).filter(message=>!drop.has(String(message?.id)))];
}

export function historyGapBeforeId(messages=[],detached=null){
  if(!detached?.ids?.length)return null;
  const ids=new Set(detached.ids.map(String));
  return (messages||[]).find(message=>!ids.has(String(message?.id)))?.id??null;
}

// What an older page of the newest history does to the gap above it: it shrinks the gap, or reaches the detached turn and
// joins it. Joined history pages on with the page's cursor when the page covers the detached turns, else with theirs.
export function historyGapPage(detached,{earlier=[],pageTurnIds=[],nextCursor=null,windowTurnIds=[]}={}){
  const detachedIds=new Set((detached?.ids||[]).map(String)),detachedTurns=new Set((detached?.turnIds||[]).map(String));
  const pageIds=new Set((earlier||[]).map(message=>String(message?.id)));
  const reached=!nextCursor||(pageTurnIds||[]).some(id=>detachedTurns.has(String(id)))||[...pageIds].some(id=>detachedIds.has(id));
  if(reached){
    const covered=[...detachedIds].every(id=>pageIds.has(id));
    return {joined:true,detached:null,nextCursor:covered?nextCursor:detached?.cursor||null,itemPaging:covered?undefined:false};
  }
  const loaded=new Set((windowTurnIds||[]).map(String)),added=new Set((pageTurnIds||[]).map(String).filter(id=>id&&!loaded.has(id)));
  const missing=detached?.missing?{...detached.missing,count:Math.max(0,detached.missing.count-added.size)}:null;
  return {joined:false,detached:{...detached,missing},nextCursor};
}

// The messages once that page lands: between the detached turn and the newest pages, or (joined) in place of the detached
// copies it also holds.
export function mergeHistoryGapMessages(messages=[],detached=null,earlier=[],joined=false){
  const detachedIds=new Set((detached?.ids||[]).map(String)),pageIds=new Set((earlier||[]).map(message=>String(message?.id)));
  const before=(messages||[]).filter(message=>detachedIds.has(String(message?.id))),after=(messages||[]).filter(message=>!detachedIds.has(String(message?.id)));
  return mergeHistoryMessages([...(joined?before.filter(message=>!pageIds.has(String(message?.id))):before),...(earlier||[])],after);
}

// How many turns lie between a detached turn and the loaded pages, counted from cheap metadata pages (no items). null when the
// count cannot be told; more:true when there are more than maxPages pages of them.
export async function countUnloadedTurns(request,{threadId,turnCursor,turnId,loadedTurnIds=[],limit=200,maxPages=5}={}){
  if(!turnCursor||typeof request!=="function")return null;
  const loaded=new Set([...(loadedTurnIds||[])].map(String));let cursor=turnCursor,count=0;
  for(let page=0;page<maxPages&&cursor;page++){
    const result=await request("thread/turns/list",{threadId,cursor,limit,sortDirection:"asc",itemsView:"notLoaded"});
    for(const turn of result?.data||[]){
      const id=String(turn?.id||"");if(!id||id===String(turnId||""))continue;
      if(loaded.has(id))return {count,more:false};
      count++;
    }
    cursor=result?.nextCursor||null;
  }
  return cursor?{count,more:true}:null;
}

export function historyGapLabel(missing){
  if(!missing)return "Turns not loaded";
  const count=Math.max(0,Number(missing.count)||0);
  return `${count.toLocaleString("en-US")}${missing.more?"+":""} ${count===1&&!missing.more?"turn":"turns"} not loaded`;
}

function activeTurn(turn){
  return turn?.status==="inProgress"||turn?.status==="active"||turn?.status?.type==="active";
}

export function resumedActiveTurnId(resumed){
  if(resumed?.thread?.status?.type!=="active")return null;
  const explicit=resumed?.activeTurnId||resumed?.thread?.activeTurnId||resumed?.thread?.status?.turnId;
  if(explicit)return String(explicit);
  const threadTurn=[...(resumed?.thread?.turns||[])].reverse().find(activeTurn);if(threadTurn?.id)return String(threadTurn.id);
  // A turn page names how its turns stand, newest first, and so does the page of turn outcomes an item page is read with: the relay
  // and Codex resume an item-paged thread with no turns and an active status that names none.
  const page=resumed?.__trebellHistoryPage,pageTurns=page?.kind==="turns"?page.data:page?.kind==="items"?page.turns:null;
  const pageTurn=(pageTurns||[]).find(activeTurn);if(pageTurn?.id)return String(pageTurn.id);
  return null;
}

