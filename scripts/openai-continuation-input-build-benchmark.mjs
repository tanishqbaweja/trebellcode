import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { ProviderManager } from "../src/provider-manager.mjs";
import { NATIVE_OPENAI_CONTINUATION_IDENTITY } from "../src/openai-response-continuation.mjs";

const seedPairs=1500,turns=50,rounds=7;
const seedMessages=[
  {role:"system",content:"Stable Trebell Native instructions"},
  {role:"developer",content:"Stable project instructions"},
  {role:"user",content:"Repair and verify the repository."},
];
for(let index=0;index<seedPairs;index++){
  seedMessages.push(
    {role:"assistant",content:index%11===0?`Inspecting ${index}`:"",toolCalls:[{id:`seed-call-${index}`,namespace:"trebell_workspace",name:"read_file",arguments:{path:`src/file-${index}.mjs`}}]},
    {role:"tool",toolCallId:`seed-call-${index}`,content:`export const value${index}=${index};\n${"x".repeat(650)}`},
  );
}
const tools=[];
function median(values){const ordered=[...values].sort((a,b)=>a-b);return ordered[Math.floor(ordered.length/2)]}

async function run(reuseOpenAiContinuationInputBuild,{captureBodies=false}={}){
  global.gc?.();
  const root=mkdtempSync(join(tmpdir(),"trebell-openai-continuation-input-build-")),bodies=[];
  try{
    let requestIndex=0;
    const manager=new ProviderManager({
      env:{TREBELL_HOME:root},
      reuseOpenAiContinuationInputBuild,
      fetchFn:async(_url,init={})=>{
        const wireBody=String(init.body||"{}"),body=JSON.parse(wireBody);if(captureBodies)bodies.push(wireBody);
        const index=requestIndex++,callId=`call-${index}`;
        return Response.json({
          id:`resp-${index}`,model:body.model,status:"completed",
          output:[{type:"function_call",call_id:callId,name:"trebell_terminal__run",arguments:JSON.stringify({command:"node",args:[`verify-${index}.mjs`]})}],
          usage:{input_tokens:1,output_tokens:1,total_tokens:2},
        });
      },
    });
    manager.setKey("openai","benchmark-key");
    const messages=[...seedMessages],identityToken={};let previousResponseId="",checksum=0,reused=0;
    const started=performance.now();
    for(let index=0;index<turns;index++){
      const result=await manager.turn("openai",{
        model:"gpt-5.6",messages,tools,promptCacheComparisonResponseId:previousResponseId,
        [NATIVE_OPENAI_CONTINUATION_IDENTITY]:identityToken,
      });
      const continuation=result.telemetry?.responseContinuation;if(continuation?.inputBuildReused)reused++;
      checksum+=Number(continuation?.fullInputCount||0)+Number(continuation?.deltaInputCount||0)+Number(continuation?.savedRequestBytes||0);
      previousResponseId=result.id;
      const call=result.toolCalls[0];
      messages.push(
        {role:"assistant",content:result.text,toolCalls:result.toolCalls},
        {role:"tool",toolCallId:call.id,content:`result-${index} ${"r".repeat(800)}`},
      );
    }
    return {durationMs:performance.now()-started,checksum,reused,bodies};
  }finally{
    rmSync(root,{recursive:true,force:true});
  }
}

const baselineProof=await run(false,{captureBodies:true}),candidateProof=await run(true,{captureBodies:true});
assert.deepEqual(candidateProof.bodies,baselineProof.bodies,"optimized continuation must send byte-identical provider request JSON");
assert.equal(candidateProof.checksum,baselineProof.checksum);
assert.equal(baselineProof.reused,0);assert.equal(candidateProof.reused,turns-1);

for(let warm=0;warm<2;warm++){await run(false);await run(true)}
const baselineRuns=[],candidateRuns=[];
for(let round=0;round<rounds;round++){
  if(round%2===0){baselineRuns.push(await run(false));candidateRuns.push(await run(true))}
  else{candidateRuns.push(await run(true));baselineRuns.push(await run(false))}
}
assert.ok(baselineRuns.every(item=>item.checksum===candidateRuns[0].checksum&&item.reused===0));
assert.ok(candidateRuns.every(item=>item.checksum===baselineRuns[0].checksum&&item.reused===turns-1));
const baselineMedian=median(baselineRuns.map(item=>item.durationMs)),candidateMedian=median(candidateRuns.map(item=>item.durationMs)),saved=baselineMedian-candidateMedian;
console.log(JSON.stringify({
  ok:true,benchmark:"openai-continuation-input-build",seedCanonicalMessages:seedMessages.length,turns,rounds,
  baseline:{medianDurationMs:Number(baselineMedian.toFixed(3)),runsMs:baselineRuns.map(item=>Number(item.durationMs.toFixed(3)))},
  candidate:{medianDurationMs:Number(candidateMedian.toFixed(3)),runsMs:candidateRuns.map(item=>Number(item.durationMs.toFixed(3))),suffixBuildTurns:candidateRuns[0].reused},
  savings:{medianDurationMs:Number(saved.toFixed(3)),medianPercent:Number((saved/baselineMedian*100).toFixed(2))},
  note:"Deterministic zero-network-latency ProviderManager benchmark. Both variants retain fingerprint reuse and strict continuation; the candidate additionally avoids rebuilding provider input for the already-proven canonical prefix. Every provider request body is asserted byte-identical and continuation accounting checksums are asserted identical.",
},null,2));
