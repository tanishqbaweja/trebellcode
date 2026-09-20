import React from "react";
import { Archive, Bot, CircleDollarSign, Clock3, Code2, FileCode2, Folder, GitBranch, Globe2, History, LayoutTemplate, MessageSquarePlus, MoreHorizontal, Pin, Search, Settings, Users, X } from "lucide-react";

function titleOf(thread){return thread.name||thread.preview||"Untitled task"}
function relativeTime(epoch){if(!epoch)return"";const d=Math.max(0,Date.now()/1000-epoch);if(d<60)return"now";if(d<3600)return Math.floor(d/60)+"m";if(d<86400)return Math.floor(d/3600)+"h";return Math.floor(d/86400)+"d"}

function ThreadRow({thread,active,selected,bulk,onOpen,onSelect,onAction,onMove}){
  const section=thread.section?.name||"Active";
  return <div className={active?"thread-row active":"thread-row"}>
    {bulk&&<input type="checkbox" checked={selected} onChange={()=>onSelect(thread.id)}/>}
    <button className="thread-main" onClick={()=>onOpen(thread)}><FileCode2 size={14}/><div><strong>{titleOf(thread)}</strong><span>{thread.model?.replace(/^freebuff\//,"")||section} · {relativeTime(thread.updatedAt)}</span></div></button>
    <div className="thread-actions">
      <button title={section==="Pinned"?"Unpin":"Pin"} onClick={()=>onAction(thread,section==="Pinned"?"active":"pin")}><Pin size={11}/></button>
      <button title="Snooze" onClick={()=>onAction(thread,"snooze")}><Clock3 size={11}/></button>
      <button title={section==="Settled"?"Un-settle":"Settle"} onClick={()=>onAction(thread,section==="Settled"?"active":"settle")}><Archive size={11}/></button>
      <button title="Move up" onClick={()=>onMove(thread,-1)}>↑</button><button title="Move down" onClick={()=>onMove(thread,1)}>↓</button>
    </div>
  </div>;
}

export default function ThreadSidebar({section,setSection,threads,activeThreadId,query,setQuery,onOpen,onNew,onThreadAction,onMove,selectedIds,setSelectedIds,onBulkAction}){
  const groups={
    Pinned:threads.filter(t=>t.section?.name==="Pinned"),
    Active:threads.filter(t=>!t.section),
    Snoozed:threads.filter(t=>t.section?.name==="Snoozed"),
    Settled:threads.filter(t=>t.section?.name==="Settled"),
  };
  const bulk=selectedIds.size>0;
  const nav=[
    ["new",MessageSquarePlus,"New task"],["chat",Code2,"Current thread"],["projects",Folder,"Projects"],["source",GitBranch,"Source Control"],
    ["agents",Users,"Agents"],["preview",Globe2,"Preview"],["templates",LayoutTemplate,"Templates"],["freebuff",CircleDollarSign,"Freebuff"],["settings",Settings,"Settings"],
  ];
  function toggle(id){const next=new Set(selectedIds);next.has(id)?next.delete(id):next.add(id);setSelectedIds(next)}
  return <aside className="sidebar">
    <div className="brand"><div className="brand-mark">✦</div><div><div className="brand-name">Trebell <span>Code</span></div><div className="brand-tag">Freebuff agent harness</div></div></div>
    <div className="search-box"><Search size={16}/><input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search threads & messages…"/><kbd>Ctrl K</kbd></div>
    <nav className="nav-stack">{nav.map(([id,Icon,label])=><button key={id} className={section===id?"nav-item active":"nav-item"} onClick={()=>id==="new"?onNew():setSection(id)}><Icon size={17}/><span>{label}</span></button>)}</nav>
    <div className="sidebar-rule"/>
    <div className="recent-head"><span>Threads</span><button onClick={()=>setSelectedIds(bulk?new Set():new Set(threads.slice(0,1).map(t=>t.id)))}>{bulk?<X size={14}/>:<MoreHorizontal size={14}/>}</button></div>
    {bulk&&<div className="bulk-bar"><button onClick={()=>onBulkAction("pin")}>Pin</button><button onClick={()=>onBulkAction("snooze")}>Snooze</button><button onClick={()=>onBulkAction("settle")}>Settle</button><button onClick={()=>onBulkAction("archive")}>Archive</button></div>}
    <div className="thread-sections">{Object.entries(groups).map(([name,items])=>items.length>0&&<section key={name}><h4>{name}<span>{items.length}</span></h4>{items.map(t=><ThreadRow key={t.id} thread={t} active={t.id===activeThreadId} bulk={bulk} selected={selectedIds.has(t.id)} onOpen={onOpen} onSelect={toggle} onAction={onThreadAction} onMove={onMove}/>)}</section>)}</div>
    <button className="view-all" onClick={()=>setSection("history")}><History size={12}/> Full history</button>
    <div className="profile-card"><div className="avatar">T</div><div><strong>Trebell Code</strong><span>Local harness · Freebuff model</span></div><button onClick={()=>setSection("settings")}><Settings size={15}/></button></div>
  </aside>;
}
