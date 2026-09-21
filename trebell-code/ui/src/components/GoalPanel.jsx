import React,{useEffect,useState} from "react";
import { CheckCircle2, Pause, Play, RefreshCw, Target, Trash2 } from "lucide-react";

export default function GoalPanel({rpc,rpcStatus,thread,goal,onGoal}){
  const [objective,setObjective]=useState("");
  const [budget,setBudget]=useState("");
  const [busy,setBusy]=useState("");
  const [error,setError]=useState("");
  useEffect(()=>{setObjective(goal?.objective||"");setBudget(goal?.tokenBudget==null?"":String(goal.tokenBudget))},[goal?.threadId,goal?.objective,goal?.tokenBudget]);
  if(!thread?.id)return <div className="empty-state"><Target size={28}/><strong>No active thread</strong><span>Start or open a thread before setting a durable goal.</span></div>;
  if(rpcStatus!=="connected")return <div className="empty-state"><Target size={28}/><strong>Codex harness is reconnecting</strong><span>Thread goals are stored by the bundled Codex app-server.</span></div>;
  async function setGoal(patch){
    if(!rpc)return;setBusy("save");setError("");
    try{const result=await rpc.request("thread/goal/set",{threadId:thread.id,...patch});onGoal?.(result?.goal||null)}
    catch(e){setError(e.message||String(e))}finally{setBusy("")}
  }
  async function save(){
    const text=objective.trim();if(!text){setError("Enter an objective first.");return}
    const raw=budget.trim();const tokenBudget=raw?Number(raw):null;
    if(raw&&(!Number.isInteger(tokenBudget)||tokenBudget<=0)){setError("Token budget must be a positive whole number.");return}
    await setGoal({objective:text,status:goal?.status||"active",tokenBudget});
  }
  async function clear(){
    if(!rpc||!confirm("Clear this thread goal?"))return;setBusy("clear");setError("");
    try{await rpc.request("thread/goal/clear",{threadId:thread.id});onGoal?.(null);setObjective("");setBudget("")}
    catch(e){setError(e.message||String(e))}finally{setBusy("")}
  }
  const status=goal?.status||"not set";
  return <div className="goal-panel">
    <div className="goal-panel-head"><Target size={19}/><div><strong>Thread goal</strong><span>Durable objective stored by Codex, independent of the chat transcript.</span></div><em className={"goal-status status-"+String(status).replace(/[^a-z]/gi,"").toLowerCase()}>{status}</em></div>
    {error&&<div className="inline-error">{error}</div>}
    <label>Objective<textarea value={objective} onChange={e=>setObjective(e.target.value)} maxLength={4000} placeholder="What should this thread keep working toward?"/></label>
    <label>Token budget <span>(optional)</span><input type="number" min="1" step="1" value={budget} onChange={e=>setBudget(e.target.value)} placeholder="No fixed budget"/></label>
    {goal&&<div className="goal-metrics"><div><span>Tokens used</span><strong>{Number(goal.tokensUsed||0).toLocaleString()}</strong></div><div><span>Time used</span><strong>{Math.round(Number(goal.timeUsedSeconds||0)/60)}m</strong></div></div>}
    <div className="goal-actions">
      <button className="primary" onClick={save} disabled={!!busy}><RefreshCw size={12}/> {goal?"Update goal":"Set goal"}</button>
      {goal?.status==="active"&&<button onClick={()=>setGoal({status:"paused"})} disabled={!!busy}><Pause size={12}/> Pause</button>}
      {goal&&goal.status!=="active"&&goal.status!=="complete"&&<button onClick={()=>setGoal({status:"active"})} disabled={!!busy}><Play size={12}/> Resume</button>}
      {goal&&goal.status!=="complete"&&<button onClick={()=>setGoal({status:"complete"})} disabled={!!busy}><CheckCircle2 size={12}/> Complete</button>}
      {goal&&<button className="danger" onClick={clear} disabled={!!busy}><Trash2 size={12}/> Clear</button>}
    </div>
  </div>;
}
