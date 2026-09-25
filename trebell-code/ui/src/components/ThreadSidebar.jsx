import React,{memo,useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState} from "react";
import {
  Archive, BarChart3, Bot, Clock3, Folder, Globe2, History,
  GitPullRequest, MoreHorizontal, Pin, Plus, Search, Settings, SlidersHorizontal, Wrench, Server, PanelLeftClose
} from "lucide-react";
import { formatSnoozeUntil } from "../thread-snooze.js";
import { threadReferenceValues } from "../thread-references.js";
import { writeClipboardText } from "../clipboard.js";
import { groupSidebarThreads, THREAD_GROUP_NAMES } from "../thread-sidebar-groups.js";
import { threadCatalogRuntime } from "../thread-catalog.js";
import { shouldVirtualizeSidebarGroup, sidebarChunkIndexForThread, sidebarVirtualChunks } from "../sidebar-virtualization.js";

function titleOf(thread){return thread.name||thread.preview||"Untitled task"}
function relativeTime(epoch){
  if(!epoch)return "";
  const d=Math.max(0,Date.now()/1000-epoch);
  if(d<60)return "now";
  if(d<3600)return Math.floor(d/60)+"m";
  if(d<86400)return Math.floor(d/3600)+"h";
  return Math.floor(d/86400)+"d";
}

function threadCanFork(thread,runtimeCapabilities={}){
  if(runtimeCapabilities.fork===true)return true;
  if(runtimeCapabilities.fork!=="runtime")return false;
  return thread?.providerMeta?.initialize?.agentCapabilities?.sessionCapabilities?.fork!=null;
}

