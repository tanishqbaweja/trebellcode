import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { attachNativePromptProvenance, nativeRequestMetrics, NATIVE_TOOL_SCHEMA_FINGERPRINT } from "../src/native-request-metrics.mjs";
import { platformDynamicToolNamespaces } from "../src/platform-tool-catalog.mjs";

const seed=[{role:"system",content:"Stable system "+"s".repeat(3000)},{role:"developer",content:"Stable developer "+"d".repeat(2200)}];
for(let index=0;index<1200;index++)seed.push({role:"assistant",content:`prior-${index} `+"a".repeat(300)},{role:"tool",toolCallId:`prior-tool-${index}`,content:`prior-result-${index} `+"r".repeat(500)});
const entries=[];for(let index=0;index<180;index++)entries.push({kind:index%3===0?"application":"untrusted",value:`context-${index}:`+"c".repeat(700)});
const contextText="Trebell generated context\n"+entries.map(item=>item.value).join("\n"),user=attachNativePromptProvenance({role:"user",content:"Repair the repository and verify it."},{userParts:[{type:"text",text:"Repair the repository and verify it."}],contextText,contextEntries:entries}),tools=platformDynamicToolNamespaces({repository:true,progressiveRepository:true,workspaceTools:true,terminal:true,output:true,browser:false,computer:false,sourceControl:false,delegation:false}),growthSteps=80,rounds=9;
const median=values=>{const ordered=[...values].sort((a,b)=>a-b);return ordered[Math.floor(values.length/2)]};

function run(cached){
  global.gc?.();const messages=[...seed,user],toolCache=new WeakMap(),messageCache=new WeakMap(),historyHashCache={},classificationCache={},currentTurnBreakdownCache=cached?new WeakMap():null,started=performance.now();let checksum=0,lastHash="",lastFingerprint="";
  for(let step=0;step<growthSteps;step++){
    messages.push({role:"assistant",content:`new-answer-${step} `+"x".repeat(360)},{role:"tool",toolCallId:`new-tool-${step}`,content:`new-result-${step} `+"y".repeat(640)});
    const result=nativeRequestMetrics(messages,tools,{toolSchemaCache:toolCache,messageSerializationCache:messageCache,historyHashCache,messageClassificationCache:classificationCache,...(currentTurnBreakdownCache?{currentTurnBreakdownCache}:{})});
    checksum+=result.currentUser.bytes+result.workingContext.bytes+result.applicationContext.bytes+result.untrustedContext.bytes+result.contextEnvelope.bytes+result.totalLogical.bytes;lastHash=result.conversationHistoryHash;lastFingerprint=result[NATIVE_TOOL_SCHEMA_FINGERPRINT];
  }
  return {durationMs:Number((performance.now()-started).toFixed(3)),checksum,lastHash,lastFingerprint};
}

for(let warm=0;warm<3;warm++){run(false);run(true)}
const baselineRuns=[],candidateRuns=[];for(let round=0;round<rounds;round++){if(round%2===0){baselineRuns.push(run(false));candidateRuns.push(run(true))}else{candidateRuns.push(run(true));baselineRuns.push(run(false))}}
assert.ok(baselineRuns.every(item=>item.checksum===candidateRuns[0].checksum&&item.lastHash===candidateRuns[0].lastHash&&item.lastFingerprint===candidateRuns[0].lastFingerprint));assert.ok(candidateRuns.every(item=>item.checksum===baselineRuns[0].checksum&&item.lastHash===baselineRuns[0].lastHash&&item.lastFingerprint===baselineRuns[0].lastFingerprint));
const baselineMedian=median(baselineRuns.map(item=>item.durationMs)),candidateMedian=median(candidateRuns.map(item=>item.durationMs)),saved=baselineMedian-candidateMedian;
console.log(JSON.stringify({ok:true,benchmark:"native-current-turn-breakdown-cache",seedMessages:seed.length+1,contextBytes:Buffer.byteLength(contextText,"utf8"),contextEntries:entries.length,growthSteps,rounds,baseline:{medianDurationMs:baselineMedian,runsMs:baselineRuns.map(item=>item.durationMs)},candidate:{medianDurationMs:candidateMedian,runsMs:candidateRuns.map(item=>item.durationMs)},savings:{medianDurationMs:Number(saved.toFixed(3)),medianPercent:Number((saved/baselineMedian*100).toFixed(2))},note:"Deterministic local Native request-metrics benchmark with one large immutable current user/context envelope reused across an 80-inference turn. Both variants use the production tool-schema, message-serialization, history-hash, and message-classification caches; candidate additionally memoizes only the current-turn breakdown by exact user-message/provenance identity. All measured bytes, history hashes, and full tool-schema fingerprints are identical."},null,2));
