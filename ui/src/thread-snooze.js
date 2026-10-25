export function formatSnoozeUntil(timestamp){
  const value=Number(timestamp);if(!Number.isFinite(value))return "";
  return new Date(value).toLocaleString(undefined,{weekday:"short",month:"short",day:"numeric",hour:"numeric",minute:"2-digit"});
}

export function nextSnoozeWakeAt(threads=[],threadMeta={},now=Date.now()){
  const current=Number(now);let next=null;
  for(const thread of threads||[]){
    if(thread?.section?.name!=="Snoozed")continue;
    const value=Number(threadMeta?.[thread.id]?.snoozedUntil);if(!Number.isFinite(value)||value<=0)continue;
    const candidate=Math.max(current,value);
    if(next==null||candidate<next)next=candidate;
  }
  return next;
}
