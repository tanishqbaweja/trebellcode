import React,{useEffect,useState} from "react";
import { CircleStop, RefreshCw, SquareTerminal } from "lucide-react";
import { backgroundTerminalResourceText, listThreadBackgroundTerminals } from "../background-terminals.js";

export default function AgentBackgroundTerminals({rpc,rpcStatus,threadId}){
  const [items,setItems]=useState([]);
  const [loading,setLoading]=useState(false);
  const [busy,setBusy]=useState("");
  const [error,setError]=useState("");

  async function refresh({quiet=false}={}){
    if(!rpc||rpcStatus!=="connected"||!threadId)return;
    if(!quiet)setLoading(true);
    try{setItems(await listThreadBackgroundTerminals(rpc,threadId));setError("")}
    catch(err){setError(err.message||String(err))}
    finally{if(!quiet)setLoading(false)}
  }
  useEffect(()=>{
    if(!rpc||rpcStatus!=="connected"||!threadId){setItems([]);setError("");return}
    let disposed=false;
    const load=async()=>{try{const next=await listThreadBackgroundTerminals(rpc,threadId);if(!disposed){setItems(next);setError("")}}catch(err){if(!disposed)setError(err.message||String(err))}};
    load();const timer=setInterval(load,4000);
    return()=>{disposed=true;clearInterval(timer)};
  },[rpc,rpcStatus,threadId]);

  async function terminate(processId){
    setBusy(processId);setError("");
    try{await rpc.request("thread/backgroundTerminals/terminate",{threadId,processId});await refresh({quiet:true})}
    catch(err){setError(err.message||String(err))}
    finally{setBusy("")}
  }
  async function clean(){
    setBusy("all");setError("");
    try{await rpc.request("thread/backgroundTerminals/clean",{threadId});await refresh({quiet:true})}
    catch(err){setError(err.message||String(err))}
    finally{setBusy("")}
  }

  return <section className="agent-background-terminals" data-testid="agent-background-terminals">
    <div className="agent-background-head"><div><SquareTerminal size={13}/><strong>Agent background processes</strong><span>{items.length}</span></div><div><button onClick={()=>refresh()} disabled={loading||!!busy} title="Refresh background processes"><RefreshCw size={11}/></button>{items.length>0&&<button onClick={clean} disabled={!!busy}><CircleStop size={11}/> Stop all</button>}</div></div>
    {error?<p className="agent-background-error">{error}</p>:items.length?<div className="agent-background-list">{items.map(item=><div key={item.processId}><span><strong>{item.command||"Background command"}</strong><small>{item.cwd||""}</small>{backgroundTerminalResourceText(item)&&<em>{backgroundTerminalResourceText(item)}</em>}</span><button onClick={()=>terminate(item.processId)} disabled={!!busy}>{busy===item.processId?"Stopping…":"Stop"}</button></div>)}</div>:<p className="agent-background-empty">{loading?"Checking…":"No agent background processes."}</p>}
  </section>;
}
