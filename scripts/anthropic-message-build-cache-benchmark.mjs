import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { ProviderManager } from "../src/provider-manager.mjs";
import { NATIVE_OPENAI_CONTINUATION_IDENTITY } from "../src/openai-response-continuation.mjs";
import { NATIVE_TOOL_SCHEMA_FINGERPRINT } from "../src/native-request-metrics.mjs";

const seedPairs=1500,turns=60,rounds=7,seedMessages=[{role:"system",content:"Stable Anthropic coding instructions"},{role:"developer",content:"Stable project rules"},{role:"user",content:"Repair and verify."}];
for(let index=0;index<seedPairs;index++)seedMessages.push({role:"assistant",content:"",toolCalls:[{id:`seed-call-${index}`,namespace:"trebell_workspace",name:"read_file",arguments:{path:`src/file-${index}.mjs`}}]},{role:"tool",toolCallId:`seed-call-${index}`,content:`file-${index}\n${"x".repeat(850)}`});
const tools=[{type:"namespace",name:"trebell_terminal",description:"Terminal",tools:[{name:"run",description:"Run an argv-style command",inputSchema:{type:"object",properties:{command:{type:"string"},args:{type:"array",items:{type:"string"}}},required:["command"],additionalProperties:false}}]}],toolFingerprint="a".repeat(64);
const median=values=>{const ordered=[...values].sort((a,b)=>a-b);return ordered[Math.floor(ordered.length/2)]};

async function run(reuseAnthropicMessageBuild,{captureBodies=false}={}){
  global.gc?.();const root=mkdtempSync(join(tmpdir(),"trebell-anthropic-message-build-")),bodies=[];
  try{
    let requestIndex=0;const manager=new ProviderManager({env:{TREBELL_HOME:root},reuseAnthropicMessageBuild,fetchFn:async(_url,init={})=>{const wireBody=String(init.body||"{}");if(captureBodies)bodies.push(wireBody);const body=JSON.parse(wireBody),index=requestIndex++,callId=`call-${index}`;return Response.json({id:`msg-${index}`,type:"message",role:"assistant",model:body.model,content:[{type:"tool_use",id:callId,name:"trebell_terminal__run",input:{command:"node",args:[`verify-${index}.mjs`]}}],stop_reason:"tool_use",usage:{input_tokens:1,output_tokens:1}})}});manager.setKey("anthropic","benchmark-key");
    const messages=[...seedMessages],identity={};let checksum=0;const started=performance.now();
    for(let index=0;index<turns;index++){
      const result=await manager.turn("anthropic",{model:"claude-opus-4-8",messages,tools,[NATIVE_TOOL_SCHEMA_FINGERPRINT]:toolFingerprint,[NATIVE_OPENAI_CONTINUATION_IDENTITY]:identity});checksum+=Number(result.usage?.inputTokens||0)+Number(result.usage?.outputTokens||0);const call=result.toolCalls[0];messages.push({role:"assistant",content:result.text,toolCalls:result.toolCalls},{role:"tool",toolCallId:call.id,content:`result-${index} ${"r".repeat(800)}`});
    }
    return {durationMs:Number((performance.now()-started).toFixed(3)),checksum,bodies};
  }finally{rmSync(root,{recursive:true,force:true})}
}

const baselineProof=await run(false,{captureBodies:true}),candidateProof=await run(true,{captureBodies:true});assert.deepEqual(candidateProof.bodies,baselineProof.bodies,"Anthropic incremental message build must keep every provider request byte-identical");assert.equal(candidateProof.checksum,baselineProof.checksum);
for(let warm=0;warm<2;warm++){await run(false);await run(true)}
const baselineRuns=[],candidateRuns=[];for(let round=0;round<rounds;round++){if(round%2===0){baselineRuns.push(await run(false));candidateRuns.push(await run(true))}else{candidateRuns.push(await run(true));baselineRuns.push(await run(false))}}
assert.ok(baselineRuns.every(item=>item.checksum===candidateRuns[0].checksum));assert.ok(candidateRuns.every(item=>item.checksum===baselineRuns[0].checksum));const baselineMedian=median(baselineRuns.map(item=>item.durationMs)),candidateMedian=median(candidateRuns.map(item=>item.durationMs)),saved=baselineMedian-candidateMedian;
console.log(JSON.stringify({ok:true,benchmark:"anthropic-message-build-cache",seedCanonicalMessages:seedMessages.length,turns,rounds,baseline:{medianDurationMs:baselineMedian,runsMs:baselineRuns.map(item=>item.durationMs)},candidate:{medianDurationMs:candidateMedian,runsMs:candidateRuns.map(item=>item.durationMs)},savings:{medianDurationMs:Number(saved.toFixed(3)),medianPercent:Number((saved/baselineMedian*100).toFixed(2))},note:"Deterministic zero-network-latency ProviderManager benchmark for direct Anthropic Native turns. Candidate reuses only the canonical-to-Anthropic message projection inside one hidden Native turn and revalidates prior shallow message refs before appending. Source replacement/shrinkage or unstable tool-call ids falls back to fresh conversion. Every provider request JSON body is asserted byte-identical."},null,2));
