import React,{useEffect,useMemo,useRef,useState} from "react";
import { CornerDownLeft, FolderCode, MessageSquareText, Search } from "lucide-react";

export default function CommandPalette({open,onClose,actions=[],projects=[],threads=[],environmentNames={},onOpenProject,onOpenThread,onSearchThreadMessages}){
  const [query,setQuery]=useState("");
  const [selected,setSelected]=useState(0);
  const [messageMatches,setMessageMatches]=useState([]);
  const [messageSearching,setMessageSearching]=useState(false);
  const inputRef=useRef(null);
  useEffect(()=>{if(!open)return;setQuery("");setSelected(0);setMessageMatches([]);setMessageSearching(false);const t=setTimeout(()=>inputRef.current?.focus(),0);return()=>clearTimeout(t)},[open]);
  useEffect(()=>{
    if(!open)return;
    const closeOnEscape=event=>{
      if(event.key!=="Escape")return;
      event.preventDefault();
      event.stopPropagation();
      onClose?.();
    };
    window.addEventListener("keydown",closeOnEscape,true);
    return()=>window.removeEventListener("keydown",closeOnEscape,true);
  },[open,onClose]);
  useEffect(()=>{
    const raw=query.trim();const q=raw.startsWith(">")?raw.slice(1).trim():raw;
    if(!open||raw.startsWith(">")||q.length<2||!onSearchThreadMessages){setMessageMatches([]);setMessageSearching(false);return}
    let cancelled=false;setMessageSearching(true);
    const timer=setTimeout(async()=>{
      const matches=await onSearchThreadMessages(q).catch(()=>[]);
      if(!cancelled){setMessageMatches(matches||[]);setMessageSearching(false)}
    },180);
    return()=>{cancelled=true;clearTimeout(timer)}
  },[open,query,onSearchThreadMessages]);
  const items=useMemo(()=>{
    const raw=query.trim();const actionOnly=raw.startsWith(">");const q=(actionOnly?raw.slice(1):raw).trim().toLowerCase();
    const messageMap=new Map((messageMatches||[]).map(match=>[match.threadId,match.excerpt]));
    const commands=actions.map(action=>({...action,kind:"command"}));
    const projectItems=(projects||[]).map(project=>{
      const environmentId=project.environmentId||"local";
      const environment=project.environment?.name||environmentNames[environmentId]||"Local machine";
      return {id:"project:"+project.id,kind:"project",label:project.name||project.path||"Workspace",detail:environment+" · "+project.path,onRun:()=>onOpenProject?.(project)};
    });
    const threadItems=(threads||[]).map(thread=>{
      const environmentId=thread.providerMeta?.environmentId||"local";
      const environment=environmentNames[environmentId]||"Local machine";
      const excerpt=messageMap.get(thread.id);
      return {id:"thread:"+thread.id,kind:"thread",label:thread.name||thread.preview||"Untitled task",detail:excerpt?"Message · "+excerpt:environment+" · "+(thread.cwd||"Open thread"),messageMatch:Boolean(excerpt),onRun:()=>onOpenThread?.(thread)};
    });
    const all=actionOnly?commands:[...commands,...projectItems,...threadItems];
    return (q?all.filter(item=>item.messageMatch||(item.label+" "+(item.detail||"")).toLowerCase().includes(q)):all).slice(0,24);
  },[actions,projects,threads,environmentNames,onOpenProject,onOpenThread,query,messageMatches]);
  useEffect(()=>{if(selected>=items.length)setSelected(Math.max(0,items.length-1))},[items.length,selected]);
  if(!open)return null;
  function run(item){if(!item)return;onClose?.();Promise.resolve(item.onRun?.()).catch(()=>{})}
  function keyDown(event){
    if(event.key==="Escape"){event.preventDefault();onClose?.();return}
    if(event.key==="ArrowDown"){event.preventDefault();setSelected(i=>Math.min(items.length-1,i+1));return}
    if(event.key==="ArrowUp"){event.preventDefault();setSelected(i=>Math.max(0,i-1));return}
    if(event.key==="Enter"){event.preventDefault();run(items[selected])}
  }
  return <div className="command-palette-backdrop" data-testid="command-palette" onMouseDown={event=>event.target===event.currentTarget&&onClose?.()}>
    <div className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette">
      <div className="command-palette-search"><Search size={15}/><input ref={inputRef} value={query} onChange={event=>{setQuery(event.target.value);setSelected(0)}} onKeyDown={keyDown} placeholder="Search commands, threads, and messages…"/>{messageSearching&&<span className="command-palette-searching">Searching messages…</span>}<kbd>Esc</kbd></div>
      <div className="command-palette-results">
        {items.map((item,index)=><button key={item.id} className={index===selected?"selected":""} onMouseEnter={()=>setSelected(index)} onClick={()=>run(item)}>
          <span className="command-palette-icon">{item.kind==="thread"?<MessageSquareText size={14}/>:item.kind==="project"?<FolderCode size={14}/>:item.icon||<CornerDownLeft size={14}/>}</span>
          <span><strong>{item.label}</strong><small>{item.detail||""}</small></span>{item.shortcut&&<kbd>{item.shortcut}</kbd>}
        </button>)}
        {!items.length&&<div className="command-palette-empty">No matching command or thread.</div>}
      </div>
    </div>
  </div>;
}
