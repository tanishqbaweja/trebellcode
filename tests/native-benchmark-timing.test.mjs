import test from "node:test";
import assert from "node:assert/strict";
import { nativeToolTiming } from "../scripts/native-benchmark-timing.mjs";

test("Native benchmark timing removes parallel overlap from tool wall time",()=>{
  const events=[
    {name:"native.tool.completed",at:100,data:{namespace:"trebell_workspace",name:"read_file",durationMs:10}},
    {name:"native.tool.completed",at:96,data:{namespace:"trebell_workspace",name:"read_file",durationMs:8}},
    {name:"native.tool.completed",at:110,data:{namespace:"trebell_terminal",name:"run",durationMs:4}},
    {name:"native.model.completed",at:120,data:{durationMs:80}},
  ];
  const result=nativeToolTiming(events,{elapsedMs:100,providerLatencyMs:70});
  assert.equal(result.toolExecutionMs,22);
  assert.equal(result.toolWallMs,16);
  assert.equal(result.parallelToolOverlapMs,6);
  assert.equal(result.otherElapsedMs,14);
  assert.deepEqual(result.toolTiming,[
    {tool:"trebell_workspace/read_file",count:2,totalMs:18,averageMs:9,maxMs:10},
    {tool:"trebell_terminal/run",count:1,totalMs:4,averageMs:4,maxMs:4},
  ]);
});

test("Native benchmark timing stays bounded when events are incomplete",()=>{
  const result=nativeToolTiming([{name:"native.tool.completed",data:{namespace:"trebell_repo",name:"search",durationMs:-4}}],{elapsedMs:5,providerLatencyMs:12});
  assert.equal(result.toolExecutionMs,0);assert.equal(result.toolWallMs,0);assert.equal(result.parallelToolOverlapMs,0);assert.equal(result.otherElapsedMs,0);
  assert.deepEqual(result.toolTiming,[{tool:"trebell_repo/search",count:1,totalMs:0,averageMs:0,maxMs:0}]);
});
