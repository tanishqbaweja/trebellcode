import React,{useEffect,useRef,useState} from "react";
import { Columns2, Plus, Rows2, SquareTerminal, X, Paperclip } from "lucide-react";
import { api,wsUrl } from "../api.js";

const MAX_SPLIT_PANES=4;
const stripAnsi=(text)=>String(text||"").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,"").replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g,"");

export default function TerminalPanel({projectPath,environmentId=null,environmentName="Local machine",onAttachExcerpt}){
  const [sessions,setSessions]=useState([]);
  const [activeId,setActiveId]=useState(null);
  const [paneIds,setPaneIds]=useState([]);
  const [splitDirection,setSplitDirection]=useState("horizontal");
  const [outputs,setOutputs]=useState({});
  const [lines,setLines]=useState({});
  const [focusTick,setFocusTick]=useState(0);
  const [error,setError]=useState("");
  const sockets=useRef(new Map());
  const outputRefs=useRef(new Map());
  const inputRefs=useRef(new Map());
  const environmentQuery=()=>"?"+new URLSearchParams({environmentId:environmentId||""}).toString();

  async function refresh(preferredId=null){
    let data;
    try{data=await api("/api/terminal/sessions"+environmentQuery());setError("")}
    catch(cause){setError(cause?.message||String(cause)||"Could not load terminal sessions.");return sessions}
    const list=data.sessions||[];setSessions(list);
    const target=preferredId||(activeId&&list.some(session=>session.id===activeId)?activeId:null)||list[0]?.id||null;
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
        if(msg.type==="snapshot")setOutputs(previous=>({...previous,[id]:stripAnsi(msg.session?.buffer||"")}));
        else if(msg.type==="output")setOutputs(previous=>({...previous,[id]:stripAnsi((previous[id]||"")+msg.data)}));
        else if(msg.type==="exit")setSessions(previous=>previous.map(session=>session.id===id?{...session,running:false,exitCode:msg.exitCode}:session));
      };
      ws.onclose=()=>{if(sockets.current.get(id)===ws)sockets.current.delete(id)};
    }
  },[paneIds.join("|")]);

  useEffect(()=>{
    for(const id of paneIds){const node=outputRefs.current.get(id);if(node)node.scrollTo({top:node.scrollHeight})}
  },[outputs,paneIds]);
  useEffect(()=>{if(activeId)setTimeout(()=>inputRefs.current.get(activeId)?.focus(),0)},[activeId,focusTick]);

  async function createSession(){
    const data=await api("/api/terminal/sessions",{method:"POST",body:{cwd:projectPath||undefined,environmentId:environmentId||null,cols:120,rows:32,name:"Terminal "+(sessions.length+1)}});
    setSessions(previous=>[...previous,data.session]);setLines(previous=>({...previous,[data.session.id]:""}));return data.session;
  }
  async function create(){
    try{const session=await createSession();setError("");setPaneIds([session.id]);setActiveId(session.id);setFocusTick(value=>value+1);return session}
    catch(cause){setError(cause?.message||String(cause)||"Could not create terminal.");return null}
  }
  async function split(direction="horizontal"){
    try{
      let current=paneIds;
      if(!current.length){
        const base=activeId||sessions[0]?.id;
        if(base)current=[base];
        else{const first=await createSession();current=[first.id]}
      }
      if(current.length>=MAX_SPLIT_PANES)return;
      const session=await createSession();setError("");setSplitDirection(direction);setPaneIds([...current,session.id]);setActiveId(session.id);setFocusTick(value=>value+1);
    }catch(cause){setError(cause?.message||String(cause)||"Could not split terminal.")}
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
  const paneStyle=paneSessions.length>1?(splitDirection==="vertical"?{gridTemplateRows:"repeat("+paneSessions.length+",minmax(0,1fr))"}:{gridTemplateColumns:"repeat("+paneSessions.length+",minmax(0,1fr))"}):{};
  return <div className="real-terminal">
    <div className="terminal-tabs">
      {sessions.map(session=><button key={session.id} className={session.id===activeId?"active":""} onClick={()=>selectSession(session.id)}><SquareTerminal size={13}/>{session.name||"Terminal"}{!session.running&&<em>{session.exitCode}</em>}<span onClick={(event)=>{event.stopPropagation();close(session.id)}}><X size={11}/></span></button>)}
      <button className="terminal-new" onClick={create}><Plus size={14}/> New</button>
      <button title="Split horizontally" onClick={()=>split("horizontal")} disabled={paneSessions.length>=MAX_SPLIT_PANES}><Columns2 size={13}/></button>
      <button title="Split vertically" onClick={()=>split("vertical")} disabled={paneSessions.length>=MAX_SPLIT_PANES}><Rows2 size={13}/></button>
    </div>
    <div className="terminal-content">
      {error&&<div className="terminal-error" role="alert">{error}</div>}
      {!paneSessions.length?<div className="terminal-empty"><SquareTerminal size={30}/><strong>No terminal session</strong><button onClick={create}>Create terminal</button></div>:<div className={"terminal-panes "+(paneSessions.length>1?"split "+splitDirection:"")} style={paneStyle}>
      {paneSessions.map(session=><section key={session.id} className={"terminal-pane"+(session.id===activeId?" active":"")} onMouseDown={()=>session.id!==activeId&&setActiveId(session.id)}>
        <div className="terminal-pane-head"><span><SquareTerminal size={11}/>{session.name||"Terminal"}</span>{paneSessions.length>1&&<button onClick={()=>close(session.id)} aria-label={"Close "+(session.name||"terminal")}><X size={10}/></button>}</div>
        <pre ref={node=>node?outputRefs.current.set(session.id,node):outputRefs.current.delete(session.id)} className="terminal-screen">{outputs[session.id]||"Terminal connected.\n"}</pre>
        <form className="terminal-command-line" onSubmit={event=>send(session.id,event)}><span>$</span><input ref={node=>node?inputRefs.current.set(session.id,node):inputRefs.current.delete(session.id)} value={lines[session.id]||""} onChange={event=>setLines(previous=>({...previous,[session.id]:event.target.value}))} placeholder={session.running?"Type a command…":"Stopped terminal history"} disabled={!session.running}/><button type="button" onClick={()=>ctrlC(session.id)} disabled={!session.running}>Ctrl+C</button><button disabled={!session.running}>Send</button></form>
        <div className="terminal-foot"><span>{session.restored?"Restored history · ":""}{session.environmentName||environmentName} · {session.cwd||projectPath||"Home"}</span><button onClick={()=>onAttachExcerpt?.((outputs[session.id]||"").slice(-8000))}><Paperclip size={12}/> Attach recent output</button></div>
      </section>)}
      </div>}
    </div>
  </div>;
}
