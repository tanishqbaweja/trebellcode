import React,{useEffect,useState} from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, Pause, Play, RefreshCw, Target, Trash2 } from "lucide-react";

function lines(value){return (Array.isArray(value)?value:[]).join("\n")}
function parseLines(value){return String(value||"").split(/\r?\n/).map(item=>item.trim()).filter(Boolean)}
function wholeNumber(value,label){
  const raw=String(value||"").trim();if(!raw)return null;
  const number=Number(raw);if(!Number.isInteger(number)||number<=0)throw new Error(label+" must be a positive whole number.");
  return number;
}
function positiveNumber(value,label){
  const raw=String(value||"").trim();if(!raw)return null;
  const number=Number(raw);if(!Number.isFinite(number)||number<=0)throw new Error(label+" must be a positive number.");
  return number;
}
function durationLabel(seconds){
  const value=Math.max(0,Number(seconds)||0);
  if(value<60)return Math.round(value)+"s";
  if(value<3600)return Math.round(value/60)+"m";
  const hours=Math.floor(value/3600),minutes=Math.round((value%3600)/60);
  return minutes?hours+"h "+minutes+"m":hours+"h";
}
function remainingTimeLabel(minutes){
  const value=Math.max(0,Number(minutes)||0);return durationLabel(value*60)+" remaining";
}
function moneyLabel(value){
  return "$"+Math.max(0,Number(value)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:4});
}

