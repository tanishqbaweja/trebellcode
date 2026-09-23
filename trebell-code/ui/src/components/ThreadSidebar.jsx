import React,{useEffect,useRef} from "react";
import {
  Archive, BarChart3, Bot, Clock3, Folder, Globe2, History,
  GitPullRequest, MoreHorizontal, Pin, Plus, Search, Settings, SlidersHorizontal, Wrench, Server, PanelLeftClose
} from "lucide-react";
import { formatSnoozeUntil } from "../thread-snooze.js";
import { threadReferenceValues } from "../thread-references.js";
import { writeClipboardText } from "../clipboard.js";

function titleOf(thread){return thread.name||thread.preview||"Untitled task"}
function relativeTime(epoch){
  if(!epoch)return "";
  const d=Math.max(0,Date.now()/1000-epoch);
  if(d<60)return "now";
  if(d<3600)return Math.floor(d/60)+"m";
  if(d<86400)return Math.floor(d/3600)+"h";
  return Math.floor(d/86400)+"d";
}

function ThreadRow({thread,meta,active,selected,bulk,onOpen,onSelect,onAction,onMove,agentRuntime="codex"}){
  const section=thread.section?.name||"Active";
  const linked=Array.isArray(meta?.linkedPullRequests)
    ?meta.linkedPullRequests
    :(meta?.attachments||[]).filter(item=>item?.attachmentType==="pull_request").map(item=>item.payload||{}).filter(Boolean);
  const detected=linked.length?null:meta?.branchPullRequest||null;
  const review=linked[0]||detected;const reviewNumber=review?.identity?.number||review?.number;
  const reviewLabel=linked.length>1?"#"+reviewNumber+" +"+(linked.length-1):reviewNumber?"#"+reviewNumber:null;
  const references=threadReferenceValues(thread,meta);
  const copy=value=>writeClipboardText(value);
  return <div className={active?"thread-row active":"thread-row"}>
    {bulk&&<input className="thread-select" type="checkbox" checked={selected} onChange={()=>onSelect(thread.id)}/>}
    <button className="thread-main" onClick={()=>onOpen(thread)} title={titleOf(thread)}>
      <span className={"thread-status-dot "+(section==="Pinned"?"pinned":section==="Snoozed"?"snoozed":section==="Settled"?"settled":"")}/>
      <div>
        <strong className="thread-title-line"><span className="thread-title-text">{titleOf(thread)}</span>{reviewLabel&&<em className={linked.length?"thread-pr-chip linked":"thread-pr-chip detected"} title={linked.length?"Linked pull request":"Detected from saved branch"}><GitPullRequest size={9}/>{reviewLabel}</em>}</strong>
        <span>{section==="Snoozed"&&meta?.snoozedUntil?"Wakes "+formatSnoozeUntil(meta.snoozedUntil):meta?.projectless?"No project · "+relativeTime(thread.updatedAt):(thread.model?.replace(/^freebuff\//,"")||({codex:"Codex",claude:"Claude",cursor:"Cursor",grok:"Grok",opencode:"OpenCode",antigravity:"Antigravity"}[agentRuntime]||agentRuntime))+" · "+relativeTime(thread.updatedAt)}</span>
      </div>
    </button>
    <details className="thread-menu">
      <summary title="Thread actions"><MoreHorizontal size={13}/></summary>
      <div className="thread-menu-popover">
        <button onClick={()=>onAction(thread,section==="Pinned"?"active":"pin")}>{section==="Pinned"?"Unpin":"Pin"}</button>
        <button onClick={()=>onAction(thread,section==="Snoozed"?"active":"snooze")}>{section==="Snoozed"?"Wake thread":"Snooze…"}</button>
        <button onClick={()=>onAction(thread,section==="Settled"?"active":"settle")}>{section==="Settled"?"Un-settle":"Settle"}</button>
        {(agentRuntime==="codex"||agentRuntime==="opencode"||thread.providerMeta?.initialize?.agentCapabilities?.sessionCapabilities?.fork!=null)&&<button onClick={()=>onAction(thread,"fork")}>Fork thread</button>}
        <button onClick={()=>onMove(thread,-1)}>Move up</button>
        <button onClick={()=>onMove(thread,1)}>Move down</button>
        <button onClick={()=>copy(references.threadId)}>Copy thread ID</button>
        {references.branch&&<button onClick={()=>copy(references.branch)}>Copy branch</button>}
        {references.path&&!meta?.projectless&&<button onClick={()=>copy(references.path)}>Copy path</button>}
        <button onClick={()=>onAction(thread,"archive")}>Archive</button>
        <button className="danger" onClick={()=>onAction(thread,"delete")}>Delete</button>
      </div>
    </details>
  </div>;
}

function UtilityButton({Icon,label,active,onClick}){
  return <button className={active?"sidebar-utility active":"sidebar-utility"} onClick={onClick} aria-label={label} title={label}>
    <Icon size={15}/><span>{label}</span>
  </button>;
}

export default function ThreadSidebar({
  section,setSection,threads,activeThreadId,query,setQuery,onOpen,onNew,onThreadAction,onMove,
  selectedIds,setSelectedIds,onBulkAction,provider="freebuff",agentRuntime="codex",threadMeta={},onCollapse,
  rightPanelOpen=false,rightPanelTab="files"
}){
  const searchRef=useRef(null);
  useEffect(()=>{
    const focus=()=>{searchRef.current?.focus();searchRef.current?.select?.()};
    window.addEventListener("trebell:sidebar-search",focus);
    return()=>window.removeEventListener("trebell:sidebar-search",focus);
  },[]);
  const groups={
    Pinned:threads.filter(t=>t.section?.name==="Pinned"),
    General:threads.filter(t=>!t.section&&threadMeta[t.id]?.projectless),
    Active:threads.filter(t=>!t.section&&!threadMeta[t.id]?.projectless),
    Snoozed:threads.filter(t=>t.section?.name==="Snoozed"),
    Settled:threads.filter(t=>t.section?.name==="Settled"),
  };
  const bulk=selectedIds.size>0;
  const providerLabel={freebuff:"Freebuff",agentrouter:"AgentRouter",justworker:"JustWorker",hcnsec:"HCNSec",vyceai:"VyceAi"}[provider]||provider;
  const runtimeLabel={codex:"Codex",claude:"Claude Code",cursor:"Cursor",grok:"Grok Build",opencode:"OpenCode",antigravity:"Antigravity"}[agentRuntime]||agentRuntime;
  function toggle(id){const next=new Set(selectedIds);next.has(id)?next.delete(id):next.add(id);setSelectedIds(next)}

  return <aside className="sidebar">
    <div className="sidebar-titlebar">
      <button className="sidebar-brand" onClick={()=>setSection("chat")} aria-label="Threads">
        <img className="brand-mark" src="/trebell-code-icon.svg" alt="" aria-hidden="true"/><strong>Trebell <em>Code</em></strong>
      </button>
      <div className="sidebar-title-actions"><button className="sidebar-new-thread" onClick={onCollapse} aria-label="Collapse sidebar" title="Collapse sidebar · Ctrl+B"><PanelLeftClose size={15}/></button><button className="sidebar-new-thread" onClick={onNew} aria-label="New thread" title="New thread"><Plus size={16}/></button></div>
    </div>

    <div className="sidebar-thread-tools">
      <div className="search-box">
        <Search size={14}/>
        <input ref={searchRef} value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search"/>
        {query&&<button onClick={()=>setQuery("")} aria-label="Clear search">×</button>}
      </div>
      <button className="sidebar-bulk-toggle" onClick={()=>setSelectedIds(bulk?new Set():new Set(threads.slice(0,1).map(t=>t.id)))} title="Thread actions" aria-label="Thread actions">
        {bulk?<SlidersHorizontal size={14}/>:<MoreHorizontal size={15}/>}
      </button>
    </div>

    {bulk&&<div className="bulk-bar">
      <span>{selectedIds.size} selected</span>
      <button onClick={()=>onBulkAction("pin")}>Pin</button>
      <button onClick={()=>onBulkAction("snooze")}>Snooze</button>
      <button onClick={()=>onBulkAction("settle")}>Settle</button>
      <button onClick={()=>onBulkAction("archive")}>Archive</button>
    </div>}

    <div className="thread-sections">
      {Object.entries(groups).map(([name,items])=>items.length>0&&<section key={name}>
        <h4>{name}<span>{items.length}</span></h4>
        {items.map(t=><ThreadRow key={t.id} thread={t} meta={threadMeta[t.id]||null} active={t.id===activeThreadId} bulk={bulk} selected={selectedIds.has(t.id)} onOpen={onOpen} onSelect={toggle} onAction={onThreadAction} onMove={onMove} agentRuntime={agentRuntime}/>)}
      </section>)}
      {!threads.length&&<div className="sidebar-empty">No threads yet.<br/>Start a task to create one.</div>}
    </div>

    <div className="sidebar-footer">
      <div className="sidebar-utilities">
        <UtilityButton Icon={Folder} label="Projects" active={section==="projects"} onClick={()=>setSection("projects")}/>
        <UtilityButton Icon={Globe2} label="Browser" active={rightPanelOpen&&rightPanelTab==="preview"} onClick={()=>setSection("preview")}/>
        {agentRuntime==="codex"&&<UtilityButton Icon={Bot} label="Agents" active={rightPanelOpen&&rightPanelTab==="agents"} onClick={()=>setSection("agents")}/>}
        <UtilityButton Icon={History} label="History" active={section==="history"} onClick={()=>setSection("history")}/>
        <UtilityButton Icon={BarChart3} label="Usage" active={section==="usage"} onClick={()=>setSection("usage")}/>
        {agentRuntime==="codex"&&<UtilityButton Icon={Wrench} label="Tools" active={section==="tools"} onClick={()=>setSection("tools")}/>}
        <UtilityButton Icon={Server} label="Environments" active={section==="environments"} onClick={()=>setSection("environments")}/>
        <UtilityButton Icon={Settings} label="Settings" active={section==="settings"} onClick={()=>setSection("settings")}/>
      </div>
      <button className="sidebar-provider" onClick={()=>setSection(agentRuntime==="codex"&&provider==="freebuff"?"freebuff":"settings")} title={"Configure "+runtimeLabel}><span className="provider-dot"/><div><strong>{runtimeLabel}</strong><span>{agentRuntime==="codex"?providerLabel+" inference":"Agent harness"}</span></div><MoreHorizontal size={13}/></button>
    </div>
  </aside>;
}
