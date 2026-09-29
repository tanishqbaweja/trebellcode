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
      {name:"native.model.completed",atMs:100,data:{modelTurn:1,durationMs:10,usage:{inputTokens:2000,cachedInputTokens:1024},providerTelemetry:{promptCacheDiagnostics:{type:"cache_miss",reason:"tools_changed",comparisonReusableTokens:1536,cacheMissedTokens:512}}}},
      {name:"native.model.completed",atMs:200,data:{modelTurn:2,durationMs:10,usage:{inputTokens:2200,cachedInputTokens:2048},providerTelemetry:{promptCacheDiagnostics:{type:"cache_hit",reason:null,comparisonReusableTokens:2048,cacheMissedTokens:null}}}},
      {name:"native.model.completed",atMs:300,data:{modelTurn:3,durationMs:10,usage:{inputTokens:10,cachedInputTokens:0},providerTelemetry:{promptCacheDiagnostics:{type:"unavailable",reason:"not_supported",comparisonReusableTokens:null,cacheMissedTokens:null}}}},
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
  }finally{await rm(root,{recursive:true,force:true})}
});
