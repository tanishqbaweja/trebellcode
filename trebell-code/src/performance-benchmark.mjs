import { performance } from "node:perf_hooks";
import { EventJournal } from "./event-journal.mjs";
import { createReplayFixture, replayEventFixture } from "./event-replay.mjs";

function integer(value,fallback,min,max){
  const number=Math.trunc(Number(value));return Number.isFinite(number)?Math.max(min,Math.min(max,number)):fallback;
}
function memory(){const value=process.memoryUsage();return {rss:value.rss,heapUsed:value.heapUsed,external:value.external}}
function delta(after,before){return Object.fromEntries(Object.keys(after).map(key=>[key,Math.max(0,(after[key]||0)-(before[key]||0))]))}

export function syntheticEventHistory({threads=1000,eventsPerThread=20}={}){
  const threadCount=integer(threads,1000,1,20_000),perThread=integer(eventsPerThread,20,2,200),events=[];let at=1;
  for(let threadIndex=0;threadIndex<threadCount;threadIndex++){
    const threadId="bench-thread-"+threadIndex;
    for(let index=0;index<perThread;index++){
      const turnIndex=Math.floor(index/2),turnId=threadId+"-turn-"+turnIndex,isStart=index%2===0;
      events.push({
        id:threadId+"-"+index,at:at++,runtime:threadIndex%2?"claude":"codex",provider:threadIndex%3?"provider-a":"provider-b",
        threadId,turnId,category:isStart?"client":"runtime",name:isStart?"turn/started":"turn/completed",status:isStart?null:"completed",
        data:isStart?{}:{turn:{id:turnId,status:"completed",durationMs:25+index}},
      });
    }
  }
  return events;
}

export function benchmarkReplay(options={}){
  const events=syntheticEventHistory(options),before=memory(),start=performance.now(),fixture=createReplayFixture(events,{maxEvents:events.length}),fixtureMs=performance.now()-start;
  const replayStart=performance.now(),replay=replayEventFixture(fixture),replayMs=performance.now()-replayStart,after=memory();
  return {
    events:events.length,threads:replay.threadCount,
    fixtureMs:Number(fixtureMs.toFixed(3)),replayMs:Number(replayMs.toFixed(3)),
    memoryDeltaBytes:delta(after,before),
    diagnostics:fixture.diagnostics,
  };
}

export async function benchmarkEventStore({env,eventCount=10_000,queryCount=200}={}){
  const count=integer(eventCount,10_000,100,200_000),queries=integer(queryCount,200,1,10_000),journal=new EventJournal(env,{maxRecords:Math.max(100,count),maxBytes:128*1024*1024});
  const before=memory(),insertStart=performance.now();
  try{
    for(let index=0;index<count;index++){
      const threadId="store-thread-"+(index%1000),turnId=threadId+"-turn-"+Math.floor(index/2);
      journal.record({id:"store-"+index,at:index+1,runtime:index%2?"claude":"codex",threadId,turnId,category:index%5===0?"verification":"runtime",name:index%2?"turn/completed":"turn/started",status:index%2?"completed":null,data:{index}});
    }
    await journal.flush();const insertMs=performance.now()-insertStart,queryStart=performance.now();
    let returned=0;
    for(let index=0;index<queries;index++)returned+=journal.list({threadId:"store-thread-"+(index%1000),limit:50}).length;
    const queryMs=performance.now()-queryStart,after=memory(),status=journal.status();
    return {
      events:count,queries,returned,backend:status.backend,
      insertMs:Number(insertMs.toFixed(3)),queryMs:Number(queryMs.toFixed(3)),
      avgInsertUs:Number((insertMs*1000/count).toFixed(3)),avgQueryUs:Number((queryMs*1000/queries).toFixed(3)),
      memoryDeltaBytes:delta(after,before),logicalBytes:status.bytes,fileBytes:status.fileBytes,
    };
  }finally{await journal.close()}
}

export async function runCoreBenchmark({env=process.env,threads=1000,eventsPerThread=20,eventCount=10_000,queryCount=200}={}){
  const startedAt=new Date().toISOString(),started=performance.now(),replay=benchmarkReplay({threads,eventsPerThread}),eventStore=await benchmarkEventStore({env,eventCount,queryCount});
  return {
    version:1,startedAt,durationMs:Number((performance.now()-started).toFixed(3)),
    environment:{node:process.version,platform:process.platform,arch:process.arch},
    replay,eventStore,
  };
}
