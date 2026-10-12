// A poll that follows the window's focus: every focusedMs while the window has focus, every blurredMs while it does not, never while
// the page is hidden, and at once when the window gets focus back or the page shows again. A window left in the background asks
// the server (and its git) a few times a minute instead of every few seconds.
export function startFocusPoll(task,{focusedMs=3500,blurredMs=30_000,runImmediately=true,documentRef=globalThis.document,windowRef=globalThis.window,setTimeoutFn=globalThis.setTimeout,clearTimeoutFn=globalThis.clearTimeout}={}){
  if(typeof task!=="function")throw new TypeError("Focus poll task must be a function");
  let disposed=false,busy=false,timer=null;
  const focused=()=>documentRef?.hasFocus?.()!==false;
  const run=async()=>{
    if(disposed||busy||documentRef?.hidden)return false;
    busy=true;
    try{await task();return true}
    finally{busy=false}
  };
  // The next run is timed from this one's start, as an interval would be, at the pace the window's focus asks for now.
  const tick=()=>{clearTimeoutFn(timer);timer=disposed?null:setTimeoutFn(tick,Math.max(250,Number(focused()?focusedMs:blurredMs)||focusedMs));run().catch(()=>{})};
  const wake=()=>{if(!documentRef?.hidden)tick()};
  if(runImmediately)tick();else timer=setTimeoutFn(tick,Math.max(250,Number(focused()?focusedMs:blurredMs)||focusedMs));
  windowRef?.addEventListener?.("focus",wake);
  documentRef?.addEventListener?.("visibilitychange",wake);
  return {
    run,
    dispose(){
      if(disposed)return;
      disposed=true;
      clearTimeoutFn(timer);timer=null;
      windowRef?.removeEventListener?.("focus",wake);
      documentRef?.removeEventListener?.("visibilitychange",wake);
    },
  };
}
