import React,{memo,useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState} from "react";
import {
  Archive, BarChart3, Bot, Clock3, Folder, Globe2, History,
  GitPullRequest, MoreHorizontal, Pin, Plus, Search, Settings, SlidersHorizontal, Wrench, Server, PanelLeftClose, SquarePen
} from "lucide-react";
import { formatSnoozeUntil } from "../thread-snooze.js";
import { threadReferenceValues } from "../thread-references.js";
import { writeClipboardText } from "../clipboard.js";
import { sidebarThreadGroups } from "../thread-sidebar-groups.js";
import { threadCatalogRuntime } from "../thread-catalog.js";
import { shouldVirtualizeSidebarGroup, sidebarChunkIndexForThread, sidebarVirtualChunks } from "../sidebar-virtualization.js";
import { DEFAULT_MODEL_PROVIDER, modelProviderLabel } from "../provider-labels.js";
import { fullDateTime, relativeTime } from "../time-format.js";
import { shortcutHint as formatShortcutHint } from "../keybindings.js";
import "./ThreadSidebar.css";

function titleOf(thread){return thread.name||thread.preview||"Untitled task"}

// A row's menu is shown in the top layer, where overlays.css anchors it to its button: nothing around the list can clip or cover it there
// (the list's edge fade is a mask, which hides whatever is drawn inside the list, a fixed menu too, and the destinations sit under the
// list). Without anchor positioning it stays in the list.
const ROW_MENU_TOP_LAYER=typeof CSS!=="undefined"&&typeof HTMLElement!=="undefined"&&"showPopover" in HTMLElement.prototype&&Boolean(CSS.supports?.("anchor-scope:all")&&CSS.supports?.("position-try-fallbacks:flip-block"));
function showRowMenu(menu,open){
  const popover=ROW_MENU_TOP_LAYER?menu?.querySelector(":scope>.thread-menu-popover"):null;if(!popover)return;
  try{if(open!==popover.matches(":popover-open"))open?popover.showPopover():popover.hidePopover()}catch{}
}
function closeRowMenu(menu){if(!menu)return;menu.open=false;showRowMenu(menu,false)}

function threadCanFork(thread,runtimeCapabilities={}){
  if(runtimeCapabilities.fork===true)return true;
  if(runtimeCapabilities.fork!=="runtime")return false;
  return thread?.providerMeta?.initialize?.agentCapabilities?.sessionCapabilities?.fork!=null;
}

