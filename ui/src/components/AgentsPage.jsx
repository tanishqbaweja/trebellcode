import React,{useEffect,useMemo,useState} from "react";
import { Archive, Bot, Check, CircleAlert, GitBranch, RefreshCw, Trash2, UsersRound } from "lucide-react";

function delegatedParentId(thread,meta={}){return thread?.parentThreadId||meta?.delegation?.parentThreadId||meta?.parentThreadId||null}
function delegatedLabel(thread,meta={}){return thread?.name||meta?.delegation?.label||meta?.delegation?.task||thread?.agentNickname||thread?.preview||"Delegated task"}
function delegatedRole(thread,meta={}){return thread?.agentRole||meta?.delegation?.role||"delegate"}

function statusOf(thread){
  const type=thread?.status?.type||"notLoaded";
  if(type==="active")return {key:"working",label:"Working"};
  if(type==="idle")return {key:"idle",label:"Idle · resumable"};
  if(type==="systemError")return {key:"error",label:"Error"};
  return {key:"sleeping",label:"Not loaded"};
}
function ageLabel(epoch){
  if(!epoch)return "";
  const seconds=Math.max(0,Math.floor(Date.now()/1000-Number(epoch)));
  if(seconds<60)return seconds+"s";
  if(seconds<3600)return Math.floor(seconds/60)+"m";
  if(seconds<86400)return Math.floor(seconds/3600)+"h";
  return Math.floor(seconds/86400)+"d";
}
function compactNumber(value){
  const number=Number(value);
  if(!Number.isFinite(number))return null;
  if(number>=1_000_000)return (number/1_000_000).toFixed(number>=10_000_000?0:1).replace(/\.0$/,"")+"m";
  if(number>=1_000)return (number/1_000).toFixed(number>=100_000?0:1).replace(/\.0$/,"")+"k";
  return String(number);
}
function usageLabel(usage){
  if(!usage)return "";
  const parts=[];
  const total=compactNumber(usage.total?.totalTokens);
  if(total)parts.push(total+" tokens");
  const windowSize=Number(usage.modelContextWindow);
  const input=Number(usage.last?.inputTokens);
  if(Number.isFinite(windowSize)&&windowSize>0&&Number.isFinite(input))parts.push("ctx "+Math.round(input/windowSize*100)+"%");
  return parts.join(" · ");
}
function phaseLabel(thread,live,status){
  const flags=thread?.status?.type==="active"?(thread.status.activeFlags||[]):[];
  if(flags.includes("waitingOnApproval"))return "Waiting for approval";
  if(flags.includes("waitingOnUserInput"))return "Waiting for input";
  if(live?.currentActivity?.title)return live.currentActivity.title;
  if(live?.turnId)return "Working";
  if(live?.lastError)return "Error · "+live.lastError;
  return status.label;
}

