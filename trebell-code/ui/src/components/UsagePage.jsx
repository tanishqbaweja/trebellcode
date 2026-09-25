import React,{useEffect,useMemo,useState} from "react";
import { CircleAlert, RefreshCw, RotateCcw, Sparkles, Trash2 } from "lucide-react";
import { api } from "../api.js";
import { codexRateLimitEntries,formatRateReset,microsToCurrency,rateLimitReachedLabel,rateLimitRemainingPercent } from "../usage-account.js";

function formatTokens(value){const n=Number(value||0);if(n>=1_000_000)return (n/1_000_000).toFixed(n>=10_000_000?1:2)+"M";if(n>=1_000)return (n/1_000).toFixed(n>=100_000?0:1)+"K";return n.toLocaleString()}
function estimateCost(record,settings){
  if(record.cost?.currency==="USD"&&Number.isFinite(Number(record.cost.amount)))return {amount:Number(record.cost.amount),estimated:false};
  const price=(settings.customModels||[]).find(item=>item.id===record.model&&item.runtime===record.runtime&&(record.runtime!=="codex"||item.provider===record.provider));if(!price)return null;
  const usage=record.usage||{};const rate=key=>price[key]==null?0:Number(price[key])||0;
  const amount=(Number(usage.inputTokens||0)*rate("inputPrice")+Number(usage.outputTokens||0)*rate("outputPrice")+Number(usage.cachedInputTokens||0)*rate("cacheReadPrice")+Number(usage.cacheWriteInputTokens||0)*rate("cacheWritePrice"))/1_000_000;
  return {amount,estimated:true};
}
function runtimeLabel(value){return ({native:"Trebell Native",codex:"Codex",claude:"Claude Code",opencode:"OpenCode",cursor:"Cursor",grok:"Grok Build",antigravity:"Antigravity"}[value]||value||"Unknown")}
function money(value){return Number.isFinite(value)?`$${value.toFixed(value<1?4:2)}`:"—"}
function duration(value){const seconds=Number(value);if(!Number.isFinite(seconds)||seconds<0)return "—";if(seconds<60)return Math.round(seconds)+"s";const mins=Math.round(seconds/60);return mins<60?mins+"m":Math.floor(mins/60)+"h "+(mins%60)+"m"}
function withoutKey(object,key){return Object.fromEntries(Object.entries(object||{}).filter(([name])=>name!==key))}

