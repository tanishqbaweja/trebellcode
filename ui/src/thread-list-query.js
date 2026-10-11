export function threadListParams(limit=100){
  return {limit,sortKey:"updated_at",sortDirection:"desc"};
}

// A section in the order its runtime keeps it, top first (Codex sorts by section_position only within one section).
export function threadSectionOrderParams(sectionId,limit=100){
  return {limit,sectionId,sortKey:"section_position",sortDirection:"asc"};
}

// Each listed thread with its place in its section (sectionRank, null for none). The agent relay lists every thread with one; Codex
// lists none, but keeps an order for each section (thread/section/move), so each section the threads are in is listed in that order.
// Codex keeps no order for the threads outside a section: they have no place. A section whose order could not be read is named in
// failures, and its threads have no place.
export async function rankThreadSections(client,threads=[],{maxPages=20}={}){
  const list=Array.isArray(threads)?threads:[],sectionOf=thread=>{const id=thread?.section?.id;return id==null||id===""?null:String(id)};
  const pending=[...new Set(list.filter(thread=>sectionOf(thread)&&!Number.isFinite(thread?.sectionRank)).map(sectionOf))];
  const ranks=new Map(),failures=[];
  await Promise.all(pending.map(async sectionId=>{
    try{
      const page=await loadThreadListPages(client,{params:threadSectionOrderParams(sectionId),maxPages});let rank=0;
      for(const thread of page.data)if(sectionOf(thread)===sectionId)ranks.set(String(thread.id),rank++);
    }catch(error){failures.push({sectionId,name:list.find(thread=>sectionOf(thread)===sectionId)?.section?.name||sectionId,error})}
  }));
  return {
    threads:list.map(thread=>({...thread,sectionRank:Number.isFinite(thread?.sectionRank)?thread.sectionRank:ranks.get(String(thread?.id))??null})),
    failures,
  };
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
