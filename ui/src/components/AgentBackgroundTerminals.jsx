import React,{useEffect,useState} from "react";
import { CircleStop, RefreshCw, SquareTerminal } from "lucide-react";
import { backgroundTerminalResourceText, listThreadBackgroundTerminals } from "../background-terminals.js";
import { startVisibilityPoll } from "../visibility-poll.js";

export default function AgentBackgroundTerminals({rpc,rpcStatus,threadId}){
  const [items,setItems]=useState([]);
  const [loading,setLoading]=useState(false);
  const [busy,setBusy]=useState("");
  const [error,setError]=useState("");
  // A failed Stop or Stop all keeps its message until the next action or a manual refresh. The 4-second poll only clears its
  // own listing error; it used to wipe the Stop error within four seconds, often before it could be read.
  const [actionError,setActionError]=useState("");

  async function refresh({quiet=false}={}){
    if(!rpc||rpcStatus!=="connected"||!threadId)return;
    if(!quiet)setLoading(true);
    try{setItems(await listThreadBackgroundTerminals(rpc,threadId));setError("");if(!quiet)setActionError("")}
    catch(err){setError(err.message||String(err))}
    finally{if(!quiet)setLoading(false)}
  }
  useEffect(()=>{
    // While the harness is away its last list stays, said to be so below: those processes may well still be running.
    if(!rpc||rpcStatus!=="connected"||!threadId){setError("");setActionError("");return}
    let disposed=false;
    const load=async()=>{try{const next=await listThreadBackgroundTerminals(rpc,threadId);if(!disposed){setItems(next);setError("")}}catch(err){if(!disposed)setError(err.message||String(err))}};
    const poll=startVisibilityPoll(load,{intervalMs:4000});
    return()=>{disposed=true;poll.dispose()};
  },[rpc,rpcStatus,threadId]);

  async function terminate(processId){
    setBusy(processId);setActionError("");
    try{await rpc.request("thread/backgroundTerminals/terminate",{threadId,processId});await refresh({quiet:true})}
    catch(err){setActionError(err.message||String(err))}
    finally{setBusy("")}
  }
  async function clean(){
    setBusy("all");setActionError("");
    try{await rpc.request("thread/backgroundTerminals/clean",{threadId});await refresh({quiet:true})}
    catch(err){setActionError(err.message||String(err))}
    finally{setBusy("")}
  }

  const away=rpcStatus!=="connected",locked=away||!!busy;
  // Away with nothing listed (Runtime opened while the harness is away) gives no count: 0 would say none run.
  return <section className="agent-background-terminals" data-testid="agent-background-terminals">
    <div className="agent-background-head"><div><SquareTerminal size={13}/><strong>Agent background processes</strong>{!(away&&!items.length)&&<span>{items.length}</span>}</div><div><button onClick={()=>refresh()} disabled={loading||locked} title="Refresh background processes"><RefreshCw size={11}/></button>{items.length>0&&<button onClick={clean} disabled={locked}><CircleStop size={11}/> Stop all</button>}</div></div>
    {away&&<p className="agent-background-empty" role="status">Agent harness is not connected, so this thread's background processes cannot be checked or stopped.{items.length?" The processes it last listed are kept below.":""}</p>}
    {actionError&&<p className="agent-background-error">{actionError}</p>}
    {error&&error!==actionError&&<p className="agent-background-error">{error}</p>}
    {/* A failed Stop keeps the process list on screen under its error, so the other processes stay reachable. */}
    {items.length?<div className="agent-background-list">{items.map(item=><div key={item.processId}><span><strong title={item.command||undefined}>{item.command||"Background command"}</strong><small title={item.cwd||undefined}>{item.cwd||""}</small>{backgroundTerminalResourceText(item)&&<em>{backgroundTerminalResourceText(item)}</em>}</span><button onClick={()=>terminate(item.processId)} disabled={locked}>{busy===item.processId?"Stopping…":"Stop"}</button></div>)}</div>:error||away?null:<p className="agent-background-empty">{loading?"Checking…":"No agent background processes."}</p>}
  </section>;
}
