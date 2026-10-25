import React,{useEffect,useLayoutEffect,useMemo,useRef,useState} from "react";
import { BarChart3, Bot, Copy, CornerDownLeft, FileDiff, Files, FolderCode, FolderGit2, FolderOpen, GitBranch, GitPullRequest, Globe, Layers, MessageSquarePlus, MessageSquareText, Monitor, Moon, Palette, Play, Scale, Search, Server, Settings, ShieldCheck, SquarePen, SquareTerminal, Sun, Target, Wrench } from "lucide-react";

// Presentational icons for the built-in palette actions (keyed by action id). Actions can still pass their own icon.
const ACTION_ICONS={
  new:SquarePen,"new-general":MessageSquarePlus,folder:FolderOpen,projects:FolderGit2,files:Files,diff:FileDiff,git:GitBranch,
  context:Layers,"link-pr":GitPullRequest,terminal:SquareTerminal,browser:Globe,agents:Bot,goal:Target,review:ShieldCheck,
  tools:Wrench,environments:Server,usage:BarChart3,licenses:Scale,"appearance-system":Monitor,"appearance-light":Sun,
  "appearance-dark":Moon,settings:Settings,copy:Copy,
};
const GROUP_LABELS={command:"Commands",project:"Projects",thread:"Threads"};

// Modal focus: keep Tab/Shift+Tab inside the palette so keyboard users cannot reach (and activate) controls behind
// the backdrop. Focus that sits inside another open modal is left alone, the question a command asks in the app's own <dialog>
// (Link pull request) among them.
function useModalFocus(ref,active,focusOnOpen=true){
  useEffect(()=>{
    const node=ref.current;if(!active||!node)return;
    if(focusOnOpen&&!node.contains(document.activeElement))node.focus({preventScroll:true});
    const onKey=event=>{
      if(event.key!=="Tab"||event.defaultPrevented)return;
      const current=document.activeElement,owner=current?.closest?.('[aria-modal="true"],dialog[open]');
      if(owner&&owner!==node)return;
      const items=[...node.querySelectorAll("button,input,select,textarea,a[href],[tabindex]")].filter(item=>item.tabIndex>=0&&!item.disabled&&item.getClientRects().length);
      if(!items.length){event.preventDefault();node.focus();return}
      const first=items[0],last=items[items.length-1];
      if(!node.contains(current)||current===node){event.preventDefault();(event.shiftKey?last:first).focus()}
      else if(event.shiftKey&&current===first){event.preventDefault();last.focus()}
      else if(!event.shiftKey&&current===last){event.preventDefault();first.focus()}
    };
    document.addEventListener("keydown",onKey,true);
    return()=>document.removeEventListener("keydown",onKey,true);
  },[ref,active,focusOnOpen]);
}

// A key that types a character, which goes back to the search box from a result or Reload; Space presses the button it is on.
const typedKey=event=>event.key.length===1&&event.key!==" "&&!event.ctrlKey&&!event.metaKey&&!event.altKey;

function actionIcon(item){
  if(item.icon)return item.icon;
  const id=String(item.id||"");
  const Icon=ACTION_ICONS[id]||(id.startsWith("theme-")?Palette:id.startsWith("project-action:")?Play:CornerDownLeft);
  return <Icon size={15}/>;
}

export default function CommandPalette(props){
  if(!props.open)return null;
  return <CommandPaletteOpen {...props}/>;
}

