import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { nativeRequestMetrics } from "../src/native-request-metrics.mjs";
import { platformDynamicToolNamespaces } from "../src/platform-tool-catalog.mjs";

const seed=[{role:"system",content:"Stable system "+"s".repeat(3000)},{role:"developer",content:"Stable developer "+"d".repeat(2200)}];
for(let index=0;index<1800;index++){
  seed.push({role:"user",content:`request-${index} `+"u".repeat(260)},{role:"assistant",content:`answer-${index} `+"a".repeat(440)});
  if(index%2===0)seed.push({role:"tool",toolCallId:`tool-${index}`,content:`result-${index} `+"r".repeat(820)});
}
const tools=platformDynamicToolNamespaces({repository:true,progressiveRepository:true,workspaceTools:true,terminal:true,output:true,browser:false,computer:false,sourceControl:false,delegation:false}),growthSteps=70,rounds=9;
function median(values){const ordered=[...values].sort((a,b)=>a-b);return ordered[Math.floor(ordered.length/2)]}
function run(cached){
  global.gc?.();const messages=[...seed],toolCache=new WeakMap(),messageCache=new WeakMap(),historyHashCache=cached?{}:null,started=performance.now();let checksum="";
  for(let step=0;step<growthSteps;step++){
    messages.push({role:"assistant",content:`new-answer-${step} `+"x".repeat(360)},{role:"tool",toolCallId:`new-tool-${step}`,content:`new-result-${step} `+"y".repeat(640)});
    const result=nativeRequestMetrics(messages,tools,{toolSchemaCache:toolCache,messageSerializationCache:messageCache,...(historyHashCache?{historyHashCache}:{})});checksum+=result.conversationHistoryHash;
  }
  return {durationMs:Number((performance.now()-started).toFixed(3)),checksum};
}
for(let warm=0;warm<3;warm++){run(false);run(true)}
const baselineRuns=[],candidateRuns=[];for(let round=0;round<rounds;round++){if(round%2===0){baselineRuns.push(run(false));candidateRuns.push(run(true))}else{candidateRuns.push(run(true));baselineRuns.push(run(false))}}
assert.ok(baselineRuns.every(run=>run.checksum===candidateRuns[0].checksum));assert.ok(candidateRuns.every(run=>run.checksum===baselineRuns[0].checksum));
const baselineMedian=median(baselineRuns.map(run=>run.durationMs)),candidateMedian=median(candidateRuns.map(run=>run.durationMs)),savedMs=Number((baselineMedian-candidateMedian).toFixed(3));
console.log(JSON.stringify({ok:true,benchmark:"native-history-hash-cache",seedMessages:seed.length,growthSteps,rounds,baseline:{medianDurationMs:baselineMedian,runsMs:baselineRuns.map(run=>run.durationMs)},candidate:{medianDurationMs:candidateMedian,runsMs:candidateRuns.map(run=>run.durationMs)},savings:{medianDurationMs:savedMs,medianPercent:Number((savedMs/baselineMedian*100).toFixed(2))},note:"Deterministic local telemetry benchmark on top of the per-message serialization cache. The candidate reuses an open SHA-256 state only while history fragment identity proves an append-only prefix; every per-step history hash is asserted identical."},null,2));