const ThreadRow=memo(function ThreadRow({thread,meta,active,selected,bulk,onOpen,onSelect,onAction,onMove,runAction,agentRuntime="codex",runtimeCapabilities={}}){
  const section=thread.section?.name||"Active";
  const rowRuntime=threadCatalogRuntime(thread,meta,agentRuntime),foreignRuntime=rowRuntime!==agentRuntime;
  const rowRuntimeLabel=({codex:"Codex",claude:"Claude",cursor:"Cursor",grok:"Grok",opencode:"OpenCode",antigravity:"Antigravity"}[rowRuntime]||rowRuntime);
  const linked=Array.isArray(meta?.linkedPullRequests)
    ?meta.linkedPullRequests
    :(meta?.attachments||[]).filter(item=>item?.attachmentType==="pull_request").map(item=>item.payload||{}).filter(Boolean);
  const detected=linked.length?null:meta?.branchPullRequest||null;
  const review=linked[0]||detected;const reviewNumber=review?.identity?.number||review?.number;
  const reviewLabel=linked.length>1?"#"+reviewNumber+" +"+(linked.length-1):reviewNumber?"#"+reviewNumber:null;
  const references=threadReferenceValues(thread,meta);
  const copy=async value=>{
    const copied=await writeClipboardText(value);
    if(!copied)throw new Error("Could not copy to clipboard.");
  };
  return <div className={active?"thread-row active":"thread-row"} data-thread-id={thread.id}>
    {bulk&&<input className="thread-select" type="checkbox" checked={selected} disabled={foreignRuntime} title={foreignRuntime?"Open this thread before applying bulk actions":undefined} onChange={()=>onSelect(thread.id)}/>}
    <button className="thread-main" onClick={()=>runAction(()=>onOpen(thread))} title={titleOf(thread)}>
      <span className={"thread-status-dot "+(section==="Pinned"?"pinned":section==="Snoozed"?"snoozed":section==="Settled"?"settled":"")}/>
      <div>
        <strong className="thread-title-line"><span className="thread-title-text">{titleOf(thread)}</span>{foreignRuntime&&<em className="thread-runtime-chip" title={"Owned by "+rowRuntimeLabel}>{rowRuntimeLabel}</em>}{reviewLabel&&<em className={linked.length?"thread-pr-chip linked":"thread-pr-chip detected"} title={linked.length?"Linked pull request":"Detected from saved branch"}><GitPullRequest size={9}/>{reviewLabel}</em>}</strong>
        <span>{section==="Snoozed"&&meta?.snoozedUntil?"Wakes "+formatSnoozeUntil(meta.snoozedUntil):meta?.projectless?"No project · "+relativeTime(thread.updatedAt):(thread.model?.replace(/^freebuff\//,"")||({codex:"Codex",claude:"Claude",cursor:"Cursor",grok:"Grok",opencode:"OpenCode",antigravity:"Antigravity"}[agentRuntime]||agentRuntime))+" · "+relativeTime(thread.updatedAt)}</span>
      </div>
    </button>
    <details className="thread-menu">
      <summary title="Thread actions"><MoreHorizontal size={13}/></summary>
      <div className="thread-menu-popover">
        {foreignRuntime?<button onClick={()=>runAction(()=>onOpen(thread))}>Open in {rowRuntimeLabel}</button>:<>
          <button onClick={()=>runAction(()=>onAction(thread,section==="Pinned"?"active":"pin"))}>{section==="Pinned"?"Unpin":"Pin"}</button>
          <button onClick={()=>runAction(()=>onAction(thread,section==="Snoozed"?"active":"snooze"))}>{section==="Snoozed"?"Wake thread":"Snooze…"}</button>
          <button onClick={()=>runAction(()=>onAction(thread,section==="Settled"?"active":"settle"))}>{section==="Settled"?"Un-settle":"Settle"}</button>
          {threadCanFork(thread,runtimeCapabilities)&&<button onClick={()=>runAction(()=>onAction(thread,"fork"))}>Fork thread</button>}
          <button onClick={()=>runAction(()=>onMove(thread,-1))}>Move up</button>
          <button onClick={()=>runAction(()=>onMove(thread,1))}>Move down</button>
        </>}
        <button onClick={()=>runAction(()=>copy(references.threadId))}>Copy thread ID</button>
        {references.branch&&<button onClick={()=>runAction(()=>copy(references.branch))}>Copy branch</button>}
        {references.path&&!meta?.projectless&&<button onClick={()=>runAction(()=>copy(references.path))}>Copy path</button>}
        {!foreignRuntime&&<><button onClick={()=>runAction(()=>onAction(thread,"archive"))}>Archive</button><button className="danger" onClick={()=>runAction(()=>onAction(thread,"delete"))}>Delete</button></>}
      </div>
    </details>
  </div>;
});

const SidebarVirtualChunk=memo(function SidebarVirtualChunk({chunk,rootRef,forceMount=false,initialMount=false,activeThreadId=null,renderRow}){
  const ref=useRef(null),[mounted,setMounted]=useState(Boolean(initialMount||forceMount)),[placeholderHeight,setPlaceholderHeight]=useState(Math.max(1,Number(chunk.estimatedHeight)||1));
  useEffect(()=>{if(forceMount)setMounted(true)},[forceMount]);
  useEffect(()=>{
    if(!mounted||!ref.current)return;
    const measure=()=>{const height=Math.ceil(ref.current?.getBoundingClientRect?.().height||0);if(height>0)setPlaceholderHeight(height)};
    measure();
    if(typeof ResizeObserver==="undefined")return;
    const observer=new ResizeObserver(measure);observer.observe(ref.current);return()=>observer.disconnect();
  },[mounted,chunk.key]);
  useEffect(()=>{
    const node=ref.current,root=rootRef?.current;if(!node||!root||typeof IntersectionObserver==="undefined"){setMounted(true);return}
    let timer=null;
    const observer=new IntersectionObserver(entries=>{
      const visible=entries.some(entry=>entry.isIntersecting);
      if(visible||forceMount){if(timer){clearTimeout(timer);timer=null}setMounted(true);return}
      const height=Math.ceil(node.getBoundingClientRect().height||0);if(height>0)setPlaceholderHeight(height);
      timer=setTimeout(()=>setMounted(false),120);
    },{root,rootMargin:"600px 0px 600px 0px",threshold:0});
    observer.observe(node);return()=>{if(timer)clearTimeout(timer);observer.disconnect()};
  },[rootRef,forceMount,chunk.key]);
  useEffect(()=>{
    const node=ref.current,root=rootRef?.current;if(!node||!root)return;
    const update=()=>{
      const rootRect=root.getBoundingClientRect(),rect=node.getBoundingClientRect();
      if(rect.bottom>=rootRect.top-600&&rect.top<=rootRect.bottom+600)setMounted(true);
    };
    update();root.addEventListener("scroll",update,{passive:true});window.addEventListener("resize",update);
    return()=>{root.removeEventListener("scroll",update);window.removeEventListener("resize",update)};
  },[rootRef,chunk.key]);
  useLayoutEffect(()=>{
    if(!forceMount||!mounted||!activeThreadId)return;
    const target=[...(ref.current?.querySelectorAll?.("[data-thread-id]")||[])].find(element=>String(element.dataset.threadId)===String(activeThreadId));
    target?.scrollIntoView?.({block:"nearest",behavior:"auto"});
  },[forceMount,mounted,activeThreadId,chunk.key]);
  return <div ref={ref} className={"sidebar-virtual-chunk"+(mounted?" mounted":" placeholder")} data-sidebar-chunk={chunk.key} style={mounted?undefined:{height:placeholderHeight}}>{mounted?chunk.items.map(renderRow):null}</div>;
});

function UtilityButton({Icon,label,active,onClick}){
  return <button className={active?"sidebar-utility active":"sidebar-utility"} onClick={onClick} aria-label={label} title={label}>
    <Icon size={15}/><span>{label}</span>
  </button>;
}

const ThreadSidebar=memo(function ThreadSidebar({
  section,setSection,threads,activeThreadId,query,setQuery,onOpen,onNew,onThreadAction,onMove,
  selectedIds,setSelectedIds,onBulkAction,provider="freebuff",agentRuntime="codex",threadMeta={},onCollapse,
  rightPanelOpen=false,rightPanelTab="files",searchError="",runtimeCapabilities={}
}){
  const searchRef=useRef(null);
  const sectionsRef=useRef(null);
  const [actionError,setActionError]=useState("");
  const runAction=useCallback(action=>{
    setActionError("");
    return Promise.resolve().then(action).catch(error=>setActionError(error?.message||String(error)||"Action failed."));
  },[]);
  useEffect(()=>{
    const focus=()=>{searchRef.current?.focus();searchRef.current?.select?.()};
    window.addEventListener("trebell:sidebar-search",focus);
    return()=>window.removeEventListener("trebell:sidebar-search",focus);
  },[]);
  const groups=useMemo(()=>groupSidebarThreads(threads,threadMeta),[threads,threadMeta]);
  const bulk=selectedIds.size>0;
  const providerLabel={freebuff:"Freebuff",agentrouter:"AgentRouter",justworker:"JustWorker",hcnsec:"HCNSec",vyceai:"VyceAi"}[provider]||provider;
  const runtimeLabel={codex:"Codex",claude:"Claude Code",cursor:"Cursor",grok:"Grok Build",opencode:"OpenCode",antigravity:"Antigravity"}[agentRuntime]||agentRuntime;
  const toggle=useCallback(id=>{const next=new Set(selectedIds);next.has(id)?next.delete(id):next.add(id);setSelectedIds(next)},[selectedIds,setSelectedIds]);
  const firstGroupName=THREAD_GROUP_NAMES.find(name=>groups[name]?.length)||null;
  const renderRow=useCallback(t=><ThreadRow key={t.id} thread={t} meta={threadMeta[t.id]||null} active={t.id===activeThreadId} bulk={bulk} selected={selectedIds.has(t.id)} onOpen={onOpen} onSelect={toggle} onAction={onThreadAction} onMove={onMove} runAction={runAction} agentRuntime={agentRuntime} runtimeCapabilities={runtimeCapabilities}/>,[threadMeta,activeThreadId,bulk,selectedIds,onOpen,toggle,onThreadAction,onMove,runAction,agentRuntime,runtimeCapabilities]);

  return <aside className="sidebar">
    <div className="sidebar-titlebar">
      <button className="sidebar-brand" onClick={()=>setSection("chat")} aria-label="Threads">
        <img className="brand-mark" src="/trebell-code-icon.svg" alt="" aria-hidden="true"/><strong>Trebell <em>Code</em></strong>
      </button>
      <div className="sidebar-title-actions"><button className="sidebar-new-thread" onClick={onCollapse} aria-label="Collapse sidebar" title="Collapse sidebar · Ctrl+B"><PanelLeftClose size={15}/></button><button className="sidebar-new-thread" onClick={()=>runAction(onNew)} aria-label="New thread" title="New thread"><Plus size={16}/></button></div>
    </div>

    <div className="sidebar-thread-tools">
      <div className="search-box">
        <Search size={14}/>
        <input ref={searchRef} value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search"/>
        {query&&<button onClick={()=>setQuery("")} aria-label="Clear search">×</button>}
      </div>
      <button className="sidebar-bulk-toggle" onClick={()=>setSelectedIds(bulk?new Set():new Set(threads.filter(thread=>threadCatalogRuntime(thread,threadMeta[thread.id]||{},agentRuntime)===agentRuntime).slice(0,1).map(t=>t.id)))} title="Thread actions" aria-label="Thread actions">
        {bulk?<SlidersHorizontal size={14}/>:<MoreHorizontal size={15}/>}
      </button>
    </div>

    {searchError&&<div className="sidebar-action-error" role="alert">{searchError}</div>}
    {actionError&&<div className="sidebar-action-error" role="alert">{actionError}</div>}
    {bulk&&<div className="bulk-bar">
      <span>{selectedIds.size} selected</span>
      <button onClick={()=>runAction(()=>onBulkAction("pin"))}>Pin</button>
      <button onClick={()=>runAction(()=>onBulkAction("snooze"))}>Snooze</button>
      <button onClick={()=>runAction(()=>onBulkAction("settle"))}>Settle</button>
      <button onClick={()=>runAction(()=>onBulkAction("archive"))}>Archive</button>
    </div>}

    <div className="thread-sections" ref={sectionsRef}>
      {THREAD_GROUP_NAMES.map(name=>{const items=groups[name],virtualized=shouldVirtualizeSidebarGroup(items),chunks=virtualized?sidebarVirtualChunks(items):[],activeChunk=virtualized?sidebarChunkIndexForThread(chunks,activeThreadId):-1;return items.length>0&&<section key={name}>
        <h4>{name}<span>{items.length}</span></h4>
        {virtualized?chunks.map((chunk,index)=><SidebarVirtualChunk key={chunk.key} chunk={chunk} rootRef={sectionsRef} forceMount={index===activeChunk} initialMount={name===firstGroupName&&index===0} activeThreadId={activeThreadId} renderRow={renderRow}/>):items.map(renderRow)}
      </section>})}
      {!threads.length&&<div className="sidebar-empty">{query?"No matching threads.":<>No threads yet.<br/>Start a task to create one.</>}</div>}
    </div>

    <div className="sidebar-footer">
      <div className="sidebar-utilities">
        <UtilityButton Icon={Folder} label="Projects" active={section==="projects"} onClick={()=>setSection("projects")}/>
        <UtilityButton Icon={Globe2} label="Browser" active={rightPanelOpen&&rightPanelTab==="preview"} onClick={()=>setSection("preview")}/>
        {runtimeCapabilities.delegation&&<UtilityButton Icon={Bot} label="Agents" active={rightPanelOpen&&rightPanelTab==="agents"} onClick={()=>setSection("agents")}/>}
        <UtilityButton Icon={History} label="History" active={section==="history"} onClick={()=>setSection("history")}/>
        <UtilityButton Icon={BarChart3} label="Usage" active={section==="usage"} onClick={()=>setSection("usage")}/>
        {runtimeCapabilities.harnessTools&&<UtilityButton Icon={Wrench} label="Tools" active={section==="tools"} onClick={()=>setSection("tools")}/>}
        <UtilityButton Icon={Server} label="Environments" active={section==="environments"} onClick={()=>setSection("environments")}/>
        <UtilityButton Icon={Settings} label="Settings" active={section==="settings"} onClick={()=>setSection("settings")}/>
      </div>
      <button className="sidebar-provider" onClick={()=>setSection(agentRuntime==="codex"&&provider==="freebuff"?"freebuff":"settings")} title={"Configure "+runtimeLabel}><span className="provider-dot"/><div><strong>{runtimeLabel}</strong><span>{agentRuntime==="codex"?providerLabel+" inference":"Agent harness"}</span></div><MoreHorizontal size={13}/></button>
    </div>
  </aside>;
});

export default ThreadSidebar;
