import React,{useEffect,useLayoutEffect,useRef,useState} from "react";
import { Columns2, Plus, Rows2, SquareTerminal, X, Paperclip } from "lucide-react";
import { api,wsUrl } from "../api.js";
import { createTerminalScreen,TERMINAL_SCROLLBACK_CHARS,TERMINAL_SCROLLBACK_LINES } from "../terminal-screen.js";
import { terminalKeyboardAsked } from "../terminal-keyboard.js";

const MAX_SPLIT_PANES=4;
const RECONNECTING="Terminal is reconnecting. Try again in a moment.";
const nextTerminalName=(taken)=>{
  const used=new Set(taken.map(session=>session?.name));
  let number=1;while(used.has("Terminal "+number))number+=1;
  return "Terminal "+number;
};

export default function TerminalPanel({projectPath,environmentId=null,environmentName="Local machine",onAttachExcerpt}){
  const [sessions,setSessions]=useState([]);
  const [activeId,setActiveId]=useState(null);
  const [paneIds,setPaneIds]=useState([]);
  const [splitDirection,setSplitDirection]=useState("horizontal");
  const [lines,setLines]=useState({});
  // Each session's screen (terminal-screen.js) takes its output as it arrives; the panes redraw at most once a frame.
  const screens=useRef(new Map());const screenFrame=useRef(0);const [,setScreenTick]=useState(0);
  const screenOf=id=>{let screen=screens.current.get(id);if(!screen)screens.current.set(id,screen=createTerminalScreen());return screen};
  const drawScreens=()=>{if(!screenFrame.current)screenFrame.current=requestAnimationFrame(()=>{screenFrame.current=0;setScreenTick(tick=>tick+1)})};
  const [focusTick,setFocusTick]=useState(0);
  const [error,setError]=useState("");
  // Until the environment's sessions are first listed the drawer says it is loading, rather than "No terminal session" with Create
  // terminal: with sessions to come that button would go as they show (dropping the keyboard Focus terminal put there, or starting
  // one more terminal for an Enter pressed meanwhile), and Focus terminal waits for what the list shows (focusTerminalDrawer in App).
  const [listed,setListed]=useState(false);
  const [attachBusy,setAttachBusy]=useState("");
  const [creating,setCreating]=useState(false);
  const creatingRef=useRef(false);
  const tabListRef=useRef(null);
  const sockets=useRef(new Map());
  // The sessions whose socket dropped by itself, each with the timer that opens it again.
  const reconnects=useRef(new Map());
  const outputRefs=useRef(new Map());
  const inputRefs=useRef(new Map());
  const environmentQuery=()=>"?"+new URLSearchParams({environmentId:environmentId||""}).toString();

  async function refresh(preferredId=null){
    let data;
    try{data=await api("/api/terminal/sessions"+environmentQuery());setError("")}
    catch(cause){setError(cause?.message||String(cause)||"Could not load terminal sessions.");setListed(true);return sessions}
    // Listed in the same render as the sessions it shows.
    const list=data?.sessions||[];setSessions(list);setListed(true);
    // With nothing selected yet the newest live terminal is shown instead of the oldest entry (often stopped history): the
    // worktree-setup and project-action terminals open this drawer, and their refresh event can fire before it has mounted.
    const newestLive=list.filter(session=>session.running).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0))[0];
    const target=preferredId||(activeId&&list.some(session=>session.id===activeId)?activeId:null)||newestLive?.id||list[0]?.id||null;
    setActiveId(target);
    setPaneIds(current=>{
      const valid=current.filter(id=>list.some(session=>session.id===id));
      return valid.length?valid:(target?[target]:[]);
    });
    return list;
  }

  // A socket closed here is taken from its session first, so its close opens nothing again, and a reconnect still waiting is dropped.
  const closeSocket=id=>{clearTimeout(reconnects.current.get(id));reconnects.current.delete(id);const socket=sockets.current.get(id);sockets.current.delete(id);socket?.close()};
  const closeSockets=(kept=[])=>{for(const id of new Set([...sockets.current.keys(),...reconnects.current.keys()]))if(!kept.includes(id))closeSocket(id)};
  useEffect(()=>{
    closeSockets();setActiveId(null);setPaneIds([]);screens.current.clear();setLines({});setListed(false);refresh();
  },[environmentId]);
  useEffect(()=>()=>{closeSockets();cancelAnimationFrame(screenFrame.current)},[]);

  // A socket that drops by itself (the server restarted, the machine slept) opens again while its pane is shown, half a second later
  // and then twice as long after each try that fails, up to 5 s, as the agent's transport does: it stayed closed, and every command
  // was refused until the drawer was opened again.
  useEffect(()=>{
    closeSockets(paneIds);
    const connect=(id,attempt=0)=>{
      const ws=new WebSocket(wsUrl("/api/terminal/ws?session="+encodeURIComponent(id)));sockets.current.set(id,ws);
      ws.onmessage=(event)=>{
        let msg;try{msg=JSON.parse(event.data)}catch{return}
        if(msg.type==="snapshot"){
          // The snapshot a socket opens with brings the screen up to date, and the notice that refused input while it was away goes.
          attempt=0;setError(current=>current===RECONNECTING?"":current);
          screenOf(id).reset(msg.session?.buffer||"");drawScreens();
          // A session that exited while its tab was not shown gets its real state (and exit badge) when it is shown.
          if(typeof msg.session?.running==="boolean")setSessions(previous=>previous.map(session=>session.id===id?{...session,running:msg.session.running,exitCode:msg.session.exitCode??session.exitCode}:session));
        }
        else if(msg.type==="output"){screenOf(id).write(msg.data);drawScreens()}
        else if(msg.type==="exit")setSessions(previous=>previous.map(session=>session.id===id?{...session,running:false,exitCode:msg.exitCode}:session));
      };
      ws.onclose=()=>{
        if(sockets.current.get(id)!==ws)return;sockets.current.delete(id);
        reconnects.current.set(id,setTimeout(()=>{reconnects.current.delete(id);connect(id,attempt+1)},Math.min(5000,500*2**attempt)));
      };
    };
    for(const id of paneIds)if(!sockets.current.has(id)&&!reconnects.current.has(id))connect(id);
  },[paneIds.join("|")]);

  // New output is followed only on a screen that shows the latest output: one the person scrolled up in stays where it is until
  // they scroll back down or send it something, so earlier output can be read while a program keeps printing. Every redraw
  // shows the output that has arrived (typing redraws too), so each one moves a following screen to its end before a scroll
  // event can find it short of the end and take it for the person scrolling up.
  useLayoutEffect(()=>{
    for(const id of paneIds){const node=outputRefs.current.get(id);if(node&&node.dataset.stick!=="false")node.scrollTo({top:node.scrollHeight})}
  });
  // A screen that shows the latest output keeps showing it when the drawer or a split makes it shorter (it used to stay at
  // the top and hide the prompt), or the window or the right panel re-wraps its lines; one the user scrolled up in stays where
  // it is. Such a screen has no scroll anchor (inspector.css), whose move as its lines re-wrapped it took for the person scrolling.
  useEffect(()=>{
    if(typeof ResizeObserver==="undefined")return;
    const observer=new ResizeObserver(entries=>{for(const entry of entries)if(entry.target.dataset.stick!=="false")entry.target.scrollTop=entry.target.scrollHeight});
    for(const id of paneIds){const node=outputRefs.current.get(id);if(node)observer.observe(node)}
    return()=>observer.disconnect();
  },[paneIds.join("|")]);
  // The active terminal's command line takes the keyboard, unless something outside the drawer was pressed since it was asked for
  // (terminal-keyboard.js): the terminals listed late keep a menu opened meanwhile open.
  useEffect(()=>{if(activeId)setTimeout(()=>{if(terminalKeyboardAsked())inputRefs.current.get(activeId)?.focus()},0)},[activeId,focusTick]);
  // The active session tab stays in view when more tabs are open than the header row can show.
  useEffect(()=>{tabListRef.current?.querySelector("button.active")?.scrollIntoView?.({block:"nearest",inline:"nearest"})},[activeId,sessions.length]);
  // The tab list shows once the sessions are listed.
  useEffect(()=>{
    const list=tabListRef.current;if(!list||typeof ResizeObserver==="undefined")return;
    const observer=new ResizeObserver(()=>list.querySelector("button.active")?.scrollIntoView?.({block:"nearest",inline:"nearest"}));
    observer.observe(list);return()=>observer.disconnect();
  },[listed]);

  // Names take the lowest free number ("Terminal 2" again after it was closed) instead of the session count, which repeated
  // names once a middle terminal was closed; `created` covers sessions made earlier in the same action.
  async function createSession(created=[]){
    const data=await api("/api/terminal/sessions",{method:"POST",body:{cwd:projectPath||undefined,environmentId:environmentId||null,cols:120,rows:32,name:nextTerminalName([...sessions,...created])}});
    setSessions(previous=>[...previous,data.session]);setLines(previous=>({...previous,[data.session.id]:""}));return data.session;
  }
  // One create or split at a time: a double click on New or Split used to start two terminals.
  async function exclusive(work){
    if(creatingRef.current)return null;
    creatingRef.current=true;setCreating(true);
    try{return await work()}
    finally{creatingRef.current=false;setCreating(false)}
  }
  function create(){
    return exclusive(async()=>{
      try{const session=await createSession();setError("");setPaneIds([session.id]);setActiveId(session.id);setFocusTick(value=>value+1);return session}
      catch(cause){setError(cause?.message||String(cause)||"Could not create terminal.");return null}
    });
  }
  function split(direction="horizontal"){
    return exclusive(async()=>{
      try{
        let current=paneIds;const created=[];
        if(!current.length){
          const base=activeId||sessions[0]?.id;
          if(base)current=[base];
          else{const first=await createSession();created.push(first);current=[first.id]}
        }
        if(current.length>=MAX_SPLIT_PANES)return;
        const session=await createSession(created);setError("");setSplitDirection(direction);setPaneIds([...current,session.id]);setActiveId(session.id);setFocusTick(value=>value+1);
      }catch(cause){setError(cause?.message||String(cause)||"Could not split terminal.")}
    });
  }
  async function close(id){
    try{await api("/api/terminal/sessions?id="+encodeURIComponent(id),{method:"DELETE"});setError("")}
    catch(cause){setError(cause?.message||String(cause)||"Could not close terminal.");return false}
    closeSocket(id);
    const remainingSessions=sessions.filter(session=>session.id!==id);setSessions(remainingSessions);
    let remainingPanes=paneIds.filter(paneId=>paneId!==id);
    if(!remainingPanes.length&&remainingSessions[0])remainingPanes=[remainingSessions[0].id];
    setPaneIds(remainingPanes);screens.current.delete(id);setLines(previous=>{const next={...previous};delete next[id];return next});
    if(id===activeId)setActiveId(remainingPanes[0]||remainingSessions[0]?.id||null);
    return true;
  }
  function selectSession(id){
    setActiveId(id);setFocusTick(value=>value+1);
    setPaneIds(current=>{
      if(current.includes(id))return current;
      if(!current.length)return[id];
      const replace=current.includes(activeId)?current.indexOf(activeId):current.length-1;
      return current.map((paneId,index)=>index===replace?id:paneId);
    });
  }
  function write(id,data){
    const socket=sockets.current.get(id);
    if(socket?.readyState!==WebSocket.OPEN){setError(RECONNECTING);return false}
    setError("");socket.send(JSON.stringify({type:"input",data}));
    // What the person sends takes its screen back to the latest output, as typing in a terminal does, so the answer shows.
    const node=outputRefs.current.get(id);if(node){node.dataset.stick="true";node.scrollTo({top:node.scrollHeight})}
    return true;
  }
  // An empty line is sent too: its Enter is what ends a Python block or takes the default a prompt offers.
  function send(id,event){event?.preventDefault();if(write(id,(lines[id]||"")+"\r"))setLines(previous=>({...previous,[id]:""}))}
  function ctrlC(id){write(id,"\x03")}
  // A paste of several lines reaches the program as a terminal sends it, each finished line with its Enter, and the text after
  // the last line break stays on the command line; the single-line input used to join the lines into one command. The first
  // pasted line goes in at the caret, and its Enter sends the whole command typed around it, as a terminal's Enter does.
  function paste(id,event){
    const text=event.clipboardData?.getData("text")||"";if(!/[\r\n]/.test(text))return;
    event.preventDefault();const input=event.currentTarget;
    const pasted=text.split(/\r\n|\r|\n/),rest=pasted.pop();
    pasted[0]=input.value.slice(0,input.selectionStart)+pasted[0]+input.value.slice(input.selectionEnd);
    if(write(id,pasted.map(line=>line+"\r").join("")))setLines(previous=>({...previous,[id]:rest}));
  }
  async function attachRecent(session){
    if(!onAttachExcerpt||attachBusy)return;
    const text=(screens.current.get(session.id)?.text()||"").slice(-8000);if(!text.trim())return;
    setAttachBusy(session.id);setError("");
    try{await Promise.resolve(onAttachExcerpt(text))}
    catch(cause){setError(cause?.message||String(cause)||"Could not attach terminal output.")}
    finally{setAttachBusy("")}
  }

  useEffect(()=>{
    const refreshExternal=event=>refresh(event.detail||null).then(()=>setFocusTick(value=>value+1));
    const createNew=()=>create();
    const closeActive=()=>{if(activeId)close(activeId)};
    const splitPane=event=>split(event.detail?.direction==="vertical"?"vertical":"horizontal");
    window.addEventListener("trebell:terminal-refresh",refreshExternal);
    window.addEventListener("trebell:terminal-new",createNew);
    window.addEventListener("trebell:terminal-close",closeActive);
    window.addEventListener("trebell:terminal-split",splitPane);
    return()=>{
      window.removeEventListener("trebell:terminal-refresh",refreshExternal);
      window.removeEventListener("trebell:terminal-new",createNew);
      window.removeEventListener("trebell:terminal-close",closeActive);
      window.removeEventListener("trebell:terminal-split",splitPane);
    };
  },[activeId,paneIds,sessions,projectPath,environmentId]);

  // Each chunk of a screen is its own text node, so new output redraws only the last one. A screen that has dropped earlier
  // output says so where it was.
  const screenContent=id=>{
    const screen=screens.current.get(id);if(!screen?.chunks.length)return "Terminal connected.\n";
    return <>{screen.dropped>0&&<span className="terminal-dropped">Earlier output was dropped: the screen keeps the last {TERMINAL_SCROLLBACK_LINES.toLocaleString()} lines, up to {TERMINAL_SCROLLBACK_CHARS.toLocaleString()} characters.</span>}{screen.chunks.map(chunk=><span key={chunk.id}>{chunk.text}</span>)}</>;
  };
  const paneSessions=paneIds.map(id=>sessions.find(session=>session.id===id)).filter(Boolean);
  // Stacked panes keep room for a few lines and the command line each, and side-by-side panes room for a usable command field;
  // when four do not fit the drawer the panes scroll instead of squeezing every pane until its input covers the output or its
  // command field shows three characters.
  const paneStyle=paneSessions.length>1?(splitDirection==="vertical"?{gridTemplateRows:"repeat("+paneSessions.length+",minmax(170px,1fr))"}:{gridTemplateColumns:"repeat("+paneSessions.length+",minmax(250px,1fr))"}):{};
  // As the drawer reads while this panel's code loads (App's DeferredSurface).
  if(!listed)return <div className="surface-loading compact" role="status">Loading terminal…</div>;
  return <div className="real-terminal">
    <div className="terminal-tabs">
      {/* Session tabs scroll on their own so New and the split buttons stay in reach however many terminals are open. */}
      {/* A tab's close button stands beside the button that selects it (a button cannot hold another), so the keyboard reaches it and
          it has a name. Closing from either hands focus to the terminal that is then active, as the gone button cannot keep it. */}
      <div className="terminal-tab-list" ref={tabListRef} onWheel={event=>{if(event.deltaY&&!event.deltaX)event.currentTarget.scrollLeft+=event.deltaY}}>{sessions.map(session=>{
        const name=session.name||"Terminal",closeTab=()=>close(session.id).then(closed=>closed&&setFocusTick(value=>value+1));
        return <div key={session.id} className={"terminal-tab"+(session.id===activeId?" active":"")}>
          <button className="terminal-tab-select" onClick={()=>selectSession(session.id)} onKeyDown={event=>{if(event.key==="Delete"){event.preventDefault();closeTab()}}} aria-keyshortcuts="Delete" aria-current={session.id===activeId||undefined}><SquareTerminal size={13}/><bdi title={name}>{name}</bdi>{!session.running&&<em className={session.exitCode===0?"exit-ok":"exit-failed"}>{session.exitCode}</em>}</button>
          <button type="button" className="terminal-tab-close" onClick={closeTab} aria-label={"Close "+name} title={"Close "+name}><X size={11}/></button>
        </div>;
      })}</div>
      <button className="terminal-new" onClick={create} data-busy={creating||undefined}><Plus size={14}/> New</button>
      <button title="Split horizontally" onClick={()=>split("horizontal")} disabled={paneSessions.length>=MAX_SPLIT_PANES} data-busy={creating||undefined}><Columns2 size={13}/></button>
      <button title="Split vertically" onClick={()=>split("vertical")} disabled={paneSessions.length>=MAX_SPLIT_PANES} data-busy={creating||undefined}><Rows2 size={13}/></button>
    </div>
    <div className="terminal-content">
      {error&&<div className="terminal-error" role="alert"><span>{error}</span><button type="button" onClick={()=>setError("")} aria-label="Dismiss terminal error" title="Dismiss"><X size={12}/></button></div>}
      {!paneSessions.length?<div className="terminal-empty"><SquareTerminal size={30}/><strong>No terminal session</strong><button onClick={create} data-busy={creating||undefined}>Create terminal</button></div>:<div className={"terminal-panes "+(paneSessions.length>1?"split "+splitDirection:"")} style={paneStyle}>
      {paneSessions.map(session=><section key={session.id} className={"terminal-pane"+(session.id===activeId?" active":"")} onMouseDown={()=>session.id!==activeId&&setActiveId(session.id)}>
        <div className="terminal-pane-head"><span><SquareTerminal size={11}/>{session.name||"Terminal"}</span>{paneSessions.length>1&&<button onClick={()=>close(session.id)} aria-label={"Close "+(session.name||"terminal")}><X size={10}/></button>}</div>
        <pre ref={node=>node?outputRefs.current.set(session.id,node):outputRefs.current.delete(session.id)} className="terminal-screen" onScroll={event=>{const node=event.currentTarget;node.dataset.stick=String(node.scrollTop+node.clientHeight>=node.scrollHeight-8)}}>{screenContent(session.id)}</pre>
        <form className="terminal-command-line" onSubmit={event=>send(session.id,event)}><span>$</span><input ref={node=>node?inputRefs.current.set(session.id,node):inputRefs.current.delete(session.id)} value={lines[session.id]||""} onChange={event=>setLines(previous=>({...previous,[session.id]:event.target.value}))} onPaste={event=>paste(session.id,event)} placeholder={session.running?"Type a command…":"Stopped terminal history"} disabled={!session.running}/><button type="button" onClick={()=>ctrlC(session.id)} disabled={!session.running}>Ctrl+C</button><button disabled={!session.running}>Send</button></form>
        <div className="terminal-foot"><span>{session.restored?"Restored history · ":""}{session.environmentName||environmentName} · {session.cwd||projectPath||"Home"}</span><button onClick={()=>attachRecent(session)} disabled={attachBusy===session.id} title="Attach recent output to the composer"><Paperclip size={12}/> {attachBusy===session.id?"Attaching…":"Attach recent output"}</button></div>
      </section>)}
      </div>}
    </div>
  </div>;
}
