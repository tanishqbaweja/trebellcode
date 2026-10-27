import React,{useEffect,useMemo,useRef,useState} from "react";
import { CalendarDays, CircleAlert, Cpu, History, RefreshCw, RotateCcw, Sparkles, Trash2 } from "lucide-react";
import { api } from "../api.js";
import { agentName, failureText } from "../display-labels.js";
import { codexRateLimitEntries,formatRateReset,microsToCurrency,rateLimitReachedLabel,rateLimitRemainingPercent } from "../usage-account.js";
import { estimateUsageCost } from "../usage-pricing.js";
import { askConfirm } from "../ask-dialog.js";

function formatTokens(value){const n=Number(value||0);if(n>=1_000_000)return (n/1_000_000).toFixed(n>=10_000_000?1:2)+"M";if(n>=1_000)return (n/1_000).toFixed(n>=100_000?0:1)+"K";return n.toLocaleString()}
function runtimeLabel(value){return value?agentName(value):"Unknown"}
function money(value){return Number.isFinite(value)?`$${value.toFixed(value<1?4:2)}`:"—"}
function duration(value){const seconds=Number(value);if(!Number.isFinite(seconds)||seconds<0)return "—";if(seconds<60)return Math.round(seconds)+"s";const mins=Math.round(seconds/60);return mins<60?mins+"m":Math.floor(mins/60)+"h "+(mins%60)+"m"}
function withoutKey(object,key){return Object.fromEntries(Object.entries(object||{}).filter(([name])=>name!==key))}
// Meter tone from the remaining share: the bar turns warning at 25% left and critical at 10% left.
function meterTone(remaining){const value=Number(remaining);if(remaining==null||!Number.isFinite(value))return "";return value<=10?" critical":value<=25?" low":""}
// What each live Codex read loads, so a failed one is listed by what could not be loaded rather than by its request key.
const CODEX_READS={account:"Could not load the Codex account",rateLimits:"Could not load Codex rate limits",usage:"Could not load Codex usage",messages:"Could not load workspace messages"};
const SUBSCRIPTION_RUNTIMES=["claude","opencode","cursor","grok","muse"];

