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

export function hydratePersistedQueue(items=[]){
  return persistedQueueItems(items).map(item=>item.dispatchingAt?{
    ...item,dispatchingAt:null,autoStartFailed:true,recoveredUncertainDispatch:true,
  }:item);
}
