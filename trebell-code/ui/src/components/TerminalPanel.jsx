import React,{useEffect,useRef,useState} from "react";
import { Plus, SquareTerminal, X, Paperclip } from "lucide-react";
import { api,wsUrl } from "../api.js";

const stripAnsi=(text)=>String(text||"").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,"").replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g,"");

export default function TerminalPanel({projectPath,environmentId=null,environmentName="Local machine",onAttachExcerpt}){
  const [sessions,setSessions]=useState([]);
  const [activeId,setActiveId]=useState(null);
  const [output,setOutput]=useState("");
  const [line,setLine]=useState("");
  const socket=useRef(null);
  const outputRef=useRef(null);
  const inputRef=useRef(null);
  const environmentQuery=()=>"?"+new URLSearchParams({environmentId:environmentId||""}).toString();

  async function refresh(preferredId=null){
    const data=await api("/api/terminal/sessions"+environmentQuery()).catch(()=>({sessions:[]}));
    setSessions(data.sessions||[]);
    const target=preferredId||(activeId&&data.sessions?.some(session=>session.id===activeId)?activeId:null)||data.sessions?.[0]?.id||null;
    setActiveId(target);
    return data.sessions||[];
  }
  useEffect(()=>{setActiveId(null);setOutput("");refresh();},[environmentId]);
  useEffect(()=>{
    const onRefresh=event=>refresh(event.detail||null);
    window.addEventListener("trebell:terminal-refresh",onRefresh);
    return()=>window.removeEventListener("trebell:terminal-refresh",onRefresh);
  },[activeId]);
  useEffect(()=>{
    const focus=()=>setTimeout(()=>inputRef.current?.focus(),0);
    const createNew=()=>create().then(()=>focus()).catch(()=>{});
    const closeActive=()=>{if(activeId)close(activeId).catch(()=>{})};
    window.addEventListener("trebell:terminal-focus",focus);
    window.addEventListener("trebell:terminal-new",createNew);
    window.addEventListener("trebell:terminal-close",closeActive);
    return()=>{
      window.removeEventListener("trebell:terminal-focus",focus);
      window.removeEventListener("trebell:terminal-new",createNew);
      window.removeEventListener("trebell:terminal-close",closeActive);
    };
  },[activeId,sessions.length,projectPath,environmentId]);

  useEffect(()=>{
    socket.current?.close();
    if(!activeId) return;
    const ws=new WebSocket(wsUrl("/api/terminal/ws?session="+encodeURIComponent(activeId)));
    socket.current=ws;
    ws.onmessage=(event)=>{
      let msg;try{msg=JSON.parse(event.data)}catch{return}
      if(msg.type==="snapshot") setOutput(stripAnsi(msg.session?.buffer||""));
      else if(msg.type==="output") setOutput(prev=>stripAnsi(prev+msg.data));
      else if(msg.type==="exit") setSessions(prev=>prev.map(s=>s.id===activeId?{...s,running:false,exitCode:msg.exitCode}:s));
    };
    return()=>ws.close();
  },[activeId]);

  useEffect(()=>{outputRef.current?.scrollTo({top:outputRef.current.scrollHeight});},[output]);

  async function create(){
    const data=await api("/api/terminal/sessions",{method:"POST",body:{cwd:projectPath||undefined,environmentId:environmentId||null,cols:120,rows:32,name:"Terminal "+(sessions.length+1)}});
    setSessions(prev=>[...prev,data.session]);setActiveId(data.session.id);
  }
  async function close(id){
    await api("/api/terminal/sessions?id="+encodeURIComponent(id),{method:"DELETE"}).catch(()=>{});
    const next=sessions.filter(s=>s.id!==id);setSessions(next);setActiveId(next[0]?.id||null);if(id===activeId)setOutput("");
  }
  function send(e){
    e?.preventDefault(); if(!line||socket.current?.readyState!==WebSocket.OPEN)return;
    socket.current.send(JSON.stringify({type:"input",data:line+"\r"}));setLine("");
  }
  function ctrlC(){socket.current?.send(JSON.stringify({type:"input",data:"\x03"}));}
  const active=sessions.find(session=>session.id===activeId)||null;
  return <div className="real-terminal">
    <div className="terminal-tabs">
      {sessions.map(s=><button key={s.id} className={s.id===activeId?"active":""} onClick={()=>setActiveId(s.id)}><SquareTerminal size={13}/>{s.name||"Terminal"}{!s.running&&<em>{s.exitCode}</em>}<span onClick={(e)=>{e.stopPropagation();close(s.id)}}><X size={11}/></span></button>)}
      <button className="terminal-new" onClick={create}><Plus size={14}/> New</button>
    </div>
    {!activeId?<div className="terminal-empty"><SquareTerminal size={30}/><strong>No terminal session</strong><button onClick={create}>Create terminal</button></div>:<>
      <pre ref={outputRef} className="terminal-screen">{output||"Terminal connected.\n"}</pre>
      <form className="terminal-command-line" onSubmit={send}><span>$</span><input ref={inputRef} value={line} onChange={e=>setLine(e.target.value)} placeholder={active?.running?"Type a command…":"Stopped terminal history"} disabled={!active?.running} autoFocus/><button type="button" onClick={ctrlC} disabled={!active?.running}>Ctrl+C</button><button disabled={!active?.running}>Send</button></form>
      <div className="terminal-foot"><span>{active?.restored?"Restored history · ":""}{active?.environmentName||environmentName} · {active?.cwd||projectPath||"Home"}</span><button onClick={()=>onAttachExcerpt?.(output.slice(-8000))}><Paperclip size={12}/> Attach recent output</button></div>
    </>}
  </div>;
}
