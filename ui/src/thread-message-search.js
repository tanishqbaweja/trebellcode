import { normalizedPath } from "./codex-projects.js";
import { threadTitle } from "./thread-catalog.js";
import { nativeThreadSearchMatches, rankSearchHits } from "./thread-list-query.js";
import { threadsInListOrder } from "./thread-order.js";

export function searchableThreadMessage(item={}){
  if(item?.type!=="userMessage"&&item?.type!=="agentMessage")return "";
  if(typeof item.text==="string")return item.text.trim();
  if(Array.isArray(item.content))return item.content.map(part=>part?.text||part?.input_text||"").join("").trim();
  return "";
}

export function matchingMessageExcerpt(items,query,{maxLength=120}={}){
  const needle=String(query||"").trim().toLowerCase();if(needle.length<2)return null;
  for(const entry of items||[]){
    const text=searchableThreadMessage(entry?.item||entry);if(!text||!text.toLowerCase().includes(needle))continue;
    const normalized=text.replace(/\s+/g," ").trim();const lower=normalized.toLowerCase();const index=lower.indexOf(needle);
    const start=Math.max(0,index-35);const end=Math.min(normalized.length,start+Math.max(40,Number(maxLength)||120));
    return (start>0?"…":"")+normalized.slice(start,end)+(end<normalized.length?"…":"");
  }
  return null;
}

function pullRequestSearchText(link={}){
  const identity=link.identity||{};
  const snapshot=link.snapshot||{};
  return [
    link.url,link.title,link.state,link.headRefName,link.baseRefName,
    snapshot.title,snapshot.state,snapshot.headBranch,snapshot.baseBranch,
    identity.host,identity.repository,
    identity.number?String(identity.number):"",
    identity.number?"#"+String(identity.number):"",
  ].filter(Boolean).join(" ").toLowerCase();
}

export function matchingPullRequestExcerpt(meta={},query){
  const needle=String(query||"").trim().toLowerCase();if(needle.length<2)return null;
  const attachments=(meta.attachments||[]).filter(item=>item?.attachmentType==="pull_request").map(item=>item.payload||{});
  const legacy=Array.isArray(meta.linkedPullRequests)?meta.linkedPullRequests:[];
  const seen=new Set();
  for(const link of [...attachments,...legacy]){
    const identity=link.identity||{};const key=[identity.host,identity.repository,identity.number,link.url].filter(Boolean).join("|");
    if(seen.has(key))continue;seen.add(key);
    if(!pullRequestSearchText(link).includes(needle))continue;
    const number=identity.number||link.number;const title=link.snapshot?.title||link.title||"Pull request";
    const repository=identity.repository?identity.repository+" · ":"";
    return repository+(number?"#"+number+" ":"")+title;
  }
  return null;
}

// What the sidebar search finds in the threads it lists: a thread whose title has the query, whose project's name has it (the
// project named as the header crumb names it: its record's name, else its folder's), or whose linked pull request matches it.
// The rest of the folder path is left out, since the folders a project sits in (a home or repos folder) would match nearly
// every thread. A General chat belongs to no project. query is matched as typed, lower-cased.
export function sidebarSearchMatches(threads=[],query="",{threadMeta={},projects=[]}={}){
  const needle=String(query||"").toLowerCase();if(!needle.trim())return [];
  const key=(path,environmentId)=>(environmentId||"")+"|"+normalizedPath(path);
  const names=new Map((projects||[]).map(project=>[key(project.path,project.environmentId),String(project.name||"").trim()]));
  return (threads||[]).filter(thread=>{
    const meta=threadMeta?.[thread?.id]||{};
    if(threadTitle(thread).toLowerCase().includes(needle))return true;
    const projectless=Object.prototype.hasOwnProperty.call(meta,"projectless")?meta.projectless:thread?.providerMeta?.projectless;
    if(!projectless&&thread?.cwd){
      const name=names.get(key(thread.cwd,meta.environmentId??thread.providerMeta?.environmentId))||normalizedPath(thread.cwd).split("/").filter(Boolean).at(-1)||"";
      if(name.toLowerCase().includes(needle))return true;
    }
    return Boolean(matchingPullRequestExcerpt(meta,needle));
  });
}

