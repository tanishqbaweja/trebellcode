export function startVisibilityPoll(task,{intervalMs=1000,runImmediately=true,documentRef=globalThis.document,setIntervalFn=globalThis.setInterval,clearIntervalFn=globalThis.clearInterval}={}){
  if(typeof task!=="function")throw new TypeError("Visibility poll task must be a function");
  let disposed=false,busy=false;
  const run=async()=>{
    if(disposed||busy||documentRef?.hidden)return false;
    busy=true;
    try{await task();return true}
    finally{busy=false}
  };
  const tick=()=>{run().catch(()=>{})};
  const onVisibilityChange=()=>{if(!documentRef?.hidden)tick()};
  if(runImmediately)tick();
  const timer=setIntervalFn(tick,Math.max(250,Number(intervalMs)||1000));
  documentRef?.addEventListener?.("visibilitychange",onVisibilityChange);
  return {
    run,
    dispose(){
      if(disposed)return;
      disposed=true;
      clearIntervalFn(timer);
      documentRef?.removeEventListener?.("visibilitychange",onVisibilityChange);
    },
  };
}
