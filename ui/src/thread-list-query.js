export function threadListParams(limit=100){
  return {limit,sortKey:"updated_at",sortDirection:"desc"};
}

export async function loadThreadListPages(client,{limit=100,maxPages=20,params=null}={}){
  if(!client?.request)return {data:[],nextCursor:null,truncated:false};
  const pageSize=Math.max(1,Math.min(200,Number(limit)||100));
  const pageLimit=Math.max(1,Math.min(100,Number(maxPages)||20));
  const base={...(params||threadListParams(pageSize)),limit:pageSize};delete base.cursor;
  const data=[],seenIds=new Set(),seenCursors=new Set();let cursor=null,nextCursor=null,pages=0,truncated=false;
  while(pages<pageLimit){
    const requestParams={...base,...(cursor?{cursor}:{})};
    const page=await client.request("thread/list",requestParams);pages++;
    for(const thread of page?.data||[]){
      if(!thread?.id||seenIds.has(thread.id))continue;
      seenIds.add(thread.id);data.push(thread);
    }
    nextCursor=page?.nextCursor||null;
    if(!nextCursor)break;
    if(seenCursors.has(nextCursor)){truncated=true;break}
    seenCursors.add(nextCursor);cursor=nextCursor;
  }
  if(nextCursor&&pages>=pageLimit)truncated=true;
  return {data,nextCursor:truncated?nextCursor:null,truncated,pages};
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
