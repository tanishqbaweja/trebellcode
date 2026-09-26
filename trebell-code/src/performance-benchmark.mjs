import { performance } from "node:perf_hooks";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ContextEngine } from "./context-engine.mjs";
import { EventJournal } from "./event-journal.mjs";
import { createReplayFixture, replayEventFixture } from "./event-replay.mjs";
import { TrebellStateStore } from "./trebell-state.mjs";
import { AgentThreadStore } from "./agent-thread-store.mjs";
import { createTextFrameBuffer } from "../ui/src/text-frame-buffer.js";
import { CONVERSATION_CHUNK_SIZE, conversationChunkIndexForMessage, conversationVirtualChunks, shouldVirtualizeConversation } from "../ui/src/conversation-virtualization.js";

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

export function benchmarkConversationVirtualization({messageCount=10_000,lookupCount=200}={}){
  const count=integer(messageCount,10_000,200,100_000),lookups=integer(lookupCount,200,1,5000);
  const text="Trebell long-conversation benchmark message with enough content to exercise height estimation and chunk bookkeeping. ";
  const messages=Array.from({length:count},(_,index)=>({
    id:"chat-message-"+index,role:index%3===0?"user":"assistant",text:text+"#"+index,
  }));
  const before=memory(),chunkStart=performance.now(),chunks=conversationVirtualChunks(messages),chunkBuildMs=performance.now()-chunkStart;
  const lookupStart=performance.now();let lookupHits=0;
  for(let index=0;index<lookups;index++){
    const messageIndex=Math.min(count-1,Math.floor(index*Math.max(1,count-1)/Math.max(1,lookups-1)));
    if(conversationChunkIndexForMessage(chunks,"chat-message-"+messageIndex)>=0)lookupHits++;
  }
  const lookupMs=performance.now()-lookupStart,after=memory(),initialChunks=chunks.slice(-2);
  return {
    messages:count,virtualized:shouldVirtualizeConversation(messages),chunks:chunks.length,chunkSize:CONVERSATION_CHUNK_SIZE,
    maxChunkMessages:chunks.reduce((max,chunk)=>Math.max(max,chunk.messages.length),0),
    initiallyMountedMessages:initialChunks.reduce((sum,chunk)=>sum+chunk.messages.length,0),
    lookups,lookupHits,chunkBuildMs:Number(chunkBuildMs.toFixed(3)),lookupMs:Number(lookupMs.toFixed(3)),
    avgLookupUs:Number((lookupMs*1000/lookups).toFixed(3)),memoryDeltaBytes:delta(after,before),
  };
}

