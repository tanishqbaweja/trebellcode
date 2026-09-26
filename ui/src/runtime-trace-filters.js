const DEFAULT_CATEGORIES=["runtime","client","policy","checkpoint","source-control","verification","budget"];

export function traceQuery({threadId=null,turnId="",runtime="",category="",timeWindow="all",now=Date.now(),limit=40}={}){
  const params=new URLSearchParams({limit:String(Math.max(1,Math.min(1000,Number(limit)||40)))});
  if(threadId)params.set("threadId",String(threadId));
  if(turnId)params.set("turnId",String(turnId));
  if(runtime)params.set("runtime",String(runtime));
  if(category)params.set("category",String(category));
  const windowMs=timeWindow==="15m"?15*60_000:timeWindow==="1h"?60*60_000:timeWindow==="24h"?24*60*60_000:0;
  if(windowMs)params.set("after",String(Number(now)-windowMs));
  return params;
}

export function mergeTraceFilterOptions(previous={},items=[]){
  const runtimes=new Set(previous.runtimes||[]);
  const categories=new Set([...(previous.categories||[]),...DEFAULT_CATEGORIES]);
  const turns=new Map((previous.turns||[]).map(item=>[item.id,item]));
  for(const item of Array.isArray(items)?items:[]){
    if(item?.runtime)runtimes.add(String(item.runtime));
    if(item?.category)categories.add(String(item.category));
    if(item?.turnId){
      const id=String(item.turnId);
      if(!turns.has(id))turns.set(id,{id,label:id.length>18?id.slice(0,12)+"…":id});
    }
  }
  return {
    runtimes:[...runtimes].sort(),
    categories:[...categories].sort(),
    turns:[...turns.values()],
  };
}
