export const THREAD_SCROLL_END_THRESHOLD=48;

export function captureThreadScrollPosition(node,threshold=THREAD_SCROLL_END_THRESHOLD){
  if(!node)return null;
  const scrollTop=Math.max(0,Number(node.scrollTop)||0);
  const scrollHeight=Math.max(0,Number(node.scrollHeight)||0);
  const clientHeight=Math.max(0,Number(node.clientHeight)||0);
  const maxTop=Math.max(0,scrollHeight-clientHeight);
  const distanceFromEnd=Math.max(0,maxTop-scrollTop);
  return {top:Math.min(scrollTop,maxTop),atEnd:distanceFromEnd<=threshold,distanceFromEnd};
}

export function restoredThreadScrollTop(position,node){
  if(!node)return 0;
  const maxTop=Math.max(0,(Number(node.scrollHeight)||0)-(Number(node.clientHeight)||0));
  if(!position)return maxTop;
  if(position.atEnd)return maxTop;
  return Math.max(0,Math.min(Number(position.top)||0,maxTop));
}

export function rememberThreadScrollPosition(cache,threadId,position,limit=100){
  if(!cache||!threadId||!position)return;
  cache.delete(threadId);cache.set(threadId,position);
  while(cache.size>limit){
    const oldest=cache.keys().next().value;
    if(oldest===undefined)break;
    cache.delete(oldest);
  }
}

function messageIdForNode(node){
  return node?.dataset?.messageId||node?.getAttribute?.("data-message-id")||"";
}

export function captureHistoryPrependAnchor(node){
  if(!node?.querySelectorAll||!node?.getBoundingClientRect)return null;
  const root=node.getBoundingClientRect();
  const rows=[...node.querySelectorAll("[data-message-id]")];
  const anchor=rows.find(row=>{
    const rect=row?.getBoundingClientRect?.();
    return rect&&rect.bottom>root.top&&rect.top<root.bottom;
  });
  const messageId=messageIdForNode(anchor);
  if(!anchor||!messageId)return null;
  return {messageId,offset:anchor.getBoundingClientRect().top-root.top};
}

export function restoreHistoryPrependAnchor(node,anchor){
  if(!node?.querySelectorAll||!node?.getBoundingClientRect||!anchor?.messageId)return false;
  const target=[...node.querySelectorAll("[data-message-id]")].find(row=>String(messageIdForNode(row))===String(anchor.messageId));
  if(!target?.getBoundingClientRect)return false;
  const root=node.getBoundingClientRect(),currentOffset=target.getBoundingClientRect().top-root.top;
  const delta=currentOffset-(Number(anchor.offset)||0);
  if(Math.abs(delta)>0.5)node.scrollTop=Math.max(0,(Number(node.scrollTop)||0)+delta);
  return true;
}
