import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { benchmarkConversationVirtualization, benchmarkDurableState, benchmarkReplay, benchmarkRepositoryIndex, benchmarkStreamingCoalescing, runCoreBenchmark, syntheticEventHistory } from "../src/performance-benchmark.mjs";

test("synthetic performance fixture is deterministic and bounded",()=>{
  const a=syntheticEventHistory({threads:3,eventsPerThread:4}),b=syntheticEventHistory({threads:3,eventsPerThread:4});
  assert.deepEqual(a,b);assert.equal(a.length,12);assert.equal(a[0].threadId,"bench-thread-0");assert.equal(a.at(-1).threadId,"bench-thread-2");
});

test("replay benchmark reports factual counts, timing and memory evidence",()=>{
  const result=benchmarkReplay({threads:20,eventsPerThread:10});
  assert.equal(result.events,200);assert.equal(result.threads,20);assert.ok(result.fixtureMs>=0);assert.ok(result.replayMs>=0);assert.equal(result.diagnostics.replayEvents,200);
});

test("long-conversation benchmark exercises the production virtualization window",()=>{
  const result=benchmarkConversationVirtualization({messageCount:5000,lookupCount:50});
  assert.equal(result.messages,5000);assert.equal(result.virtualized,true);assert.equal(result.lookupHits,50);
  assert.equal(result.chunks,Math.ceil(5000/result.chunkSize));assert.ok(result.maxChunkMessages<=result.chunkSize);assert.ok(result.initiallyMountedMessages<=result.chunkSize*2);
  assert.ok(result.chunkBuildMs>=0);assert.ok(result.lookupMs>=0);assert.ok(result.avgLookupUs>=0);
});

test("streaming benchmark proves production delta buffering coalesces UI commits",()=>{
  const result=benchmarkStreamingCoalescing({deltaCount:1000,deltaBytes:16,deltasPerFrame:25});
  assert.equal(result.deltas,1000);assert.equal(result.inputBytes,16_000);assert.equal(result.flushedBytes,result.inputBytes);
  assert.equal(result.scheduledFrames,40);assert.equal(result.commits,40);assert.equal(result.coalescingRatio,25);
  assert.ok(result.elapsedMs>=0);assert.ok(result.deltasPerSecond>0);assert.ok(result.throughputMiBPerSecond>0);
});

test("repository benchmark proves unchanged reuse and one-file incremental reparsing",async()=>{
  const result=await benchmarkRepositoryIndex({fileCount:40});
  assert.equal(result.files,40);assert.equal(result.first.filesIndexed,40);assert.equal(result.first.reparsed,40);
  assert.equal(result.unchanged.reparsed,0);assert.equal(result.unchanged.reused,40);assert.equal(result.unchangedReuseRatio,1);
  assert.equal(result.incremental.reparsed,1);assert.equal(result.incremental.reused,39);assert.equal(result.incremental.filesIndexed,40);
  assert.ok(result.first.elapsedMs>=0);assert.ok(result.unchanged.elapsedMs>=0);assert.ok(result.incremental.elapsedMs>=0);
});

test("durable state benchmark measures indexed writes queries and lean general-state payloads",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-state-benchmark-test-"));
  try{
    const result=await benchmarkDurableState({env:{TREBELL_HOME:home,HOME:home},recordCount:40,queryCount:5});
    assert.equal(result.records,40);assert.equal(result.queries,5);assert.equal(result.persisted.usage,40);assert.equal(result.persisted.verification,4);assert.equal(result.persisted.knowledge,2);assert.equal(result.persisted.checkpoints,2);
    assert.ok(result.writeMs>=0);assert.ok(result.queryMs>=0);assert.ok(result.avgWriteUs>=0);assert.ok(result.avgQueryBatchUs>=0);assert.ok(result.compatSnapshotBytes>result.leanSnapshotBytes);assert.ok(result.uiStateFileBytes<result.compatSnapshotBytes);
  }finally{await rm(home,{recursive:true,force:true})}
});

test("core benchmark exercises SQLite event storage without a hard machine-speed threshold",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-benchmark-test-"));
  try{
    const result=await runCoreBenchmark({env:{TREBELL_HOME:home,HOME:home},threads:10,eventsPerThread:6,eventCount:200,queryCount:10,stateRecords:30,repoFiles:30,longChatMessages:500,streamDeltas:1000});
    assert.equal(result.replay.events,60);assert.equal(result.eventStore.events,200);assert.equal(result.eventStore.queries,10);assert.ok(["sqlite","jsonl"].includes(result.eventStore.backend));
    assert.equal(result.conversation.messages,500);assert.equal(result.conversation.virtualized,true);assert.equal(result.streaming.deltas,1000);assert.equal(result.streaming.flushedBytes,result.streaming.inputBytes);
    assert.equal(result.durableState.records,30);assert.ok(result.durableState.compatSnapshotBytes>result.durableState.leanSnapshotBytes);
    assert.equal(result.repositoryIndex.files,30);assert.equal(result.repositoryIndex.unchanged.reparsed,0);assert.equal(result.repositoryIndex.incremental.reparsed,1);
    assert.ok(result.durationMs>=0);assert.ok(result.eventStore.avgInsertUs>=0);assert.ok(result.eventStore.avgQueryUs>=0);
  }finally{await rm(home,{recursive:true,force:true})}
});
