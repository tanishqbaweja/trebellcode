import assert from "node:assert/strict";
import { NativeAgentSession } from "../src/native-agent-session.mjs";
import { nativeRequestMetrics } from "../src/native-request-metrics.mjs";
import { ProviderManager } from "../src/provider-manager.mjs";

const apiKey=String(process.env.TREBELL_TEST_VYCE_API_KEY||process.env.VYCEAI_API_KEY||process.env.VYCE_API_KEY||"").trim();
if(!apiKey)throw new Error("Set TREBELL_TEST_VYCE_API_KEY, VYCEAI_API_KEY, or VYCE_API_KEY before running the Native tool-call-history benchmark.");

const env={...process.env,VYCEAI_API_KEY:apiKey},manager=new ProviderManager({env});
const catalog=await manager.models("vyceai"),requested=String(process.env.VYCE_MODEL||"deepseek-v4.1").trim(),model=catalog.models.includes(requested)?requested:catalog.models[0];
if(!model)throw new Error("Vyce did not advertise any model for the Native tool-call-history benchmark.");

const largeContent="export const generated = "+JSON.stringify("x".repeat(40_000))+";\n";
const tools=[{
  type:"namespace",name:"trebell_workspace",tools:[
    {type:"function",name:"write_file",description:"Write a file.",inputSchema:{type:"object",properties:{path:{type:"string"},content:{type:"string"}},required:["path","content"]}},
    {type:"function",name:"read_file",description:"Read a file.",inputSchema:{type:"object",properties:{path:{type:"string"}},required:["path"]}},
  ],
}];

function callArguments(messages,id){
  for(const message of messages||[]){
    if(message?.role!=="assistant")continue;
    const call=(message.toolCalls||message.tool_calls||[]).find(item=>String(item?.id||"")===id);
    if(call)return typeof call.arguments==="string"?call.arguments:JSON.stringify(call.arguments||{});
  }
  return "";
}

const requests=[],events=[];
const session=new NativeAgentSession({
  provider:"vyceai",model,tools,onEvent:event=>events.push(event),
  initialMessages:[{role:"system",content:"Use the supplied tool evidence. When the tool steps are complete, return a concise final answer and do not call another tool."}],
  executeTool:async call=>call.id==="write-1"
    ?{success:true,path:"src/generated.mjs",size:largeContent.length}
    :{path:"src/check.mjs",size:18,content:"export const ok=1;"},
  providerTurn:async request=>{
    const requestNumber=requests.length+1,effective=requestNumber===3?{...request,tools:[],toolChoice:"none"}:request;
    const record={
      messages:structuredClone(effective.messages),tools:structuredClone(effective.tools),toolChoice:structuredClone(effective.toolChoice),
      metrics:nativeRequestMetrics(effective.messages,effective.tools),usage:null,telemetry:null,text:null,toolCalls:[],
    };
    requests.push(record);
    if(requestNumber===1)return {id:"synthetic-write",provider:"fixture",model,text:"",toolCalls:[{id:"write-1",namespace:"trebell_workspace",name:"write_file",arguments:JSON.stringify({path:"src/generated.mjs",content:largeContent})}],usage:{}};
    if(requestNumber===2)return {id:"synthetic-read",provider:"fixture",model,text:"",toolCalls:[{id:"read-1",namespace:"trebell_workspace",name:"read_file",arguments:'{"path":"src/check.mjs"}'}],usage:{}};
    const response=await manager.turn("vyceai",{...effective,provider:"vyceai",model,maxOutputTokens:32},{signal:request.signal});
    record.usage=response.usage;record.telemetry=response.telemetry;record.text=String(response.text||"");record.toolCalls=structuredClone(response.toolCalls||[]);return response;
  },
});

await session.start({providerSessionId:"toolcall-history-benchmark",model});
await session.prompt([{type:"text",text:"Perform the required write and read sequence, then summarize the completed work."}],{maxModelTurns:3,maxToolCalls:2,maxWallTimeMs:120_000});
assert.equal(requests.length,3);
const hotArgs=callArguments(requests[1].messages,"write-1"),laterArgs=callArguments(requests[2].messages,"write-1"),final=requests[2];
assert.ok(hotArgs.length>40_000);assert.ok(laterArgs.length>0);assert.ok(laterArgs.length<hotArgs.length/4);assert.match(laterArgs,/compacted prior tool argument/i);assert.ok(String(final.text||"").trim());assert.equal(final.toolCalls.length,0);
const cooling=events.filter(event=>event.name==="native.tool.history_cooled"&&event.data?.phase==="same_turn");
console.log(JSON.stringify({
  ok:true,runtime:"native",provider:"vyceai",model,
  finalRequestInputTokens:Number(final.usage?.inputTokens||0),
  finalRequestOutputTokens:Number(final.usage?.outputTokens||0),
  finalRequestCachedInputTokens:Number(final.usage?.cachedInputTokens||0),
  finalRequestBytes:Number(final.telemetry?.requestBytes||0),
  finalRequestMessageChars:JSON.stringify(final.messages).length,
  finalRequestToolResultEstimatedTokens:Number(final.metrics?.toolResults?.estimatedTokens||0),
  hotWriteArgumentChars:hotArgs.length,
  laterWriteArgumentChars:laterArgs.length,
  sameTurnCoolingEvents:cooling.length,
  sameTurnSavedChars:cooling.reduce((sum,event)=>sum+Number(event.data?.savedChars||0),0),
  finalAgentText:String(final.text||"").trim(),
},null,2));
