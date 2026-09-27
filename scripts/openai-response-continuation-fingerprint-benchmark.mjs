import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { OpenAiResponseContinuationTracker, openAiContinuationOutputItems } from "../src/openai-response-continuation.mjs";

const seedInput=[];const seedRefs=[];
for(let index=0;index<4000;index++){
  seedInput.push({type:"message",role:index%2?"assistant":"user",content:[{type:index%2?"output_text":"input_text",text:`history-${index} `+"x".repeat(420)}]});
  seedRefs.push({role:index%2?"assistant":"user",content:`history-${index}`});
}
const body=input=>({model:"gpt-5.6",instructions:"Stable Trebell Native instructions",tools:[],input,stream:true,prompt_cache_key:"stable-key"}),turns=70,rounds=9;
function median(values){const ordered=[...values].sort((a,b)=>a-b);return ordered[Math.floor(values.length/2)]}

function run(accelerated){
  global.gc?.();const tracker=new OpenAiResponseContinuationTracker(),input=[...seedInput],refs=[...seedRefs],token=accelerated?{}:null,started=performance.now();let previous="",checksum=0,fastPrefixItems=0;
  for(let index=0;index<turns;index++){
    const full=body(input),prepared=tracker.prepare(full,previous,accelerated?{messageRefs:refs,identityToken:token}:undefined);checksum+=prepared.deltaInputCount+prepared.fullInputCount+prepared.savedRequestBytes;fastPrefixItems+=Number(prepared.fastPrefixCount||0);
    const call={id:`call-${index}`,namespace:"trebell_terminal",name:"run",arguments:{command:"node",args:[`verify-${index}.mjs`]}},turn={model:"gpt-5.6",text:"",toolCalls:[call]},responseId=`resp-${index}`;tracker.record(responseId,prepared,turn);previous=responseId;
    input.push(...openAiContinuationOutputItems(turn),{type:"function_call_output",call_id:call.id,output:`result-${index} `+"r".repeat(900)});
    refs.push({role:"assistant",content:"",toolCalls:[call]},{role:"tool",toolCallId:call.id,content:`result-${index}`});
  }
  return {durationMs:Number((performance.now()-started).toFixed(3)),checksum,fastPrefixItems};
}

const slowProof=new OpenAiResponseContinuationTracker(),fastProof=new OpenAiResponseContinuationTracker(),proofInput=[...seedInput.slice(0,10)],proofRefs=[...seedRefs.slice(0,10)],proofToken={},slowFirst=slowProof.prepare(body(proofInput)),fastFirst=fastProof.prepare(body(proofInput),"",{messageRefs:proofRefs,identityToken:proofToken}),proofTurn={model:"gpt-5.6",text:"",toolCalls:[{id:"proof-call",namespace:"trebell_terminal",name:"run",arguments:{command:"node",args:["verify.mjs"]}}]};
slowProof.record("slow-parent",slowFirst,proofTurn);fastProof.record("fast-parent",fastFirst,proofTurn);proofInput.push(...openAiContinuationOutputItems(proofTurn),{type:"function_call_output",call_id:"proof-call",output:"failed"});proofRefs.push({role:"assistant",content:"",toolCalls:proofTurn.toolCalls},{role:"tool",toolCallId:"proof-call",content:"failed"});const slowSecond=slowProof.prepare(body(proofInput),"slow-parent"),fastSecond=fastProof.prepare(body(proofInput),"fast-parent",{messageRefs:proofRefs,identityToken:proofToken});assert.equal(fastSecond.fastPrefixCount,10);assert.deepEqual(fastSecond.body.input,slowSecond.body.input);assert.equal(fastSecond.savedRequestBytes,slowSecond.savedRequestBytes);assert.deepEqual(fastSecond.fullInputDigests,slowSecond.fullInputDigests);

for(let warm=0;warm<3;warm++){run(false);run(true)}
const baselineRuns=[],candidateRuns=[];for(let round=0;round<rounds;round++){if(round%2===0){baselineRuns.push(run(false));candidateRuns.push(run(true))}else{candidateRuns.push(run(true));baselineRuns.push(run(false))}}
assert.ok(baselineRuns.every(item=>item.checksum===candidateRuns[0].checksum));assert.ok(candidateRuns.every(item=>item.checksum===baselineRuns[0].checksum));assert.ok(candidateRuns.every(item=>item.fastPrefixItems>0));
const baselineMedian=median(baselineRuns.map(item=>item.durationMs)),candidateMedian=median(candidateRuns.map(item=>item.durationMs)),saved=Number((baselineMedian-candidateMedian).toFixed(3));
console.log(JSON.stringify({ok:true,benchmark:"openai-response-continuation-fingerprint-reuse",seedInputItems:seedInput.length,turns,rounds,baseline:{medianDurationMs:baselineMedian,runsMs:baselineRuns.map(item=>item.durationMs)},candidate:{medianDurationMs:candidateMedian,runsMs:candidateRuns.map(item=>item.durationMs)},savings:{medianDurationMs:saved,medianPercent:Number((saved/baselineMedian*100).toFixed(2))},candidateFastPrefixItemsMedian:median(candidateRuns.map(item=>item.fastPrefixItems)),note:"Deterministic local continuation-tracker benchmark. The candidate reuses prior request fingerprints only when a per-Native-turn identity token and canonical message-object prefix prove the old request unchanged; delta body, saved-byte accounting, and full input digests are asserted identical."},null,2));
