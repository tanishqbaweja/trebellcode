import React,{useEffect,useMemo,useRef,useState} from "react";
import { CornerDownLeft, MessageSquareText, Search } from "lucide-react";

export default function CommandPalette({open,onClose,actions=[],threads=[],onOpenThread}){
  const [query,setQuery]=useState("");
  const [selected,setSelected]=useState(0);
  const inputRef=useRef(null);
  useEffect(()=>{if(!open)return;setQuery("");setSelected(0);const t=setTimeout(()=>inputRef.current?.focus(),0);return()=>clearTimeout(t)},[open]);
  const items=useMemo(()=>{
    const q=query.trim().toLowerCase();
    const commands=actions.map(action=>({...action,kind:"command"}));
    const threadItems=(threads||[]).map(thread=>({id:"thread:"+thread.id,kind:"thread",label:thread.name||thread.preview||"Untitled task",detail:thread.cwd||"Open thread",onRun:()=>onOpenThread?.(thread)}));
    const all=[...commands,...threadItems];
    return (q?all.filter(item=>(item.label+" "+(item.detail||"")).toLowerCase().includes(q)):all).slice(0,24);
  },[actions,threads,onOpenThread,query]);
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
      <div className="command-palette-search"><Search size={15}/><input ref={inputRef} value={query} onChange={event=>{setQuery(event.target.value);setSelected(0)}} onKeyDown={keyDown} placeholder="Search commands and threads…"/><kbd>Esc</kbd></div>
      <div className="command-palette-results">
        {items.map((item,index)=><button key={item.id} className={index===selected?"selected":""} onMouseEnter={()=>setSelected(index)} onClick={()=>run(item)}>
          <span className="command-palette-icon">{item.kind==="thread"?<MessageSquareText size={14}/>:item.icon||<CornerDownLeft size={14}/>}</span>
          <span><strong>{item.label}</strong><small>{item.detail||""}</small></span>{item.shortcut&&<kbd>{item.shortcut}</kbd>}
        </button>)}
        {!items.length&&<div className="command-palette-empty">No matching command or thread.</div>}
      </div>
    </div>
  </div>;
}
