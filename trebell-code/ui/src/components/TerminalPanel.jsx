import React,{useEffect,useRef,useState} from "react";
import { Plus, SquareTerminal, X, Paperclip } from "lucide-react";
import { api,wsUrl } from "../api.js";

const stripAnsi=(text)=>String(text||"").replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,"").replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g,"");

export default function TerminalPanel({projectPath,onAttachExcerpt}){
  const [sessions,setSessions]=useState([]);
  const [activeId,setActiveId]=useState(null);
  const [output,setOutput]=useState("");
  const [line,setLine]=useState("");
  const socket=useRef(null);
  const outputRef=useRef(null);

  async function refresh(){
    const data=await api("/api/terminal/sessions").catch(()=>({sessions:[]}));
    setSessions(data.sessions||[]);
    if(!activeId && data.sessions?.[0]) setActiveId(data.sessions[0].id);
  }
  useEffect(()=>{refresh();},[]);

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
    const data=await api("/api/terminal/sessions",{method:"POST",body:{cwd:projectPath||undefined,cols:120,rows:32,name:"Terminal "+(sessions.length+1)}});
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
  return <div className="real-terminal">
    <div className="terminal-tabs">
      {sessions.map(s=><button key={s.id} className={s.id===activeId?"active":""} onClick={()=>setActiveId(s.id)}><SquareTerminal size={13}/>{s.name||"Terminal"}{!s.running&&<em>{s.exitCode}</em>}<span onClick={(e)=>{e.stopPropagation();close(s.id)}}><X size={11}/></span></button>)}
      <button className="terminal-new" onClick={create}><Plus size={14}/> New</button>
    </div>
    {!activeId?<div className="terminal-empty"><SquareTerminal size={30}/><strong>No terminal session</strong><button onClick={create}>Create terminal</button></div>:<>
      <pre ref={outputRef} className="terminal-screen">{output||"Terminal connected.\n"}</pre>
      <form className="terminal-command-line" onSubmit={send}><span>$</span><input value={line} onChange={e=>setLine(e.target.value)} placeholder="Type a command…" autoFocus/><button type="button" onClick={ctrlC}>Ctrl+C</button><button>Send</button></form>
      <div className="terminal-foot"><span>{projectPath||"Home"}</span><button onClick={()=>onAttachExcerpt?.(output.slice(-8000))}><Paperclip size={12}/> Attach recent output</button></div>
    </>}
  </div>;
}
