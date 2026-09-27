function rounded(value){return Number(Math.max(0,Number(value)||0).toFixed(3))}

export function optionalFiniteMetric(value){
  if(value==null||value==="")return null;
  const number=Number(value);
  return Number.isFinite(number)&&number>=0?number:null;
}

export function optionalMetricTotal(total,samples){
  return Number(samples)>0?optionalFiniteMetric(total):null;
}

function mergedIntervalMs(intervals=[]){
  const ordered=intervals.filter(item=>Number.isFinite(item?.start)&&Number.isFinite(item?.end)&&item.end>=item.start).sort((a,b)=>a.start-b.start||a.end-b.end);
  if(!ordered.length)return 0;
  let total=0,start=ordered[0].start,end=ordered[0].end;
  for(const interval of ordered.slice(1)){
    if(interval.start<=end){end=Math.max(end,interval.end);continue}
    total+=end-start;start=interval.start;end=interval.end;
  }
  return total+(end-start);
}

export function nativeToolTiming(events=[], {elapsedMs=0,providerLatencyMs=0}={}){
  const completed=(Array.isArray(events)?events:[]).filter(event=>event?.name==="native.tool.completed"),intervals=[],groups=new Map();
  let toolExecutionMs=0;
  for(const event of completed){
    const duration=Math.max(0,Number(event?.data?.durationMs)||0),end=Number(event?.at)||0;
    toolExecutionMs+=duration;if(end>0&&duration>0)intervals.push({start:end-duration,end});
    const namespace=String(event?.data?.namespace||"native"),name=String(event?.data?.name||"tool"),key=namespace+"/"+name,group=groups.get(key)||{tool:key,count:0,totalMs:0,maxMs:0};
    group.count++;group.totalMs+=duration;group.maxMs=Math.max(group.maxMs,duration);groups.set(key,group);
  }
  const toolWallMs=mergedIntervalMs(intervals),providerMs=Math.max(0,Number(providerLatencyMs)||0),elapsed=Math.max(0,Number(elapsedMs)||0);
  return {
    toolExecutionMs:rounded(toolExecutionMs),
    toolWallMs:rounded(toolWallMs),
    parallelToolOverlapMs:rounded(toolExecutionMs-toolWallMs),
    otherElapsedMs:rounded(elapsed-providerMs-toolWallMs),
    toolTiming:[...groups.values()].map(item=>({tool:item.tool,count:item.count,totalMs:rounded(item.totalMs),averageMs:rounded(item.totalMs/Math.max(1,item.count)),maxMs:rounded(item.maxMs)})).sort((a,b)=>b.totalMs-a.totalMs||a.tool.localeCompare(b.tool)),
  };
}
