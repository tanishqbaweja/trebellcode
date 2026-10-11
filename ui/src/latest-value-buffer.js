export function createLatestValueBuffer({schedule, cancel, onFlush}={}){
  if(typeof schedule!=="function"||typeof onFlush!=="function")throw new Error("createLatestValueBuffer requires schedule and onFlush");
  let pending=new Map(),handle=null,disposed=false;
  const deliver=()=>{
    handle=null;if(disposed||!pending.size)return;
    const entries=[...pending.entries()];pending=new Map();onFlush(entries);
  };
  return {
    push(key,value){
      if(disposed)return;pending.set(String(key),value);
      if(handle==null)handle=schedule(deliver);
    },
    // What waits goes out now, for a caller that needs it in place before it goes on.
    flush(){if(handle!=null)cancel?.(handle);deliver()},
    reset(){if(handle!=null)cancel?.(handle);handle=null;pending.clear()},
    dispose(){disposed=true;if(handle!=null)cancel?.(handle);handle=null;pending.clear()},
  };
}
