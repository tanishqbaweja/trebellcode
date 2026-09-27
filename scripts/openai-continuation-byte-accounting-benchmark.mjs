import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { OpenAiResponseContinuationTracker, openAiContinuationOutputItems } from "../src/openai-response-continuation.mjs";

const seedInput=[],seedRefs=[];
for(let index=0;index<4000;index++){
  seedInput.push({type:"message",role:index%2?"assistant":"user",content:[{type:index%2?"output_text":"input_text",text:`history-${index} `+"x".repeat(420)}]});
  seedRefs.push({role:index%2?"assistant":"user",content:`history-${index}`});
}
const body=input=>({model:"gpt-5.6",instructions:"Stable Trebell Native instructions",tools:[],input,stream:true,prompt_cache_key:"stable-key"}),turns=70,rounds=7,iterationsPerMeasurement=6;
const median=values=>{const ordered=[...values].sort((a,b)=>a-b);return ordered[Math.floor(values.length/2)]};

function run(reuseByteAccounting,{capture=false}={}){
  const tracker=new OpenAiResponseContinuationTracker({reuseByteAccounting}),input=[...seedInput],refs=[...seedRefs],token={};let previous="",checksum=0;const proof=[];
  for(let index=0;index<turns;index++){
    const full=body(input),prepared=tracker.prepare(full,previous,{messageRefs:refs,identityToken:token});checksum+=prepared.deltaInputCount+prepared.fullInputCount+prepared.savedRequestBytes;if(capture)proof.push({used:prepared.used,parentId:prepared.parentId,deltaInputCount:prepared.deltaInputCount,fullInputCount:prepared.fullInputCount,savedRequestBytes:prepared.savedRequestBytes,body:JSON.stringify(prepared.body),digests:prepared.fullInputDigests});
    const call={id:`call-${index}`,namespace:"trebell_terminal",name:"run",arguments:{command:"node",args:[`verify-${index}.mjs`]}},turn={model:"gpt-5.6",text:"",toolCalls:[call]},responseId=`resp-${index}`;tracker.record(responseId,prepared,turn);previous=responseId;
    input.push(...openAiContinuationOutputItems(turn),{type:"function_call_output",call_id:call.id,output:`result-${index} `+"r".repeat(900)});refs.push({role:"assistant",content:"",toolCalls:[call]},{role:"tool",toolCallId:call.id,content:`result-${index}`});
  }
  return {checksum,proof};
}

function measure(reuseByteAccounting){global.gc?.();const started=performance.now();let checksum=0;for(let index=0;index<iterationsPerMeasurement;index++)checksum+=run(reuseByteAccounting).checksum;return {durationMs:performance.now()-started,checksum}}

const baselineProof=run(false,{capture:true}),candidateProof=run(true,{capture:true});assert.equal(candidateProof.checksum,baselineProof.checksum);assert.deepEqual(candidateProof.proof,baselineProof.proof);
for(let warm=0;warm<2;warm++){measure(false);measure(true)}
const baselineRuns=[],candidateRuns=[];for(let round=0;round<rounds;round++){if(round%2===0){baselineRuns.push(measure(false));candidateRuns.push(measure(true))}else{candidateRuns.push(measure(true));baselineRuns.push(measure(false))}}
assert.ok(baselineRuns.every(item=>item.checksum===candidateRuns[0].checksum));assert.ok(candidateRuns.every(item=>item.checksum===baselineRuns[0].checksum));
const baselineMedian=median(baselineRuns.map(item=>item.durationMs)),candidateMedian=median(candidateRuns.map(item=>item.durationMs)),saved=baselineMedian-candidateMedian;
console.log(JSON.stringify({ok:true,benchmark:"openai-continuation-byte-accounting",seedInputItems:seedInput.length,turns,rounds,iterationsPerMeasurement,baseline:{medianDurationMs:Number(baselineMedian.toFixed(3)),runsMs:baselineRuns.map(item=>Number(item.durationMs.toFixed(3)))},candidate:{medianDurationMs:Number(candidateMedian.toFixed(3)),runsMs:candidateRuns.map(item=>Number(item.durationMs.toFixed(3)))},savings:{medianDurationMs:Number(saved.toFixed(3)),medianPercent:Number((saved/baselineMedian*100).toFixed(2))},note:"Both variants use the same continuation fingerprint reuse. The candidate carries the prior request fingerprint byte sum forward and sums only newly appended fingerprints when deriving exact saved-request-byte telemetry. Every continuation decision, body, digest sequence, count, and saved-byte metric is asserted identical."},null,2));
