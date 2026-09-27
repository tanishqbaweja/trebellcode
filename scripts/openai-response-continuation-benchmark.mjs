import assert from "node:assert/strict";
import { OpenAiResponseContinuationTracker, openAiContinuationOutputItems } from "../src/openai-response-continuation.mjs";

const tracker=new OpenAiResponseContinuationTracker(),turns=20,tools=Array.from({length:12},(_,index)=>({type:"function",name:"tool_"+index,description:"Stable coding tool "+index,parameters:{type:"object",properties:{path:{type:"string"}},required:["path"]}}));
let input=[{type:"message",role:"user",content:[{type:"input_text",text:"Fix the repository issue and verify it."}]}],previous="",fullBytes=0,continuedBytes=0,continuations=0;
for(let index=0;index<turns;index++){
  const full={model:"gpt-5.6",instructions:"Stable Trebell Native instructions",tools,input,parallel_tool_calls:true,stream:true,prompt_cache_key:"stable-key"},prep=tracker.prepare(full,previous);
  fullBytes+=Buffer.byteLength(JSON.stringify(full),"utf8");continuedBytes+=Buffer.byteLength(JSON.stringify(prep.body),"utf8");if(prep.used)continuations++;
  const call={id:"call-"+index,namespace:"trebell_workspace",name:"read_file",arguments:JSON.stringify({path:`src/file-${index}.mjs`})},turn={model:"gpt-5.6",text:"",toolCalls:[call]},responseId="resp-"+index;
  tracker.record(responseId,prep,turn);previous=responseId;
  input=[...input,...openAiContinuationOutputItems(turn),{type:"function_call_output",call_id:call.id,output:"x".repeat(1200)+index}];
}
assert.equal(continuations,turns-1);assert.ok(continuedBytes<fullBytes);
console.log(JSON.stringify({ok:true,benchmark:"openai-response-continuation-wire",turns,continuations,fullRequestBytes:fullBytes,continuedRequestBytes:continuedBytes,savedRequestBytes:fullBytes-continuedBytes,savedPercent:Number((((fullBytes-continuedBytes)/fullBytes)*100).toFixed(2))},null,2));
