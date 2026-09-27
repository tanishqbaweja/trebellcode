import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { nativeRequestMetrics, NATIVE_TOOL_SCHEMA_FINGERPRINT } from "../src/native-request-metrics.mjs";
import { platformDynamicToolNamespaces } from "../src/platform-tool-catalog.mjs";

const seed=[{role:"system",content:"Stable system "+"s".repeat(4000)},{role:"developer",content:"Stable developer "+"d".repeat(3000)}];
for(let index=0;index<1600;index++){
  seed.push({role:"user",content:`request-${index} `+"u".repeat(240)},{role:"assistant",content:`answer-${index} `+"a".repeat(360)});
  if(index%2===0)seed.push({role:"tool",toolCallId:`tool-${index}`,content:`result-${index} `+"r".repeat(720)});
}

const tools=platformDynamicToolNamespaces({repository:true,progressiveRepository:true,workspaceTools:true,terminal:true,output:true,browser:false,computer:false,sourceControl:false,delegation:false}),growthSteps=60,rounds=9;
function median(values){const ordered=[...values].sort((a,b)=>a-b);return ordered[Math.floor(ordered.length/2)]}
function run(cached){
  global.gc?.();
  const messages=[...seed],toolCache=new WeakMap(),messageCache=cached?new WeakMap():null,started=performance.now();let checksum=0,fingerprint="";
  for(let step=0;step<growthSteps;step++){
    messages.push({role:"user",content:`new-request-${step} `+"n".repeat(220)},{role:"assistant",content:`new-answer-${step} `+"x".repeat(320)});
    const result=nativeRequestMetrics(messages,tools,{toolSchemaCache:toolCache,...(messageCache?{messageSerializationCache:messageCache}:{})});
    checksum+=result.totalLogical.bytes+result.conversationHistory.bytes+result.toolResults.bytes;fingerprint=result[NATIVE_TOOL_SCHEMA_FINGERPRINT];
  }
  return {durationMs:Number((performance.now()-started).toFixed(3)),checksum,fingerprint};
}

for(let warm=0;warm<3;warm++){run(false);run(true)}
const baselineRuns=[],candidateRuns=[];
for(let round=0;round<rounds;round++){
  if(round%2===0){baselineRuns.push(run(false));candidateRuns.push(run(true))}
  else{candidateRuns.push(run(true));baselineRuns.push(run(false))}
}
assert.ok(baselineRuns.every(run=>run.checksum===candidateRuns[0].checksum));assert.ok(candidateRuns.every(run=>run.checksum===baselineRuns[0].checksum));assert.ok(baselineRuns.every(run=>run.fingerprint===candidateRuns[0].fingerprint));assert.ok(candidateRuns.every(run=>run.fingerprint===baselineRuns[0].fingerprint));
const baselineMedian=median(baselineRuns.map(run=>run.durationMs)),candidateMedian=median(candidateRuns.map(run=>run.durationMs)),savedMs=Number((baselineMedian-candidateMedian).toFixed(3));
console.log(JSON.stringify({ok:true,benchmark:"native-message-serialization-cache",seedMessages:seed.length,growthSteps,toolFunctions:tools.reduce((sum,entry)=>sum+(entry.tools?.length||0),0),rounds,baseline:{medianDurationMs:baselineMedian,runsMs:baselineRuns.map(run=>run.durationMs)},candidate:{medianDurationMs:candidateMedian,runsMs:candidateRuns.map(run=>run.durationMs)},savings:{medianDurationMs:savedMs,medianPercent:Number((savedMs/baselineMedian*100).toFixed(2))},note:"Deterministic local Native telemetry benchmark. Candidate reuses exact per-message JSON fragments only within one simulated agent turn; every growth step preserves byte-accounting checksums and the full tool-schema fingerprint."},null,2));
