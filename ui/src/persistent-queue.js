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
    ...(item.heldBy&&Number(item.heldUntil)?{heldBy:String(item.heldBy),heldUntil:Number(item.heldUntil)}:{}),
  }));
}

// A message a window holds in its thread's queue while the automatic compaction before it runs (heldBy: that window's key, which a
// reload of it keeps; heldUntil: when its hold ends, which that window renews while it waits) is on its way in that window: another
// window shows it as being sent until then. With no time (now), any hold of another window's counts: a copy of the queue read earlier
// may say a hold has ended that its window has renewed since, so only a fresh read, with the time, ends it. The window itself
// reloaded is gone, and knows it by its key.
export function heldElsewhere(item,windowKey,now=null){
  return Boolean(item?.dispatchingAt&&item.heldBy&&item.heldBy!==windowKey&&(now==null||Number(item.heldUntil)>now));
}

// A follow-up left on its way by a window that is gone (a reload, a restart) may have started, so it waits for a retry; one still on
// its way in this window (onItsWay, the ids of those), or held in another (heldElsewhere), keeps its mark while its send goes on.
export function hydratePersistedQueue(items=[],onItsWay=new Set(),windowKey=null,now=null){
  return persistedQueueItems(items).map(item=>item.dispatchingAt&&!onItsWay.has(item.id)&&!heldElsewhere(item,windowKey,now)?{
    ...item,dispatchingAt:null,autoStartFailed:true,recoveredUncertainDispatch:true,heldBy:null,heldUntil:null,
  }:item);
}
