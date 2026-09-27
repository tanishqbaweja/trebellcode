import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { ProviderManager } from "../src/provider-manager.mjs";
import { nativeRequestMetrics, NATIVE_TOOL_SCHEMA_FINGERPRINT } from "../src/native-request-metrics.mjs";
import { nativeSystemPrompt } from "../src/native-system-prompt.mjs";
import { platformDynamicToolNamespaces } from "../src/platform-tool-catalog.mjs";

const rounds=7;
function manager(cacheSize){
  const home=mkdtempSync(join(tmpdir(),"trebell-openai-cache-key-bench-")),bodies=[];
  const instance=new ProviderManager({env:{TREBELL_HOME:home},openAiToolManifestCacheSize:32,openAiPromptCacheKeyCacheSize:cacheSize,fetchFn:async(_url,init={})=>{const body=String(init.body||"");bodies.push(body);return {ok:true,status:200,headers:{get:()=>"application/json"},text:async()=>' {"id":"resp","model":"gpt-5.6","status":"completed","output":[],"usage":{}} '.trim()}}});
  instance.setKey("openai","oa-key");return {instance,home,bodies};
}
async function measure(cacheSize,request,iterations){
  const fixture=manager(cacheSize);
  try{
    for(let warm=0;warm<8;warm++)await fixture.instance.turn("openai",request);
    fixture.bodies.length=0;global.gc?.();const started=performance.now();
    for(let index=0;index<iterations;index++)await fixture.instance.turn("openai",request);
    const durationMs=performance.now()-started,first=fixture.bodies[0];assert.ok(fixture.bodies.every(body=>body===first));
    return {durationMs:Number(durationMs.toFixed(3)),wireBody:first};
  }finally{rmSync(fixture.home,{recursive:true,force:true})}
}
const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
async function benchmark(name,tools,iterations){
  const messages=[{role:"system",content:nativeSystemPrompt({tools,permissionMode:"supervised",projectless:false})},{role:"developer",content:"Follow repository-local instructions and preserve unrelated work."},{role:"user",content:"Repair the repository and verify the change."}],metrics=nativeRequestMetrics(messages,tools),request={model:"gpt-5.6",messages,tools,[NATIVE_TOOL_SCHEMA_FINGERPRINT]:metrics[NATIVE_TOOL_SCHEMA_FINGERPRINT]},baselineRuns=[],candidateRuns=[];
  for(let round=0;round<rounds;round++){
    if(round%2===0){baselineRuns.push(await measure(0,request,iterations));candidateRuns.push(await measure(128,request,iterations))}
    else{candidateRuns.push(await measure(128,request,iterations));baselineRuns.push(await measure(0,request,iterations))}
  }
  assert.equal(candidateRuns[0].wireBody,baselineRuns[0].wireBody);
  const baselineMedian=median(baselineRuns.map(run=>run.durationMs)),candidateMedian=median(candidateRuns.map(run=>run.durationMs)),saved=Number((baselineMedian-candidateMedian).toFixed(3));
  return {name,systemChars:String(messages[0].content).length,toolNamespaces:tools.length,toolFunctions:tools.reduce((sum,entry)=>sum+(entry.tools?.length||0),0),canonicalToolSchemaBytes:metrics.toolSchemas.bytes,iterationsPerRound:iterations,baseline:{medianDurationMs:baselineMedian,runsMs:baselineRuns.map(run=>run.durationMs)},candidate:{medianDurationMs:candidateMedian,runsMs:candidateRuns.map(run=>run.durationMs)},savings:{medianDurationMs:saved,medianPercent:Number((saved/baselineMedian*100).toFixed(2))}};
}

const actualTools=platformDynamicToolNamespaces({repository:true,progressiveRepository:true,workspaceTools:true,terminal:true,output:true,browser:false,computer:false,sourceControl:false,delegation:false});
const stressTools=Array.from({length:18},(_,namespace)=>({type:"namespace",name:`namespace_${namespace}`,description:"Namespace "+"n".repeat(260),tools:Array.from({length:7},(_,index)=>({name:`tool_${index}`,description:"Tool "+"d".repeat(520),inputSchema:{type:"object",properties:Object.fromEntries(Array.from({length:10},(_,field)=>[`field_${field}`,{type:"string",description:"Field "+"f".repeat(120)}])),additionalProperties:false}}))}));
const actual=await benchmark("current-native-coding-surface",actualTools,600),stress=await benchmark("large-schema-stress",stressTools,120);
console.log(JSON.stringify({ok:true,benchmark:"openai-prompt-cache-key-cache",rounds,wireByteIdentical:true,actual,stress,note:"Deterministic local ProviderManager benchmark with a zero-latency fake provider. The first request computes the existing prompt_cache_key formula; later identical stable-prefix requests reuse that exact string. Provider request JSON is asserted byte-identical."},null,2));
