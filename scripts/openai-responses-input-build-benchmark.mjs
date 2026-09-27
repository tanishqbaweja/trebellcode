import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { providerTurnToResponses } from "../src/provider-turn.mjs";

const toolPairs=600,iterations=40,rounds=6,messages=[{role:"system",content:"Stable Trebell Native instructions"},{role:"user",content:"Repair the repository and verify it."}];
for(let index=0;index<toolPairs;index++){
  messages.push({role:"assistant",content:"",toolCalls:[{id:`call-${index}`,namespace:"trebell_workspace",name:"read_file",arguments:JSON.stringify({path:`src/file-${index}.mjs`})}]});
  messages.push({role:"tool",toolCallId:`call-${index}`,content:`export const value${index} = ${index};\n${"x".repeat(900)}`});
}
const request={model:"gpt-5.6",messages,tools:[],parallelToolCalls:true};

function legacyCacheBreakpoints(input=[]){
  return input.map(item=>{
    if(item?.type!=="function_call_output")return item;
    const output=Array.isArray(item.output)?item.output.map(part=>part&&typeof part==="object"?{...part}:part):(typeof item.output==="string"&&item.output.length?[{type:"input_text",text:item.output}]:[]);
    let index=-1;for(let i=output.length-1;i>=0;i--)if(output[i]?.type==="input_text"){index=i;break}
    if(index<0)return item;output[index]={...output[index],prompt_cache_breakpoint:{mode:"explicit"}};return {...item,output};
  });
}

function legacyBuild(){
  const body=providerTurnToResponses(request,{preserveInstructionOrder:true});
  body.input=body.input.map(item=>{
    if(item?.type!=="function_call"||!item.namespace)return item;
    const next={...item,name:`${item.namespace}__${item.name}`};delete next.namespace;return next;
  });
  body.input=legacyCacheBreakpoints(body.input);return body;
}
function integratedBuild(){return providerTurnToResponses(request,{preserveInstructionOrder:true,flattenToolCallNames:true,toolResultCacheBreakpoints:true})}

const legacyJson=JSON.stringify(legacyBuild()),integratedJson=JSON.stringify(integratedBuild());assert.equal(integratedJson,legacyJson);
for(let i=0;i<8;i++){legacyBuild();integratedBuild()}
function measure(fn,inputItems){const started=performance.now();let seen=0;for(let i=0;i<iterations;i++)seen+=fn().input.length;assert.equal(seen,inputItems*iterations);return performance.now()-started}
const inputItems=integratedBuild().input.length,legacyTimes=[],integratedTimes=[];
for(let round=0;round<rounds;round++){
  const order=round%2===0?[[legacyBuild,legacyTimes],[integratedBuild,integratedTimes]]:[[integratedBuild,integratedTimes],[legacyBuild,legacyTimes]];
  for(const [fn,target] of order)target.push(measure(fn,inputItems));
}
const average=values=>values.reduce((sum,value)=>sum+value,0)/values.length,legacyMs=average(legacyTimes),integratedMs=average(integratedTimes);
console.log(JSON.stringify({
  ok:true,benchmark:"openai-responses-integrated-input-transforms",toolPairs,inputItems,iterationsPerRound:iterations,rounds,
  wireBytes:Buffer.byteLength(integratedJson,"utf8"),wireByteIdentical:true,
  legacyExtraWholeHistoryPasses:2,integratedExtraWholeHistoryPasses:0,extraHistoryItemVisitsAvoidedPerBuild:inputItems*2,
  legacyAverageBuildMs:Number(legacyMs.toFixed(3)),integratedAverageBuildMs:Number(integratedMs.toFixed(3)),observedBuildTimeReductionPercent:Number((((legacyMs-integratedMs)/legacyMs)*100).toFixed(2)),
  note:"Local CPU microbenchmark only. The deterministic claim is byte-identical wire output with two post-conversion whole-history passes removed.",
},null,2));