export default function AgentsPage({threads,onOpen,onAction,onRefreshThreads,onDelegate,rpc,rpcStatus,activeThread,model,telemetry={},threadMeta={},canModelDelegate=false}){
  const parentIdOf=thread=>delegatedParentId(thread,threadMeta[thread.id]||{});
  const activeProjectless=Boolean(activeThread?.id&&threadMeta[activeThread.id]?.projectless);
  const children=useMemo(()=>threads.filter(t=>parentIdOf(t)),[threads,threadMeta]);
  const currentChildren=useMemo(()=>activeThread?.id?children.filter(t=>parentIdOf(t)===activeThread.id):[],[children,activeThread?.id,threadMeta]);
  const otherChildren=useMemo(()=>activeThread?.id?children.filter(t=>parentIdOf(t)!==activeThread.id):children,[children,activeThread?.id,threadMeta]);
  const [modes,setModes]=useState([]);
  const [selected,setSelected]=useState("");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [delegateOpen,setDelegateOpen]=useState(false);
  const [delegateTask,setDelegateTask]=useState("");
  const [delegatePermission,setDelegatePermission]=useState("supervised");
  const [delegateIsolation,setDelegateIsolation]=useState(activeProjectless?"inherit":"worktree");
  useEffect(()=>setDelegateIsolation(activeProjectless?"inherit":"worktree"),[activeThread?.id,activeProjectless]);

  const counts=useMemo(()=>{
    const result={working:0,idle:0,error:0,sleeping:0};
    for(const thread of children)result[statusOf(thread).key]++;
    return result;
  },[children]);

  async function refresh(){
    setError("");
    try{
      const jobs=[];
      if(rpc&&rpcStatus==="connected")jobs.push(rpc.request("collaborationMode/list",{}).then(result=>setModes(result?.data||[])));
      else setModes([]);
      if(onRefreshThreads)jobs.push(Promise.resolve(onRefreshThreads()));
      await Promise.all(jobs);
    }catch(e){setError(e.message||String(e))}
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

  async function agentAction(thread,action){
    if(!onAction||busy)return;
    setBusy(true);setError("");
    try{await onAction(thread,action);await onRefreshThreads?.()}
    catch(e){setError(e.message||String(e))}
    finally{setBusy(false)}
  }
  async function openAgent(thread){
    if(!onOpen||busy)return;
    setBusy(true);setError("");
    try{await onOpen(thread)}
    catch(e){setError(e.message||String(e))}
    finally{setBusy(false)}
  }
  async function submitDelegate(){
    const task=delegateTask.trim();if(!task||!onDelegate||!activeThread?.id)return;
    setBusy(true);setError("");
    try{
      await onDelegate({task,permissions:delegatePermission,isolation:delegateIsolation});
      setDelegateTask("");setDelegateOpen(false);await onRefreshThreads?.();
    }catch(e){setError(e.message||String(e))}
    finally{setBusy(false)}
  }

  function renderAgents(items){
    return <div className="agent-list">{items.map(t=>{
      const status=statusOf(t);
      const flags=t.status?.type==="active"?(t.status.activeFlags||[]):[];
      const live=telemetry[t.id]||{};
      const meta=threadMeta[t.id]||{},delegation=meta.delegation||{};
      const phase=phaseLabel(t,live,status);
      const usage=usageLabel(live.tokenUsage);
      const activityAge=ageLabel((live.lastActivityAt?live.lastActivityAt/1000:null)||t.updatedAt);
      return <div className="agent-row" key={t.id}>
        <button className="agent-open" onClick={()=>openAgent(t)} disabled={busy}>
          <span className={"agent-status-dot "+status.key}/>
          <div>
            <strong>{delegatedLabel(t,meta)}</strong>
            <span className="agent-live-phase">{delegatedRole(t,meta)} · <b>{delegation.status==="uncertain"?"Uncertain launch":delegation.status==="failed"?"Launch failed":phase}</b>{flags.length?" · "+flags.join(", "):""}</span>
            <small>{(t.model||delegation.model||model||"model").replace(/^freebuff\//,"")}{delegation.permissions||delegation.permission?" · "+(delegation.permissions||delegation.permission):""}{delegation.isolation?" · "+delegation.isolation:""}{delegation.branch?" · "+delegation.branch:""}{usage?" · "+usage:""}{activityAge?" · active "+activityAge+" ago":""} · parent {String(parentIdOf(t)||"").slice(0,8)}</small>
            {delegation.ownership?.length>0&&<small className="agent-last-activity">Owns · {delegation.ownership.join(", ")}</small>}
            {!live.currentActivity&&live.lastActivity?.title&&<small className="agent-last-activity">Last · {live.lastActivity.title}{live.lastActivity.durationMs!=null?" · "+Math.max(1,Math.round(live.lastActivity.durationMs))+"ms":""}</small>}
          </div>
          {status.key==="error"?<CircleAlert size={13}/>:status.key==="idle"?<Check size={13}/>:<GitBranch size={13}/>}
        </button>
        <div className="agent-actions">
          <button title="Archive agent thread" aria-label="Archive agent thread" onClick={()=>agentAction(t,"archive")} disabled={busy}><Archive size={13}/></button>
          <button className="danger" title="Delete agent thread" aria-label="Delete agent thread" onClick={()=>agentAction(t,"delete")} disabled={busy}><Trash2 size={13}/></button>
        </div>
      </div>;
    })}</div>;
  }

  return <div className="agents-page">
    <div className="agent-summary">
      <Bot size={24}/>
      <div><strong>Delegated agents</strong><span>Native subagents and Trebell-managed child tasks, grouped around the thread you are working in.</span></div>
      <button className="agent-refresh" onClick={refresh} disabled={busy}><RefreshCw size={13}/></button>
    </div>
    <div className="agent-fleet-stats">
      <span className="working">{counts.working} working</span><span>{counts.idle} idle</span><span>{counts.sleeping} sleeping</span>{counts.error>0&&<span className="error">{counts.error} error</span>}
    </div>
    <section className="delegate-card">
      <div className="delegate-head"><div><GitBranch size={15}/><span><strong>Delegate a bounded task</strong><small>{canModelDelegate?"The model can also invoke Trebell delegation when parallel work is useful.":"Manual delegation is available; this runtime does not expose Trebell's delegation tool directly to the model."}</small></span></div>{activeThread?.id&&onDelegate&&<button onClick={()=>setDelegateOpen(value=>!value)} disabled={busy}>{delegateOpen?"Close":"Delegate"}</button>}</div>
      {!activeThread?.id?<p>Open a parent thread before starting a child task.</p>:delegateOpen?<div className="delegate-form">
        <textarea aria-label="Delegated task" value={delegateTask} onChange={event=>setDelegateTask(event.target.value)} placeholder="Give the child one concrete objective…"/>
        <div><label>Permissions<select aria-label="Delegation permissions" value={delegatePermission} onChange={event=>setDelegatePermission(event.target.value)}><option value="supervised">Supervised</option><option value="read-only">Read only</option><option value="workspace-write">Workspace write</option><option value="full">Full access</option></select></label><label>Isolation<select aria-label="Delegation isolation" value={delegateIsolation} onChange={event=>setDelegateIsolation(event.target.value)}><option value="worktree">Isolated worktree</option><option value="inherit">Inherit parent workspace</option></select></label></div>
        <button className="delegate-submit" onClick={submitDelegate} disabled={busy||!delegateTask.trim()}>Start child task</button>
      </div>:<p>Parallel coding delegates use separate worktrees by default. Shared workspace mode is explicit because two agents editing the same checkout is how merge drama gets promoted to production.</p>}
    </section>
    <section className="collaboration-card">
      <div className="collaboration-head"><div><UsersRound size={15}/><span><strong>Collaboration mode</strong><small>Choose provider-native collaboration behavior when the active runtime exposes it.</small></span></div><button onClick={refresh} disabled={busy||rpcStatus!=="connected"}><RefreshCw size={12}/></button></div>
      {!activeThread?.id?<p>Start or open a thread to select a collaboration mode.</p>:modes.length?<div className="collaboration-modes">{modes.map(mask=><button key={mask.name} className={selected===mask.name?"active":""} onClick={()=>applyMode(mask)} disabled={busy}><strong>{mask.name}</strong><span>{mask.mode||"default"}{mask.model?" · "+mask.model:""}{mask.reasoning_effort?" · "+mask.reasoning_effort:""}</span></button>)}</div>:<p>No provider-native collaboration presets were reported by this runtime.</p>}
    </section>
    {error&&<p className="provider-status-error" role="alert">{error}</p>}
    {currentChildren.length>0&&<section className="agent-group"><h4>Current thread <span>{currentChildren.length}</span></h4>{renderAgents(currentChildren)}</section>}
    {otherChildren.length>0&&<section className="agent-group"><h4>{activeThread?.id?"Other agents":"All agents"} <span>{otherChildren.length}</span></h4>{renderAgents(otherChildren)}</section>}
    {children.length===0&&<div className="agent-empty-state"><Bot size={18}/><strong>No delegated agents yet</strong><span>Native subagents or Trebell-managed child tasks will appear here with their live status and ownership.</span></div>}
  </div>;
}
