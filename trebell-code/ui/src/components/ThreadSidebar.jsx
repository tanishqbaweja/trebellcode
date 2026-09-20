import React from "react";
import {
  Archive, Bot, CircleDollarSign, Clock3, Folder, GitBranch, Globe2, History,
  MoreHorizontal, Pin, Plus, Search, Settings, SlidersHorizontal
} from "lucide-react";

function titleOf(thread){return thread.name||thread.preview||"Untitled task"}
function relativeTime(epoch){
  if(!epoch)return "";
  const d=Math.max(0,Date.now()/1000-epoch);
  if(d<60)return "now";
  if(d<3600)return Math.floor(d/60)+"m";
  if(d<86400)return Math.floor(d/3600)+"h";
  return Math.floor(d/86400)+"d";
}

function ThreadRow({thread,active,selected,bulk,onOpen,onSelect,onAction,onMove}){
  const section=thread.section?.name||"Active";
  return <div className={active?"thread-row active":"thread-row"}>
    {bulk&&<input className="thread-select" type="checkbox" checked={selected} onChange={()=>onSelect(thread.id)}/>}
    <button className="thread-main" onClick={()=>onOpen(thread)} title={titleOf(thread)}>
      <span className={"thread-status-dot "+(section==="Pinned"?"pinned":section==="Snoozed"?"snoozed":section==="Settled"?"settled":"")}/>
      <div>
        <strong>{titleOf(thread)}</strong>
        <span>{thread.model?.replace(/^freebuff\//,"")||"Codex"} · {relativeTime(thread.updatedAt)}</span>
      </div>
    </button>
    <div className="thread-actions">
      <button title={section==="Pinned"?"Unpin":"Pin"} onClick={()=>onAction(thread,section==="Pinned"?"active":"pin")}><Pin size={11}/></button>
      <button title="Snooze" onClick={()=>onAction(thread,"snooze")}><Clock3 size={11}/></button>
      <button title={section==="Settled"?"Un-settle":"Settle"} onClick={()=>onAction(thread,section==="Settled"?"active":"settle")}><Archive size={11}/></button>
      <button title="Move up" onClick={()=>onMove(thread,-1)}>↑</button>
      <button title="Move down" onClick={()=>onMove(thread,1)}>↓</button>
    </div>
  </div>;
}

function UtilityButton({Icon,label,active,onClick}){
  return <button className={active?"sidebar-utility active":"sidebar-utility"} onClick={onClick} aria-label={label} title={label}>
    <Icon size={15}/><span>{label}</span>
  </button>;
}

export default function ThreadSidebar({
  section,setSection,threads,activeThreadId,query,setQuery,onOpen,onNew,onThreadAction,onMove,
  selectedIds,setSelectedIds,onBulkAction,provider="freebuff"
}){
  const groups={
    Pinned:threads.filter(t=>t.section?.name==="Pinned"),
    Active:threads.filter(t=>!t.section),
    Snoozed:threads.filter(t=>t.section?.name==="Snoozed"),
    Settled:threads.filter(t=>t.section?.name==="Settled"),
  };
  const bulk=selectedIds.size>0;
  const providerLabel={freebuff:"Freebuff",agentrouter:"AgentRouter",justworker:"JustWorker",hcnsec:"HCNSec",vyceai:"VyceAi"}[provider]||provider;
  function toggle(id){const next=new Set(selectedIds);next.has(id)?next.delete(id):next.add(id);setSelectedIds(next)}

  return <aside className="sidebar">
    <div className="sidebar-titlebar">
      <button className="sidebar-brand" onClick={()=>setSection("chat")} aria-label="Threads">
        <span className="brand-mark">T</span><strong>Trebell <em>Code</em></strong>
      </button>
      <button className="sidebar-new-thread" onClick={onNew} aria-label="New thread" title="New thread"><Plus size={16}/></button>
    </div>

    <div className="sidebar-thread-tools">
      <div className="search-box">
        <Search size={14}/>
        <input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search"/>
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
        {items.map(t=><ThreadRow key={t.id} thread={t} active={t.id===activeThreadId} bulk={bulk} selected={selectedIds.has(t.id)} onOpen={onOpen} onSelect={toggle} onAction={onThreadAction} onMove={onMove}/>)}
      </section>)}
      {!threads.length&&<div className="sidebar-empty">No threads yet.<br/>Start a task to create one.</div>}
    </div>

    <div className="sidebar-footer">
      <div className="sidebar-utilities">
        <UtilityButton Icon={Folder} label="Projects" active={section==="projects"} onClick={()=>setSection("projects")}/>
        <UtilityButton Icon={GitBranch} label="Source Control" active={section==="source"} onClick={()=>setSection("source")}/>
        <UtilityButton Icon={Globe2} label="Preview" active={section==="preview"} onClick={()=>setSection("preview")}/>
        <UtilityButton Icon={Bot} label="Agents" active={section==="agents"} onClick={()=>setSection("agents")}/>
        {provider==="freebuff"&&<UtilityButton Icon={CircleDollarSign} label="Freebuff" active={section==="freebuff"} onClick={()=>setSection("freebuff")}/>}
        <UtilityButton Icon={History} label="History" active={section==="history"} onClick={()=>setSection("history")}/>
        <UtilityButton Icon={Settings} label="Settings" active={section==="settings"} onClick={()=>setSection("settings")}/>
      </div>
      <div className="sidebar-provider"><span className="provider-dot"/><div><strong>{providerLabel}</strong><span>Codex harness</span></div></div>
    </div>
  </aside>;
}
