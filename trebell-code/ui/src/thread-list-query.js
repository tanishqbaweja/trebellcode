export function threadListParams(limit=100){
  return {limit,sortKey:"updated_at",sortDirection:"desc"};
}

export function nativeThreadSearchMatches(response={}){
  const out=[];
  const seen=new Set();
  for(const entry of response?.data||[]){
    const thread=entry?.thread;
    if(!thread?.id||seen.has(thread.id))continue;
    const excerpt=String(entry?.snippet||"").replace(/\s+/g," ").trim().slice(0,220);
    if(!excerpt)continue;
    seen.add(thread.id);
    out.push({threadId:thread.id,excerpt,thread});
  }
  return out;
}
