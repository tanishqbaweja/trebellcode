export function createTextFrameBuffer({schedule,cancel,onFlush}={}){
  const scheduleFn=schedule||((callback)=>setTimeout(callback,0));
  const cancelFn=cancel||((handle)=>clearTimeout(handle));
  let buffered="",handle=null,disposed=false;
  const flush=()=>{
    handle=null;
    if(disposed||!buffered)return;
    const value=buffered;buffered="";
    onFlush?.(value);
  };
  return {
    push(value){
      if(disposed)return;
      const text=String(value||"");if(!text)return;
      buffered+=text;
      if(handle==null)handle=scheduleFn(flush);
    },
    flush,
    reset(){
      buffered="";
      if(handle!=null){cancelFn(handle);handle=null}
    },
    dispose(){
      disposed=true;
      buffered="";
      if(handle!=null){cancelFn(handle);handle=null}
    },
    pending(){return buffered},
  };
}

export function createKeyedTextFrameBuffer({schedule,cancel,onFlush}={}){
  const scheduleFn=schedule||((callback)=>setTimeout(callback,0));
  const cancelFn=cancel||((handle)=>clearTimeout(handle));
  const buffered=new Map();let handle=null,disposed=false;
  const flush=()=>{
    handle=null;
    if(disposed||!buffered.size)return;
    const entries=[...buffered.entries()];buffered.clear();
    onFlush?.(entries);
  };
  return {
    push(key,value){
      if(disposed)return;
      const id=String(key||"");const text=String(value||"");if(!id||!text)return;
      buffered.set(id,(buffered.get(id)||"")+text);
      if(handle==null)handle=scheduleFn(flush);
    },
    flushKey(key){
      if(disposed)return;
      const id=String(key||"");if(!id||!buffered.has(id))return;
      const value=buffered.get(id);buffered.delete(id);
      onFlush?.([[id,value]]);
    },
    flush,
    reset(){
      buffered.clear();
      if(handle!=null){cancelFn(handle);handle=null}
    },
    dispose(){
      disposed=true;buffered.clear();
      if(handle!=null){cancelFn(handle);handle=null}
    },
    pending(key){return buffered.get(String(key||""))||""},
  };
}