// seed: App's handoff from the stand-in search box it shows while this code loads ({opener,query}, see CommandPaletteLoading).
// focusFallback: where focus goes when the control the palette was opened from has gone with the view a command left.
function CommandPaletteOpen({open,onClose,seed,focusFallback,actions=[],projects=[],threads=[],environmentNames={},dataError="",onOpenProject,onOpenThread,onSearchThreadMessages}){
  const [query,setQuery]=useState("");
  const [selected,setSelected]=useState(0);
  const [messageMatches,setMessageMatches]=useState([]);
  const [messageSearching,setMessageSearching]=useState(false);
  const [runningId,setRunningId]=useState(null);
  const [actionError,setActionError]=useState("");
  // Degraded message search ("Full thread search unavailable…") is a warning, kept apart from command failures so a
  // search that finishes late can no longer replace or wipe a command's error message.
  const [searchWarning,setSearchWarning]=useState("");
  // A message search that could not run at all (its code could not load) offers Reload, and with no message searched an empty list
  // says that no command or thread name matches, not that no thread does. It counts only while its warning shows.
  const [searchFailed,setSearchFailed]=useState(false);
  const inputRef=useRef(null);
  const resultsRef=useRef(null);
  const refocusRef=useRef(false);
  const dialogRef=useRef(null);
  const openerRef=useRef(null);
  useModalFocus(dialogRef,open,false);
  // The search box takes focus as the palette appears, before the next key is handled, so keys typed straight after Ctrl+K land in it
  // rather than in the composer (or nowhere). On a first open, while this code loads, App's stand-in search box takes them: the palette
  // starts from what was typed there, and from the control the stand-in was opened from. The arrow keys and Enter pressed there act
  // once the results for that search show (handedKeysRef), as they would have in the palette.
  const handedKeysRef=useRef(null);
  useLayoutEffect(()=>{
    const handoff=seed?.current;
    if(handoff){handoff.adopted=true;seed.current=null;if(handoff.query)setQuery(handoff.query);if(handoff.keys?.length)handedKeysRef.current={query:handoff.query||"",keys:handoff.keys}}
    if(!openerRef.current)openerRef.current=handoff?handoff.opener:document.activeElement;
    inputRef.current?.focus({preventScroll:true});
  },[]);
  // Closing gives focus back to what had it when the palette opened (the button or menu it was chosen from, the composer it was called
  // up from), so a keyboard user carries on from there rather than from the page's start. A command that put focus somewhere keeps it,
  // and when the opener went with the view the command left (the composer, for a command that opens a page) focusFallback places it.
  const focusFallbackRef=useRef(focusFallback);
  focusFallbackRef.current=focusFallback;
  useEffect(()=>()=>{
    const focused=document.activeElement,opener=openerRef.current;
    if(focused&&focused!==document.body&&!dialogRef.current?.contains(focused))return;
    if(opener instanceof HTMLElement&&opener!==document.body&&opener.isConnected&&opener.getClientRects().length)opener.focus({preventScroll:true});
    else focusFallbackRef.current?.();
  },[]);
  const messageSearchRef=useRef(onSearchThreadMessages);
  messageSearchRef.current=onSearchThreadMessages;
  // Escape in a question a command asked over the palette (askText's <dialog>, Link pull request) belongs to that question: it
  // cancels the question alone, and the command then ends as Cancel ends it.
  useEffect(()=>{
    if(!open)return;
    const closeOnEscape=event=>{
      if(event.key!=="Escape"||event.target?.closest?.("dialog[open]"))return;
      event.preventDefault();
      event.stopPropagation();
      onClose?.();
    };
    window.addEventListener("keydown",closeOnEscape,true);
    return()=>window.removeEventListener("keydown",closeOnEscape,true);
  },[open,onClose]);
  useEffect(()=>{
    if(!open)return;
    const raw=query.trim();const q=raw.startsWith(">")?raw.slice(1).trim():raw;
    if(raw.startsWith(">")||q.length<2||!messageSearchRef.current){setMessageMatches(current=>current.length?[]:current);setMessageSearching(false);setActionError("");setSearchWarning("");return}
    let cancelled=false;setMessageSearching(true);setActionError("");setSearchWarning("");
    const timer=setTimeout(async()=>{
      let result,failed=false;
      try{result=await messageSearchRef.current(q)}
      catch(error){failed=true;result={matches:[],warning:"Could not search thread messages: "+(error?.message||String(error))}}
      const matches=Array.isArray(result)?result:(result?.matches||[]);
      const warning=Array.isArray(result)?"":(result?.warning||"");
      if(!cancelled){setMessageMatches(matches);setMessageSearching(false);setSearchWarning(warning);setSearchFailed(failed)}
    },180);
    return()=>{cancelled=true;clearTimeout(timer)}
  },[open,query]);
  const items=useMemo(()=>{
    const raw=query.trim();const actionOnly=raw.startsWith(">");const q=(actionOnly?raw.slice(1):raw).trim().toLowerCase();
    const messageMap=new Map((messageMatches||[]).map(match=>[match.threadId,match.excerpt]));
    const threadMap=new Map((threads||[]).map(thread=>[thread.id,thread]));
    // A thread the list holds only as what Trebell saved of it (one beyond the listed page, kept without its name) shows as the search
    // found it, as the sidebar's search shows it.
    for(const match of messageMatches||[])if(match.thread?.id&&(!threadMap.has(match.thread.id)||threadMap.get(match.thread.id).__trebellCatalog))threadMap.set(match.thread.id,match.thread);
    const commands=actions.map(action=>({...action,kind:"command"}));
    const projectItems=(projects||[]).map(project=>{
      const environmentId=project.environmentId||"local";
      const environment=project.environment?.name||environmentNames[environmentId]||"Local machine";
      return {id:"project:"+project.id,kind:"project",label:project.name||project.path||"Workspace",detail:environment+" · "+project.path,onRun:()=>onOpenProject?.(project)};
    });
    const threadItems=[...threadMap.values()].map(thread=>{
      const environmentId=thread.providerMeta?.environmentId||"local";
      const environment=environmentNames[environmentId]||"Local machine";
      const excerpt=messageMap.get(thread.id);
      return {id:"thread:"+thread.id,kind:"thread",label:thread.name||thread.preview||"Untitled task",detail:excerpt?"Message · "+excerpt:environment+" · "+(thread.cwd||"Open thread"),messageMatch:Boolean(excerpt),onRun:()=>onOpenThread?.(thread)};
    });
    const all=actionOnly?commands:[...commands,...projectItems,...threadItems];
    // A command is found by its name, its detail and the other name it goes by (keywords: "New task", as the sidebar calls New thread).
    return (q?all.filter(item=>item.messageMatch||[item.label,item.detail,item.keywords].filter(Boolean).join(" ").toLowerCase().includes(q)):all).slice(0,24);
  },[actions,projects,threads,environmentNames,onOpenProject,onOpenThread,query,messageMatches]);
  useEffect(()=>{if(selected>=items.length)setSelected(Math.max(0,items.length-1))},[items.length,selected]);
  useEffect(()=>{
    const handed=handedKeysRef.current;if(!handed||handed.query!==query)return;
    handedKeysRef.current=null;
    let index=0;
    for(const key of handed.keys){
      if(key==="ArrowDown")index=Math.max(0,Math.min(items.length-1,index+1));
      else if(key==="ArrowUp")index=Math.max(0,index-1);
      else if(key==="Enter"){setSelected(index);run(items[index]);return}
    }
    setSelected(index);
  },[query,items]);
  // Keep the keyboard selection visible when arrowing past the visible part of the list.
  useEffect(()=>{resultsRef.current?.querySelector("button.selected")?.scrollIntoView?.({block:"nearest"})},[selected,items]);
  // After a failed command, return focus to the search box once it is enabled again (a timeout could fire while it
  // was still disabled, which left focus on <body> so typing and arrow keys stopped reaching the palette).
  useEffect(()=>{if(!runningId&&refocusRef.current){refocusRef.current=false;inputRef.current?.focus()}},[runningId]);
  async function run(item){
    if(!item||runningId)return;
    setRunningId(item.id);setActionError("");setSearchWarning("");
    try{await item.onRun?.();onClose?.()}
    catch(error){setActionError(error?.message||String(error)||"The command failed.");refocusRef.current=true;setRunningId(null)}
  }
  function keyDown(event){
    // A key of the person's own that moves or runs comes after the ones handed over from the stand-in, which then no longer apply.
    if(["ArrowDown","ArrowUp","Enter"].includes(event.key))handedKeysRef.current=null;
    if(event.key==="Escape"){event.preventDefault();onClose?.();return}
    if(event.key==="ArrowDown"){event.preventDefault();setSelected(i=>Math.min(items.length-1,i+1));return}
    if(event.key==="ArrowUp"){event.preventDefault();setSelected(i=>Math.max(0,i-1));return}
    if(event.key==="Enter"){event.preventDefault();run(items[selected])}
  }
  // Keyboard focus inside the result list (after Tab): arrows move between results, and typing goes back to the
  // search box. Before, arrows did nothing there and typed characters were lost.
  function resultsKeyDown(event){
    const buttons=[...(resultsRef.current?.querySelectorAll("button.command-palette-item")||[])];
    const at=buttons.indexOf(document.activeElement);
    if(at<0)return;
    if(event.key==="ArrowDown"||event.key==="ArrowUp"){
      event.preventDefault();
      buttons[Math.max(0,Math.min(buttons.length-1,at+(event.key==="ArrowDown"?1:-1)))]?.focus();
      return;
    }
    if(typedKey(event))inputRef.current?.focus();
  }
  // Reload, Tab's first stop from the search box while the message search could not load, takes keys as a result does: ArrowDown goes
  // on to the first result and ArrowUp back to the search box, and typing goes back to the search box, where it lands. Space and
  // Enter press it. Arrows did nothing there and letters were lost.
  function reloadKeyDown(event){
    if(event.key==="ArrowDown"||event.key==="ArrowUp"){
      const next=event.key==="ArrowUp"?inputRef.current:resultsRef.current?.querySelector("button.command-palette-item");
      if(next){event.preventDefault();next.focus()}
      return;
    }
    if(typedKey(event))inputRef.current?.focus();
  }
  const visibleError=[dataError,actionError,searchWarning].filter(Boolean).join(" · ");
  const warningOnly=Boolean(searchWarning)&&!dataError&&!actionError,unsearched=searchFailed&&Boolean(searchWarning);
  return <div className="command-palette-backdrop" data-testid="command-palette" onMouseDown={event=>event.target===event.currentTarget&&onClose?.()}>
    <div className="command-palette" role="dialog" aria-modal="true" aria-label="Command palette" ref={dialogRef} tabIndex={-1}>
      <div className="command-palette-search"><Search size={16}/><input ref={inputRef} value={query} onChange={event=>{handedKeysRef.current=null;setQuery(event.target.value);setSelected(0);setActionError("");setSearchWarning("")}} onKeyDown={keyDown} placeholder="Search commands, threads, and messages…" disabled={Boolean(runningId)} spellCheck={false} autoComplete="off"/>{messageSearching&&<span className="command-palette-searching">Searching messages…</span>}<kbd className="tb-kbd">Esc</kbd></div>
      {visibleError&&<div className={"command-palette-error"+(warningOnly?" is-warning":"")} role="alert"><span>{visibleError}</span>{unsearched&&<button type="button" className="tb-btn tb-btn--sm" onKeyDown={reloadKeyDown} onClick={()=>window.location.reload()}>Reload</button>}</div>}
      <div className="command-palette-results" ref={resultsRef} onKeyDown={resultsKeyDown}>
        {items.map((item,index)=><React.Fragment key={item.id}>
          {item.kind!==items[index-1]?.kind&&<div className="command-palette-group" role="presentation">{GROUP_LABELS[item.kind]||"Results"}</div>}
          <button className={(index===selected?"selected ":"")+"command-palette-item kind-"+item.kind+(item.messageMatch?" message-match":"")} aria-current={index===selected?"true":undefined} disabled={Boolean(runningId)} onMouseMove={()=>{if(index!==selected)setSelected(index)}} onFocus={()=>{if(index!==selected)setSelected(index)}} onClick={()=>run(item)}>
            <span className="command-palette-icon">{item.kind==="thread"?<MessageSquareText size={15}/>:item.kind==="project"?<FolderCode size={15}/>:actionIcon(item)}</span>
            <span className="command-palette-text"><strong>{item.label}</strong><small>{runningId===item.id?"Running…":item.detail||""}</small></span>{item.shortcut&&<kbd className="tb-kbd">{item.shortcut}</kbd>}
          </button>
        </React.Fragment>)}
        {!items.length&&<div className="command-palette-empty"><Search size={18}/><span>{unsearched?"No matching command or thread name.":"No matching command or thread."}</span></div>}
      </div>
      <div className="command-palette-footer" aria-hidden="true"><span><kbd className="tb-kbd">↑</kbd><kbd className="tb-kbd">↓</kbd> navigate</span><span><kbd className="tb-kbd">↵</kbd> run</span><span><kbd className="tb-kbd">esc</kbd> close</span><span className="command-palette-hint"><kbd className="tb-kbd">&gt;</kbd> commands only</span></div>
    </div>
  </div>;
}