// What the sidebar's and the palette's searches find in the threads' messages (needle: the query, trimmed, of two letters or more):
// the first 50 threads whose linked pull request matches, then the harness's own thread search where it has one (the threads it finds
// that the list does not hold join it), else the last 150 items of each of the other threads, read eight at a time and kept in cache
// by thread while its updatedAt holds (the 100 newest threads' only). App loads it at idle (idle-parts.js, B11) and hands it what its
// render reads: rpc, threads, threadMeta, runtimeCapabilities, setThreads and the cache. A search that could not read everything says
// so in warning.
export async function searchThreadMessages({rpc,threads,threadMeta,runtimeCapabilities,setThreads,cache},needle){
  const candidates=threads.slice(0,50);let cursor=0;
  const results=[];const matched=new Set();let nativeError=null;const readErrors=[];
  for(const thread of candidates){
    const excerpt=matchingPullRequestExcerpt(threadMeta[thread.id]||{},needle);
    if(excerpt){results.push({threadId:thread.id,excerpt:"PR · "+excerpt,thread});matched.add(thread.id)}
  }
  if(runtimeCapabilities.threadSearch){
    try{
      const response=await rpc.request("thread/search",{searchTerm:needle,limit:50,sortKey:"recency_at",sortDirection:"desc",archived:false});
      if(response?.data){
        const native=nativeThreadSearchMatches(response);
        const merged=new Map(results.map(item=>[item.threadId,item]));
        for(const item of native)if(!merged.has(item.threadId))merged.set(item.threadId,item);
        if(native.length)setThreads(prev=>{
          const known=new Set(prev.map(thread=>thread.id));
          const extra=native.map(item=>item.thread).filter(thread=>thread?.id&&!known.has(thread.id));
          return extra.length?[...prev,...extra]:prev;
        });
        return{matches:[...merged.values()],warning:""};
      }
    }catch(error){nativeError=error}
  }
  const searchable=candidates.filter(thread=>!matched.has(thread.id));
  const workers=Array.from({length:Math.min(8,searchable.length)},async()=>{
    while(cursor<searchable.length){
      const thread=searchable[cursor++];const version=Number(thread.updatedAt||0);let cached=cache.get(thread.id);
      if(!cached||cached.updatedAt!==version){
        try{
          const response=await rpc.request("thread/items/list",{threadId:thread.id,limit:150,sortDirection:"desc"});
          cached={updatedAt:version,items:response.data||[]};cache.set(thread.id,cached);
        }catch(error){readErrors.push(error);continue}
      }
      const excerpt=matchingMessageExcerpt(cached.items,needle);if(excerpt)results.push({threadId:thread.id,excerpt,thread});
    }
  });
  await Promise.all(workers);
  if(cache.size>100){const keep=new Set(threads.slice(0,100).map(thread=>thread.id));for(const id of cache.keys())if(!keep.has(id))cache.delete(id)}
  const warnings=[];
  if(nativeError)warnings.push("Full thread search unavailable: "+(nativeError?.message||String(nativeError))+". Searching loaded threads only.");
  if(readErrors.length)warnings.push(`${readErrors.length} loaded thread${readErrors.length===1?"":"s"} could not be searched: ${readErrors[0]?.message||String(readErrors[0])}.`);
  return{matches:results,warning:warnings.join(" ")};
}

// The sidebar's search as the person types (App's effect): the threads whose titles match at once, then, after a moment's pause,
// those whose messages match, in the sidebar's order. The cleanup it returns drops what a search the next letters replace finds.
export function searchSidebar({query,threads,threadMeta,projectRecords,rpc,rpcStatus,agentRuntime,orderedSectionsRef,searchThreadMessages,setSearchResults,setThreadSearchError}){
  let cancelled=false;
  const titleMatches=sidebarSearchMatches(threads,query.toLowerCase(),{threadMeta,projects:projectRecords});
  setThreadSearchError("");
  if(!rpc||rpcStatus!=="connected"||query.length<2){setSearchResults(titleMatches);return()=>{}}
  const timer=setTimeout(async()=>{
    const found=new Map(titleMatches.map(t=>[t.id,t]));
    try{
      const outcome=await searchThreadMessages(query);
      for(const match of outcome.matches||[]){const thread=match.thread||threads.find(item=>item.id===match.threadId);if(thread)found.set(thread.id,thread)}
      // Message matches join the title matches where the list has them: the sidebar's order (and a move made in it) holds. Codex's
      // search gives a thread no place in its section, so one beyond the listed page takes the place its section gives it.
      const shown=threadsInListOrder([...found.values()],threads);
      const results=agentRuntime==="codex"?await rankSearchHits(rpc,shown,threads,{orderedSections:orderedSectionsRef.current}).catch(()=>shown):shown;
      if(!cancelled){setSearchResults(results);setThreadSearchError(outcome.warning||"")}
    }catch(error){
      if(!cancelled){setSearchResults(threadsInListOrder([...found.values()],threads));setThreadSearchError("Could not search thread messages: "+(error?.message||String(error)))}
    }
  },250);
  return()=>{cancelled=true;clearTimeout(timer)};
}