export default function GoalPanel({rpc,rpcStatus,thread,goal,onGoal}){
  const [objective,setObjective]=useState("");
  const [tokenBudget,setTokenBudget]=useState("");
  const [timeBudget,setTimeBudget]=useState("");
  const [turnBudget,setTurnBudget]=useState("");
  const [costBudgetUsd,setCostBudgetUsd]=useState("");
  const [completionConditions,setCompletionConditions]=useState("");
  const [constraints,setConstraints]=useState("");
  const [validationExpectations,setValidationExpectations]=useState("");
  const [detailsOpen,setDetailsOpen]=useState(false);
  const [busy,setBusy]=useState("");
  const [error,setError]=useState("");
  useEffect(()=>{
    setObjective(goal?.objective||"");
    setTokenBudget(goal?.tokenBudget==null?"":String(goal.tokenBudget));
    setTimeBudget(goal?.timeBudgetMinutes==null?"":String(goal.timeBudgetMinutes));
    setTurnBudget(goal?.turnBudget==null?"":String(goal.turnBudget));
    setCostBudgetUsd(goal?.costBudgetUsd==null?"":String(goal.costBudgetUsd));
    setCompletionConditions(lines(goal?.completionConditions));
    setConstraints(lines(goal?.constraints));
    setValidationExpectations(lines(goal?.validationExpectations));
  },[goal?.threadId,goal?.objective,goal?.tokenBudget,goal?.timeBudgetMinutes,goal?.turnBudget,goal?.costBudgetUsd,goal?.completionConditions,goal?.constraints,goal?.validationExpectations]);
  useEffect(()=>setDetailsOpen(false),[thread?.id]);
  if(!thread?.id)return <div className="empty-state"><Target size={28}/><strong>No active thread</strong><span>Start or open a thread before setting a durable goal.</span></div>;
  if(rpcStatus!=="connected")return <div className="empty-state"><Target size={28}/><strong>Agent harness is reconnecting</strong><span>This thread's durable goal will be available again when the active harness reconnects.</span></div>;
  async function setGoal(patch){
    if(!rpc)return;setBusy("save");setError("");
    try{const result=await rpc.request("thread/goal/set",{threadId:thread.id,...patch});onGoal?.(result?.goal||null)}
    catch(e){setError(e.message||String(e))}finally{setBusy("")}
  }
  async function save(){
    const text=objective.trim();if(!text){setError("Enter an objective first.");return}
    let nextTokenBudget,nextTimeBudget,nextTurnBudget,nextCostBudgetUsd;
    try{
      nextTokenBudget=wholeNumber(tokenBudget,"Token budget");nextTimeBudget=wholeNumber(timeBudget,"Time budget");
      nextTurnBudget=wholeNumber(turnBudget,"Turn budget");nextCostBudgetUsd=positiveNumber(costBudgetUsd,"Cost budget");
    }
    catch(e){setError(e.message||String(e));return}
    await setGoal({
      objective:text,status:goal?.status||"active",tokenBudget:nextTokenBudget,timeBudgetMinutes:nextTimeBudget,turnBudget:nextTurnBudget,costBudgetUsd:nextCostBudgetUsd,
      completionConditions:parseLines(completionConditions),constraints:parseLines(constraints),validationExpectations:parseLines(validationExpectations),
    });
  }
  async function clear(){
    if(!rpc||!confirm("Clear this thread goal?"))return;setBusy("clear");setError("");
    try{
      await rpc.request("thread/goal/clear",{threadId:thread.id});onGoal?.(null);
      setObjective("");setTokenBudget("");setTimeBudget("");setTurnBudget("");setCostBudgetUsd("");setCompletionConditions("");setConstraints("");setValidationExpectations("");setDetailsOpen(false);
    }
    catch(e){setError(e.message||String(e))}finally{setBusy("")}
  }
  const status=goal?.status||"not set";
  const blocked=goal?.status==="active"&&goal?.budgetExhausted;
  const tokensUsed=Math.max(0,Number(goal?.tokensUsed)||0),timeUsedSeconds=Math.max(0,Number(goal?.timeUsedSeconds)||0);
  const guidanceCount=(goal?.completionConditions?.length||0)+(goal?.constraints?.length||0)+(goal?.validationExpectations?.length||0);
  return <div className="goal-panel" data-testid="goal-panel">
    <div className="goal-panel-head"><Target size={19}/><div><strong>Thread goal</strong><span>Durable objective stored with this thread, independent of the chat transcript.</span></div><em className={"goal-status status-"+String(status).replace(/[^a-z]/gi,"").toLowerCase()}>{status}</em></div>
    {error&&<div className="inline-error">{error}</div>}
    {blocked&&<div className="goal-budget-alert" role="alert" data-testid="goal-budget-alert"><AlertTriangle size={16}/><div><strong>Goal budget exhausted</strong><span>New turns are blocked. Increase the exhausted budget, or pause, complete, or clear this goal.</span></div></div>}
    <label>Objective<textarea aria-label="Objective" value={objective} onChange={e=>setObjective(e.target.value)} maxLength={4000} placeholder="What should this thread keep working toward?"/></label>
    <div className="goal-budget-grid">
      <label>Token budget <span>(optional)</span><input aria-label="Token budget" type="number" min="1" step="1" value={tokenBudget} onChange={e=>setTokenBudget(e.target.value)} placeholder="No token cap"/></label>
      <label>Time budget <span>(minutes, optional)</span><input aria-label="Time budget" type="number" min="1" step="1" value={timeBudget} onChange={e=>setTimeBudget(e.target.value)} placeholder="No time cap"/></label>
      <label>Turn budget <span>(optional)</span><input aria-label="Turn budget" type="number" min="1" max="500" step="1" value={turnBudget} onChange={e=>setTurnBudget(e.target.value)} placeholder="No turn cap"/></label>
      <label>Cost budget <span>(USD, optional)</span><input aria-label="Cost budget" type="number" min="0.0001" step="0.01" value={costBudgetUsd} onChange={e=>setCostBudgetUsd(e.target.value)} placeholder="No cost cap"/></label>
    </div>
    {goal&&<div className="goal-metrics">
      <div className={goal.tokenBudgetRemaining===0?"exhausted":""}><span>Tokens used</span><strong>{tokensUsed.toLocaleString()}{goal.tokenBudget!=null?" / "+Number(goal.tokenBudget).toLocaleString():""}</strong><small>{goal.tokenBudgetRemaining==null?"No token cap":Number(goal.tokenBudgetRemaining).toLocaleString()+" remaining"}</small></div>
      <div className={goal.timeBudgetRemainingMinutes===0?"exhausted":""}><span>Agent work time</span><strong>{durationLabel(timeUsedSeconds)}{goal.timeBudgetMinutes!=null?" / "+durationLabel(Number(goal.timeBudgetMinutes)*60):""}</strong><small>{goal.timeBudgetRemainingMinutes==null?"No time cap":remainingTimeLabel(goal.timeBudgetRemainingMinutes)}</small></div>
      <div className={goal.turnBudgetRemaining===0?"exhausted":""}><span>Model turns</span><strong>{Number(goal.turnsUsed||0).toLocaleString()}{goal.turnBudget!=null?" / "+Number(goal.turnBudget).toLocaleString():""}</strong><small>{goal.turnBudgetRemaining==null?"No turn cap":Number(goal.turnBudgetRemaining).toLocaleString()+" remaining"}</small></div>
      <div className={goal.costBudgetUsd!=null&&goal.costTelemetryComplete&&Number(goal.costBudgetRemainingUsd)===0?"exhausted":""}><span>Known cost</span><strong>{goal.costUsedUsd==null?"Unavailable":moneyLabel(goal.costUsedUsd)+(goal.costBudgetUsd!=null?" / "+moneyLabel(goal.costBudgetUsd):"")}</strong><small>{goal.costBudgetUsd==null?"No cost cap":!goal.costTelemetryComplete?"Cost telemetry incomplete · not enforced":goal.costBudgetRemainingUsd==null?"Waiting for cost telemetry":moneyLabel(goal.costBudgetRemainingUsd)+" remaining"}</small></div>
    </div>}
    <details className="goal-details" open={detailsOpen} onToggle={e=>setDetailsOpen(e.currentTarget.open)}>
      <summary><span><strong>Completion & guardrails</strong><small>{guidanceCount?guidanceCount+" saved guidance item"+(guidanceCount===1?"":"s"):"Optional durable guidance for long-running work."}</small></span><ChevronDown size={14}/></summary>
      <div className="goal-details-body">
        <label>Completion conditions <span>(one per line)</span><textarea aria-label="Completion conditions" value={completionConditions} onChange={e=>setCompletionConditions(e.target.value)} placeholder={"Tests pass\nFeature works after restart"}/></label>
        <label>Constraints <span>(one per line)</span><textarea aria-label="Constraints" value={constraints} onChange={e=>setConstraints(e.target.value)} placeholder={"Keep backward compatibility\nDo not change the schema"}/></label>
        <label>Validation expectations <span>(one per line)</span><textarea aria-label="Validation expectations" value={validationExpectations} onChange={e=>setValidationExpectations(e.target.value)} placeholder={"Run targeted tests\nVerify the UI with a screenshot"}/></label>
      </div>
    </details>
    <div className="goal-actions">
      <button className="primary" onClick={save} disabled={!!busy}><RefreshCw size={12}/> {goal?"Update goal":"Set goal"}</button>
      {goal?.status==="active"&&<button onClick={()=>setGoal({status:"paused"})} disabled={!!busy}><Pause size={12}/> Pause</button>}
      {goal&&goal.status!=="active"&&goal.status!=="complete"&&<button onClick={()=>setGoal({status:"active"})} disabled={!!busy}><Play size={12}/> Resume</button>}
      {goal&&goal.status!=="complete"&&<button onClick={()=>setGoal({status:"complete"})} disabled={!!busy}><CheckCircle2 size={12}/> Complete</button>}
      {goal&&<button className="danger" onClick={clear} disabled={!!busy}><Trash2 size={12}/> Clear</button>}
    </div>
  </div>;
}
