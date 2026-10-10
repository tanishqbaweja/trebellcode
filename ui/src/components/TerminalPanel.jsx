import React,{useEffect,useRef,useState} from "react";
import { Columns2, Plus, Rows2, SquareTerminal, X, Paperclip } from "lucide-react";
import { api,wsUrl } from "../api.js";

const MAX_SPLIT_PANES=4;
// The screen is plain text, so terminal control sequences are turned into the text they stand for. Windows' ConPTY moves the
// cursor to column 1 of a later row instead of writing a newline before each prompt, which glued lines together
// ("…All rights reserved.H:\repo>"); such a move becomes a line break, a cursor-forward becomes spaces, a lone carriage
// return (progress redraws) starts a new line, and clearing the screen (cls, clear) drops the output before it.
const LINE_MOVE="\uffff";
const stripAnsi=(text)=>{
  let value=String(text||"").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g,"");
  const cleared=Math.max(value.lastIndexOf("\x1b[2J"),value.lastIndexOf("\x1b[3J"));
  if(cleared>=0)value=value.slice(cleared+4);
  value=value.replace(/\x1b\[\d*(?:;1)?H/g,LINE_MOVE).replace(/\x1b\[(\d*)C/g,(match,count)=>" ".repeat(Math.min(Number(count)||1,240))).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,"").replace(/\r(?=[^\n])/g,"\n");
  return value.replace(/\uffff+/g,(match,offset,source)=>offset===0||source[offset-1]==="\n"?"":"\n");
};
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
  const [outputs,setOutputs]=useState({});
  const [lines,setLines]=useState({});
  const [focusTick,setFocusTick]=useState(0);
  const [error,setError]=useState("");
  const [attachBusy,setAttachBusy]=useState("");
  const [creating,setCreating]=useState(false);
  const creatingRef=useRef(false);
  const tabListRef=useRef(null);
  const sockets=useRef(new Map());
  const outputRefs=useRef(new Map());
  const inputRefs=useRef(new Map());
  const environmentQuery=()=>"?"+new URLSearchParams({environmentId:environmentId||""}).toString();

  async function refresh(preferredId=null){
    let data;
    try{data=await api("/api/terminal/sessions"+environmentQuery());setError("")}
    catch(cause){setError(cause?.message||String(cause)||"Could not load terminal sessions.");return sessions}
    const list=data.sessions||[];setSessions(list);
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

  useEffect(()=>{
    for(const socket of sockets.current.values())socket.close();
    sockets.current.clear();setActiveId(null);setPaneIds([]);setOutputs({});setLines({});refresh();
  },[environmentId]);
  useEffect(()=>()=>{for(const socket of sockets.current.values())socket.close();sockets.current.clear()},[]);

  useEffect(()=>{
    const visible=new Set(paneIds);
    for(const [id,socket] of sockets.current.entries())if(!visible.has(id)){socket.close();sockets.current.delete(id)}
    for(const id of paneIds){
      if(sockets.current.has(id))continue;
      const ws=new WebSocket(wsUrl("/api/terminal/ws?session="+encodeURIComponent(id)));sockets.current.set(id,ws);
      ws.onmessage=(event)=>{
        let msg;try{msg=JSON.parse(event.data)}catch{return}
        if(msg.type==="snapshot"){
          setOutputs(previous=>({...previous,[id]:stripAnsi(msg.session?.buffer||"")}));
          // A session that exited while its tab was not shown gets its real state (and exit badge) when it is shown.
          if(typeof msg.session?.running==="boolean")setSessions(previous=>previous.map(session=>session.id===id?{...session,running:msg.session.running,exitCode:msg.session.exitCode??session.exitCode}:session));
        }
        else if(msg.type==="output")setOutputs(previous=>({...previous,[id]:stripAnsi((previous[id]||"")+msg.data)}));
        else if(msg.type==="exit")setSessions(previous=>previous.map(session=>session.id===id?{...session,running:false,exitCode:msg.exitCode}:session));
      };
      ws.onclose=()=>{if(sockets.current.get(id)===ws)sockets.current.delete(id)};
    }
  },[paneIds.join("|")]);

  useEffect(()=>{
    for(const id of paneIds){const node=outputRefs.current.get(id);if(node)node.scrollTo({top:node.scrollHeight})}
  },[outputs,paneIds]);
  // A screen that shows the latest output keeps showing it when the drawer or a split makes it shorter (it used to stay at
  // the top and hide the prompt); one the user scrolled up in stays where it is.
  useEffect(()=>{
    if(typeof ResizeObserver==="undefined")return;
    const observer=new ResizeObserver(entries=>{for(const entry of entries)if(entry.target.dataset.stick!=="false")entry.target.scrollTop=entry.target.scrollHeight});
    for(const id of paneIds){const node=outputRefs.current.get(id);if(node)observer.observe(node)}
    return()=>observer.disconnect();
  },[paneIds.join("|")]);
  useEffect(()=>{if(activeId)setTimeout(()=>inputRefs.current.get(activeId)?.focus(),0)},[activeId,focusTick]);
  // The active session tab stays in view when more tabs are open than the header row can show.
  useEffect(()=>{tabListRef.current?.querySelector("button.active")?.scrollIntoView?.({block:"nearest",inline:"nearest"})},[activeId,sessions.length]);
  useEffect(()=>{
    const list=tabListRef.current;if(!list||typeof ResizeObserver==="undefined")return;
    const observer=new ResizeObserver(()=>list.querySelector("button.active")?.scrollIntoView?.({block:"nearest",inline:"nearest"}));
    observer.observe(list);return()=>observer.disconnect();
  },[]);

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
    sockets.current.get(id)?.close();sockets.current.delete(id);
    const remainingSessions=sessions.filter(session=>session.id!==id);setSessions(remainingSessions);
    let remainingPanes=paneIds.filter(paneId=>paneId!==id);
    if(!remainingPanes.length&&remainingSessions[0])remainingPanes=[remainingSessions[0].id];
    setPaneIds(remainingPanes);setOutputs(previous=>{const next={...previous};delete next[id];return next});setLines(previous=>{const next={...previous};delete next[id];return next});
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
  function send(id,event){
    event?.preventDefault();const line=lines[id]||"";const socket=sockets.current.get(id);
    if(!line)return;
    if(socket?.readyState!==WebSocket.OPEN){setError("Terminal is reconnecting. Try again in a moment.");return}
    setError("");socket.send(JSON.stringify({type:"input",data:line+"\r"}));setLines(previous=>({...previous,[id]:""}));
  }
  function ctrlC(id){const socket=sockets.current.get(id);if(socket?.readyState!==WebSocket.OPEN){setError("Terminal is reconnecting. Try again in a moment.");return}setError("");socket.send(JSON.stringify({type:"input",data:"\x03"}))}
  async function attachRecent(session){
    if(!onAttachExcerpt||attachBusy)return;
    const text=(outputs[session.id]||"").slice(-8000);if(!text.trim())return;
    setAttachBusy(session.id);setError("");
    try{await Promise.resolve(onAttachExcerpt(text))}
    catch(cause){setError(cause?.message||String(cause)||"Could not attach terminal output.")}
    finally{setAttachBusy("")}
  }

  useEffect(()=>{
    const focus=()=>setFocusTick(value=>value+1);
    const refreshExternal=event=>refresh(event.detail||null).then(()=>setFocusTick(value=>value+1));
    const createNew=()=>create();
    const closeActive=()=>{if(activeId)close(activeId)};
    const splitPane=event=>split(event.detail?.direction==="vertical"?"vertical":"horizontal");
    window.addEventListener("trebell:terminal-focus",focus);
    window.addEventListener("trebell:terminal-refresh",refreshExternal);
    window.addEventListener("trebell:terminal-new",createNew);
    window.addEventListener("trebell:terminal-close",closeActive);
    window.addEventListener("trebell:terminal-split",splitPane);
    return()=>{
      window.removeEventListener("trebell:terminal-focus",focus);
      window.removeEventListener("trebell:terminal-refresh",refreshExternal);
      window.removeEventListener("trebell:terminal-new",createNew);
      window.removeEventListener("trebell:terminal-close",closeActive);
      window.removeEventListener("trebell:terminal-split",splitPane);
    };
  },[activeId,paneIds,sessions,projectPath,environmentId]);

  const paneSessions=paneIds.map(id=>sessions.find(session=>session.id===id)).filter(Boolean);
  // Stacked panes keep room for a few lines and the command line each; when four do not fit the drawer the stack scrolls
  // instead of squeezing every pane until its input covers the output.
  const paneStyle=paneSessions.length>1?(splitDirection==="vertical"?{gridTemplateRows:"repeat("+paneSessions.length+",minmax(170px,1fr))"}:{gridTemplateColumns:"repeat("+paneSessions.length+",minmax(0,1fr))"}):{};
  return <div className="real-terminal">
    <div className="terminal-tabs">
      {/* Session tabs scroll on their own so New and the split buttons stay in reach however many terminals are open. */}
      <div className="terminal-tab-list" ref={tabListRef} onWheel={event=>{if(event.deltaY&&!event.deltaX)event.currentTarget.scrollLeft+=event.deltaY}}>{sessions.map(session=><button key={session.id} className={session.id===activeId?"active":""} onClick={()=>selectSession(session.id)} onKeyDown={event=>{if(event.key==="Delete"){event.preventDefault();close(session.id).then(closed=>closed&&setFocusTick(value=>value+1))}}} aria-keyshortcuts="Delete"><SquareTerminal size={13}/><bdi title={session.name||"Terminal"}>{session.name||"Terminal"}</bdi>{!session.running&&<em className={session.exitCode===0?"exit-ok":"exit-failed"}>{session.exitCode}</em>}<span onClick={(event)=>{event.stopPropagation();close(session.id)}}><X size={11}/></span></button>)}</div>
      <button className="terminal-new" onClick={create} data-busy={creating||undefined}><Plus size={14}/> New</button>
      <button title="Split horizontally" onClick={()=>split("horizontal")} disabled={paneSessions.length>=MAX_SPLIT_PANES} data-busy={creating||undefined}><Columns2 size={13}/></button>
      <button title="Split vertically" onClick={()=>split("vertical")} disabled={paneSessions.length>=MAX_SPLIT_PANES} data-busy={creating||undefined}><Rows2 size={13}/></button>
    </div>
    <div className="terminal-content">
      {error&&<div className="terminal-error" role="alert"><span>{error}</span><button type="button" onClick={()=>setError("")} aria-label="Dismiss terminal error" title="Dismiss"><X size={12}/></button></div>}
      {!paneSessions.length?<div className="terminal-empty"><SquareTerminal size={30}/><strong>No terminal session</strong><button onClick={create} data-busy={creating||undefined}>Create terminal</button></div>:<div className={"terminal-panes "+(paneSessions.length>1?"split "+splitDirection:"")} style={paneStyle}>
      {paneSessions.map(session=><section key={session.id} className={"terminal-pane"+(session.id===activeId?" active":"")} onMouseDown={()=>session.id!==activeId&&setActiveId(session.id)}>
        <div className="terminal-pane-head"><span><SquareTerminal size={11}/>{session.name||"Terminal"}</span>{paneSessions.length>1&&<button onClick={()=>close(session.id)} aria-label={"Close "+(session.name||"terminal")}><X size={10}/></button>}</div>
        <pre ref={node=>node?outputRefs.current.set(session.id,node):outputRefs.current.delete(session.id)} className="terminal-screen" onScroll={event=>{const node=event.currentTarget;node.dataset.stick=String(node.scrollTop+node.clientHeight>=node.scrollHeight-8)}}>{outputs[session.id]||"Terminal connected.\n"}</pre>
        <form className="terminal-command-line" onSubmit={event=>send(session.id,event)}><span>$</span><input ref={node=>node?inputRefs.current.set(session.id,node):inputRefs.current.delete(session.id)} value={lines[session.id]||""} onChange={event=>setLines(previous=>({...previous,[session.id]:event.target.value}))} placeholder={session.running?"Type a command…":"Stopped terminal history"} disabled={!session.running}/><button type="button" onClick={()=>ctrlC(session.id)} disabled={!session.running}>Ctrl+C</button><button disabled={!session.running}>Send</button></form>
        <div className="terminal-foot"><span>{session.restored?"Restored history · ":""}{session.environmentName||environmentName} · {session.cwd||projectPath||"Home"}</span><button onClick={()=>attachRecent(session)} disabled={attachBusy===session.id} title="Attach recent output to the composer"><Paperclip size={12}/> {attachBusy===session.id?"Attaching…":"Attach recent output"}</button></div>
      </section>)}
      </div>}
    </div>
  </div>;
}
