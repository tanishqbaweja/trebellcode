const MESSAGE_ITEM_TYPES=new Set(["userMessage","agentMessage"]);

function entryTurnId(entry){
  return entry?.turnId||null;
}

function latestTurnId(entries=[]){
  for(let index=entries.length-1;index>=0;index--){
    const entry=entries[index];
    if((entry?.type==="turnStarted"||entry?.type==="turnCompleted")&&entry.turnId)return entry.turnId;
    if(entry?.type==="item"&&entry.turnId)return entry.turnId;
  }
  return null;
}

export function timelineActivityItems(entries=[],turnId=null){
  const items=[];
  for(const entry of entries||[]){
    if(entry?.type!=="item"||!entry.item)continue;
    if(turnId&&entryTurnId(entry)!==turnId)continue;
    if(MESSAGE_ITEM_TYPES.has(entry.item.type))continue;
    items.push(entry.item);
  }
  return items;
}

export async function loadLatestTurnTimeline(client,threadId,{pageSize=100,maxPages=4}={}){
  if(!client||!threadId)return {turnId:null,items:[],complete:false};
  let cursor=null,targetTurnId=null,started=false,pages=0;
  let items=[];
  const seenItems=new Set();
  do{
    const page=await client.request("thread/timeline/list",{threadId,cursor,limit:pageSize});
    const entries=page?.data||[];
    if(!targetTurnId)targetTurnId=latestTurnId(entries);
    if(targetTurnId){
      const pageItems=timelineActivityItems(entries,targetTurnId).filter(item=>{
        const id=String(item?.id||"");if(!id||seenItems.has(id))return false;seenItems.add(id);return true;
      });
      if(pageItems.length)items=[...pageItems,...items];
      if(entries.some(entry=>entry?.type==="turnStarted"&&entry.turnId===targetTurnId))started=true;
    }
    cursor=page?.nextCursor||null;pages++;
  }while(cursor&&targetTurnId&&!started&&pages<Math.max(1,maxPages));
  return {turnId:targetTurnId,items,complete:started};
}
