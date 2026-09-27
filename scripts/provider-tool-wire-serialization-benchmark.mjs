import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { ProviderManager } from "../src/provider-manager.mjs";
import { nativeRequestMetrics, NATIVE_TOOL_SCHEMA_FINGERPRINT } from "../src/native-request-metrics.mjs";
import { platformDynamicToolNamespaces } from "../src/platform-tool-catalog.mjs";

const messages=[{role:"system",content:"Stable Trebell Native instructions"},{role:"user",content:"Repair the repository."}],rounds=7;

function manager(provider,reusePreSerializedToolJson){
  const home=mkdtempSync(join(tmpdir(),`trebell-${provider}-wire-json-bench-`)),bodies=[];
  const instance=new ProviderManager({env:{TREBELL_HOME:home},reusePreSerializedToolJson,fetchFn:async(_url,init={})=>{const body=String(init.body||"");bodies.push(body);const parsed=JSON.parse(body);if(provider==="openai")return Response.json({id:"resp",model:parsed.model,status:"completed",output:[],usage:{}});if(provider==="anthropic")return Response.json({id:"msg",type:"message",role:"assistant",model:parsed.model,content:[],stop_reason:"end_turn",usage:{}});return Response.json({id:"chat",model:parsed.model,choices:[{finish_reason:"stop",message:{role:"assistant",content:"ok"}}],usage:{}})}});const providerId=provider==="chat"?"hcnsec":provider;instance.setKey(providerId,provider==="openai"?"oa-key":provider==="anthropic"?"an-key":"hc-key");return {instance,home,bodies,providerId};
}

async function measure(provider,reusePreSerializedToolJson,request,iterations){
  const fixture=manager(provider,reusePreSerializedToolJson);
  try{
    for(let warm=0;warm<8;warm++)await fixture.instance.turn(fixture.providerId,request,{promptCaching:provider==="anthropic"});
    fixture.bodies.length=0;global.gc?.();const started=performance.now();
    for(let index=0;index<iterations;index++)await fixture.instance.turn(fixture.providerId,request,{promptCaching:provider==="anthropic"});
    const durationMs=performance.now()-started,first=fixture.bodies[0];assert.ok(fixture.bodies.every(body=>body===first));
    return {durationMs:Number(durationMs.toFixed(3)),wireBody:first};
  }finally{rmSync(fixture.home,{recursive:true,force:true})}
}

const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
async function benchmark(provider,name,tools,iterations){
  const metrics=nativeRequestMetrics(messages,tools),fingerprint=metrics[NATIVE_TOOL_SCHEMA_FINGERPRINT];assert.match(fingerprint,/^[a-f0-9]{64}$/);
  const request={model:provider==="openai"?"gpt-5.6":provider==="anthropic"?"claude-opus-4-8":"glm-5.3",messages,tools,[NATIVE_TOOL_SCHEMA_FINGERPRINT]:fingerprint},baselineRuns=[],candidateRuns=[];
  for(let round=0;round<rounds;round++){
    if(round%2===0){baselineRuns.push(await measure(provider,false,request,iterations));candidateRuns.push(await measure(provider,true,request,iterations))}
    else{candidateRuns.push(await measure(provider,true,request,iterations));baselineRuns.push(await measure(provider,false,request,iterations))}
  }
  assert.equal(candidateRuns[0].wireBody,baselineRuns[0].wireBody);
  const baselineMedian=median(baselineRuns.map(run=>run.durationMs)),candidateMedian=median(candidateRuns.map(run=>run.durationMs)),saved=Number((baselineMedian-candidateMedian).toFixed(3));
  return {name,toolNamespaces:tools.length,toolFunctions:tools.reduce((sum,entry)=>sum+(entry.tools?.length||0),0),canonicalToolSchemaBytes:metrics.toolSchemas.bytes,iterationsPerRound:iterations,baseline:{medianDurationMs:baselineMedian,runsMs:baselineRuns.map(run=>run.durationMs)},candidate:{medianDurationMs:candidateMedian,runsMs:candidateRuns.map(run=>run.durationMs)},savings:{medianDurationMs:saved,medianPercent:Number((saved/baselineMedian*100).toFixed(2))}};
}

const actualTools=platformDynamicToolNamespaces({repository:true,progressiveRepository:true,workspaceTools:true,terminal:true,output:true,browser:false,computer:false,sourceControl:false,delegation:false});
const stressTools=Array.from({length:18},(_,namespace)=>({type:"namespace",name:`namespace_${namespace}`,description:"Namespace "+"n".repeat(260),tools:Array.from({length:7},(_,index)=>({name:`tool_${index}`,description:"Tool "+"d".repeat(520),inputSchema:{type:"object",properties:Object.fromEntries(Array.from({length:10},(_,field)=>[`field_${field}`,{type:"string",description:"Field "+"f".repeat(120)}])),additionalProperties:false}}))}));
const openAiActual=await benchmark("openai","openai-current-native-surface",actualTools,500),openAiStress=await benchmark("openai","openai-large-schema-stress",stressTools,120),anthropicActual=await benchmark("anthropic","anthropic-current-native-surface",actualTools,500),anthropicStress=await benchmark("anthropic","anthropic-large-schema-stress",stressTools,120),chatActual=await benchmark("chat","chat-current-native-surface",actualTools,500),chatStress=await benchmark("chat","chat-large-schema-stress",stressTools,120);
console.log(JSON.stringify({ok:true,benchmark:"provider-pre-serialized-tool-wire-json",rounds,wireByteIdentical:true,openai:{actual:openAiActual,stress:openAiStress},anthropic:{actual:anthropicActual,stress:anthropicStress},chat:{actual:chatActual,stress:chatStress},note:"Deterministic local ProviderManager benchmark with zero-latency fake providers. Both sides use the existing manifest caches; the candidate splices only the trusted pre-serialized top-level tools array into otherwise normal JSON serialization, and final wire bodies are asserted byte-identical."},null,2));
