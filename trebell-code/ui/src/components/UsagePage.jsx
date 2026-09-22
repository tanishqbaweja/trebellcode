import React,{useEffect,useMemo,useState} from "react";
import { RefreshCw, Trash2 } from "lucide-react";
import { api } from "../api.js";

function formatTokens(value){const n=Number(value||0);if(n>=1_000_000)return (n/1_000_000).toFixed(n>=10_000_000?1:2)+"M";if(n>=1_000)return (n/1_000).toFixed(n>=100_000?0:1)+"K";return n.toLocaleString()}
function estimateCost(record,settings){
  if(record.cost?.currency==="USD"&&Number.isFinite(Number(record.cost.amount)))return {amount:Number(record.cost.amount),estimated:false};
  const price=(settings.customModels||[]).find(item=>item.id===record.model&&item.runtime===record.runtime&&(record.runtime!=="codex"||item.provider===record.provider));if(!price)return null;
  const usage=record.usage||{};const rate=key=>price[key]==null?0:Number(price[key])||0;
  const amount=(Number(usage.inputTokens||0)*rate("inputPrice")+Number(usage.outputTokens||0)*rate("outputPrice")+Number(usage.cachedInputTokens||0)*rate("cacheReadPrice")+Number(usage.cacheWriteInputTokens||0)*rate("cacheWritePrice"))/1_000_000;
  return {amount,estimated:true};
}
function runtimeLabel(value){return ({codex:"Codex",claude:"Claude Code",opencode:"OpenCode",cursor:"Cursor",grok:"Grok Build",antigravity:"Antigravity"}[value]||value||"Unknown")}

export default function UsagePage({settings={}}){
  const [days,setDays]=useState(30);const [data,setData]=useState({records:[],total:{},models:{},runtimes:{},daily:{}});const [loading,setLoading]=useState(false);const [error,setError]=useState("");
  async function refresh(){setLoading(true);setError("");try{setData(await api(`/api/usage?days=${days}&limit=5000`))}catch(err){setError(err.message)}finally{setLoading(false)}}
  useEffect(()=>{refresh()},[days]);
  const computed=useMemo(()=>{
    let cost=0,known=0,estimated=0;const modelMap={};
    for(const record of data.records||[]){const item=estimateCost(record,settings);if(item){cost+=item.amount;item.estimated?estimated++:known++}const key=record.model||"Unknown model";const bucket=modelMap[key]||(modelMap[key]={tokens:0,turns:0,cost:0,costEntries:0,runtime:record.runtime});bucket.tokens+=Number(record.usage?.totalTokens||0);bucket.turns++;if(item){bucket.cost+=item.amount;bucket.costEntries++}}
    return {cost,known,estimated,models:Object.entries(modelMap).sort((a,b)=>b[1].tokens-a[1].tokens)};
  },[data,settings]);
  const daily=Object.entries(data.daily||{}).sort((a,b)=>a[0].localeCompare(b[0]));const maxDaily=Math.max(1,...daily.map(([,value])=>Number(value.tokens||0)));
  async function clear(){if(!confirm("Clear Trebell's locally recorded usage history? Provider account usage is not affected."))return;await api("/api/usage",{method:"DELETE"});await refresh()}
  return <div className="usage-page">
    <div className="capabilities-toolbar"><div><h2>Usage</h2><p>Local per-turn token and cost history across Trebell harnesses. Provider-reported cost wins; custom-model prices are marked as estimates.</p></div><div className="usage-toolbar"><select value={days} onChange={e=>setDays(Number(e.target.value))}><option value={7}>7 days</option><option value={30}>30 days</option><option value={90}>90 days</option><option value={365}>1 year</option></select><button onClick={refresh} disabled={loading}><RefreshCw size={13}/>{loading?"Refreshing…":"Refresh"}</button><button onClick={clear} disabled={!data.records?.length}><Trash2 size={13}/> Clear local history</button></div></div>
    {error&&<div className="inline-error">{error}</div>}
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
    <section className="capability-card usage-recent"><div className="capability-card-head"><span><strong>Recent turns</strong></span><em>{Math.min(100,(data.records||[]).length)}</em></div><div className="usage-table"><div className="usage-table-head"><span>When</span><span>Harness</span><span>Model</span><span>Tokens</span><span>Cost</span></div>{(data.records||[]).slice(0,100).map(record=>{const cost=estimateCost(record,settings);return <div key={record.id}><span>{new Date(record.at).toLocaleString()}</span><span>{runtimeLabel(record.runtime)}</span><span title={record.model||""}>{record.model||"Unknown"}</span><span>{formatTokens(record.usage?.totalTokens)}</span><span>{cost?`${cost.estimated?"≈":""}$${cost.amount.toFixed(cost.amount<1?4:2)}`:"—"}</span></div>})}</div></section>
  </div>;
}
