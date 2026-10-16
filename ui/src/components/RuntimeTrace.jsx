import React,{useCallback,useEffect,useRef,useState} from "react";
import { RefreshCw } from "lucide-react";
import { api } from "../api.js";
import { mergeTraceFilterOptions, traceQuery } from "../runtime-trace-filters.js";

function timeLabel(value){
  const date=new Date(Number(value)||Date.now());
  return date.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"});
}

export default function RuntimeTrace({threadId=null}){
  const [items,setItems]=useState([]);
  const [error,setError]=useState("");
  const [loading,setLoading]=useState(false);
  const [turnFilter,setTurnFilter]=useState("");
  const [runtimeFilter,setRuntimeFilter]=useState("");
  const [categoryFilter,setCategoryFilter]=useState("");
  const [timeWindow,setTimeWindow]=useState("all");
  const [filterOptions,setFilterOptions]=useState({runtimes:[],categories:[],turns:[]});
  // Each thread has a trace of its own (App keys it by thread). Only an answer for the filters still chosen lands: one asked
  // before they changed neither lists its events nor ends the loading of the one asked after.
  const view=useRef(0);
  const load=useCallback(async({silent=false}={})=>{
    const asked=view.current;
    if(!silent)setLoading(true);
    try{
      const params=traceQuery({threadId,turnId:turnFilter,runtime:runtimeFilter,category:categoryFilter,timeWindow,limit:40});
      const result=await api("/api/traces?"+params.toString());
      if(asked!==view.current)return false;
      const next=Array.isArray(result.items)?result.items:[];setItems(next);
      setFilterOptions(previous=>mergeTraceFilterOptions(previous,next));
      setError(result.journal?.lastError?.message||"");
      return true;
    }catch(loadError){
      if(asked===view.current)setError(loadError?.message||String(loadError)||"Could not refresh runtime trace.");
      return false;
    }finally{if(!silent&&asked===view.current)setLoading(false)}
  },[threadId,turnFilter,runtimeFilter,categoryFilter,timeWindow]);

  useEffect(()=>{
    let disposed=false,busy=false;
    const tick=async()=>{if(disposed||busy||document.hidden)return;busy=true;try{await load({silent:true})}finally{busy=false}};
    load();
    const timer=setInterval(tick,3000);
    const visible=()=>{if(!document.hidden)tick()};document.addEventListener("visibilitychange",visible);
    return()=>{disposed=true;view.current++;clearInterval(timer);document.removeEventListener("visibilitychange",visible)};
  },[load]);

  return <section className="runtime-trace" data-testid="runtime-trace">
    <div className="runtime-trace-head">
      <div><strong>Execution trace</strong><span>Bounded, redacted lifecycle events. Token/output deltas are intentionally excluded.</span></div>
      <button type="button" onClick={()=>load()} disabled={loading} aria-label="Refresh execution trace" title="Refresh execution trace"><RefreshCw size={11}/></button>
    </div>
    <div className="runtime-trace-filters">
      <select aria-label="Trace turn" value={turnFilter} onChange={event=>setTurnFilter(event.target.value)}>
        <option value="">All turns</option>{filterOptions.turns.map(turn=><option key={turn.id} value={turn.id}>{turn.label}</option>)}
      </select>
      <select aria-label="Trace runtime" value={runtimeFilter} onChange={event=>setRuntimeFilter(event.target.value)}>
        <option value="">All runtimes</option>{filterOptions.runtimes.map(runtime=><option key={runtime} value={runtime}>{runtime}</option>)}
      </select>
      <select aria-label="Trace category" value={categoryFilter} onChange={event=>setCategoryFilter(event.target.value)}>
        <option value="">All categories</option>
        {filterOptions.categories.map(category=><option key={category} value={category}>{category}</option>)}
      </select>
      <select aria-label="Trace time window" value={timeWindow} onChange={event=>setTimeWindow(event.target.value)}>
        <option value="all">All time</option><option value="15m">Last 15m</option><option value="1h">Last hour</option><option value="24h">Last 24h</option>
      </select>
    </div>
    {error&&<div className="runtime-trace-error" role="alert"><strong>Trace refresh failed.</strong><span>{/[.!?]$/.test(String(error).trim())?error:error+"."}{items.length?" Last valid trace is kept below.":""}</span></div>}
    <div className="runtime-trace-list">
      {items.map(item=><details className="runtime-trace-row" key={item.id}>
        <summary>
          <time>{timeLabel(item.at)}</time>
          <strong>{item.name}</strong>
          <span data-status={String(item.status||"").toLowerCase()||undefined}>{item.status||item.category||"event"}</span>
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
