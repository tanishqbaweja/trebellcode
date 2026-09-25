import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { benchmarkReplay, runCoreBenchmark, syntheticEventHistory } from "../src/performance-benchmark.mjs";

test("synthetic performance fixture is deterministic and bounded",()=>{
  const a=syntheticEventHistory({threads:3,eventsPerThread:4}),b=syntheticEventHistory({threads:3,eventsPerThread:4});
  assert.deepEqual(a,b);assert.equal(a.length,12);assert.equal(a[0].threadId,"bench-thread-0");assert.equal(a.at(-1).threadId,"bench-thread-2");
});

test("replay benchmark reports factual counts, timing and memory evidence",()=>{
  const result=benchmarkReplay({threads:20,eventsPerThread:10});
  assert.equal(result.events,200);assert.equal(result.threads,20);assert.ok(result.fixtureMs>=0);assert.ok(result.replayMs>=0);assert.equal(result.diagnostics.replayEvents,200);
});

test("core benchmark exercises SQLite event storage without a hard machine-speed threshold",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-benchmark-test-"));
  try{
    const result=await runCoreBenchmark({env:{TREBELL_HOME:home,HOME:home},threads:10,eventsPerThread:6,eventCount:200,queryCount:10});
    assert.equal(result.replay.events,60);assert.equal(result.eventStore.events,200);assert.equal(result.eventStore.queries,10);assert.ok(["sqlite","jsonl"].includes(result.eventStore.backend));
    assert.ok(result.durationMs>=0);assert.ok(result.eventStore.avgInsertUs>=0);assert.ok(result.eventStore.avgQueryUs>=0);
  }finally{await rm(home,{recursive:true,force:true})}
});
