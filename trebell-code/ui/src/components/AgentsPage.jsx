import React,{useEffect,useState} from "react";
import { Bot, GitBranch, RefreshCw, UsersRound } from "lucide-react";

export default function AgentsPage({threads,onOpen,rpc,rpcStatus,activeThread,model}){
  const children=threads.filter(t=>t.parentThreadId);
  const [modes,setModes]=useState([]);
  const [selected,setSelected]=useState("");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");

  async function refresh(){
    if(!rpc||rpcStatus!=="connected"){setModes([]);return}
    setError("");
    try{const result=await rpc.request("collaborationMode/list",{});setModes(result?.data||[])}
    catch(e){setModes([]);setError(e.message||String(e))}
  }
  useEffect(()=>{refresh()},[rpc,rpcStatus,activeThread?.id]);

  async function applyMode(mask){
    if(!rpc||!activeThread?.id)return;
    setBusy(true);setError("");
    try{
      const nextModel=mask.model||model;
      await rpc.request("thread/settings/update",{
        threadId:activeThread.id,
        collaborationMode:{
          mode:mask.mode||"default",
          settings:{model:nextModel,reasoning_effort:mask.reasoning_effort??null,developer_instructions:null},
        },
      });
      setSelected(mask.name);
    }catch(e){setError(e.message||String(e))}
    finally{setBusy(false)}
  }

  return <div className="agents-page">
    <div className="agent-summary"><Bot size={24}/><div><strong>Delegated agents</strong><span>Subagents created by Codex appear here with their own durable threads.</span></div></div>
    <section className="collaboration-card">
      <div className="collaboration-head"><div><UsersRound size={15}/><span><strong>Collaboration mode</strong><small>Choose how Codex coordinates work for this thread.</small></span></div><button onClick={refresh} disabled={busy||rpcStatus!=="connected"}><RefreshCw size={12}/></button></div>
      {!activeThread?.id?<p>Start or open a thread to select a collaboration mode.</p>:modes.length?<div className="collaboration-modes">{modes.map(mask=><button key={mask.name} className={selected===mask.name?"active":""} onClick={()=>applyMode(mask)} disabled={busy}><strong>{mask.name}</strong><span>{mask.mode||"default"}{mask.model?" · "+mask.model:""}{mask.reasoning_effort?" · "+mask.reasoning_effort:""}</span></button>)}</div>:<p>{error||"No collaboration presets were reported by this Codex runtime."}</p>}
    </section>
    {children.length===0?<div className="empty-state">No subagent threads yet.</div>:<div className="agent-list">{children.map(t=><button key={t.id} onClick={()=>onOpen(t)}><Bot size={17}/><div><strong>{t.name||t.agentNickname||t.preview||"Subagent"}</strong><span>{t.agentRole||"agent"} · parent {t.parentThreadId?.slice(0,8)}</span></div><GitBranch size={13}/></button>)}</div>}
  </div>;
}
