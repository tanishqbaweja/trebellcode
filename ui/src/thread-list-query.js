export function threadListParams(limit=100){
  return {limit,sortKey:"updated_at",sortDirection:"desc"};
}

// A section in the order its runtime keeps it, top first (Codex sorts by section_position only within one section).
export function threadSectionOrderParams(sectionId,limit=100){
  return {limit,sectionId,sortKey:"section_position",sortDirection:"asc"};
}

// Each listed thread with its place in its section: sectionRank (0 for the top, null for none) and sectionPlaced (the runtime holds that
// place whatever the thread's activity). The agent relay lists every thread with both. Codex lists neither and keeps an order for each
// section (thread/section/move), but that order is the order threads entered it until a person orders the section, while Trebell has
// always shown a section by recent activity: a section a person ordered (orderedSections) is read in Codex's order, every thread there
// holding its place, and any other section keeps the list's order (newest first) with no thread placed. Codex keeps no order for the
// threads outside a section: they have no place. A section whose order could not be read keeps the list's order with no place, and its
// threads say why (sectionOrderError); failures names each such section.
export async function rankThreadSections(client,threads=[],{orderedSections=[],maxPages=20}={}){
  const list=Array.isArray(threads)?threads:[],sectionOf=thread=>{const id=thread?.section?.id;return id==null||id===""?null:String(id)};
  const ordered=new Set((orderedSections||[]).map(String)),ranks=new Map(),errors=new Map(),failures=[],recent=new Map();
  const unranked=list.filter(thread=>sectionOf(thread)&&!Number.isFinite(thread?.sectionRank));
  for(const thread of unranked){const sectionId=sectionOf(thread);if(ordered.has(sectionId))continue;const rank=recent.get(sectionId)??0;ranks.set(String(thread.id),rank);recent.set(sectionId,rank+1)}
  await Promise.all([...new Set(unranked.map(sectionOf))].filter(sectionId=>ordered.has(sectionId)).map(async sectionId=>{
    try{
      const page=await loadThreadListPages(client,{params:threadSectionOrderParams(sectionId),maxPages});let rank=0;
      for(const thread of page.data)if(sectionOf(thread)===sectionId)ranks.set(String(thread.id),rank++);
    }catch(error){
      const name=list.find(thread=>sectionOf(thread)===sectionId)?.section?.name||sectionId,detail=error?.message||String(error);
      failures.push({sectionId,name,error});errors.set(sectionId,"Could not read the order of "+name+": "+detail);
    }
  }));
  return {
    threads:list.map(thread=>{
      if(Number.isFinite(thread?.sectionRank))return thread;
      const sectionId=sectionOf(thread),error=sectionId?errors.get(sectionId)||null:null;
      return {...thread,sectionRank:error?null:ranks.get(String(thread?.id))??null,sectionPlaced:Boolean(sectionId&&ordered.has(sectionId)&&!error),sectionOrderError:error};
    }),
    failures,
  };
}

// A search's threads (shown: the sidebar's copy of each one it lists, the search's own copy of any other) with a place in its section
// for each thread beyond the listed page, where the runtime's search gives none (Codex; the agent relay's search gives every thread its
// place), so it can be moved as the listed threads can. listed: the sidebar's threads, with their places. In a section a person ordered,
// a thread takes its place in Codex's order, read as the list reads it; in any other section, its place after the listed threads there,
// newest first, as the list goes on (the list holds the newest threads). A section whose order could not be read gives none and says so.
export async function rankSearchHits(client,shown=[],listed=[],{orderedSections=[],maxPages=20}={}){
  const list=Array.isArray(shown)?shown:[],sectionOf=thread=>{const id=thread?.section?.id;return id==null||id===""?null:String(id)};
  const ordered=new Set((orderedSections||[]).map(String));
  const unplaced=list.filter(thread=>sectionOf(thread)&&!Number.isFinite(thread?.sectionRank)&&!thread?.sectionOrderError);
  if(!unplaced.length)return list;
  const {threads:inOrder}=await rankThreadSections(client,unplaced.filter(thread=>ordered.has(sectionOf(thread))),{orderedSections:[...ordered],maxPages});
  const placed=new Map(inOrder.map(thread=>[String(thread.id),thread])),next=new Map();
  for(const thread of listed||[]){const sectionId=sectionOf(thread);if(sectionId&&!ordered.has(sectionId)&&Number.isFinite(thread?.sectionRank))next.set(sectionId,Math.max(next.get(sectionId)??0,thread.sectionRank+1))}
  const recent=unplaced.filter(thread=>!ordered.has(sectionOf(thread))).map((thread,index)=>({thread,index})).sort((a,b)=>(Number(b.thread?.updatedAt)||0)-(Number(a.thread?.updatedAt)||0)||a.index-b.index);
  for(const {thread} of recent){const sectionId=sectionOf(thread),rank=next.get(sectionId)??0;next.set(sectionId,rank+1);placed.set(String(thread.id),{...thread,sectionRank:rank,sectionPlaced:false,sectionOrderError:null})}
  return list.map(thread=>placed.get(String(thread?.id))||thread);
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