const ThreadRow=memo(function ThreadRow({thread,meta,active,selected,bulk,running=false,onOpen,onSelect,onAction,onMove,canMoveUp=false,canMoveDown=false,runAction,agentRuntime="codex",runtimeCapabilities={}}){
  const menuRef=useRef(null);
  const [menuOpen,setMenuOpen]=useState(false);
  // One row menu is open at a time, and it closes like other menus: Escape (focus returns to its button) or a click outside it.
  useEffect(()=>{
    const menu=menuRef.current;if(!menuOpen||!menu)return;
    for(const other of document.querySelectorAll("details.thread-menu[open]"))if(other!==menu)closeRowMenu(other);
    const pointerDown=event=>{if(!menu.contains(event.target))closeRowMenu(menu)};
    const keyDown=event=>{
      if(event.key!=="Escape"||!menu.open)return;
      event.preventDefault();event.stopPropagation();
      closeRowMenu(menu);menu.querySelector("summary")?.focus();
    };
    document.addEventListener("pointerdown",pointerDown,true);
    document.addEventListener("keydown",keyDown,true);
    return()=>{document.removeEventListener("pointerdown",pointerDown,true);document.removeEventListener("keydown",keyDown,true)};
  },[menuOpen]);
  const section=thread.section?.name||"Active";
  const rowRuntime=threadCatalogRuntime(thread,meta,agentRuntime),foreignRuntime=rowRuntime!==agentRuntime;
  const rowRuntimeLabel=({native:"Native",codex:"Codex",claude:"Claude",cursor:"Cursor",grok:"Grok",opencode:"OpenCode",antigravity:"Antigravity"}[rowRuntime]||rowRuntime);
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
  // An item gives focus back to the menu's button as the menu closes (the item hides with it), so a dialog it opens, Snooze…,
  // gives focus back there too. The button shows only while its row has focus or the pointer, so after a question the item asked
  // (Delete) it cannot take focus back by itself: the row's own button takes it first and hands it on, as SnoozeDialog does.
  const runMenuAction=callback=>{
    const menu=menuRef.current,button=menu?.querySelector("summary");button?.focus();closeRowMenu(menu);
    return runAction(callback).then(()=>{if(document.activeElement===document.body&&button?.isConnected){button.closest(".thread-row")?.querySelector(".thread-main")?.focus({preventScroll:true});button.focus({preventScroll:true})}});
  };
  // Why a thread cannot be moved: Codex orders the threads outside a section by recent activity only, and a thread of a section whose
  // order could not be read has no place to move from (the reason is named).
  const orderHint=thread.sectionOrderError||(agentRuntime==="codex"&&!thread.section?.id&&!thread.section?.name?"This list is kept in order of recent activity":undefined);
  return <div className={active?"thread-row active":"thread-row"} data-thread-id={thread.id}>
    {bulk&&<input className="thread-select" type="checkbox" checked={selected} disabled={foreignRuntime} title={foreignRuntime?"Open this thread before applying bulk actions":undefined} onChange={()=>onSelect(thread.id)}/>}
    <button className="thread-main" onClick={()=>runAction(()=>onOpen(thread))} title={titleOf(thread)}>
      <span className={"thread-status-dot "+(section==="Pinned"?"pinned":section==="Snoozed"?"snoozed":section==="Settled"?"settled":"")}/>
      <div>
        <strong className="thread-title-line">{running&&<i className="tb-dot thread-running-dot" role="img" aria-label="Running" title="Running"/>}<span className="thread-title-text">{titleOf(thread)}</span>{foreignRuntime&&<em className="thread-runtime-chip" title={"Owned by "+rowRuntimeLabel}>{rowRuntimeLabel}</em>}{reviewLabel&&<em className={linked.length?"thread-pr-chip linked":"thread-pr-chip detected"} title={linked.length?"Linked pull request":"Detected from saved branch"}><GitPullRequest size={9}/>{reviewLabel}</em>}</strong>
        <span title={section==="Snoozed"&&meta?.snoozedUntil?undefined:fullDateTime(thread.updatedAt)||undefined}>{section==="Snoozed"&&meta?.snoozedUntil?"Wakes "+formatSnoozeUntil(meta.snoozedUntil):meta?.projectless?"No project · "+relativeTime(thread.updatedAt):(thread.model||rowRuntimeLabel)+" · "+relativeTime(thread.updatedAt)}</span>
      </div>
    </button>
    <details ref={menuRef} className="thread-menu" onToggle={event=>{const open=event.currentTarget.open;showRowMenu(event.currentTarget,open);setMenuOpen(open)}}>
      {/* The button opens the menu itself, so it is in the top layer and Escape closes it as it opens: the toggle event can come after the
          next key. */}
      <summary title="Thread actions" onClick={event=>{const menu=menuRef.current;if(!menu)return;event.preventDefault();menu.open=!menu.open;showRowMenu(menu,menu.open);setMenuOpen(menu.open)}}><MoreHorizontal size={13}/></summary>
      <div className="thread-menu-popover" popover={ROW_MENU_TOP_LAYER?"manual":undefined}>
        {foreignRuntime?<button onClick={()=>runMenuAction(()=>onOpen(thread))}>Open in {rowRuntimeLabel}</button>:<>
          <button onClick={()=>runMenuAction(()=>onAction(thread,section==="Pinned"?"active":"pin"))}>{section==="Pinned"?"Unpin":"Pin"}</button>
          <button onClick={()=>runMenuAction(()=>onAction(thread,section==="Snoozed"?"active":"snooze"))}>{section==="Snoozed"?"Wake thread":"Snooze…"}</button>
          <button onClick={()=>runMenuAction(()=>onAction(thread,section==="Settled"?"active":"settle"))}>{section==="Settled"?"Un-settle":"Settle"}</button>
          {threadCanFork(thread,runtimeCapabilities)&&<button onClick={()=>runMenuAction(()=>onAction(thread,"fork"))}>Fork thread</button>}
          <button disabled={!canMoveUp} title={orderHint} onClick={()=>runMenuAction(()=>onMove(thread,-1))}>Move up</button>
          <button disabled={!canMoveDown} title={orderHint} onClick={()=>runMenuAction(()=>onMove(thread,1))}>Move down</button>
        </>}
        <button onClick={()=>runMenuAction(()=>copy(references.threadId))}>Copy thread ID</button>
        {references.branch&&<button onClick={()=>runMenuAction(()=>copy(references.branch))}>Copy branch</button>}
        {references.path&&!meta?.projectless&&<button onClick={()=>runMenuAction(()=>copy(references.path))}>Copy path</button>}
        {!foreignRuntime&&<><button onClick={()=>runMenuAction(()=>onAction(thread,"archive"))}>Archive</button><button className="danger" onClick={()=>runMenuAction(()=>onAction(thread,"delete"))}>Delete</button></>}
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

const MAC_PLATFORM=typeof navigator!=="undefined"&&/Mac|iPhone|iPad/i.test(navigator.userAgentData?.platform||navigator.platform||"");
// A keybinding as the sidebar shows it: "Mod+Shift+P" reads "Ctrl+Shift+P" (or "⌘+Shift+P" on macOS). Settings > Shortcuts uses
// the same formatter (keybindings.js).
export const shortcutHint=formatShortcutHint;
// The same keybinding in aria-keyshortcuts form ("Control+Shift+P").
function ariaShortcut(value,mac=MAC_PLATFORM){
  const parts=String(value||"").split("+").map(part=>part.trim()).filter(Boolean);
  if(!parts.length)return undefined;
  const names={mod:mac?"Meta":"Control",ctrl:"Control",control:"Control",cmd:"Meta",command:"Meta",meta:"Meta",shift:"Shift",alt:"Alt",option:"Alt"};
  return parts.map(part=>names[part.toLowerCase()]||(part.length===1?part.toUpperCase():part)).join("+");
}
// Page destinations are marked current; Browser and Agents open inspector tabs, so they show a pressed "panel open" state instead of the
// page highlight (both can be on at once, for example the Projects page with the Browser panel open).
function UtilityButton({Icon,label,active,onClick,shortcut="",panel=false}){
  const hint=shortcutHint(shortcut);
  return <button className={"sidebar-utility"+(active?" active":"")+(panel?" panel-toggle":"")+(panel&&active?" panel-open":"")} onClick={onClick} aria-label={label} title={hint?label+" · "+hint:label} aria-keyshortcuts={ariaShortcut(shortcut)} aria-pressed={panel?Boolean(active):undefined} aria-current={!panel&&active?"page":undefined}>
    <Icon size={15}/><span>{label}</span>{hint&&<kbd className="tb-kbd sidebar-utility-kbd" aria-hidden="true">{hint}</kbd>}
  </button>;
}

const ThreadSidebar=memo(function ThreadSidebar({
  section,setSection,threads,activeThreadId,query,setQuery,onOpen,onNew,onThreadAction,onMove,
  selectedIds,setSelectedIds,onBulkAction,provider=DEFAULT_MODEL_PROVIDER,agentRuntime="codex",threadMeta={},onCollapse,
  rightPanelOpen=false,rightPanelTab="files",searchError="",runtimeCapabilities={},onOpenProviderSettings,runtimeStarting=false,connection={tone:"ok",label:""},threadMoves=null,
  onOpenPalette,shortcuts={},listError="",onRetryList,runningIds=null,listLoaded=true
}){
  const searchRef=useRef(null);
  const sectionsRef=useRef(null);
  const [actionError,setActionError]=useState("");
  const [retryingList,setRetryingList]=useState(false);
  const retryList=useCallback(()=>{setRetryingList(true);Promise.resolve().then(()=>onRetryList?.()).catch(()=>{}).finally(()=>setRetryingList(false))},[onRetryList]);
  const runAction=useCallback(action=>{
    setActionError("");
    return Promise.resolve().then(action).catch(error=>setActionError(error?.message||String(error)||"Action failed."));
  },[]);
  // An earlier failure belongs to the harness that was active then; after a switch it describes nothing on screen. (An action that
  // itself switches harness, like opening another harness's thread, still reports its own failure: that lands after this reset.)
  useEffect(()=>{setActionError("")},[agentRuntime]);
  // The secondary grid's narrowest cell is what its longest destination name needs in the font this machine renders (Inter
  // when installed, else the system font), so a sidebar too narrow for two whole names gets one column instead of cutting one
  // ("Environme…"). Names are hidden in the icon-only row, which keeps the last measurement.
  const secondaryNavRef=useRef(null);
  useLayoutEffect(()=>{
    const nav=secondaryNavRef.current;if(!nav)return;
    let frame=0;
    const measure=()=>{
      let widest=0;
      for(const item of nav.children){
        const name=item.querySelector(":scope>span");if(!name?.offsetParent)continue;
        const style=getComputedStyle(item);
        widest=Math.max(widest,name.getBoundingClientRect().left-item.getBoundingClientRect().left+name.scrollWidth+parseFloat(style.paddingRight)+parseFloat(style.borderRightWidth));
      }
      if(widest)nav.style.setProperty("--tb-destination-min",Math.ceil(widest+1)+"px");
    };
    measure();
    const observer=new ResizeObserver(()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(measure)});observer.observe(nav);
    document.fonts?.ready?.then(measure);
    return ()=>{observer.disconnect();cancelAnimationFrame(frame)};
  },[runtimeCapabilities.delegation,runtimeCapabilities.harnessTools]);
  useEffect(()=>{
    const focus=()=>{searchRef.current?.focus();searchRef.current?.select?.()};
    window.addEventListener("trebell:sidebar-search",focus);
    return()=>window.removeEventListener("trebell:sidebar-search",focus);
  },[]);
  const groups=useMemo(()=>sidebarThreadGroups(threads,threadMeta),[threads,threadMeta]);
  // A row React moves (the list reordered while its menu was open) leaves the top layer, as any moved popover does: its menu goes back.
  useLayoutEffect(()=>{for(const menu of sectionsRef.current?.querySelectorAll("details.thread-menu[open]")||[])showRowMenu(menu,true)});
  const bulk=selectedIds.size>0;
  // An action that changes every selected thread ends the selection, and the bulk bar goes with the button that ran it: focus goes
  // back to Thread actions, which opened the bar, instead of falling to the page.
  const bulkToggleRef=useRef(null),wasBulk=useRef(bulk);
  useLayoutEffect(()=>{if(wasBulk.current&&!bulk&&document.activeElement===document.body)bulkToggleRef.current?.focus();wasBulk.current=bulk},[bulk]);
  const managedInference=Boolean(runtimeCapabilities.managedInference);
  const providerLabel=modelProviderLabel(provider);
  // runtimeStarting: Trebell's first load has not yet said which harness runs, so no harness is named.
  const runtimeLabel=runtimeStarting?"Starting…":{native:"Trebell Native",codex:"Codex",claude:"Claude Code",cursor:"Cursor",grok:"Grok Build",opencode:"OpenCode",antigravity:"Antigravity"}[agentRuntime]||agentRuntime;
  const toggle=useCallback(id=>{const next=new Set(selectedIds);next.has(id)?next.delete(id):next.add(id);setSelectedIds(next)},[selectedIds,setSelectedIds]);
  const firstGroupKey=groups.find(group=>group.threads.length)?.key||null;
  const renderRow=useCallback(t=><ThreadRow key={t.id} thread={t} meta={threadMeta[t.id]||null} active={t.id===activeThreadId} bulk={bulk} selected={selectedIds.has(t.id)} running={Boolean(runningIds?.has(t.id))} onOpen={onOpen} onSelect={toggle} onAction={onThreadAction} onMove={onMove} canMoveUp={Boolean(threadMoves?.get(t.id)?.up)} canMoveDown={Boolean(threadMoves?.get(t.id)?.down)} runAction={runAction} agentRuntime={agentRuntime} runtimeCapabilities={runtimeCapabilities}/>,[threadMeta,activeThreadId,bulk,selectedIds,runningIds,onOpen,toggle,onThreadAction,onMove,threadMoves,runAction,agentRuntime,runtimeCapabilities]);
  // A failed load is not an empty list: with nothing listed the sidebar says it could not load them, and over an older list it says
  // the refresh failed. Either way Retry asks again.
  const listFailure=listError&&!query?<div className="sidebar-list-error" role="alert"><strong>{threads.length?"Could not refresh threads":"Could not load threads"}</strong><span>{listError}</span>{onRetryList&&<button type="button" className="tb-btn tb-btn--sm" onClick={retryList} disabled={retryingList}>{retryingList?"Retrying…":"Retry"}</button>}</div>:null;
  // Until the harness has answered a list load, an empty sidebar is waiting for it, not empty: it says what it waits for, as the
  // harness card below does, or that the harness could not connect.
  const connectFailed=!runtimeStarting&&connection.tone==="err",waitingFor=runtimeStarting?"":connectFailed?runtimeLabel+" did not connect.":connection.tone==="warn"?"Waiting for "+runtimeLabel+" to connect.":"";
  const emptyText=query?"No matching threads.":listLoaded?<>No threads yet.<br/>Start a task to create one.</>:<>{connectFailed?"Could not load threads.":"Loading threads…"}{waitingFor&&<><br/>{waitingFor}</>}</>;

  return <aside className="sidebar">
    <div className="sidebar-titlebar">
      <button className="sidebar-brand" onClick={()=>setSection("chat")} aria-label="Threads">
        <img className="brand-mark" src="/trebell-code-icon.svg" alt="" aria-hidden="true"/><strong>Trebell <em>Code</em></strong>
      </button>
      <div className="sidebar-title-actions"><button className="sidebar-new-thread" onClick={onCollapse} aria-label="Collapse sidebar" title={shortcutHint(shortcuts.sidebarToggle)?"Collapse sidebar · "+shortcutHint(shortcuts.sidebarToggle):"Collapse sidebar"}><PanelLeftClose size={15}/></button><button className="sidebar-new-thread" onClick={()=>runAction(onNew)} aria-label="New thread" title="New thread"><Plus size={16}/></button></div>
    </div>

    {onOpenPalette&&<button type="button" className="sidebar-palette-button" onClick={onOpenPalette} aria-label="Search or jump to" aria-keyshortcuts={ariaShortcut(shortcuts.commandPalette)} title="Search threads, projects and commands">
      <Search size={14}/><span>Search or jump to…</span>{shortcutHint(shortcuts.commandPalette)&&<kbd className="tb-kbd" aria-hidden="true">{shortcutHint(shortcuts.commandPalette)}</kbd>}
    </button>}

    <div className="sidebar-thread-tools">
      <h3 className="sidebar-threads-label">Threads<span className="sidebar-threads-count">{threads.length}</span></h3>
      <div className="search-box">
        <Search size={13}/>
        <input ref={searchRef} value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.key==="Escape"&&query){e.preventDefault();setQuery("")}}} placeholder="Search threads" aria-label="Search threads"/>
        {/* Clearing removes this button, so focus goes back to the field instead of falling to the page. */}
        {query&&<button onClick={()=>{setQuery("");searchRef.current?.focus()}} aria-label="Clear search">×</button>}
      </div>
      <button ref={bulkToggleRef} className="sidebar-bulk-toggle" onClick={()=>setSelectedIds(bulk?new Set():new Set(threads.filter(thread=>threadCatalogRuntime(thread,threadMeta[thread.id]||{},agentRuntime)===agentRuntime).slice(0,1).map(t=>t.id)))} title="Thread actions" aria-label="Thread actions">
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
      {listFailure}
      {groups.map(({key,name,threads:items})=>{const virtualized=shouldVirtualizeSidebarGroup(items),chunks=virtualized?sidebarVirtualChunks(items):[],activeChunk=virtualized?sidebarChunkIndexForThread(chunks,activeThreadId):-1;return items.length>0&&<section key={key}>
        <h4><span className="thread-group-name" title={name}>{name}</span><span className="thread-group-count">{items.length}</span></h4>
        {virtualized?chunks.map((chunk,index)=><SidebarVirtualChunk key={chunk.key} chunk={chunk} rootRef={sectionsRef} forceMount={index===activeChunk} initialMount={key===firstGroupKey&&index===0} activeThreadId={activeThreadId} renderRow={renderRow}/>):items.map(renderRow)}
      </section>})}
      {!threads.length&&!listFailure&&<div className="sidebar-empty" role={query||listLoaded?undefined:"status"}>{emptyText}</div>}
    </div>

    <div className="sidebar-footer">
      <nav className="sidebar-utilities" aria-label="Destinations">
        <div className="sidebar-nav-primary">
          <UtilityButton Icon={SquarePen} label="New task" shortcut={shortcuts.newChat} active={(section==="chat"||section==="new")&&!activeThreadId} onClick={()=>runAction(onNew)}/>
          <UtilityButton Icon={Folder} label="Projects" shortcut={shortcuts.projects} active={section==="projects"} onClick={()=>setSection("projects")}/>
          <UtilityButton Icon={Settings} label="Settings" shortcut={shortcuts.settings} active={section==="settings"||section==="licenses"} onClick={()=>setSection("settings")}/>
        </div>
        <div className="sidebar-nav-secondary" ref={secondaryNavRef}>
          <UtilityButton Icon={Globe2} label="Browser" panel shortcut={shortcuts.previewToggle} active={rightPanelOpen&&rightPanelTab==="preview"} onClick={()=>setSection("preview")}/>
          {runtimeCapabilities.delegation&&<UtilityButton Icon={Bot} label="Agents" panel active={rightPanelOpen&&rightPanelTab==="agents"} onClick={()=>setSection("agents")}/>}
          <UtilityButton Icon={History} label="History" active={section==="history"} onClick={()=>setSection("history")}/>
          <UtilityButton Icon={BarChart3} label="Usage" active={section==="usage"} onClick={()=>setSection("usage")}/>
          {runtimeCapabilities.harnessTools&&<UtilityButton Icon={Wrench} label="Tools" active={section==="tools"} onClick={()=>setSection("tools")}/>}
          <UtilityButton Icon={Server} label="Environments" shortcut={shortcuts.environments} active={section==="environments"} onClick={()=>setSection("environments")}/>
        </div>
      </nav>
      <button className="sidebar-provider" onClick={()=>managedInference&&onOpenProviderSettings?onOpenProviderSettings():setSection("settings")} title={runtimeStarting?"Trebell is starting its agent harness":[connection.label,"Configure "+runtimeLabel].filter(Boolean).join(" · ")}><span className={"provider-dot tone-"+(connection.tone||"off")+(runtimeStarting?" starting":"")} data-testid="sidebar-provider-dot" aria-hidden="true"/><div><strong>{runtimeLabel}</strong><span>{managedInference?providerLabel+" inference":"Agent harness"}</span></div><MoreHorizontal size={13}/></button>
    </div>
  </aside>;
});

export default ThreadSidebar;
