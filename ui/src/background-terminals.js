export async function listThreadBackgroundTerminals(rpc,threadId,{pageSize=50,maxPages=4}={}){
  if(!rpc||!threadId)return[];
  const out=[];const seen=new Set();let cursor=null,pages=0;
  do{
    const result=await rpc.request("thread/backgroundTerminals/list",{threadId,limit:pageSize,...(cursor?{cursor}:{})});
    for(const item of result?.data||[]){
      if(!item?.processId||seen.has(item.processId))continue;
      seen.add(item.processId);out.push(item);
    }
    cursor=result?.nextCursor||null;pages++;
  }while(cursor&&pages<maxPages);
  return out;
}

export function backgroundTerminalResourceText(item={}){
  const parts=[];
  if(Number.isFinite(Number(item.cpuPercent)))parts.push(Number(item.cpuPercent).toFixed(1)+"% CPU");
  if(Number.isFinite(Number(item.rssKb))){
    const mb=Number(item.rssKb)/1024;
    parts.push((mb>=10?Math.round(mb):mb.toFixed(1))+" MB");
  }
  if(item.osPid!=null)parts.push("PID "+item.osPid);
  return parts.join(" · ");
}