export function benchmarkStreamingCoalescing({deltaCount=50_000,deltaBytes=32,deltasPerFrame=100}={}){
  const count=integer(deltaCount,50_000,100,1_000_000),bytes=integer(deltaBytes,32,1,4096),perFrame=integer(deltasPerFrame,100,1,10_000);
  const callbacks=[];let nextHandle=1,scheduledFrames=0,commits=0,flushedBytes=0;
  const before=memory(),payload="x".repeat(bytes),started=performance.now();
  const buffer=createTextFrameBuffer({
    schedule:callback=>{callbacks.push(callback);scheduledFrames++;return nextHandle++},
    cancel:()=>{},
    onFlush:value=>{commits++;flushedBytes+=Buffer.byteLength(value)},
  });
  for(let index=0;index<count;index++){
    buffer.push(payload);
    if((index+1)%perFrame===0)callbacks.shift()?.();
  }
  while(callbacks.length)callbacks.shift()?.();
  buffer.dispose();
  const elapsedMs=performance.now()-started,after=memory(),inputBytes=count*Buffer.byteLength(payload),elapsedSeconds=Math.max(elapsedMs/1000,0.000001);
  return {
    deltas:count,deltaBytes:bytes,deltasPerFrame:perFrame,inputBytes,flushedBytes,scheduledFrames,commits,
    coalescingRatio:Number((count/Math.max(1,commits)).toFixed(3)),elapsedMs:Number(elapsedMs.toFixed(3)),
    deltasPerSecond:Number((count/elapsedSeconds).toFixed(1)),throughputMiBPerSecond:Number((inputBytes/1024/1024/elapsedSeconds).toFixed(3)),
    memoryDeltaBytes:delta(after,before),
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

export async function benchmarkDurableState({env,recordCount=500,queryCount=100}={}){
  const count=integer(recordCount,500,20,5000),queries=integer(queryCount,100,1,2000),state=new TrebellStateStore(env),before=memory(),writeStart=performance.now();
  for(let index=0;index<count;index++){
    const threadId="state-thread-"+(index%100),turnId=threadId+"-turn-"+index,at=Date.now()-count+index;
    state.recordUsage({runtime:index%2?"native":"codex",provider:index%3?"provider-a":"provider-b",model:"bench-model-"+(index%4),environmentId:index%5?null:"ssh-bench",threadId,turnId,at,usage:{totalTokens:100+index,inputTokens:70+index,outputTokens:30},cost:index%7===0?{amount:0.001,currency:"USD"}:null});
    if(index%10===0)state.recordVerification({id:"bench-verification-"+index,environmentId:index%5?null:"ssh-bench",projectPath:"/bench/project-"+(index%8),threadId,turnId,plan:{risk:"low",steps:[]},evidence:[],assessment:{status:"verified",risk:"low",verified:true},updatedAt:at});
    if(index%20===0)state.upsertRepositoryKnowledge({id:"bench-knowledge-"+index,projectPath:"/bench/project-"+(index%8),environmentId:index%5?null:"ssh-bench",category:"benchmark",fact:"Synthetic benchmark fact "+index,status:"verified",updatedAt:at});
    if(index%25===0)state.addCheckpoint({id:"bench-checkpoint-"+index,threadId,root:"/bench/project-"+(index%8),commit:"deadbeef"+index,createdAt:at});
  }
  const writeMs=performance.now()-writeStart,queryStart=performance.now();let returned=0;
  for(let index=0;index<queries;index++){
    const threadId="state-thread-"+(index%100);returned+=state.usage({days:1,limit:50,environmentIds:index%2?[null]:["ssh-bench"]}).records.length;
    returned+=state.verificationRecords({threadId,limit:20}).length;returned+=state.repositoryKnowledge({projectPath:"/bench/project-"+(index%8),limit:20}).length;returned+=state.checkpoints(threadId).length;
  }
  const queryMs=performance.now()-queryStart,after=memory(),lean=state.snapshot({includeCollections:false}),compat=state.snapshot(),uiState=await readFile(state.path,"utf8").catch(()=>"");
  return {
    records:count,queries,returned,
    writeMs:Number(writeMs.toFixed(3)),queryMs:Number(queryMs.toFixed(3)),avgWriteUs:Number((writeMs*1000/count).toFixed(3)),avgQueryBatchUs:Number((queryMs*1000/queries).toFixed(3)),
    memoryDeltaBytes:delta(after,before),leanSnapshotBytes:Buffer.byteLength(JSON.stringify(lean)),compatSnapshotBytes:Buffer.byteLength(JSON.stringify(compat)),uiStateFileBytes:Buffer.byteLength(uiState),
    persisted:{usage:compat.usageRecords.length,verification:compat.verificationRecords.length,knowledge:compat.repositoryKnowledge.length,checkpoints:compat.checkpoints.length},
  };
}

export function benchmarkAgentThreadSearch({env,threadCount=1000,queryCount=100}={}){
  const count=integer(threadCount,1000,20,10_000),queries=integer(queryCount,100,1,2000),store=new AgentThreadStore(env),before=memory(),writeStart=performance.now();
  for(let index=0;index<count;index++){
    const thread=store.create({runtime:"native",cwd:"/bench/project",providerSessionId:"bench-session-"+index,name:"Benchmark thread "+index});
    const turn=store.addTurn(thread.id,{id:"bench-turn-"+index,inputText:"Synthetic request "+index+" target-group-"+(index%50)});
    store.addItem(thread.id,turn.id,{id:"bench-tool-"+index,type:"commandExecution",status:"completed",aggregatedOutput:"tool-only benchmark output "+index});
    store.addItem(thread.id,turn.id,{id:"bench-agent-"+index,type:"agentMessage",text:"Synthetic completed result "+index});
    store.finishTurn(thread.id,turn.id);
  }
  const writeMs=performance.now()-writeStart,restartStart=performance.now(),restarted=new AgentThreadStore(env),catalog=restarted.list(),restartMs=performance.now()-restartStart,catalogHydratedTurns=catalog.reduce((sum,item)=>sum+(item.turns?.length||0),0),queryStart=performance.now();let returned=0,hydratedTurns=0;
  for(let index=0;index<queries;index++){
    const matches=restarted.searchCandidates("native","target-group-"+(index%50));returned+=matches.length;hydratedTurns+=matches.reduce((sum,item)=>sum+(item.turns?.length||0),0);
  }
  const queryMs=performance.now()-queryStart,after=memory();
  return {
    threads:count,queries,returned,hydratedTurns,catalogThreads:catalog.length,catalogHydratedTurns,restartMs:Number(restartMs.toFixed(3)),writeMs:Number(writeMs.toFixed(3)),queryMs:Number(queryMs.toFixed(3)),
    avgWriteUs:Number((writeMs*1000/count).toFixed(3)),avgQueryUs:Number((queryMs*1000/queries).toFixed(3)),memoryDeltaBytes:delta(after,before),
  };
}

async function writeSyntheticRepository(root,fileCount){
  const source=join(root,"src");await mkdir(source,{recursive:true});
  await writeFile(join(root,"package.json"),JSON.stringify({name:"trebell-context-benchmark",private:true,scripts:{test:"node --test"}},null,2));
  const width=String(Math.max(0,fileCount-1)).length;
  for(let start=0;start<fileCount;start+=100){
    const writes=[];
    for(let index=start;index<Math.min(fileCount,start+100);index++){
      const id=String(index).padStart(width,"0"),previous=String(Math.max(0,index-1)).padStart(width,"0");
      const imported=index?'import { value'+(index-1)+' } from "./module-'+previous+'.js";\n':"",inherited=index?'value'+(index-1):"0";
      const content=imported+'export const value'+index+' = '+inherited+' + 1;\nexport function feature'+index+'(input){ return input + value'+index+'; }\n';
      writes.push(writeFile(join(source,"module-"+id+".js"),content));
    }
    await Promise.all(writes);
  }
  return {source,width};
}

function indexEvidence(packet,elapsedMs){
  const stats=packet?.stats||{};
  return {
    elapsedMs:Number(elapsedMs.toFixed(3)),indexDurationMs:Number(Number(stats.durationMs||0).toFixed(3)),
    filesIndexed:Number(stats.filesIndexed)||0,reparsed:Number(stats.reparsed)||0,reused:Number(stats.reused)||0,
    inspected:Number(stats.inspected)||0,skipped:Number(stats.skipped)||0,graphEdges:Number(stats.graphEdges)||0,
  };
}

export async function benchmarkRepositoryIndex({fileCount=1000}={}){
  const count=integer(fileCount,1000,10,10_000),root=await mkdtemp(join(tmpdir(),"trebell-repository-benchmark-"));
  try{
    const fixture=await writeSyntheticRepository(root,count),engine=new ContextEngine(),before=memory();let started=performance.now();
    const firstPacket=await engine.buildPacket({root,task:"Trace feature dependencies and identify related tests.",maxTokens:3200,maxFiles:24});
    const first=indexEvidence(firstPacket,performance.now()-started);started=performance.now();
    const unchangedPacket=await engine.buildPacket({root,task:"Trace feature dependencies and identify related tests.",maxTokens:3200,maxFiles:24});
    const unchanged=indexEvidence(unchangedPacket,performance.now()-started),edited=String(Math.floor(count/2)).padStart(fixture.width,"0");
    await appendFile(join(fixture.source,"module-"+edited+".js"),"\nexport const benchmarkEdit = true;\n");started=performance.now();
    const incrementalPacket=await engine.buildPacket({root,task:"Trace feature dependencies and identify related tests.",maxTokens:3200,maxFiles:24});
    const incremental=indexEvidence(incrementalPacket,performance.now()-started),after=memory();
    return {
      files:count,editedFile:"src/module-"+edited+".js",first,unchanged,incremental,
      unchangedReuseRatio:unchanged.filesIndexed?Number((unchanged.reused/unchanged.filesIndexed).toFixed(4)):0,
      incrementalReparseRatio:incremental.filesIndexed?Number((incremental.reparsed/incremental.filesIndexed).toFixed(4)):0,
      memoryDeltaBytes:delta(after,before),
    };
  }finally{await rm(root,{recursive:true,force:true})}
}

export async function runCoreBenchmark({env=process.env,threads=1000,eventsPerThread=20,eventCount=10_000,queryCount=200,stateRecords=500,threadSearchThreads=1000,repoFiles=1000,longChatMessages=10_000,streamDeltas=50_000}={}){
  const startedAt=new Date().toISOString(),started=performance.now(),replay=benchmarkReplay({threads,eventsPerThread}),conversation=benchmarkConversationVirtualization({messageCount:longChatMessages}),streaming=benchmarkStreamingCoalescing({deltaCount:streamDeltas}),eventStore=await benchmarkEventStore({env,eventCount,queryCount}),durableState=await benchmarkDurableState({env,recordCount:stateRecords,queryCount}),agentThreadSearch=benchmarkAgentThreadSearch({env,threadCount:threadSearchThreads,queryCount}),repositoryIndex=await benchmarkRepositoryIndex({fileCount:repoFiles});
  return {
    version:5,startedAt,durationMs:Number((performance.now()-started).toFixed(3)),
    environment:{node:process.version,platform:process.platform,arch:process.arch},
    replay,conversation,streaming,eventStore,durableState,agentThreadSearch,repositoryIndex,
  };
}
