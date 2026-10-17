const MAX_PERSISTED_QUEUE_ITEMS=100;

export function persistedQueueItems(items=[]){
  return (Array.isArray(items)?items:[]).filter(item=>item&&!item.native&&item.id&&typeof item.text==="string").slice(0,MAX_PERSISTED_QUEUE_ITEMS).map(item=>({
    id:String(item.id),
    text:item.text,
    attachments:Array.isArray(item.attachments)?[...item.attachments]:[],
    contextChips:Array.isArray(item.contextChips)?item.contextChips.map(chip=>({...chip})):[],
    model:item.model||null,
    createdAt:Number(item.createdAt)||Date.now(),
    autoStartFailed:Boolean(item.autoStartFailed),
    dispatchingAt:Number(item.dispatchingAt)||null,
  }));
}

// A follow-up left on its way by a window that is gone (a reload, a restart) may have started, so it waits for a retry; one still on
// its way in this window (onItsWay, the ids of those) keeps its mark while its send goes on.
export function hydratePersistedQueue(items=[],onItsWay=new Set()){
  return persistedQueueItems(items).map(item=>item.dispatchingAt&&!onItsWay.has(item.id)?{
    ...item,dispatchingAt:null,autoStartFailed:true,recoveredUncertainDispatch:true,
  }:item);
}
