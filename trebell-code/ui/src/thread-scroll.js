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
