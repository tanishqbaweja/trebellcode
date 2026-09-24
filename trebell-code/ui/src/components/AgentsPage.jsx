import React,{useEffect,useMemo,useState} from "react";
import { Archive, Bot, Check, CircleAlert, GitBranch, RefreshCw, Trash2, UsersRound } from "lucide-react";

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

export default function AgentsPage({threads,onOpen,onAction,onRefreshThreads,rpc,rpcStatus,activeThread,model,telemetry={}}){
  const children=useMemo(()=>threads.filter(t=>t.parentThreadId),[threads]);
  const currentChildren=useMemo(()=>activeThread?.id?children.filter(t=>t.parentThreadId===activeThread.id):[],[children,activeThread?.id]);
  const otherChildren=useMemo(()=>activeThread?.id?children.filter(t=>t.parentThreadId!==activeThread.id):children,[children,activeThread?.id]);
  const [modes,setModes]=useState([]);
  const [selected,setSelected]=useState("");
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");

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

  function renderAgents(items){
    return <div className="agent-list">{items.map(t=>{
      const status=statusOf(t);
      const flags=t.status?.type==="active"?(t.status.activeFlags||[]):[];
      const live=telemetry[t.id]||{};
      const phase=phaseLabel(t,live,status);
      const usage=usageLabel(live.tokenUsage);
      const activityAge=ageLabel((live.lastActivityAt?live.lastActivityAt/1000:null)||t.updatedAt);
      return <div className="agent-row" key={t.id}>
        <button className="agent-open" onClick={()=>openAgent(t)} disabled={busy}>
          <span className={"agent-status-dot "+status.key}/>
          <div>
            <strong>{t.name||t.agentNickname||t.preview||"Subagent"}</strong>
            <span className="agent-live-phase">{t.agentRole||"agent"} · <b>{phase}</b>{flags.length?" · "+flags.join(", "):""}</span>
            <small>{(t.model||model||"model").replace(/^freebuff\//,"")}{usage?" · "+usage:""}{activityAge?" · active "+activityAge+" ago":""} · parent {t.parentThreadId?.slice(0,8)}</small>
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
      <div><strong>Delegated agents</strong><span>Live Codex subagent threads, grouped around the thread you are working in.</span></div>
      <button className="agent-refresh" onClick={refresh} disabled={busy}><RefreshCw size={13}/></button>
    </div>
    <div className="agent-fleet-stats">
      <span className="working">{counts.working} working</span><span>{counts.idle} idle</span><span>{counts.sleeping} sleeping</span>{counts.error>0&&<span className="error">{counts.error} error</span>}
    </div>
    <section className="collaboration-card">
      <div className="collaboration-head"><div><UsersRound size={15}/><span><strong>Collaboration mode</strong><small>Choose how Codex coordinates work for this thread.</small></span></div><button onClick={refresh} disabled={busy||rpcStatus!=="connected"}><RefreshCw size={12}/></button></div>
      {!activeThread?.id?<p>Start or open a thread to select a collaboration mode.</p>:modes.length?<div className="collaboration-modes">{modes.map(mask=><button key={mask.name} className={selected===mask.name?"active":""} onClick={()=>applyMode(mask)} disabled={busy}><strong>{mask.name}</strong><span>{mask.mode||"default"}{mask.model?" · "+mask.model:""}{mask.reasoning_effort?" · "+mask.reasoning_effort:""}</span></button>)}</div>:<p>No collaboration presets were reported by this Codex runtime.</p>}
    </section>
    {error&&<p className="provider-status-error" role="alert">{error}</p>}
    {currentChildren.length>0&&<section className="agent-group"><h4>Current thread <span>{currentChildren.length}</span></h4>{renderAgents(currentChildren)}</section>}
    {otherChildren.length>0&&<section className="agent-group"><h4>{activeThread?.id?"Other agents":"All agents"} <span>{otherChildren.length}</span></h4>{renderAgents(otherChildren)}</section>}
    {children.length===0&&<div className="agent-empty-state"><Bot size={18}/><strong>No delegated agents yet</strong><span>When Codex delegates work, subagent threads and their live status will appear here.</span></div>}
  </div>;
}