export default function UsagePage({settings={},rpc=null,rpcStatus="disconnected",activeThread=null,agentRuntime="codex"}){
  // Each read starts out loading, as it runs when the page opens: nothing claims a period or an account is empty before it answers.
  // `shownQuery` is the period and environments the latest usage read answered: null until one loads, and again once a read
  // fails, so a failed refresh leaves no empty-period claim or zero total beside its alert (rows it kept still show).
  const [days,setDays]=useState(30);const [data,setData]=useState({records:[],total:{},models:{},runtimes:{},daily:{}});const [loading,setLoading]=useState(true);const [error,setError]=useState("");
  const [shownQuery,setShownQuery]=useState(null);const usageRequest=useRef(0);
  const [clearing,setClearing]=useState(false);
  const [codex,setCodex]=useState(()=>({account:null,rateLimits:null,usage:null,messages:null,errors:{},loading:agentRuntime==="codex"&&Boolean(rpc)&&rpcStatus==="connected",notice:"",failure:"",unknownReset:null,answered:false}));
  const [runtimeUsage,setRuntimeUsage]=useState(()=>({data:null,loading:SUBSCRIPTION_RUNTIMES.includes(agentRuntime),error:""}));
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
  // `keep`: a read the person did not ask for (Codex connected again, another thread, a harness switched back) keeps what the last Use
  // reset credit came to, its notice or its failure, until Refresh, Clear local history or another Use reset credit. A reset whose
  // harness dropped on the way fails while the card is hidden for Codex connecting again, and still says so once it is back.
  // unknownReset: a reset sent that no answer came for (the harness dropped, or did not answer in time) may have been used all the
  // same. The card says it cannot tell until a read of the limits shows whether that credit is still there: then it says the credit
  // could not be used, or that it was.
  async function refreshCodex({keep=false}={}){
    // `answered` is false until a read on the current connection completes: the card mounts as Codex connects, a render before
    // this read starts, and must not claim the route returned no limits then.
    if(agentRuntime!=="codex"||!rpc||rpcStatus!=="connected"){setCodex(current=>({...current,account:null,rateLimits:null,usage:null,messages:null,errors:{},loading:false,answered:false}));return}
    setCodex(current=>({...current,loading:true,errors:{},...(keep?null:{notice:"",failure:""})}));
    const requests=[
      ["account",()=>rpc.request("account/read",{refreshToken:false})],
      ["rateLimits",()=>rpc.request("account/rateLimits/read",{excludeResetCreditDetails:false})],
      ["usage",()=>rpc.request("account/usage/read",activeThread?.id?{threadId:activeThread.id}:{})],
      ["messages",()=>rpc.request("account/workspaceMessages/read",{})],
    ];
    const results=await Promise.all(requests.map(async([key,run])=>{try{return [key,await run(),null]}catch(err){return [key,null,err?.message||String(err)]}}));
    setCodex(current=>{
      const next={...current,errors:{},loading:false,notice:keep?current.notice:"",answered:true};
      for(const [key,value,failure] of results){
        if(failure)next.errors[key]=failure;
        else next[key]=value;
      }
      const tried=current.unknownReset,credits=next.errors.rateLimits?null:next.rateLimits?.rateLimitResetCredits;
      if(tried&&credits){
        const unused=tried.creditId?(credits.credits||[]).some(item=>item.id===tried.creditId&&item.status==="available"):tried.available>0&&Number(credits.availableCount)>=tried.available;
        next.unknownReset=null;
        if(unused)next.failure=failureText("Could not use the reset credit",tried.error);else{next.failure="";next.notice="The reset credit was used."}
      }
      return next;
    });
  }
  const usageQuery=days+"|"+selectedEnvironments.join("|");
  async function refreshLocal(){
    // Only the latest read lands, so an earlier period's answer never replaces the one asked for last or ends its wait.
    const request=++usageRequest.current,query=usageQuery;
    setLoading(true);setError("");
    try{
      const params=new URLSearchParams({days:String(days),limit:"5000"});
      for(const id of selectedEnvironments)params.append("environmentId",id);
      const next=await api("/api/usage?"+params.toString());
      if(request===usageRequest.current){setData(next);setShownQuery(query)}
    }catch(err){if(request===usageRequest.current){setError(failureText("Could not load usage",err));setShownQuery(null)}}
    finally{if(request===usageRequest.current)setLoading(false)}
  }
  async function refreshRuntimeUsage(){
    if(!SUBSCRIPTION_RUNTIMES.includes(agentRuntime)){setRuntimeUsage({data:null,loading:false,error:""});return}
    setRuntimeUsage(current=>({...current,loading:true,error:""}));
    try{setRuntimeUsage({data:await api("/api/agent-runtime-usage"),loading:false,error:""})}
    catch(err){setRuntimeUsage(current=>({...current,loading:false,error:failureText("Could not load subscription limits",err)}))}
  }
  async function refreshEnvironments(){
    setEnvironmentError("");
    try{
      const next=await api("/api/environments");
      setEnvironmentData(next);return next;
    }catch(err){
      setEnvironmentError(failureText("Could not refresh environments",err));
      return null;
    }
  }
  async function refresh(){await Promise.all([refreshLocal(),refreshCodex(),refreshRuntimeUsage(),refreshEnvironments()])}
  useEffect(()=>{refreshLocal()},[days,selectedEnvironments.join("|")]);
  useEffect(()=>{refreshCodex({keep:true})},[rpc,rpcStatus,activeThread?.id,agentRuntime]);
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
  // The environment filter is a <details> popover: Escape or a click anywhere outside it closes it, including the toolbar's
  // own Refresh, period and Clear controls, so the menu never stays open over the result of one of them.
  const filterRef=useRef(null);
  useEffect(()=>{
    const onPointer=event=>{const node=filterRef.current;if(!node?.open)return;if(node.contains(event.target))return;node.open=false};
    const onKey=event=>{const node=filterRef.current;if(event.key!=="Escape"||!node?.open)return;node.open=false;node.querySelector("summary")?.focus()};
    document.addEventListener("pointerdown",onPointer);document.addEventListener("keydown",onKey);
    return()=>{document.removeEventListener("pointerdown",onPointer);document.removeEventListener("keydown",onKey)};
  },[]);
  const computed=useMemo(()=>{
    let cost=0,known=0,estimated=0;const modelMap={};
    for(const record of data.records||[]){const item=estimateUsageCost(record,settings);if(item){cost+=item.amount;item.estimated?estimated++:known++}const key=record.model||"Unknown model";const bucket=modelMap[key]||(modelMap[key]={tokens:0,turns:0,cost:0,costEntries:0,runtime:record.runtime});bucket.tokens+=Number(record.usage?.totalTokens||0);bucket.turns++;if(item){bucket.cost+=item.amount;bucket.costEntries++}}
    return {cost,known,estimated,models:Object.entries(modelMap).sort((a,b)=>b[1].tokens-a[1].tokens)};
  },[data,settings]);
  // Daily bars count the viewer's own calendar days, the clock the Recent turns times use. The server's daily map is keyed
  // by UTC date, which put a turn made just after local midnight (east of UTC) on the day before.
  const daily=useMemo(()=>{
    const days={};
    for(const record of data.records||[]){
      const at=new Date(record.at);if(Number.isNaN(at.getTime()))continue;
      const key=at.getFullYear()+"-"+String(at.getMonth()+1).padStart(2,"0")+"-"+String(at.getDate()).padStart(2,"0");
      (days[key]||(days[key]={tokens:0})).tokens+=Number(record.usage?.totalTokens||0);
    }
    return Object.entries(days).sort((a,b)=>a[0].localeCompare(b[0]));
  },[data.records]);
  const maxDaily=Math.max(1,...daily.map(([,value])=>Number(value.tokens||0)));
  async function clear(){
    if(!await askConfirm("Clear Trebell's locally recorded usage history? Provider account usage is not affected.",{confirm:"Clear history"}))return;
    setClearing(true);setError("");
    try{
      await api("/api/usage",{method:"DELETE"});
      // The history is gone once the delete succeeds, so its rows leave the page now: a reload that then fails shows its alert beside
      // no rows (and, as no answer is current, no empty-period claim) rather than beside the turns just deleted.
      setData({records:[],total:{},models:{},runtimes:{},daily:{}});setShownQuery(null);
      await refresh();
    }catch(err){setError(failureText("Could not clear local usage history",err))}
    finally{setClearing(false)}
  }
  async function resetCodexLimit(creditId=null){
    if(!rpc||!await askConfirm("Use one earned Codex reset credit now? This can reset an eligible rate-limit window.",{confirm:"Use reset credit",tone:"primary"}))return;
    const tried={creditId:creditId||null,available:Number(codex.rateLimits?.rateLimitResetCredits?.availableCount)||0};
    setCodex(current=>({...current,loading:true,notice:"",failure:"",unknownReset:null}));
    try{
      const result=await rpc.request("account/rateLimitResetCredit/consume",{idempotencyKey:crypto.randomUUID(),creditId:creditId||null});
      const labels={reset:"Rate-limit window reset.",nothingToReset:"No current window is eligible for a reset.",noCredit:"No reset credit is available.",alreadyRedeemed:"That reset was already completed."};
      await refreshCodex();
      setCodex(current=>({...current,notice:labels[result?.outcome]||String(result?.outcome||"Reset request completed.")}));
    }catch(err){
      // Codex refused it (its answer is the reason), or no answer came: then the credit may have been used all the same.
      if(err?.trebellRpcResponse)setCodex(current=>({...current,loading:false,failure:failureText("Could not use the reset credit",err)}));
      else setCodex(current=>({...current,loading:false,failure:failureText("Could not tell whether the reset credit was used",err),unknownReset:{...tried,error:err}}));
    }
  }
  const codexLimits=codexRateLimitEntries(codex.rateLimits);
  const codexSummary=codex.usage?.summary||null;
  const threadUsage=codex.usage?.threadUsage||null;
  const resetCredits=codex.rateLimits?.rateLimitResetCredits||null;
  const showLiveCodex=agentRuntime==="codex"&&rpcStatus==="connected"&&(selectedEnvironments.length===0||selectedEnvironments.includes(activeEnvironmentKey));
  const showLiveRuntime=SUBSCRIPTION_RUNTIMES.includes(agentRuntime)&&(selectedEnvironments.length===0||selectedEnvironments.includes(activeEnvironmentKey));
  // The page speaks for recorded usage it has rows for, or for an answer to the period and environments now selected with nothing
  // newer loading. Otherwise (loading, or a failed read) the totals read "—" and no card says the period is empty.
  const records=data.records||[];
  // Clear local history clears every turn Trebell holds, not only the shown period's and environments' (storedTurns counts them
  // all), so it is offered while any is held.
  const held=records.length||data.storedTurns;
  const usageCurrent=!loading&&shownQuery===usageQuery,usageKnown=records.length>0||usageCurrent,usagePending=loading?"Loading…":"Unavailable";
  return <div className="usage-page">
    <div className="capabilities-toolbar"><div><h2>Usage</h2><p>Per-turn token and cost history across Trebell harnesses and environments, plus live account limits when the active harness exposes them.</p></div><div className="usage-toolbar"><details className="usage-environment-filter" ref={filterRef}><summary>{environmentFilterLabel}</summary><div><button onClick={()=>setSelectedEnvironments([])} className={selectedEnvironments.length===0?"active":""}>All environments</button>{environmentOptions.map(item=><label key={item.id}><input type="checkbox" checked={selectedEnvironments.includes(item.id)} onChange={()=>toggleEnvironment(item.id)}/><span>{item.name}</span><em>{item.type}</em></label>)}</div></details><select aria-label="Period" value={days} onChange={e=>setDays(Number(e.target.value))}><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option><option value={365}>1 year</option></select><button className="usage-refresh" onClick={refresh} disabled={loading||codex.loading||runtimeUsage.loading||clearing}><RefreshCw size={13}/>{loading||codex.loading||runtimeUsage.loading?"Refreshing…":"Refresh"}</button><button className="usage-clear" onClick={clear} disabled={!held||clearing}><Trash2 size={13}/> {clearing?"Clearing…":"Clear local history"}</button></div></div>
    {error&&<div className="inline-error" role="alert">{error}</div>}
    {environmentError&&<div className="inline-error" role="alert">{environmentError}</div>}
    {showLiveCodex&&<section className="capability-card codex-account-usage" data-testid="codex-account-usage">
      <div className="capability-card-head"><span><Sparkles size={15}/><strong>Codex account & limits</strong></span><em>{activeEnvironmentName} · {codex.account?.account?.planType||codex.rateLimits?.rateLimits?.planType||"live"}</em></div>
      {codex.account?.account?.email&&<p className="codex-account-line">{codex.account.account.email}</p>}
      {codex.rateLimits?.ordinaryUsageAllowed===false&&<div className="usage-warning"><CircleAlert size={14}/><span>Ordinary included usage is currently blocked by the account backend.</span></div>}
      {codexLimits.length>0?<div className="codex-limit-grid">{codexLimits.map(({id,label,snapshot})=><div className="codex-limit-card" key={id}>
        <div><strong>{label}</strong>{snapshot.rateLimitReachedType&&<span className="limit-reached">{rateLimitReachedLabel(snapshot.rateLimitReachedType)}</span>}</div>
        {snapshot.primary&&<div className={"limit-window"+meterTone(rateLimitRemainingPercent(snapshot.primary))}><span>Primary</span><i><b style={{width:`${Math.max(2,rateLimitRemainingPercent(snapshot.primary)??0)}%`}}/></i><strong>{rateLimitRemainingPercent(snapshot.primary)}% left</strong><small>{formatRateReset(snapshot.primary.resetsAt)}</small></div>}
        {snapshot.secondary&&<div className={"limit-window"+meterTone(rateLimitRemainingPercent(snapshot.secondary))}><span>Secondary</span><i><b style={{width:`${Math.max(2,rateLimitRemainingPercent(snapshot.secondary)??0)}%`}}/></i><strong>{rateLimitRemainingPercent(snapshot.secondary)}% left</strong><small>{formatRateReset(snapshot.secondary.resetsAt)}</small></div>}
        {snapshot.credits&&<div className="limit-meta"><span>Credits</span><strong>{snapshot.credits.unlimited?"Unlimited":snapshot.credits.balance??(snapshot.credits.hasCredits?"Available":"None")}</strong></div>}
        {snapshot.individualLimit&&<div className="limit-meta"><span>Spend control</span><strong>{snapshot.individualLimit.used} / {snapshot.individualLimit.limit}</strong><small>{snapshot.individualLimit.remainingPercent}% left · {formatRateReset(snapshot.individualLimit.resetsAt)}</small></div>}
      </div>)}</div>:codex.loading||!codex.answered?<p aria-busy="true">Loading live Codex account limits…</p>:!codex.errors.rateLimits&&<p>This inference route did not return Codex account limits.</p>}
      {resetCredits?.availableCount>0&&<div className="reset-credit-row"><div><strong>{resetCredits.availableCount} reset credit{resetCredits.availableCount===1?"":"s"} available</strong><span>Earned reset credits can restore an eligible Codex rate-limit window.</span></div><button onClick={()=>resetCodexLimit(resetCredits.credits?.find(item=>item.status==="available")?.id||null)} disabled={codex.loading}><RotateCcw size={12}/> Use reset credit</button></div>}
      {codex.failure&&<div className="inline-error" role="alert">{codex.failure}</div>}
      {codexSummary&&<div className="codex-usage-kv">
        <div><span>Lifetime tokens</span><strong>{codexSummary.lifetimeTokens==null?"—":formatTokens(codexSummary.lifetimeTokens)}</strong></div>
        <div><span>Peak day</span><strong>{codexSummary.peakDailyTokens==null?"—":formatTokens(codexSummary.peakDailyTokens)}</strong></div>
        <div><span>Current streak</span><strong>{codexSummary.currentStreakDays==null?"—":codexSummary.currentStreakDays+"d"}</strong></div>
        <div><span>Longest turn</span><strong>{duration(codexSummary.longestRunningTurnSec)}</strong></div>
      </div>}
      {threadUsage&&<div className="thread-account-usage"><strong>Current thread estimate</strong><span>{formatTokens(threadUsage.groups?.reduce((sum,item)=>sum+Number(item.totalTokens||0),0)||0)} tokens · {money(microsToCurrency(threadUsage.estimatedUsageUsdMicros))} · {(Number(threadUsage.estimatedUsageCreditsMicros||0)/1_000_000).toFixed(3)} credits</span></div>}
      {codex.messages?.featureEnabled&&codex.messages.messages?.length>0&&<div className="workspace-messages"><strong>Workspace messages</strong>{codex.messages.messages.map(message=><div key={message.messageId}><span>{String(message.messageType||"notice").replaceAll("_"," ")}</span><p>{message.messageBody}</p></div>)}</div>}
      {codex.notice&&<p className="provider-note">{codex.notice}</p>}
      {Object.values(codex.errors).length>0&&<details className="capability-details"><summary>Unavailable Codex account data</summary><pre>{Object.entries(codex.errors).map(([key,value])=>failureText(CODEX_READS[key]||"Could not load "+key,value)).join("\n")}</pre></details>}
    </section>}
    {showLiveRuntime&&<section className="capability-card codex-account-usage" data-testid="runtime-account-usage">
      <div className="capability-card-head"><span><Sparkles size={15}/><strong>{runtimeLabel(agentRuntime)} subscription limits</strong></span><em>{activeEnvironmentName}{runtimeUsage.data?.account?.email?" · "+runtimeUsage.data.account.email:""}{/* Windows a harness reported with a turn (Muse Code's) say when that was, not live, and nothing before a report. */}{runtimeUsage.data?.observedAt?" · observed "+new Date(runtimeUsage.data.observedAt).toLocaleString():runtimeUsage.data?.unavailable?.reason==="notObserved"?"":" · live"}</em></div>
      {/* Windows already read stay beside a failed refresh; a claim that there are none, or none exposed, does not. */}
      {runtimeUsage.data?.windows?.length>0?<div className="codex-limit-grid">{runtimeUsage.data.windows.map(window=>{
        const used=Math.max(0,Math.min(100,Number(window.usedPercent)||0));const remaining=Math.max(0,100-used);
        return <div className="codex-limit-card" key={window.id}><div><strong>{window.label}</strong><span>{window.kind}</span></div><div className={"limit-window"+meterTone(remaining)}><span>Usage</span><i><b style={{width:`${Math.max(2,used)}%`}}/></i><strong>{used.toFixed(used%1?1:0)}% used</strong><small>{remaining.toFixed(remaining%1?1:0)}% left{window.resetsAt?` · resets ${new Date(window.resetsAt).toLocaleString()}`:""}</small></div></div>;
      })}</div>:runtimeUsage.loading?<p aria-busy="true">Loading live subscription limits…</p>:runtimeUsage.data&&!runtimeUsage.error&&<p>{runtimeUsage.data.unavailable?.message||(!runtimeUsage.data.unavailable&&!runtimeUsage.data.error?"Nothing is metered for this account in the current period yet.":"This runtime/account does not expose subscription limits to Trebell.")}</p>}
      {runtimeUsage.error&&<div className="usage-warning"><CircleAlert size={14}/><span>{runtimeUsage.error}</span></div>}
    </section>}
    <div className="usage-summary">
      <div><span>Total tokens</span><strong className={usageKnown?undefined:"usage-stat-muted"}>{usageKnown?formatTokens(data.total?.totalTokens):"—"}</strong><small>{usageKnown?`${records.length} recorded turn${records.length===1?"":"s"}`:usagePending}</small></div>
      <div><span>Input</span><strong className={usageKnown?undefined:"usage-stat-muted"}>{usageKnown?formatTokens(data.total?.inputTokens):"—"}</strong><small>{usageKnown?`${formatTokens(data.total?.cachedInputTokens)} cache read · ${formatTokens(data.total?.cacheWriteInputTokens)} cache write`:usagePending}</small></div>
      <div><span>Output</span><strong className={usageKnown?undefined:"usage-stat-muted"}>{usageKnown?formatTokens(data.total?.outputTokens):"—"}</strong><small>{usageKnown?`${formatTokens(data.total?.reasoningOutputTokens)} reasoning`:usagePending}</small></div>
      <div><span>Cost</span><strong className={usageKnown&&(computed.known||computed.estimated||!records.length)?undefined:"usage-stat-muted"} title={!usageKnown||computed.known||computed.estimated||!records.length?undefined:"No recorded turn reported or estimated a cost"}>{!usageKnown?"—":computed.known||computed.estimated?`$${computed.cost.toFixed(computed.cost<1?4:2)}`:records.length?"—":"$0.00"}</strong><small>{usageKnown?`${computed.known} provider · ${computed.estimated} estimated`:usagePending}</small></div>
    </div>
    <div className="usage-grid">
      <section className="capability-card"><div className="capability-card-head"><span><CalendarDays size={15} aria-hidden="true"/><strong>Daily tokens</strong></span><em>{days}d</em></div><div className="usage-bars">{daily.length?daily.map(([day,value])=><div key={day}><span>{new Date(day+"T00:00:00").toLocaleDateString(undefined,{month:"short",day:"numeric"})}</span><i><b style={{width:`${Math.max(2,Number(value.tokens||0)/maxDaily*100)}%`}}/></i><strong>{formatTokens(value.tokens)}</strong></div>):usageCurrent?<p>No recorded usage in this period.</p>:loading&&<p aria-busy="true">Loading daily usage…</p>}</div></section>
      <section className="capability-card"><div className="capability-card-head"><span><Cpu size={15} aria-hidden="true"/><strong>Models</strong></span>{usageKnown&&<em>{computed.models.length}</em>}</div><div className="usage-models">{computed.models.length?computed.models.map(([name,value])=><div key={name}><span><strong>{name}</strong><small>{runtimeLabel(value.runtime)} · {value.turns} turn{value.turns===1?"":"s"}</small></span><b>{formatTokens(value.tokens)}</b><em>{value.costEntries?`$${value.cost.toFixed(value.cost<1?4:2)}`:"—"}</em></div>):usageCurrent?<p>No model usage in this period.</p>:loading&&<p aria-busy="true">Loading model usage…</p>}</div></section>
    </div>
    <section className="capability-card usage-recent"><div className="capability-card-head"><span><History size={15} aria-hidden="true"/><strong>Recent turns</strong></span>{usageKnown&&<em>{Math.min(100,records.length)}</em>}</div><div className="usage-table"><div className="usage-table-head"><span>When</span><span>Environment</span><span>Harness</span><span>Model</span><span>Tokens</span><span>Cost</span></div>{records.slice(0,100).map(record=>{const cost=estimateUsageCost(record,settings);const environmentKey=record.environmentId||"local";return <div key={record.id}><span title={new Date(record.at).toLocaleString()}>{new Date(record.at).toLocaleString(undefined,{dateStyle:"short",timeStyle:"short"})}</span><span title={environmentNames[environmentKey]||environmentKey}>{environmentNames[environmentKey]||environmentKey}</span><span>{runtimeLabel(record.runtime)}</span><span title={record.model||""}>{record.model||"Unknown"}</span><span>{formatTokens(record.usage?.totalTokens)}</span><span>{cost?`${cost.estimated?"≈":""}$${cost.amount.toFixed(cost.amount<1?4:2)}`:"—"}</span></div>})}{!records.length&&(loading||usageCurrent)&&<p className="usage-table-empty" aria-busy={loading||undefined}>{loading?"Loading recorded turns…":"No turns recorded in this period."}</p>}</div></section>
  </div>;
}