export default function UsagePage({settings={},rpc=null,rpcStatus="disconnected",activeThread=null,agentRuntime="codex"}){
  const [days,setDays]=useState(30);const [data,setData]=useState({records:[],total:{},models:{},runtimes:{},daily:{}});const [loading,setLoading]=useState(false);const [error,setError]=useState("");
  const [clearing,setClearing]=useState(false);
  const [codex,setCodex]=useState({account:null,rateLimits:null,usage:null,messages:null,errors:{},loading:false,notice:""});
  const [runtimeUsage,setRuntimeUsage]=useState({data:null,loading:false,error:""});
  const [environmentData,setEnvironmentData]=useState({profiles:[],activeEnvironmentId:null,activeEnvironment:null});
  const [environmentError,setEnvironmentError]=useState("");
  const [selectedEnvironments,setSelectedEnvironments]=useState([]);
  const environmentOptions=useMemo(()=>[
    {id:"local",name:"Local / legacy",type:"local"},
    ...(environmentData.profiles||[]).map(profile=>({id:profile.id,name:profile.name||profile.id,type:profile.type||"remote"})),
  ],[environmentData]);
  const environmentNames=useMemo(()=>Object.fromEntries(environmentOptions.map(item=>[item.id,item.name])),[environmentOptions]);
  const activeEnvironmentKey=environmentData.activeEnvironmentId||"local";
  const activeEnvironmentName=environmentNames[activeEnvironmentKey]||environmentData.activeEnvironment?.name||"Local machine";
  const environmentFilterLabel=selectedEnvironments.length===0?"All environments":selectedEnvironments.length===1?(environmentNames[selectedEnvironments[0]]||selectedEnvironments[0]):`${selectedEnvironments.length} environments`;
  function toggleEnvironment(id){
    setSelectedEnvironments(current=>current.includes(id)?current.filter(item=>item!==id):[...current,id]);
  }
  async function refreshCodex(){
    if(agentRuntime!=="codex"||!rpc||rpcStatus!=="connected"){setCodex(current=>({...current,account:null,rateLimits:null,usage:null,messages:null,errors:{},loading:false}));return}
    setCodex(current=>({...current,loading:true,errors:{},notice:""}));
    const requests=[
      ["account",()=>rpc.request("account/read",{refreshToken:false})],
      ["rateLimits",()=>rpc.request("account/rateLimits/read",{excludeResetCreditDetails:false})],
      ["usage",()=>rpc.request("account/usage/read",activeThread?.id?{threadId:activeThread.id}:{})],
      ["messages",()=>rpc.request("account/workspaceMessages/read",{})],
    ];
    const results=await Promise.all(requests.map(async([key,run])=>{try{return [key,await run(),null]}catch(err){return [key,null,err?.message||String(err)]}}));
    setCodex(current=>{
      const next={...current,errors:{},loading:false,notice:""};
      for(const [key,value,failure] of results){
        if(failure)next.errors[key]=failure;
        else next[key]=value;
      }
      return next;
    });
  }
  async function refreshLocal(){
    setLoading(true);setError("");
    try{
      const params=new URLSearchParams({days:String(days),limit:"5000"});
      for(const id of selectedEnvironments)params.append("environmentId",id);
      setData(await api("/api/usage?"+params.toString()));
    }catch(err){setError(err.message)}finally{setLoading(false)}
  }
  async function refreshRuntimeUsage(){
    if(!["opencode","cursor","grok"].includes(agentRuntime)){setRuntimeUsage({data:null,loading:false,error:""});return}
    setRuntimeUsage(current=>({...current,loading:true,error:""}));
    try{setRuntimeUsage({data:await api("/api/agent-runtime-usage"),loading:false,error:""})}
    catch(err){setRuntimeUsage(current=>({...current,loading:false,error:err.message||String(err)}))}
  }
  async function refreshEnvironments(){
    setEnvironmentError("");
    try{
      const next=await api("/api/environments");
      setEnvironmentData(next);return next;
    }catch(err){
      setEnvironmentError(err?.message||String(err)||"Could not refresh environments.");
      return null;
    }
  }
  async function refresh(){await Promise.all([refreshLocal(),refreshCodex(),refreshRuntimeUsage(),refreshEnvironments()])}
  useEffect(()=>{refreshLocal()},[days,selectedEnvironments.join("|")]);
  useEffect(()=>{refreshCodex()},[rpc,rpcStatus,activeThread?.id,agentRuntime]);
  useEffect(()=>{
    if(agentRuntime!=="codex"||rpcStatus!=="connected"||!rpc?.subscribeNotifications)return;
    let disposed=false,accountTimer=null,rateTimer=null,usageTimer=null;
    const refreshAccount=()=>{if(accountTimer)clearTimeout(accountTimer);accountTimer=setTimeout(async()=>{
      accountTimer=null;try{const account=await rpc.request("account/read",{refreshToken:false});if(!disposed)setCodex(current=>({...current,account,errors:withoutKey(current.errors,"account")}))}catch(error){if(!disposed)setCodex(current=>({...current,errors:{...current.errors,account:error?.message||String(error)}}))}
    },100)};
    const refreshRateLimits=()=>{if(rateTimer)clearTimeout(rateTimer);rateTimer=setTimeout(async()=>{
      rateTimer=null;try{const rateLimits=await rpc.request("account/rateLimits/read",{excludeResetCreditDetails:false});if(!disposed)setCodex(current=>({...current,rateLimits,errors:withoutKey(current.errors,"rateLimits")}))}catch(error){if(!disposed)setCodex(current=>({...current,errors:{...current.errors,rateLimits:error?.message||String(error)}}))}
    },100)};
    const refreshUsage=()=>{if(usageTimer)clearTimeout(usageTimer);usageTimer=setTimeout(async()=>{
      usageTimer=null;try{const usage=await rpc.request("account/usage/read",activeThread?.id?{threadId:activeThread.id}:{});if(!disposed)setCodex(current=>({...current,usage,errors:withoutKey(current.errors,"usage")}))}catch(error){if(!disposed)setCodex(current=>({...current,errors:{...current.errors,usage:error?.message||String(error)}}))}
    },250)};
    const unsubscribe=rpc.subscribeNotifications(message=>{
      if(message.method==="account/updated")refreshAccount();
      else if(message.method==="account/rateLimits/updated")refreshRateLimits();
      else if(message.method==="modelProvider/authRecoveryCompleted"){
        const params=message.params||{};
        if(!activeThread?.id||params.threadId===activeThread.id)refreshAccount();
      }else if(message.method==="thread/tokenUsage/updated"||message.method==="turn/completed"){
        const params=message.params||{};
        if(!activeThread?.id||!params.threadId||params.threadId===activeThread.id)refreshUsage();
      }
    });
    return()=>{disposed=true;if(accountTimer)clearTimeout(accountTimer);if(rateTimer)clearTimeout(rateTimer);if(usageTimer)clearTimeout(usageTimer);unsubscribe?.()};
  },[rpc,rpcStatus,activeThread?.id,agentRuntime]);
  useEffect(()=>{refreshRuntimeUsage()},[agentRuntime]);
  useEffect(()=>{refreshEnvironments()},[]);
  const computed=useMemo(()=>{
    let cost=0,known=0,estimated=0;const modelMap={};
    for(const record of data.records||[]){const item=estimateCost(record,settings);if(item){cost+=item.amount;item.estimated?estimated++:known++}const key=record.model||"Unknown model";const bucket=modelMap[key]||(modelMap[key]={tokens:0,turns:0,cost:0,costEntries:0,runtime:record.runtime});bucket.tokens+=Number(record.usage?.totalTokens||0);bucket.turns++;if(item){bucket.cost+=item.amount;bucket.costEntries++}}
    return {cost,known,estimated,models:Object.entries(modelMap).sort((a,b)=>b[1].tokens-a[1].tokens)};
  },[data,settings]);
  const daily=Object.entries(data.daily||{}).sort((a,b)=>a[0].localeCompare(b[0]));const maxDaily=Math.max(1,...daily.map(([,value])=>Number(value.tokens||0)));
  async function clear(){
    if(!confirm("Clear Trebell's locally recorded usage history? Provider account usage is not affected."))return;
    setClearing(true);setError("");
    try{await api("/api/usage",{method:"DELETE"});await refresh()}
    catch(err){setError(err?.message||String(err)||"Could not clear local usage history.")}
    finally{setClearing(false)}
  }
  async function resetCodexLimit(creditId=null){
    if(!rpc||!confirm("Use one earned Codex reset credit now? This can reset an eligible rate-limit window."))return;
    setCodex(current=>({...current,loading:true,notice:""}));
    try{
      const result=await rpc.request("account/rateLimitResetCredit/consume",{idempotencyKey:crypto.randomUUID(),creditId:creditId||null});
      const labels={reset:"Rate-limit window reset.",nothingToReset:"No current window is eligible for a reset.",noCredit:"No reset credit is available.",alreadyRedeemed:"That reset was already completed."};
      await refreshCodex();
      setCodex(current=>({...current,notice:labels[result?.outcome]||String(result?.outcome||"Reset request completed.")}));
    }catch(err){setCodex(current=>({...current,loading:false,notice:err?.message||String(err)}))}
  }
  const codexLimits=codexRateLimitEntries(codex.rateLimits);
  const codexSummary=codex.usage?.summary||null;
  const threadUsage=codex.usage?.threadUsage||null;
  const resetCredits=codex.rateLimits?.rateLimitResetCredits||null;
  const showLiveCodex=agentRuntime==="codex"&&rpcStatus==="connected"&&(selectedEnvironments.length===0||selectedEnvironments.includes(activeEnvironmentKey));
  const showLiveRuntime=["opencode","cursor","grok"].includes(agentRuntime)&&(selectedEnvironments.length===0||selectedEnvironments.includes(activeEnvironmentKey));
  return <div className="usage-page">
    <div className="capabilities-toolbar"><div><h2>Usage</h2><p>Per-turn token and cost history across Trebell harnesses and environments, plus live account limits when the active harness exposes them.</p></div><div className="usage-toolbar"><details className="usage-environment-filter"><summary>{environmentFilterLabel}</summary><div><button onClick={()=>setSelectedEnvironments([])} className={selectedEnvironments.length===0?"active":""}>All environments</button>{environmentOptions.map(item=><label key={item.id}><input type="checkbox" checked={selectedEnvironments.includes(item.id)} onChange={()=>toggleEnvironment(item.id)}/><span>{item.name}</span><em>{item.type}</em></label>)}</div></details><select value={days} onChange={e=>setDays(Number(e.target.value))}><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option><option value={365}>1 year</option></select><button onClick={refresh} disabled={loading||codex.loading||runtimeUsage.loading||clearing}><RefreshCw size={13}/>{loading||codex.loading||runtimeUsage.loading?"Refreshing…":"Refresh"}</button><button onClick={clear} disabled={!data.records?.length||clearing}><Trash2 size={13}/> {clearing?"Clearing…":"Clear local history"}</button></div></div>
    {error&&<div className="inline-error" role="alert">{error}</div>}
    {environmentError&&<div className="inline-error" role="alert">{environmentError}</div>}
    {showLiveCodex&&<section className="capability-card codex-account-usage" data-testid="codex-account-usage">
      <div className="capability-card-head"><span><Sparkles size={15}/><strong>Codex account & limits</strong></span><em>{activeEnvironmentName} · {codex.account?.account?.planType||codex.rateLimits?.rateLimits?.planType||"live"}</em></div>
      {codex.account?.account?.email&&<p className="codex-account-line">{codex.account.account.email}</p>}
      {codex.rateLimits?.ordinaryUsageAllowed===false&&<div className="usage-warning"><CircleAlert size={14}/><span>Ordinary included usage is currently blocked by the account backend.</span></div>}
      {codexLimits.length>0?<div className="codex-limit-grid">{codexLimits.map(({id,label,snapshot})=><div className="codex-limit-card" key={id}>
        <div><strong>{label}</strong>{snapshot.rateLimitReachedType&&<span className="limit-reached">{rateLimitReachedLabel(snapshot.rateLimitReachedType)}</span>}</div>
        {snapshot.primary&&<div className="limit-window"><span>Primary</span><i><b style={{width:`${Math.max(2,rateLimitRemainingPercent(snapshot.primary)??0)}%`}}/></i><strong>{rateLimitRemainingPercent(snapshot.primary)}% left</strong><small>{formatRateReset(snapshot.primary.resetsAt)}</small></div>}
        {snapshot.secondary&&<div className="limit-window"><span>Secondary</span><i><b style={{width:`${Math.max(2,rateLimitRemainingPercent(snapshot.secondary)??0)}%`}}/></i><strong>{rateLimitRemainingPercent(snapshot.secondary)}% left</strong><small>{formatRateReset(snapshot.secondary.resetsAt)}</small></div>}
        {snapshot.credits&&<div className="limit-meta"><span>Credits</span><strong>{snapshot.credits.unlimited?"Unlimited":snapshot.credits.balance??(snapshot.credits.hasCredits?"Available":"None")}</strong></div>}
        {snapshot.individualLimit&&<div className="limit-meta"><span>Spend control</span><strong>{snapshot.individualLimit.used} / {snapshot.individualLimit.limit}</strong><small>{snapshot.individualLimit.remainingPercent}% left · {formatRateReset(snapshot.individualLimit.resetsAt)}</small></div>}
      </div>)}</div>:<p>{codex.loading?"Loading live Codex account limits…":"This inference route did not return Codex account limits."}</p>}
      {resetCredits?.availableCount>0&&<div className="reset-credit-row"><div><strong>{resetCredits.availableCount} reset credit{resetCredits.availableCount===1?"":"s"} available</strong><span>Earned reset credits can restore an eligible Codex rate-limit window.</span></div><button onClick={()=>resetCodexLimit(resetCredits.credits?.find(item=>item.status==="available")?.id||null)} disabled={codex.loading}><RotateCcw size={12}/> Use reset credit</button></div>}
      {codexSummary&&<div className="codex-usage-kv">
        <div><span>Lifetime tokens</span><strong>{codexSummary.lifetimeTokens==null?"—":formatTokens(codexSummary.lifetimeTokens)}</strong></div>
        <div><span>Peak day</span><strong>{codexSummary.peakDailyTokens==null?"—":formatTokens(codexSummary.peakDailyTokens)}</strong></div>
        <div><span>Current streak</span><strong>{codexSummary.currentStreakDays==null?"—":codexSummary.currentStreakDays+"d"}</strong></div>
        <div><span>Longest turn</span><strong>{duration(codexSummary.longestRunningTurnSec)}</strong></div>
      </div>}
      {threadUsage&&<div className="thread-account-usage"><strong>Current thread estimate</strong><span>{formatTokens(threadUsage.groups?.reduce((sum,item)=>sum+Number(item.totalTokens||0),0)||0)} tokens · {money(microsToCurrency(threadUsage.estimatedUsageUsdMicros))} · {(Number(threadUsage.estimatedUsageCreditsMicros||0)/1_000_000).toFixed(3)} credits</span></div>}
      {codex.messages?.featureEnabled&&codex.messages.messages?.length>0&&<div className="workspace-messages"><strong>Workspace messages</strong>{codex.messages.messages.map(message=><div key={message.messageId}><span>{String(message.messageType||"notice").replaceAll("_"," ")}</span><p>{message.messageBody}</p></div>)}</div>}
      {codex.notice&&<p className="provider-note">{codex.notice}</p>}
      {Object.values(codex.errors).length>0&&<details className="capability-details"><summary>Unavailable Codex account data</summary><pre>{Object.entries(codex.errors).map(([key,value])=>`${key}: ${value}`).join("\n")}</pre></details>}
    </section>}
    {showLiveRuntime&&<section className="capability-card codex-account-usage" data-testid="runtime-account-usage">
      <div className="capability-card-head"><span><Sparkles size={15}/><strong>{runtimeLabel(agentRuntime)} subscription limits</strong></span><em>{activeEnvironmentName} · live</em></div>
      {runtimeUsage.data?.windows?.length>0?<div className="codex-limit-grid">{runtimeUsage.data.windows.map(window=>{
        const used=Math.max(0,Math.min(100,Number(window.usedPercent)||0));const remaining=Math.max(0,100-used);
        return <div className="codex-limit-card" key={window.id}><div><strong>{window.label}</strong><span>{window.kind}</span></div><div className="limit-window"><span>Usage</span><i><b style={{width:`${Math.max(2,used)}%`}}/></i><strong>{used.toFixed(used%1?1:0)}% used</strong><small>{remaining.toFixed(remaining%1?1:0)}% left{window.resetsAt?` · resets ${new Date(window.resetsAt).toLocaleString()}`:""}</small></div></div>;
      })}</div>:<p>{runtimeUsage.loading?"Loading live subscription limits…":runtimeUsage.data?.unavailable?.message||"This runtime/account does not expose subscription limits to Trebell."}</p>}
      {runtimeUsage.error&&<div className="usage-warning"><CircleAlert size={14}/><span>{runtimeUsage.error}</span></div>}
    </section>}
    <div className="usage-summary">
      <div><span>Total tokens</span><strong>{formatTokens(data.total?.totalTokens)}</strong><small>{(data.records||[]).length} recorded turns</small></div>
      <div><span>Input</span><strong>{formatTokens(data.total?.inputTokens)}</strong><small>{formatTokens(data.total?.cachedInputTokens)} cached</small></div>
      <div><span>Output</span><strong>{formatTokens(data.total?.outputTokens)}</strong><small>{formatTokens(data.total?.reasoningOutputTokens)} reasoning</small></div>
      <div><span>Cost</span><strong>{computed.known||computed.estimated?`$${computed.cost.toFixed(computed.cost<1?4:2)}`:"—"}</strong><small>{computed.known} provider · {computed.estimated} estimated</small></div>
    </div>
    <div className="usage-grid">
      <section className="capability-card"><div className="capability-card-head"><span><strong>Daily tokens</strong></span><em>{days}d</em></div><div className="usage-bars">{daily.length?daily.map(([day,value])=><div key={day}><span>{new Date(day+"T00:00:00").toLocaleDateString(undefined,{month:"short",day:"numeric"})}</span><i><b style={{width:`${Math.max(2,Number(value.tokens||0)/maxDaily*100)}%`}}/></i><strong>{formatTokens(value.tokens)}</strong></div>):<p>No recorded usage in this period.</p>}</div></section>
      <section className="capability-card"><div className="capability-card-head"><span><strong>Models</strong></span><em>{computed.models.length}</em></div><div className="usage-models">{computed.models.length?computed.models.map(([name,value])=><div key={name}><span><strong>{name}</strong><small>{runtimeLabel(value.runtime)} · {value.turns} turn{value.turns===1?"":"s"}</small></span><b>{formatTokens(value.tokens)}</b><em>{value.costEntries?`$${value.cost.toFixed(value.cost<1?4:2)}`:"—"}</em></div>):<p>No model usage recorded yet.</p>}</div></section>
    </div>
    <section className="capability-card usage-recent"><div className="capability-card-head"><span><strong>Recent turns</strong></span><em>{Math.min(100,(data.records||[]).length)}</em></div><div className="usage-table"><div className="usage-table-head"><span>When</span><span>Environment</span><span>Harness</span><span>Model</span><span>Tokens</span><span>Cost</span></div>{(data.records||[]).slice(0,100).map(record=>{const cost=estimateCost(record,settings);const environmentKey=record.environmentId||"local";return <div key={record.id}><span>{new Date(record.at).toLocaleString()}</span><span title={environmentNames[environmentKey]||environmentKey}>{environmentNames[environmentKey]||environmentKey}</span><span>{runtimeLabel(record.runtime)}</span><span title={record.model||""}>{record.model||"Unknown"}</span><span>{formatTokens(record.usage?.totalTokens)}</span><span>{cost?`${cost.estimated?"≈":""}$${cost.amount.toFixed(cost.amount<1?4:2)}`:"—"}</span></div>})}</div></section>
  </div>;
}
