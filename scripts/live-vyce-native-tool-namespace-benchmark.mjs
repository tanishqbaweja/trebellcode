import assert from "node:assert/strict";
import { NativeAgentSession } from "../src/native-agent-session.mjs";
import { nativeRequestMetrics } from "../src/native-request-metrics.mjs";
import { ProviderManager } from "../src/provider-manager.mjs";

const apiKey=String(process.env.TREBELL_TEST_VYCE_API_KEY||process.env.VYCEAI_API_KEY||process.env.VYCE_API_KEY||"").trim();
if(!apiKey)throw new Error("Set TREBELL_TEST_VYCE_API_KEY, VYCEAI_API_KEY, or VYCE_API_KEY before running the Native tool-namespace benchmark.");

const env={...process.env,VYCEAI_API_KEY:apiKey},manager=new ProviderManager({env});
const catalog=await manager.models("vyceai"),requested=String(process.env.VYCE_MODEL||"deepseek-v4.1").trim(),model=catalog.models.includes(requested)?requested:catalog.models[0];
if(!model)throw new Error("Vyce did not advertise any model for the Native tool-namespace benchmark.");

const tools=[
  {
    type:"namespace",name:"trebell_repo",tools:[{
      type:"function",name:"read_source",description:"Read indexed source.",
      inputSchema:{type:"object",properties:{path:{type:"string"}},required:["path"],additionalProperties:false},
    }],
  },
  {
    type:"namespace",name:"trebell_workspace",tools:[{
      type:"function",name:"replace_text",description:"Replace exact workspace text.",
      inputSchema:{type:"object",properties:{path:{type:"string"},old_text:{type:"string"},new_text:{type:"string"}},required:["path","old_text","new_text"],additionalProperties:false},
    }],
  },
];

const requests=[],updates=[],events=[];let providerCalls=0;
const session=new NativeAgentSession({
  provider:"vyceai",model,tools,onEvent:event=>events.push(event),onUpdate:update=>updates.push(update),
  initialMessages:[{role:"system",content:"Use the tool evidence. Once the exact edit succeeds, return a concise final answer without another tool."}],
  executeTool:async call=>{
    if(call.namespace==="trebell_workspace"&&call.name==="replace_text")return {success:true,path:"src/config.mjs",replacements:1};
    return {success:false,error:"Unknown Trebell tool: "+String(call.namespace||"")+"/"+String(call.name||"")};
  },
  providerTurn:async request=>{
    providerCalls++;
    const latestTool=[...(request.messages||[])].reverse().find(message=>message?.role==="tool"),latestToolText=String(latestTool?.content||"");
    const record={
      requestNumber:providerCalls,messages:structuredClone(request.messages),tools:structuredClone(request.tools),
      metrics:nativeRequestMetrics(request.messages,request.tools),usage:null,telemetry:null,text:null,toolCalls:[],
    };
    requests.push(record);
    if(providerCalls===1){
      return {
        id:"synthetic-wrong-namespace",provider:"fixture",model,text:"",
        toolCalls:[{id:"edit-misplaced",namespace:"trebell_repo",name:"replace_text",arguments:'{"path":"src/config.mjs","old_text":"legacy","new_text":"strict"}'}],
        usage:{},
      };
    }
    if(/unknown trebell tool/i.test(latestToolText)){
      return {
        id:"synthetic-corrected-namespace",provider:"fixture",model,text:"",
        toolCalls:[{id:"edit-correct",namespace:"trebell_workspace",name:"replace_text",arguments:'{"path":"src/config.mjs","old_text":"legacy","new_text":"strict"}'}],
        usage:{},
      };
    }
    assert.match(latestToolText,/"success":true/);
    const effective={...request,tools:[],toolChoice:"none",maxOutputTokens:32};
    record.messages=structuredClone(effective.messages);record.tools=[];record.metrics=nativeRequestMetrics(effective.messages,[]);
    const response=await manager.turn("vyceai",{...effective,provider:"vyceai",model},{signal:request.signal});
    record.usage=response.usage;record.telemetry=response.telemetry;record.text=String(response.text||"");record.toolCalls=structuredClone(response.toolCalls||[]);
    return response;
  },
});

await session.start({providerSessionId:"tool-namespace-benchmark",model});
const result=await session.prompt([{type:"text",text:"Apply the exact legacy-to-strict edit using the available workspace tool, then report completion."}],{
  maxModelTurns:4,maxToolCalls:3,maxWallTimeMs:120_000,
});
const toolUpdates=updates.filter(item=>item.update?.sessionUpdate==="tool_call_update"),failedToolCalls=toolUpdates.filter(item=>item.update?.status==="failed").length,final=requests.at(-1);
assert.ok(String(final?.text||"").trim());assert.equal(final?.toolCalls?.length||0,0);
console.log(JSON.stringify({
  ok:true,runtime:"native",provider:"vyceai",model,
  modelTurns:Number(result?.raw?.modelTurns||0),toolCalls:Number(result?.raw?.toolCalls||0),failedToolCalls,providerRequests:requests.length,
  finalRequestInputTokens:Number(final?.usage?.inputTokens||0),finalRequestOutputTokens:Number(final?.usage?.outputTokens||0),
  finalRequestCachedInputTokens:Number(final?.usage?.cachedInputTokens||0),finalRequestBytes:Number(final?.telemetry?.requestBytes||0),
  finalRequestMessageChars:JSON.stringify(final?.messages||[]).length,finalRequestToolResultEstimatedTokens:Number(final?.metrics?.toolResults?.estimatedTokens||0),
  tools:toolUpdates.map(item=>({tool:String(item.update?.namespace||"")+"/"+String(item.update?.tool||""),status:item.update?.status||null})),
  repairEvents:events.filter(event=>event.name==="native.tool.call_repaired").map(event=>event.data?.reason||null),
  finalAgentText:String(final?.text||"").trim(),
},null,2));
