import React,{useEffect,useRef,useState} from "react";
import { MoreHorizontal } from "lucide-react";

// The workspace header's More actions menu. header-fit.js shows it once the row has to fold actions, and the menu lists the
// folded ones, so every action stays reachable however narrow the main column is. Each item is
// {id,fold,Icon,label,detail,hint,title,pressed,onSelect}, or {id,fold,render} for a control that draws itself (the Open-in
// picker): render(close) returns it, and it calls close when it runs its action. An item with fold (its row control's data-fold)
// shows only while that control is folded; one without shows whenever the menu does. Falsy items are skipped. It closes like
// the other menus: Escape (focus returns to its button), a click outside it, a chosen action, and the header giving every
// action back to the row (the inspector closes, a turn ends).
export default function HeaderOverflowMenu({items=[]}){
  const [open,setOpen]=useState(false);
  const wrapRef=useRef(null),buttonRef=useRef(null);
  useEffect(()=>{
    const wrap=wrapRef.current;if(!open||!wrap)return;
    const pointerDown=event=>{if(!wrap.contains(event.target))setOpen(false)};
    const keyDown=event=>{
      if(event.key!=="Escape")return;
      event.preventDefault();event.stopPropagation();
      setOpen(false);buttonRef.current?.focus();
    };
    // The fit runs every level before it settles; the record arrives once it has, so only the settled fit counts. An item the
    // row takes back while the menu stays open hides, so focus on it moves to the menu's button rather than off the page.
    const header=wrap.closest(".workspace-header");
    const fit=header&&typeof MutationObserver==="function"?new MutationObserver(()=>{
      if(!wrap.offsetParent){setOpen(false);return}
      const focused=document.activeElement;if(focused!==buttonRef.current&&wrap.contains(focused)&&!focused.offsetParent)buttonRef.current?.focus();
    }):null;
    fit?.observe(header,{attributes:true,attributeFilter:["data-fit","data-folded"],subtree:true});
    document.addEventListener("pointerdown",pointerDown,true);
    document.addEventListener("keydown",keyDown,true);
    return()=>{fit?.disconnect();document.removeEventListener("pointerdown",pointerDown,true);document.removeEventListener("keydown",keyDown,true)};
  },[open]);
  const shown=items.filter(Boolean);
  if(!shown.length)return null;
  const close=()=>setOpen(false);
  const choose=item=>{close();item.onSelect?.()};
  return <div className="header-overflow" ref={wrapRef}>
    <button ref={buttonRef} type="button" className={"header-control icon-only"+(open?" active":"")} onClick={()=>setOpen(value=>!value)} aria-label="More actions" title="More actions" aria-expanded={open}><MoreHorizontal size={16}/></button>
    {open&&<div className="header-overflow-menu" data-testid="header-overflow-menu">
      {shown.map(item=>item.render?<div className="header-overflow-node" key={item.id} data-fold={item.fold}>{item.render(close)}</div>:<button key={item.id} type="button" data-fold={item.fold} onClick={()=>choose(item)} title={item.title||undefined} aria-pressed={item.pressed==null?undefined:Boolean(item.pressed)}>
        {item.Icon&&<item.Icon size={14} aria-hidden="true"/>}<span>{item.label}</span>{item.detail&&<small>{item.detail}</small>}{item.hint&&<kbd className="tb-kbd">{item.hint}</kbd>}
      </button>)}
    </div>}
  </div>;
}
