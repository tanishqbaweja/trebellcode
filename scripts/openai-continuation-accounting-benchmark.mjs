import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { OpenAiResponseContinuationTracker, openAiContinuationOutputItems } from "../src/openai-response-continuation.mjs";

function digest(value){return createHash("sha256").update(JSON.stringify(value)).digest("hex")}

function oldPrepare(fullBody,parent){
  const input=Array.isArray(fullBody?.input)?fullBody.input:[],fullInputDigests=input.map(digest),prefix=parent.conversationDigests;
  for(let index=0;index<prefix.length;index++)if(prefix[index]!==fullInputDigests[index])return {used:false,savedRequestBytes:0};
  const delta=input.slice(prefix.length),candidate={...fullBody,input:delta,previous_response_id:"resp-parent"};
  return {used:true,savedRequestBytes:Math.max(0,Buffer.byteLength(JSON.stringify(fullBody),"utf8")-Buffer.byteLength(JSON.stringify(candidate),"utf8"))};
}

function median(values){const sorted=[...values].sort((a,b)=>a-b),middle=Math.floor(sorted.length/2);return sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2}
function measure(fn,{rounds=25,batch=3}={}){const samples=[];for(let round=0;round<rounds;round++){const started=performance.now();for(let index=0;index<batch;index++)fn();samples.push((performance.now()-started)/batch)}return median(samples)}

const tracker=new OpenAiResponseContinuationTracker(),tools=Array.from({length:12},(_,index)=>({type:"function",name:`tool_${index}`,parameters:{type:"object",properties:{path:{type:"string"}}}}));
const prefixInput=[];
for(let index=0;index<240;index++)prefixInput.push({type:"function_call_output",call_id:`call-${index}`,output:`result-${index}:`+"x".repeat(3000)});
const firstBody={model:"gpt-5.6",instructions:"Stable Trebell Native instructions",tools,input:prefixInput,stream:true,prompt_cache_key:"stable-key"},first=tracker.prepare(firstBody),turn={model:"gpt-5.6",text:"",toolCalls:[{id:"tail-call",namespace:"trebell_workspace",name:"read_file",arguments:{path:"src/tail.mjs"}}]};
tracker.record("resp-parent",first,turn);const parent=tracker.entries.get("resp-parent"),delta={type:"function_call_output",call_id:"tail-call",output:"tail-result"},fullBody={...firstBody,input:[...prefixInput,...openAiContinuationOutputItems(turn),delta]};

const candidate=tracker.prepare(fullBody,"resp-parent"),baseline=oldPrepare(fullBody,parent);assert.equal(candidate.used,true);assert.equal(baseline.used,true);assert.equal(candidate.savedRequestBytes,baseline.savedRequestBytes);
for(let index=0;index<5;index++){oldPrepare(fullBody,parent);tracker.prepare(fullBody,"resp-parent")}
const baselineMs=measure(()=>oldPrepare(fullBody,parent)),candidateMs=measure(()=>tracker.prepare(fullBody,"resp-parent")),savedPercent=baselineMs>0?((baselineMs-candidateMs)/baselineMs)*100:0;
console.log(JSON.stringify({
  ok:true,benchmark:"openai-continuation-accounting",inputItems:fullBody.input.length,serializedFullRequestBytes:Buffer.byteLength(JSON.stringify(fullBody),"utf8"),savedRequestBytes:candidate.savedRequestBytes,
  baselineMedianPrepareMs:Number(baselineMs.toFixed(3)),candidateMedianPrepareMs:Number(candidateMs.toFixed(3)),medianPrepareReductionPercent:Number(savedPercent.toFixed(2)),
  note:"Local CPU/allocation benchmark of continuation preparation only. It does not measure provider latency, billing, or network time.",
},null,2));
