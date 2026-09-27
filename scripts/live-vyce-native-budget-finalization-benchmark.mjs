import assert from "node:assert/strict";
import { NativeAgentSession } from "../src/native-agent-session.mjs";
import { nativeRequestMetrics } from "../src/native-request-metrics.mjs";
import { platformDynamicToolNamespaces } from "../src/platform-tool-catalog.mjs";
import { ProviderManager } from "../src/provider-manager.mjs";

const apiKey=String(process.env.TREBELL_TEST_VYCE_API_KEY||process.env.VYCEAI_API_KEY||process.env.VYCE_API_KEY||"").trim();
if(!apiKey)throw new Error("Set TREBELL_TEST_VYCE_API_KEY, VYCEAI_API_KEY, or VYCE_API_KEY before running the Native tool-budget benchmark.");
const allowFailure=String(process.env.TREBELL_BUDGET_BENCH_ALLOW_FAILURE||"").trim()==="1";

const env={...process.env,VYCEAI_API_KEY:apiKey},manager=new ProviderManager({env});
const catalog=await manager.models("vyceai"),requested=String(process.env.VYCE_MODEL||"deepseek-v4.1").trim(),model=catalog.models.includes(requested)?requested:catalog.models[0];
if(!model)throw new Error("Vyce did not advertise any model for the Native tool-budget benchmark.");

const tools=platformDynamicToolNamespaces({
  repository:true,progressiveRepository:true,
  output:true,workspaceTools:true,terminal:true,
  process:false,browser:false,computer:false,sourceControl:false,delegation:false,
});
const requests=[],events=[];
const session=new NativeAgentSession({
  provider:"vyceai",model,tools,onEvent:event=>events.push(event),
  initialMessages:[{role:"system",content:"Use the supplied evidence. After the allowed tool work is complete, reply exactly TOOL_BUDGET_OK."}],
  executeTool:async()=>({path:"src/config.mjs",size:27,content:'export const mode="strict";'}),
  providerTurn:async request=>{
    const requestNumber=requests.length+1,effective=requestNumber===2?{...request,toolChoice:"none"}:request;
    const record={
      messages:structuredClone(effective.messages),
      tools:structuredClone(effective.tools),
      toolChoice:structuredClone(effective.toolChoice),
      metrics:nativeRequestMetrics(effective.messages,effective.tools),
      usage:null,telemetry:null,text:null,toolCalls:[],
    };
    requests.push(record);
    if(requestNumber===1)return {id:"synthetic-read",provider:"fixture",model,text:"",toolCalls:[{id:"read-1",namespace:"trebell_workspace",name:"read_file",arguments:'{"path":"src/config.mjs"}'}],usage:{}};
    const response=await manager.turn("vyceai",{...effective,provider:"vyceai",model,maxOutputTokens:32},{signal:request.signal});
    record.usage=response.usage;record.telemetry=response.telemetry;record.text=String(response.text||"");record.toolCalls=structuredClone(response.toolCalls||[]);return response;
  },
});

await session.start({providerSessionId:"tool-budget-benchmark",model});
let result=null,turnFailure=null;
try{
  result=await session.prompt([{type:"text",text:"Inspect src/config.mjs once, then return the exact completion marker."}],{maxModelTurns:2,maxToolCalls:1,maxWallTimeMs:120_000});
}catch(error){
  turnFailure={code:error?.code||null,message:String(error?.message||error).slice(0,500)};
  if(!allowFailure)throw error;
}
assert.equal(requests.length,2);
if(!allowFailure){
  assert.equal(result?.raw?.toolCalls,1);assert.equal(String(requests[1].text||"").trim(),"TOOL_BUDGET_OK");assert.equal(requests[1].toolCalls.length,0);
}
const final=requests[1],finalizationEvents=events.filter(event=>event.name==="native.tool_budget.finalizing");
console.log(JSON.stringify({
  ok:!turnFailure&&String(final.text||"").trim()==="TOOL_BUDGET_OK",runtime:"native",provider:"vyceai",model,
  finalRequestInputTokens:Number(final.usage?.inputTokens||0),
  finalRequestOutputTokens:Number(final.usage?.outputTokens||0),
  finalRequestCachedInputTokens:Number(final.usage?.cachedInputTokens||0),
  finalRequestBytes:Number(final.telemetry?.requestBytes||0),
  finalRequestMessageChars:JSON.stringify(final.messages).length,
  finalRequestSchemaChars:JSON.stringify(final.tools).length,
  finalRequestSchemaEstimatedTokens:Number(final.metrics?.toolSchemas?.estimatedTokens||0),
  finalRequestFunctionCount:final.tools.reduce((sum,namespace)=>sum+(Array.isArray(namespace?.tools)?namespace.tools.length:0),0),
  finalToolChoice:final.toolChoice,
  finalProviderToolCalls:final.toolCalls.length,
  toolBudgetFinalizationEvents:finalizationEvents.length,
  finalAgentText:String(final.text||"").trim(),
  turnFailure,
},null,2));
