import React,{useCallback,useEffect,useState} from "react";
import { RefreshCw } from "lucide-react";
import { api } from "../api.js";

function timeLabel(value){
  const date=new Date(Number(value)||Date.now());
  return date.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"});
}

export default function RuntimeTrace({threadId=null}){
  const [items,setItems]=useState([]);
  const [error,setError]=useState("");
  const [loading,setLoading]=useState(false);
  const [runtimeFilter,setRuntimeFilter]=useState("");
  const [categoryFilter,setCategoryFilter]=useState("");
  const [timeWindow,setTimeWindow]=useState("all");
  const [runtimeOptions,setRuntimeOptions]=useState([]);
  const load=useCallback(async({silent=false}={})=>{
    if(!silent)setLoading(true);
    try{
      const params=new URLSearchParams({limit:"40"});if(threadId)params.set("threadId",threadId);
      if(runtimeFilter)params.set("runtime",runtimeFilter);
      if(categoryFilter)params.set("category",categoryFilter);
      const windowMs=timeWindow==="15m"?15*60_000:timeWindow==="1h"?60*60_000:timeWindow==="24h"?24*60*60_000:0;
      if(windowMs)params.set("after",String(Date.now()-windowMs));
      const result=await api("/api/traces?"+params.toString());
      const next=Array.isArray(result.items)?result.items:[];setItems(next);
      setRuntimeOptions(previous=>Array.from(new Set([...previous,...next.map(item=>item.runtime).filter(Boolean)])).sort());
      setError(result.journal?.lastError?.message||"");
      return true;
    }catch(loadError){
      setError(loadError?.message||String(loadError)||"Could not refresh runtime trace.");
      return false;
    }finally{if(!silent)setLoading(false)}
  },[threadId,runtimeFilter,categoryFilter,timeWindow]);

  useEffect(()=>{setRuntimeFilter("");setCategoryFilter("");setTimeWindow("all");setRuntimeOptions([])},[threadId]);

  useEffect(()=>{
    let disposed=false,busy=false;
    const tick=async()=>{if(disposed||busy||document.hidden)return;busy=true;try{await load({silent:true})}finally{busy=false}};
    load();
    const timer=setInterval(tick,3000);
    const visible=()=>{if(!document.hidden)tick()};document.addEventListener("visibilitychange",visible);
    return()=>{disposed=true;clearInterval(timer);document.removeEventListener("visibilitychange",visible)};
  },[load]);

  return <section className="runtime-trace" data-testid="runtime-trace">
    <div className="runtime-trace-head">
      <div><strong>Execution trace</strong><span>Bounded, redacted lifecycle events. Token/output deltas are intentionally excluded.</span></div>
      <button type="button" onClick={()=>load()} disabled={loading} aria-label="Refresh execution trace" title="Refresh execution trace"><RefreshCw size={11}/></button>
    </div>
    <div className="runtime-trace-filters">
      <select aria-label="Trace runtime" value={runtimeFilter} onChange={event=>setRuntimeFilter(event.target.value)}>
        <option value="">All runtimes</option>{runtimeOptions.map(runtime=><option key={runtime} value={runtime}>{runtime}</option>)}
      </select>
      <select aria-label="Trace category" value={categoryFilter} onChange={event=>setCategoryFilter(event.target.value)}>
        <option value="">All categories</option>
        {["runtime","client","policy","checkpoint","source-control","verification","budget"].map(category=><option key={category} value={category}>{category}</option>)}
      </select>
      <select aria-label="Trace time window" value={timeWindow} onChange={event=>setTimeWindow(event.target.value)}>
        <option value="all">All time</option><option value="15m">Last 15m</option><option value="1h">Last hour</option><option value="24h">Last 24h</option>
      </select>
    </div>
    {error&&<div className="runtime-trace-error" role="alert"><strong>Trace refresh failed.</strong><span>{error}{items.length?" Last valid trace is kept below.":""}</span></div>}
    <div className="runtime-trace-list">
      {items.map(item=><details className="runtime-trace-row" key={item.id}>
        <summary>
          <time>{timeLabel(item.at)}</time>
          <strong>{item.name}</strong>
          <span>{item.status||item.category||"event"}</span>
        </summary>
        <div>
          <p>{[item.runtime,item.provider,item.threadId&&("thread "+String(item.threadId).slice(0,12)),item.turnId&&("turn "+String(item.turnId).slice(0,12))].filter(Boolean).join(" · ")||"Trebell runtime event"}</p>
          {item.data&&Object.keys(item.data).length>0&&<pre>{JSON.stringify(item.data,null,2)}</pre>}
        </div>
      </details>)}
      {!items.length&&!error&&<div className="runtime-trace-empty">{loading?"Loading trace…":"No trace events for this thread yet."}</div>}
    </div>
  </section>;
}
