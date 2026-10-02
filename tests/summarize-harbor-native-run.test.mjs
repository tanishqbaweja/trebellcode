import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync=promisify(execFile);

test("Harbor Native summary aggregates prompt-cache comparison diagnostics",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-summary-")),trial=join(root,"trial"),agent=join(trial,"agent");
  try{
    await mkdir(agent,{recursive:true});
    const events=[
      {name:"native.model.completed",atMs:100,data:{modelTurn:1,durationMs:10,usage:{inputTokens:2000,cachedInputTokens:1024,cacheWriteInputTokens:0,outputTokens:40,reasoningOutputTokens:30},providerTelemetry:{promptCacheDiagnostics:{type:"cache_miss",reason:"tools_changed",comparisonReusableTokens:1536,cacheMissedTokens:512},responseContinuation:{used:true,attempted:true,fallback:false,parentExpired:false,savedRequestBytes:120}}}},
      {name:"native.tool.completed",atMs:150,status:"completed",data:{namespace:"trebell_terminal",name:"run"}},
      {name:"native.progress.implementation_pressure",atMs:160,status:"running",data:{}},
      {name:"native.model.completed",atMs:200,data:{modelTurn:2,durationMs:30,usage:{inputTokens:2200,cachedInputTokens:2048,cacheWriteInputTokens:0,outputTokens:90,reasoningOutputTokens:80},providerTelemetry:{promptCacheDiagnostics:{type:"cache_hit",reason:null,comparisonReusableTokens:2048,cacheMissedTokens:null},responseContinuation:{used:false,attempted:false,fallback:false,parentExpired:true,savedRequestBytes:0}}}},
      {name:"native.tool.completed",atMs:250,status:"completed",data:{namespace:"trebell_workspace",name:"write_file"}},
      {name:"native.model.completed",atMs:300,data:{modelTurn:3,durationMs:20,usage:{inputTokens:10,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:60,reasoningOutputTokens:10},providerTelemetry:{promptCacheDiagnostics:{type:"unavailable",reason:"not_supported",comparisonReusableTokens:null,cacheMissedTokens:null},responseContinuation:{used:false,attempted:true,fallback:true,parentExpired:false,savedRequestBytes:0}}}},
      {name:"native.turn.completed",atMs:400,status:"completed",data:{}},
    ];
    await writeFile(join(agent,"trebell-native-events.jsonl"),events.map(event=>JSON.stringify(event)).join("\n")+"\n","utf8");
    const script=fileURLToPath(new URL("../scripts/summarize-harbor-native-run.mjs",import.meta.url));
    const {stdout}=await execFileAsync(process.execPath,[script,root],{windowsHide:true});
    const summary=JSON.parse(stdout);
    assert.deepEqual(summary.cacheDiagnostics,{
      hits:1,
      misses:1,
      unavailable:1,
      comparisonReusableTokens:3584,
      comparisonReusableReportedTurns:2,
      cacheMissedTokens:512,
      cacheMissedReportedTurns:1,
      missReasons:{tools_changed:1},
    });
    assert.deepEqual(summary.cacheCarryover,{
      transitions:2,
      priorRequestInputTokens:4200,
      knownCachedPriorTokens:3072,
      retainedKnownCachedTokens:1024,
      lostKnownCachedTokens:2048,
      percent:33.333,
    });
    assert.deepEqual(summary.responseContinuation,{used:1,notUsed:2,attempted:2,fallbacks:1,expiredParents:1,savedRequestBytes:120});
    assert.deepEqual(summary.topOutputTurns.map(row=>row.turn),[2,3,1]);
    assert.deepEqual(summary.topReasoningTurns.map(row=>row.turn),[2,1,3]);
    assert.deepEqual(summary.topDurationTurns.map(row=>row.turn),[2,3,1]);
    assert.deepEqual(summary.topOutputTurns[0],{
      turn:2,durationMs:30,toolCallCount:0,finishReason:null,precedingTools:["trebell_terminal/run"],precedingControllerEvents:["native.progress.implementation_pressure"],followingTools:["trebell_workspace/write_file"],inputTokens:2200,cachedInputTokens:2048,cacheWriteInputTokens:0,outputTokens:90,reasoningOutputTokens:80,
    });
  }finally{await rm(root,{recursive:true,force:true})}
});
