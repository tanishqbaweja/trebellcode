import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { ProviderManager } from "../src/provider-manager.mjs";
import { NATIVE_CHAT_MESSAGE_CACHE_IDENTITY } from "../src/provider-turn.mjs";

const seedPairs=900,turns=50,rounds=7,seed=[{role:"system",content:"Stable system"},{role:"developer",content:"Stable developer"},{role:"user",content:"Repair and verify"}];
for(let index=0;index<seedPairs;index++)seed.push({role:"assistant",content:index%7===0?`Inspecting ${index}`:"",toolCalls:[{id:`c-${index}`,namespace:"trebell_workspace",name:"read_file",arguments:{path:`src/file-${index}.mjs`}}]},{role:"tool",toolCallId:`c-${index}`,content:`result-${index} `+"r".repeat(520)});
const median=values=>{const ordered=[...values].sort((a,b)=>a-b);return ordered[Math.floor(values.length/2)]};

async function run(reuseChatMessageConversion,{capture=false}={}){
  global.gc?.();const root=mkdtempSync(join(tmpdir(),"trebell-chat-message-cache-")),wire=[];
  try{
    let responseIndex=0;
    const manager=new ProviderManager({env:{TREBELL_HOME:root},reuseChatMessageConversion,fetchFn:async(_url,init={})=>{const body=String(init.body||"{}");wire.push({bytes:Buffer.byteLength(body,"utf8"),hash:createHash("sha256").update(body).digest("hex")});const index=responseIndex++;return Response.json({id:`chat-${index}`,model:"deepseek-v4.1",choices:[{message:{role:"assistant",content:"",tool_calls:[{id:`call-${index}`,type:"function",function:{name:"trebell_terminal__run",arguments:JSON.stringify({command:"node",args:[`verify-${index}.mjs`]})}}]},finish_reason:"tool_calls"}],usage:{input_tokens:1,output_tokens:1,total_tokens:2}})}});manager.setKey("vyceai","benchmark-key");
    const messages=[...seed],identity={};let checksum=0;const started=performance.now();
    for(let index=0;index<turns;index++){
      const result=await manager.turn("vyceai",{model:"deepseek-v4.1",messages,tools:[],[NATIVE_CHAT_MESSAGE_CACHE_IDENTITY]:identity});checksum+=Number(result.telemetry?.requestBytes||0);const call=result.toolCalls[0];messages.push({role:"assistant",content:result.text,toolCalls:result.toolCalls},{role:"tool",toolCallId:call.id,content:`verify-result-${index} `+"x".repeat(700)});
    }
    return {durationMs:performance.now()-started,checksum,wire:capture?wire:wire.map(item=>item.hash)};
  }finally{rmSync(root,{recursive:true,force:true})}
}

const baselineProof=await run(false,{capture:true}),candidateProof=await run(true,{capture:true});assert.deepEqual(candidateProof.wire,baselineProof.wire);assert.equal(candidateProof.checksum,baselineProof.checksum);
for(let warm=0;warm<2;warm++){await run(false);await run(true)}
const baselineRuns=[],candidateRuns=[];for(let round=0;round<rounds;round++){if(round%2===0){baselineRuns.push(await run(false));candidateRuns.push(await run(true))}else{candidateRuns.push(await run(true));baselineRuns.push(await run(false))}}
assert.ok(baselineRuns.every(item=>item.checksum===candidateRuns[0].checksum));assert.ok(candidateRuns.every(item=>item.checksum===baselineRuns[0].checksum));
const baselineMedian=median(baselineRuns.map(item=>item.durationMs)),candidateMedian=median(candidateRuns.map(item=>item.durationMs)),saved=baselineMedian-candidateMedian;
console.log(JSON.stringify({ok:true,benchmark:"native-chat-message-conversion-cache",seedCanonicalMessages:seed.length,turns,rounds,baseline:{medianDurationMs:Number(baselineMedian.toFixed(3)),runsMs:baselineRuns.map(item=>Number(item.durationMs.toFixed(3)))},candidate:{medianDurationMs:Number(candidateMedian.toFixed(3)),runsMs:candidateRuns.map(item=>Number(item.durationMs.toFixed(3)))},savings:{medianDurationMs:Number(saved.toFixed(3)),medianPercent:Number((saved/baselineMedian*100).toFixed(2))},note:"Deterministic zero-network-latency ProviderManager benchmark for an OpenAI-compatible Chat route. The candidate caches canonical-message to Chat-message conversion and each converted message's exact JSON fragment only inside one hidden Native turn identity; the complete messages array/request string is still assembled every turn. Every request body SHA-256 and byte length is asserted identical."},null,2));
