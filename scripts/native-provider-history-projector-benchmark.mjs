import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { createDirectTerminalStatusProviderHistoryProjector } from "../src/native-tool-history.mjs";
import { nativeRequestMetrics, NATIVE_TOOL_SCHEMA_FINGERPRINT } from "../src/native-request-metrics.mjs";
import { platformDynamicToolNamespaces } from "../src/platform-tool-catalog.mjs";

const seed=[],growthSteps=70,rounds=9;
seed.push({role:"system",content:"Stable system "+"s".repeat(3000)},{role:"developer",content:"Stable developer "+"d".repeat(2200)});
for(let index=0;index<1800;index++){
  seed.push({role:"user",content:`request-${index} `+"u".repeat(260)},{role:"assistant",content:`answer-${index} `+"a".repeat(440)});
  if(index%2===0)seed.push({role:"tool",toolCallId:`tool-${index}`,content:`result-${index} `+"r".repeat(820)});
}
const tools=platformDynamicToolNamespaces({repository:true,progressiveRepository:true,workspaceTools:true,terminal:true,output:true,browser:false,computer:false,sourceControl:false,delegation:false});
const median=values=>{const ordered=[...values].sort((a,b)=>a-b);return ordered[Math.floor(values.length/2)]};

function legacyProjector(){
  return messages=>({messages:[...(Array.isArray(messages)?messages:[])],count:0,savedChars:0});
}

function run(candidate){
  global.gc?.();const messages=[...seed],project=candidate?createDirectTerminalStatusProviderHistoryProjector():legacyProjector(),toolCache=new WeakMap(),messageCache=new WeakMap(),historyHashCache={},messageClassificationCache={},started=performance.now();let checksum=0,lastHash="",lastFingerprint="";
  for(let step=0;step<growthSteps;step++){
    messages.push({role:"assistant",content:`new-answer-${step} `+"x".repeat(360)},{role:"tool",toolCallId:`new-tool-${step}`,content:`new-result-${step} `+"y".repeat(640)});
    const view=project(messages),result=nativeRequestMetrics(view.messages,tools,{toolSchemaCache:toolCache,messageSerializationCache:messageCache,historyHashCache,messageClassificationCache});
    checksum+=result.messages.bytes+result.conversationHistory.bytes+result.toolResults.bytes+result.totalLogical.bytes;lastHash=result.conversationHistoryHash;lastFingerprint=result[NATIVE_TOOL_SCHEMA_FINGERPRINT];
  }
  return {durationMs:Number((performance.now()-started).toFixed(3)),checksum,lastHash,lastFingerprint};
}

for(let warm=0;warm<3;warm++){run(false);run(true)}
const baselineRuns=[],candidateRuns=[];
for(let round=0;round<rounds;round++){if(round%2===0){baselineRuns.push(run(false));candidateRuns.push(run(true))}else{candidateRuns.push(run(true));baselineRuns.push(run(false))}}
assert.ok(baselineRuns.every(item=>item.checksum===candidateRuns[0].checksum&&item.lastHash===candidateRuns[0].lastHash&&item.lastFingerprint===candidateRuns[0].lastFingerprint));
assert.ok(candidateRuns.every(item=>item.checksum===baselineRuns[0].checksum&&item.lastHash===baselineRuns[0].lastHash&&item.lastFingerprint===baselineRuns[0].lastFingerprint));
const baselineMedian=median(baselineRuns.map(item=>item.durationMs)),candidateMedian=median(candidateRuns.map(item=>item.durationMs)),saved=Number((baselineMedian-candidateMedian).toFixed(3));
console.log(JSON.stringify({ok:true,benchmark:"native-provider-history-projector-identity",seedMessages:seed.length,growthSteps,rounds,baseline:{medianDurationMs:baselineMedian,runsMs:baselineRuns.map(item=>item.durationMs)},candidate:{medianDurationMs:candidateMedian,runsMs:candidateRuns.map(item=>item.durationMs)},savings:{medianDurationMs:saved,medianPercent:Number((saved/baselineMedian*100).toFixed(2))},note:"Deterministic local Native provider-history + request-metrics benchmark for the common no-direct-status-compaction path. Baseline mirrors the old projector behavior by returning a fresh full message array each turn; candidate returns the canonical source array unchanged until a real compaction is needed, allowing append-only metrics caches to stay hot. All measured metrics, history hashes, and full tool-schema fingerprints are asserted identical."},null,2));
