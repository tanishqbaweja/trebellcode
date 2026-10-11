import { reasoningHistoryMessage } from "./reasoning-text.js";

export function messageText(item){
  if(typeof item?.text==="string")return item.text;
  if(Array.isArray(item?.content))return item.content.map(entry=>entry?.text||entry?.input_text||"").join("");
  return "";
}

export function historyFromTurns(turns=[],checkpointByTurn={}){
  const out=[];
  for(const turn of turns||[]){
    for(const item of turn?.items||[]){
      if(item?.type==="userMessage"){
        const text=messageText(item).trim();
        if(text)out.push({id:item.id,role:"user",text,turnId:turn.id,checkpointId:checkpointByTurn[turn.id]?.id||null});
      }else if(item?.type==="agentMessage"&&item.text?.trim()){
        out.push({id:item.id,role:"assistant",text:item.text,turnId:turn.id});
      }else if(item?.type==="reasoning"){
        const thought=reasoningHistoryMessage(item,turn.id);if(thought)out.push(thought);
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
      const text=messageText(item).trim();
      if(text)out.push({id:item.id,role:"user",text,turnId,checkpointId:checkpointByTurn[turnId]?.id||null});
    }else if(item.type==="agentMessage"&&item.text?.trim()){
      out.push({id:item.id,role:"assistant",text:item.text,turnId});
    }else if(item.type==="reasoning"){
      const thought=reasoningHistoryMessage(item,turnId);if(thought)out.push(thought);
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
  if(resumed?.__trebellHistoryPage?.kind==="turns"){
    const pageTurn=(resumed.__trebellHistoryPage.data||[]).find(activeTurn);if(pageTurn?.id)return String(pageTurn.id);
  }
  return null;
}

