import assert from "node:assert/strict";
import { NativeAgentSession } from "../src/native-agent-session.mjs";
import { nativeRequestMetrics } from "../src/native-request-metrics.mjs";
import { ProviderManager } from "../src/provider-manager.mjs";

const apiKey=String(process.env.TREBELL_TEST_VYCE_API_KEY||process.env.VYCEAI_API_KEY||process.env.VYCE_API_KEY||"").trim();
if(!apiKey)throw new Error("Set TREBELL_TEST_VYCE_API_KEY, VYCEAI_API_KEY, or VYCE_API_KEY before running the Native search-dedupe benchmark.");

const env={...process.env,VYCEAI_API_KEY:apiKey},manager=new ProviderManager({env});
const catalog=await manager.models("vyceai"),requested=String(process.env.VYCE_MODEL||"deepseek-v4.1").trim(),model=catalog.models.includes(requested)?requested:catalog.models[0];
if(!model)throw new Error("Vyce did not advertise any model for the Native search-dedupe benchmark.");

const tools=[{
  type:"namespace",
  name:"trebell_repo",
  tools:[{
    type:"function",
    name:"search_code",
    description:"Search indexed repository source text.",
    inputSchema:{type:"object",properties:{query:{type:"string"}},required:["query"],additionalProperties:false},
  }],
}];
const searchResult={
  query:"needle",
  matches:Array.from({length:80},(_,index)=>({
    path:"src/file-"+String(index).padStart(2,"0")+".mjs",
    line:index+1,
    text:"needle match "+index+" "+"x".repeat(90),
  })),
};

function toolContent(request,toolCallId){
  return String((request?.messages||[]).find(message=>message?.role==="tool"&&message?.toolCallId===toolCallId)?.content||"");
}

const requests=[],events=[];
const session=new NativeAgentSession({
  provider:"vyceai",model,tools,onEvent:event=>events.push(event),
  initialMessages:[{role:"system",content:"Use the supplied repository evidence. When both searches are complete, reply exactly SEARCH_DEDUPE_OK."}],
  executeTool:async()=>structuredClone(searchResult),
  providerTurn:async request=>{
    const requestNumber=requests.length+1,finalRequest=requestNumber===3?{...request,tools:[],toolChoice:"none"}:request;
    const record={messages:structuredClone(finalRequest.messages),metrics:nativeRequestMetrics(finalRequest.messages,finalRequest.tools),usage:null,telemetry:null};requests.push(record);
    if(requestNumber===1)return {id:"synthetic-search-1",provider:"fixture",model,text:"",toolCalls:[{id:"search-1",namespace:"trebell_repo",name:"search_code",arguments:'{"query":"needle"}'}],usage:{}};
    if(requestNumber===2)return {id:"synthetic-search-2",provider:"fixture",model,text:"",toolCalls:[{id:"search-2",namespace:"trebell_repo",name:"search_code",arguments:'{"query":"needle"}'}],usage:{}};
    const response=await manager.turn("vyceai",{...finalRequest,provider:"vyceai",model,maxOutputTokens:32},{signal:request.signal});record.usage=response.usage;record.telemetry=response.telemetry;return response;
  },
});

await session.start({providerSessionId:"search-dedupe-benchmark",model});
const result=await session.prompt([{type:"text",text:"Run the same repository search twice, then return the exact completion marker."}],{maxModelTurns:3,maxToolCalls:2,maxWallTimeMs:120_000});
assert.equal(requests.length,3);assert.match(String(result?.raw?.provider||"vyceai"),/vyceai/);
const first=toolContent(requests[1],"search-1"),second=toolContent(requests[2],"search-2");
assert.ok(first.length>8000);assert.match(first,/file-79/);
const dedupe=events.filter(event=>event.name==="native.tool.observation_deduplicated"&&event.data?.namespace==="trebell_repo"&&event.data?.name==="search_code");
console.log(JSON.stringify({
  ok:true,runtime:"native",provider:"vyceai",model,
  thirdRequestInputTokens:Number(requests[2].usage?.inputTokens||0),
  thirdRequestOutputTokens:Number(requests[2].usage?.outputTokens||0),
  thirdRequestCachedInputTokens:Number(requests[2].usage?.cachedInputTokens||0),
  thirdRequestBytes:Number(requests[2].telemetry?.requestBytes||0),
  thirdRequestMessageChars:JSON.stringify(requests[2].messages).length,
  thirdRequestToolResultEstimatedTokens:Number(requests[2].metrics?.toolResults?.estimatedTokens||0),
  firstObservationChars:first.length,
  secondObservationChars:second.length,
  deduplicatedSearches:dedupe.length,
  deduplicatedSavedBytes:dedupe.reduce((sum,event)=>sum+Number(event.data?.savedBytes||0),0),
},null,2));
