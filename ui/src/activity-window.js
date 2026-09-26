export const ACTIVITY_WINDOW_SIZE=120;

function boundedSize(value){
  return Math.max(20,Math.min(500,Math.trunc(Number(value)||ACTIVITY_WINDOW_SIZE)));
}

export function activityWindow(events=[],{end=null,size=ACTIVITY_WINDOW_SIZE}={}){
  const source=Array.isArray(events)?events:[],windowSize=boundedSize(size),total=source.length;
  const requested=end==null?total:Math.trunc(Number(end));
  const resolvedEnd=Math.max(0,Math.min(total,Number.isFinite(requested)?requested:total));
  const start=Math.max(0,resolvedEnd-windowSize);
  return {
    items:source.slice(start,resolvedEnd),
    start,end:resolvedEnd,total,size:windowSize,
    latest:resolvedEnd===total,
    hasOlder:start>0,
    hasNewer:resolvedEnd<total,
  };
}

export function previousActivityWindowEnd(window){
  if(!window?.hasOlder)return window?.end??null;
  return window.start;
}

export function nextActivityWindowEnd(window){
  if(!window?.hasNewer)return null;
  const next=Math.min(window.total,window.end+window.size);
  return next>=window.total?null:next;
}
