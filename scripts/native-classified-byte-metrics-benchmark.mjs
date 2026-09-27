import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { nativeRequestMetrics, NATIVE_TOOL_SCHEMA_FINGERPRINT } from "../src/native-request-metrics.mjs";
import { platformDynamicToolNamespaces } from "../src/platform-tool-catalog.mjs";

const seed=[{role:"system",content:"Stable system "+"s".repeat(3000)},{role:"developer",content:"Stable developer "+"d".repeat(2200)}];
for(let index=0;index<1800;index++){
  seed.push({role:"user",content:`request-${index} `+"u".repeat(260)},{role:"assistant",content:`answer-${index} `+"a".repeat(440)});
  if(index%2===0)seed.push({role:"tool",toolCallId:`tool-${index}`,content:`result-${index} `+"r".repeat(820)});
}
const tools=platformDynamicToolNamespaces({repository:true,progressiveRepository:true,workspaceTools:true,terminal:true,output:true,browser:false,computer:false,sourceControl:false,delegation:false}),growthSteps=70,rounds=9;
const median=values=>{const ordered=[...values].sort((a,b)=>a-b);return ordered[Math.floor(values.length/2)]};

function run(reuseClassifiedByteMetrics){
  global.gc?.();const messages=[...seed],toolCache=new WeakMap(),messageCache=new WeakMap(),currentTurnCache=new WeakMap(),historyHashCache={},classificationCache={},started=performance.now();let checksum=0,lastHash="",lastFingerprint="";
  for(let step=0;step<growthSteps;step++){
    messages.push({role:"assistant",content:`new-answer-${step} `+"x".repeat(360)},{role:"tool",toolCallId:`new-tool-${step}`,content:`new-result-${step} `+"y".repeat(640)});
    const result=nativeRequestMetrics(messages,tools,{toolSchemaCache:toolCache,messageSerializationCache:messageCache,currentTurnBreakdownCache:currentTurnCache,historyHashCache,messageClassificationCache:classificationCache,reuseClassifiedByteMetrics});
    checksum+=result.messages.bytes+result.compactedContext.bytes+result.conversationHistory.bytes+result.toolResults.bytes+result.totalLogical.bytes;lastHash=result.conversationHistoryHash;lastFingerprint=result[NATIVE_TOOL_SCHEMA_FINGERPRINT];
  }
  return {durationMs:Number((performance.now()-started).toFixed(3)),checksum,lastHash,lastFingerprint};
}

for(let warm=0;warm<3;warm++){run(false);run(true)}
const baselineRuns=[],candidateRuns=[];for(let round=0;round<rounds;round++){if(round%2===0){baselineRuns.push(run(false));candidateRuns.push(run(true))}else{candidateRuns.push(run(true));baselineRuns.push(run(false))}}
assert.ok(baselineRuns.every(item=>item.checksum===candidateRuns[0].checksum&&item.lastHash===candidateRuns[0].lastHash&&item.lastFingerprint===candidateRuns[0].lastFingerprint));assert.ok(candidateRuns.every(item=>item.checksum===baselineRuns[0].checksum&&item.lastHash===baselineRuns[0].lastHash&&item.lastFingerprint===baselineRuns[0].lastFingerprint));
const baselineMedian=median(baselineRuns.map(item=>item.durationMs)),candidateMedian=median(candidateRuns.map(item=>item.durationMs)),saved=baselineMedian-candidateMedian;
console.log(JSON.stringify({ok:true,benchmark:"native-classified-byte-metrics",seedMessages:seed.length,growthSteps,rounds,baseline:{medianDurationMs:baselineMedian,runsMs:baselineRuns.map(item=>item.durationMs)},candidate:{medianDurationMs:candidateMedian,runsMs:candidateRuns.map(item=>item.durationMs)},savings:{medianDurationMs:Number(saved.toFixed(3)),medianPercent:Number((saved/baselineMedian*100).toFixed(2))},note:"Deterministic local Native request-metrics benchmark on top of the production tool-schema, message-serialization, current-turn, history-hash, and append-only message-classification caches. Baseline rescans every classified fragment array to sum UTF-8 bytes each inference; candidate carries those exact item-byte sums forward while classifying new messages. All metric checksums, history hashes, and full tool-schema fingerprints are identical."},null,2));
