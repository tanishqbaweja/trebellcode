function enabled(value){return ["1","true","yes","on"].includes(String(value||"").trim().toLowerCase())}
function boundedInteger(value,fallback,min,max){
  const number=Math.trunc(Number(value));return Number.isFinite(number)?Math.max(min,Math.min(max,number)):fallback;
}

export function createLiveSmokeGuard({
  env=process.env,argv=process.argv.slice(2),provider="unknown",model="unknown",runtime="unknown",maxTurns=1,timeoutMs=120_000,
}={}){
  const explicit=enabled(env.TREBELL_LIVE_SMOKE)||(Array.isArray(argv)&&argv.includes("--live"));
  if(!explicit)throw new Error("Live smoke tests are disabled by default. Re-run with --live or TREBELL_LIVE_SMOKE=1.");
  const declaredTurns=boundedInteger(maxTurns,1,1,20);
  const wallTime=boundedInteger(env.TREBELL_LIVE_SMOKE_TIMEOUT_MS,timeoutMs,15_000,600_000);
  const startedAt=Date.now();let usedTurns=0;
  function consumeTurn(label="model turn"){
    if(usedTurns>=declaredTurns)throw new Error("Live smoke turn budget exhausted ("+usedTurns+"/"+declaredTurns+") before "+label+".");
    usedTurns++;return {usedTurns,remainingTurns:declaredTurns-usedTurns};
  }
  async function withTimeout(value,label="live smoke operation"){
    const remaining=Math.max(1,wallTime-(Date.now()-startedAt));
    let timer;try{
      return await Promise.race([
        Promise.resolve(value),
        new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(label+" exceeded the live smoke wall-time budget of "+wallTime+"ms.")),remaining)}),
      ]);
    }finally{if(timer)clearTimeout(timer)}
  }
  function fingerprint(extra={}){
    return {
      live:true,provider:String(provider),model:String(model),runtime:String(runtime),
      maxTurns:declaredTurns,usedTurns,timeoutMs:wallTime,
      node:process.version,platform:process.platform,arch:process.arch,
      startedAt:new Date(startedAt).toISOString(),...extra,
    };
  }
  return {consumeTurn,withTimeout,fingerprint,maxTurns:declaredTurns,timeoutMs:wallTime,get usedTurns(){return usedTurns}};
}
