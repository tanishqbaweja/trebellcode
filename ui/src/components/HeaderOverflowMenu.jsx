import React,{useEffect,useRef,useState} from "react";
import { MoreHorizontal } from "lucide-react";

// The workspace header's More actions menu. header-fit.js shows it once the row has to fold actions, and the menu lists the
// folded ones, so every action stays reachable however narrow the main column is. Each item is
// {id,fold,Icon,label,detail,hint,title,pressed,onSelect}, or {id,fold,render} for a control that draws itself (the Open-in
// picker): render(close) returns it, and it calls close when it runs its action. An item with fold (its row control's data-fold)
// shows only while that control is folded; one without shows whenever the menu does. Falsy items are skipped. It closes like
// the other menus: Escape (focus returns to its button), a click outside it, focus moving out of it and its button (Tab past the
// last item), a chosen action (focus that was in the menu returns to its button), and the header giving every action back to
// the row (the inspector closes, a turn ends).
const focusable=node=>Boolean(node?.offsetParent)&&!node.disabled&&node.tabIndex>=0;

// Where focus in the menu (an item, or its button) goes when the row takes every action back and the button hides, and the
// menu with it: to the row's own control for the action the focused item stood for, else to the last control shown before the
// button, so it stays in the header instead of falling to the page.
function focusAfterUnfold(header,wrap,focused){
  const item=focused.closest("[data-fold]"),fold=item&&wrap.contains(item)?item.dataset.fold:null;
  const twin=fold?[...header.querySelectorAll(".workspace-header-actions>[data-fold]")].find(node=>node.dataset.fold===fold):null;
  const own=twin?[twin,...twin.querySelectorAll(focused.tagName)].find(node=>node.tagName===focused.tagName&&focusable(node)):null;
  if(own)return own;
  const controls=[...header.querySelectorAll("button,select,input,a[href]")].filter(node=>!wrap.contains(node)&&focusable(node));
  return controls.filter(node=>node.compareDocumentPosition(wrap)&Node.DOCUMENT_POSITION_FOLLOWING).at(-1)||controls[0]||null;
}

export default function HeaderOverflowMenu({items=[]}){
  const [open,setOpen]=useState(false);
  const wrapRef=useRef(null),buttonRef=useRef(null);
  const shown=items.filter(Boolean),hasItems=shown.length>0;
  useEffect(()=>{
    const wrap=wrapRef.current;if(!open||!wrap)return;
    const pointerDown=event=>{if(!wrap.contains(event.target))setOpen(false)};
    const focusIn=event=>{if(!wrap.contains(event.target))setOpen(false)};
    const keyDown=event=>{
      if(event.key!=="Escape")return;
      event.preventDefault();event.stopPropagation();
      setOpen(false);buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown",pointerDown,true);
    document.addEventListener("focusin",focusIn,true);
    document.addEventListener("keydown",keyDown,true);
    return()=>{document.removeEventListener("pointerdown",pointerDown,true);document.removeEventListener("focusin",focusIn,true);document.removeEventListener("keydown",keyDown,true)};
  },[open]);
  // The fit runs every level before it settles; the record arrives once it has, so only the settled fit counts. It is watched
  // with the menu closed too, since focus can be on the button alone. An item the row takes back while the menu stays open hides,
  // so focus on it moves to the button; when the button hides as well, focus goes to the row (focusAfterUnfold).
  useEffect(()=>{
    const wrap=wrapRef.current,header=wrap?.closest(".workspace-header");
    if(!header||typeof MutationObserver!=="function")return;
    const fit=new MutationObserver(()=>{
      const focused=document.activeElement,inside=focused!==wrap&&wrap.contains(focused);
      if(!wrap.offsetParent){setOpen(false);if(inside)focusAfterUnfold(header,wrap,focused)?.focus();return}
      if(inside&&focused!==buttonRef.current&&!focused.offsetParent)buttonRef.current?.focus();
    });
    fit.observe(header,{attributes:true,attributeFilter:["data-fit","data-folded"],subtree:true});
    return()=>fit.disconnect();
  },[hasItems]);
  if(!hasItems)return null;
  // Focus goes back to the button before the action runs, so an action that takes focus itself (the command palette) keeps it.
  const close=()=>{if(wrapRef.current?.contains(document.activeElement))buttonRef.current?.focus();setOpen(false)};
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
