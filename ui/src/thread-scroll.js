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

// The anchor row's distance from the top of the view now, or null when the row is gone.
export function historyAnchorOffset(node,anchor){
  if(!node?.querySelectorAll||!node?.getBoundingClientRect||!anchor?.messageId)return null;
  const target=[...node.querySelectorAll("[data-message-id]")].find(row=>String(messageIdForNode(row))===String(anchor.messageId));
  if(!target?.getBoundingClientRect)return null;
  return target.getBoundingClientRect().top-node.getBoundingClientRect().top;
}

export function restoreHistoryPrependAnchor(node,anchor){
  const currentOffset=historyAnchorOffset(node,anchor);if(currentOffset==null)return false;
  const delta=currentOffset-(Number(anchor.offset)||0);
  if(Math.abs(delta)>0.5)node.scrollTop=Math.max(0,(Number(node.scrollTop)||0)+delta);
  return true;
}

// Something other than the anchor moved the view since its last correction: the person scrolled, or a send scrolled to the
// end. Rows growing above the anchor leave scrollTop alone, and the browser's own scroll anchoring moves scrollTop but keeps
// the anchor row in place; neither counts. The page mounts its anchor row's chunk as it lands, so a moved view whose anchor
// row is gone was scrolled away from it (a chunk unmounts only far from the view): that counts, so it is never undone.
export function historyAnchorDisturbed(node,anchor,expectedTop,tolerance=1){
  if(!node)return true;
  if(Math.abs((Number(node.scrollTop)||0)-(Number(expectedTop)||0))<=tolerance)return false;
  const offset=historyAnchorOffset(node,anchor);
  return offset==null||Math.abs(offset-(Number(anchor?.offset)||0))>tolerance;
}

// How far the anchor row still sits below its spot after a restore: the view could not scroll far enough because the rows
// below it end inside the view (a newest page that did not fill it). 0 when it is in place or not mounted.
export function historyAnchorShortfall(node,anchor){
  const offset=historyAnchorOffset(node,anchor);
  return offset==null?0:Math.max(0,offset-(Number(anchor?.offset)||0));
}

// The column height a hold keeps after the view scrolled. Whatever lies below the view's bottom edge is not needed to keep the
// view where it is, so the hold gives that much back: scrolling up shrinks it, scrolling back down never grows it.
export function historyHoldAfterScroll(node,hold){
  const value=Math.max(0,Number(hold)||0);if(!node||!value)return 0;
  const below=(Number(node.scrollHeight)||0)-(Number(node.scrollTop)||0)-(Number(node.clientHeight)||0);
  return below>0.5?Math.max(0,Math.ceil(value-below)):value;
}
