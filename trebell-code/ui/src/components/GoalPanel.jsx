import React,{useEffect,useState} from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, Pause, Play, RefreshCw, Target, Trash2 } from "lucide-react";
import { startSameThreadVerificationRepair } from "../verification-repair.js";

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

export default function GoalPanel({rpc,rpcStatus,thread,goal,onGoal,continuity,onContinuity}){
  const [objective,setObjective]=useState("");
  const [tokenBudget,setTokenBudget]=useState("");
  const [timeBudget,setTimeBudget]=useState("");
  const [turnBudget,setTurnBudget]=useState("");
  const [toolCallBudget,setToolCallBudget]=useState("");
  const [childAgentBudget,setChildAgentBudget]=useState("");
  const [costBudgetUsd,setCostBudgetUsd]=useState("");
  const [completionConditions,setCompletionConditions]=useState("");
  const [constraints,setConstraints]=useState("");
  const [validationExpectations,setValidationExpectations]=useState("");
  const [detailsOpen,setDetailsOpen]=useState(false);
  const [advancedBudgetOpen,setAdvancedBudgetOpen]=useState(false);
  const [continuityOpen,setContinuityOpen]=useState(false);
  const [completedWork,setCompletedWork]=useState("");
  const [unresolvedFailures,setUnresolvedFailures]=useState("");
  const [importantDecisions,setImportantDecisions]=useState("");
  const [artifactsCreated,setArtifactsCreated]=useState("");
  const [pendingNextActions,setPendingNextActions]=useState("");
  const [repairStatus,setRepairStatus]=useState("");
  const [busy,setBusy]=useState("");
  const [error,setError]=useState("");
  useEffect(()=>{
    setObjective(goal?.objective||"");
    setTokenBudget(goal?.tokenBudget==null?"":String(goal.tokenBudget));
    setTimeBudget(goal?.timeBudgetMinutes==null?"":String(goal.timeBudgetMinutes));
    setTurnBudget(goal?.turnBudget==null?"":String(goal.turnBudget));
    setToolCallBudget(goal?.toolCallBudget==null?"":String(goal.toolCallBudget));
    setChildAgentBudget(goal?.childAgentBudget==null?"":String(goal.childAgentBudget));
    setCostBudgetUsd(goal?.costBudgetUsd==null?"":String(goal.costBudgetUsd));
    setCompletionConditions(lines(goal?.completionConditions));
    setConstraints(lines(goal?.constraints));
    setValidationExpectations(lines(goal?.validationExpectations));
  },[goal?.threadId,goal?.objective,goal?.tokenBudget,goal?.timeBudgetMinutes,goal?.turnBudget,goal?.toolCallBudget,goal?.childAgentBudget,goal?.costBudgetUsd,goal?.completionConditions,goal?.constraints,goal?.validationExpectations]);
  useEffect(()=>{
    setCompletedWork(lines(continuity?.notes?.completedWork));
    setUnresolvedFailures(lines(continuity?.notes?.unresolvedFailures));
    setImportantDecisions(lines(continuity?.notes?.importantDecisions));
    setArtifactsCreated(lines(continuity?.notes?.artifactsCreated));
    setPendingNextActions(lines(continuity?.notes?.pendingNextActions));
  },[continuity?.notes?.completedWork,continuity?.notes?.unresolvedFailures,continuity?.notes?.importantDecisions,continuity?.notes?.artifactsCreated,continuity?.notes?.pendingNextActions]);
  useEffect(()=>{setDetailsOpen(false);setAdvancedBudgetOpen(false);setContinuityOpen(false);setRepairStatus("")},[thread?.id]);
  if(!thread?.id)return <div className="empty-state"><Target size={28}/><strong>No active thread</strong><span>Start or open a thread before setting a durable goal.</span></div>;
  if(rpcStatus!=="connected")return <div className="empty-state"><Target size={28}/><strong>Agent harness is reconnecting</strong><span>This thread's durable goal will be available again when the active harness reconnects.</span></div>;
  async function setGoal(patch){
    if(!rpc)return;setBusy("save");setError("");
    try{const result=await rpc.request("thread/goal/set",{threadId:thread.id,...patch});onGoal?.(result?.goal||null)}
    catch(e){setError(e.message||String(e))}finally{setBusy("")}
  }
  async function save(){
    const text=objective.trim();if(!text){setError("Enter an objective first.");return}
    let nextTokenBudget,nextTimeBudget,nextTurnBudget,nextToolCallBudget,nextChildAgentBudget,nextCostBudgetUsd;
    try{
      nextTokenBudget=wholeNumber(tokenBudget,"Token budget");nextTimeBudget=wholeNumber(timeBudget,"Time budget");
      nextTurnBudget=wholeNumber(turnBudget,"Turn budget");nextToolCallBudget=wholeNumber(toolCallBudget,"Tool-call budget");nextChildAgentBudget=wholeNumber(childAgentBudget,"Child-agent budget");nextCostBudgetUsd=positiveNumber(costBudgetUsd,"Cost budget");
    }
    catch(e){setError(e.message||String(e));return}
    await setGoal({
      objective:text,status:goal?.status||"active",tokenBudget:nextTokenBudget,timeBudgetMinutes:nextTimeBudget,turnBudget:nextTurnBudget,toolCallBudget:nextToolCallBudget,childAgentBudget:nextChildAgentBudget,costBudgetUsd:nextCostBudgetUsd,
      completionConditions:parseLines(completionConditions),constraints:parseLines(constraints),validationExpectations:parseLines(validationExpectations),
    });
  }
  async function clear(){
    if(!rpc||!confirm("Clear this thread goal?"))return;setBusy("clear");setError("");
    try{
      await rpc.request("thread/goal/clear",{threadId:thread.id});onGoal?.(null);
      setObjective("");setTokenBudget("");setTimeBudget("");setTurnBudget("");setToolCallBudget("");setChildAgentBudget("");setCostBudgetUsd("");setCompletionConditions("");setConstraints("");setValidationExpectations("");setDetailsOpen(false);setAdvancedBudgetOpen(false);
    }
    catch(e){setError(e.message||String(e))}finally{setBusy("")}
  }
  async function saveContinuity(){
    if(!rpc)return;setBusy("continuity");setError("");
    try{
      const result=await rpc.request("thread/continuity/set",{
        threadId:thread.id,
        completedWork:parseLines(completedWork),unresolvedFailures:parseLines(unresolvedFailures),importantDecisions:parseLines(importantDecisions),
        artifactsCreated:parseLines(artifactsCreated),pendingNextActions:parseLines(pendingNextActions),
      });
      onContinuity?.(result?.continuity||null);
    }catch(e){setError(e.message||String(e))}finally{setBusy("")}
  }
  async function clearContinuity(){
    if(!rpc||!confirm("Clear explicit continuity notes? Trebell-derived verification, checkpoints, queue and failure evidence will remain."))return;
    setBusy("continuity-clear");setError("");
    try{
      const result=await rpc.request("thread/continuity/clear",{threadId:thread.id});onContinuity?.(result?.continuity||null);
      setCompletedWork("");setUnresolvedFailures("");setImportantDecisions("");setArtifactsCreated("");setPendingNextActions("");
    }catch(e){setError(e.message||String(e))}finally{setBusy("")}
  }
  async function repairVerification(){
    if(!rpc)return;setBusy("verification-repair");setError("");setRepairStatus("");
    try{
      const result=await startSameThreadVerificationRepair({rpc,thread});
      setRepairStatus(result?.turn?.id?"Repair turn started on this thread.":"Repair request started.");
    }catch(e){setError(e.message||String(e))}finally{setBusy("")}
  }
  const status=goal?.status||"not set";
  const blocked=goal?.status==="active"&&goal?.budgetExhausted;
  const tokensUsed=Math.max(0,Number(goal?.tokensUsed)||0),timeUsedSeconds=Math.max(0,Number(goal?.timeUsedSeconds)||0);
  const guidanceCount=(goal?.completionConditions?.length||0)+(goal?.constraints?.length||0)+(goal?.validationExpectations?.length||0);
  const advancedBudgetCount=[goal?.turnBudget,goal?.toolCallBudget,goal?.childAgentBudget,goal?.costBudgetUsd].filter(value=>value!=null).length;
  const continuityNoteCount=["completedWork","unresolvedFailures","importantDecisions","artifactsCreated","pendingNextActions"].reduce((sum,key)=>sum+(continuity?.notes?.[key]?.length||0),0);
  const verificationLabel=continuity?.verification?[continuity.verification.status,continuity.verification.risk].filter(Boolean).join(" · "):"No verification recorded";
  const workspaceLabel=continuity?.workspace?.branch||continuity?.workspace?.cwd||"No workspace metadata";
  return <div className="goal-panel" data-testid="goal-panel">
    <div className="goal-panel-head"><Target size={19}/><div><strong>Thread goal</strong><span>Durable objective stored with this thread, independent of the chat transcript.</span></div><em className={"goal-status status-"+String(status).replace(/[^a-z]/gi,"").toLowerCase()}>{status}</em></div>
    {error&&<div className="inline-error">{error}</div>}
    {blocked&&<div className="goal-budget-alert" role="alert" data-testid="goal-budget-alert"><AlertTriangle size={16}/><div><strong>Goal budget exhausted</strong><span>New turns are blocked. Increase the exhausted budget, or pause, complete, or clear this goal.</span></div></div>}
    <label>Objective<textarea aria-label="Objective" value={objective} onChange={e=>setObjective(e.target.value)} maxLength={4000} placeholder="What should this thread keep working toward?"/></label>
    <div className="goal-budget-grid">
      <label>Token budget <span>(optional)</span><input aria-label="Token budget" type="number" min="1" step="1" value={tokenBudget} onChange={e=>setTokenBudget(e.target.value)} placeholder="No token cap"/></label>
      <label>Time budget <span>(minutes, optional)</span><input aria-label="Time budget" type="number" min="1" step="1" value={timeBudget} onChange={e=>setTimeBudget(e.target.value)} placeholder="No time cap"/></label>
    </div>
    <details className="goal-details goal-budget-details" open={advancedBudgetOpen} onToggle={e=>setAdvancedBudgetOpen(e.currentTarget.open)}>
      <summary><span><strong>Advanced budgets</strong><small>{advancedBudgetCount?advancedBudgetCount+" configured limit"+(advancedBudgetCount===1?"":"s"):"Turns, tools, child agents, and known cost."}</small></span><ChevronDown size={14}/></summary>
      <div className="goal-details-body goal-budget-details-body">
        <div className="goal-budget-grid">
          <label>Turn budget <span>(optional)</span><input aria-label="Turn budget" type="number" min="1" max="500" step="1" value={turnBudget} onChange={e=>setTurnBudget(e.target.value)} placeholder="No turn cap"/></label>
          <label>Tool-call budget <span>(optional)</span><input aria-label="Tool-call budget" type="number" min="1" max="1000" step="1" value={toolCallBudget} onChange={e=>setToolCallBudget(e.target.value)} placeholder="No tool cap"/></label>
          <label>Child-agent budget <span>(optional)</span><input aria-label="Child-agent budget" type="number" min="1" max="100" step="1" value={childAgentBudget} onChange={e=>setChildAgentBudget(e.target.value)} placeholder="No child cap"/></label>
          <label>Cost budget <span>(USD, optional)</span><input aria-label="Cost budget" type="number" min="0.0001" step="0.01" value={costBudgetUsd} onChange={e=>setCostBudgetUsd(e.target.value)} placeholder="No cost cap"/></label>
        </div>
        <p className="goal-budget-note">Limits stop the next new turn after they are reached; Trebell does not kill work mid-action. Cost and child-agent caps enforce only when the runtime exposes complete telemetry.</p>
      </div>
    </details>
    {goal&&<div className="goal-metrics">
      <div className={goal.tokenBudgetRemaining===0?"exhausted":""}><span>Tokens used</span><strong>{tokensUsed.toLocaleString()}{goal.tokenBudget!=null?" / "+Number(goal.tokenBudget).toLocaleString():""}</strong><small>{goal.tokenBudgetRemaining==null?"No token cap":Number(goal.tokenBudgetRemaining).toLocaleString()+" remaining"}</small></div>
      <div className={goal.timeBudgetRemainingMinutes===0?"exhausted":""}><span>Agent work time</span><strong>{durationLabel(timeUsedSeconds)}{goal.timeBudgetMinutes!=null?" / "+durationLabel(Number(goal.timeBudgetMinutes)*60):""}</strong><small>{goal.timeBudgetRemainingMinutes==null?"No time cap":remainingTimeLabel(goal.timeBudgetRemainingMinutes)}</small></div>
      <div className={goal.turnBudgetRemaining===0?"exhausted":""}><span>Model turns</span><strong>{Number(goal.turnsUsed||0).toLocaleString()}{goal.turnBudget!=null?" / "+Number(goal.turnBudget).toLocaleString():""}</strong><small>{goal.turnBudgetRemaining==null?"No turn cap":Number(goal.turnBudgetRemaining).toLocaleString()+" remaining"}</small></div>
      <div className={goal.toolCallBudget!=null&&goal.toolCallTelemetryComplete&&Number(goal.toolCallBudgetRemaining)===0?"exhausted":""}><span>Tool calls</span><strong>{Number(goal.toolCallsUsed||0).toLocaleString()}{goal.toolCallBudget!=null?" / "+Number(goal.toolCallBudget).toLocaleString():""}</strong><small>{goal.toolCallBudget==null?"No tool cap":!goal.toolCallTelemetryComplete?"Tool telemetry incomplete · not enforced":Number(goal.toolCallBudgetRemaining||0).toLocaleString()+" remaining"}</small></div>
      <div className={goal.childAgentBudget!=null&&goal.childAgentTelemetryComplete&&Number(goal.childAgentBudgetRemaining)===0?"exhausted":""}><span>Child agents</span><strong>{goal.childAgentsUsed==null?"Unavailable":Number(goal.childAgentsUsed).toLocaleString()+(goal.childAgentBudget!=null?" / "+Number(goal.childAgentBudget).toLocaleString():"")}</strong><small>{goal.childAgentBudget==null?"No child cap":!goal.childAgentTelemetryComplete?"Child telemetry not exposed · not enforced":Number(goal.childAgentBudgetRemaining||0).toLocaleString()+" remaining"}</small></div>
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
    <details className="goal-details goal-continuity-details" open={continuityOpen} onToggle={e=>setContinuityOpen(e.currentTarget.open)}>
      <summary><span><strong>Continuity state</strong><small>{continuityNoteCount?continuityNoteCount+" explicit note"+(continuityNoteCount===1?"":"s"):"Derived facts only"}{continuity?.meaningful?" · durable state available":""}</small></span><ChevronDown size={14}/></summary>
      <div className="goal-details-body continuity-body">
        <div className="continuity-derived" data-testid="continuity-derived">
          <div><span>Workspace</span><strong>{workspaceLabel}</strong></div>
          <div><span>Verification</span><strong>{verificationLabel}</strong></div>
          <div><span>Completed turns</span><strong>{Number(continuity?.completedTurnIds?.length||0)}</strong></div>
          <div><span>Unresolved / recent failures</span><strong>{Number(continuity?.unresolvedFailures?.length||0)+Number(continuity?.recentFailures?.length||0)}</strong></div>
        </div>
        {continuity?.verification?.status==="failed"&&<div className="verification-repair-card" data-testid="verification-repair-card"><div><strong>Verification needs repair</strong><span>Start a same-thread repair turn with the persisted failed-step evidence. No second reviewer model is spawned.</span></div><button type="button" onClick={repairVerification} disabled={!!busy}>{busy==="verification-repair"?"Starting…":"Repair failed verification"}</button></div>}
        {repairStatus&&<div className="verification-repair-status">{repairStatus}</div>}
        <label>Completed work <span>(one per line)</span><textarea aria-label="Completed work" value={completedWork} onChange={e=>setCompletedWork(e.target.value)} placeholder={"Implemented the parser\nAdded regression tests"}/></label>
        <label>Unresolved failures <span>(one per line)</span><textarea aria-label="Unresolved failures" value={unresolvedFailures} onChange={e=>setUnresolvedFailures(e.target.value)} placeholder={"Preview still fails on Windows"}/></label>
        <label>Important decisions <span>(one per line)</span><textarea aria-label="Important decisions" value={importantDecisions} onChange={e=>setImportantDecisions(e.target.value)} placeholder={"Keep the public API backward compatible"}/></label>
        <label>Artifacts created <span>(one per line)</span><textarea aria-label="Artifacts created" value={artifactsCreated} onChange={e=>setArtifactsCreated(e.target.value)} placeholder={"Migration script\nRelease notes"}/></label>
        <label>Pending next actions <span>(one per line)</span><textarea aria-label="Pending next actions" value={pendingNextActions} onChange={e=>setPendingNextActions(e.target.value)} placeholder={"Run the final browser smoke test"}/></label>
        <div className="goal-actions continuity-actions"><button type="button" className="primary" onClick={saveContinuity} disabled={!!busy}><RefreshCw size={12}/> Save continuity</button>{continuityNoteCount>0&&<button type="button" className="danger" onClick={clearContinuity} disabled={!!busy}><Trash2 size={12}/> Clear notes</button>}</div>
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
