import assert from "node:assert/strict";
import { NativeAgentSession } from "../src/native-agent-session.mjs";
import { nativeRequestMetrics } from "../src/native-request-metrics.mjs";
import { ProviderManager } from "../src/provider-manager.mjs";
import { createSharedToolGateway } from "../src/shared-tool-gateway.mjs";

const apiKey=String(process.env.TREBELL_TEST_VYCE_API_KEY||process.env.VYCEAI_API_KEY||process.env.VYCE_API_KEY||"").trim();
if(!apiKey)throw new Error("Set TREBELL_TEST_VYCE_API_KEY, VYCEAI_API_KEY, or VYCE_API_KEY before running the Native shell-hint benchmark.");

const env={...process.env,VYCEAI_API_KEY:apiKey},manager=new ProviderManager({env});
const catalog=await manager.models("vyceai"),requested=String(process.env.VYCE_MODEL||"deepseek-v4.1").trim(),model=catalog.models.includes(requested)?requested:catalog.models[0];
if(!model)throw new Error("Vyce did not advertise any model for the Native shell-hint benchmark.");

const tools=[{
  type:"namespace",name:"trebell_terminal",tools:[{
    type:"function",name:"run",description:"Run one command using an argv-only contract.",
    inputSchema:{
      type:"object",
      properties:{
        command:{type:"string"},
        args:{type:"array",items:{type:"string"}},
        cwd:{type:"string"},
      },
      required:["command"],
      additionalProperties:false,
    },
  }],
}];

const gateway=createSharedToolGateway({
  environment:env,
  execute:async call=>({
    exitCode:0,
    stdout:"BENCH_SHELL_OK",
    stderr:"",
    normalizedArguments:call.arguments,
  }),
});

const requests=[],updates=[],events=[];let providerCalls=0;
const session=new NativeAgentSession({
  provider:"vyceai",model,tools,onEvent:event=>events.push(event),onUpdate:update=>updates.push(update),
  initialMessages:[{role:"system",content:"Use the terminal evidence. Once the command succeeds, return a concise user-visible final answer and do not call another tool."}],
  executeTool:async call=>gateway.invoke(call,{permissionProfile:"full",workspace:process.cwd(),runtime:"native"}),
  providerTurn:async request=>{
    providerCalls++;
    const latestTool=[...(request.messages||[])].reverse().find(message=>message?.role==="tool");
    const latestToolText=String(latestTool?.content||"");
    const record={
      requestNumber:providerCalls,
      messages:structuredClone(request.messages),
      tools:structuredClone(request.tools),
      toolChoice:structuredClone(request.toolChoice),
      metrics:nativeRequestMetrics(request.messages,request.tools),
      usage:null,telemetry:null,text:null,toolCalls:[],
    };
    requests.push(record);
    if(providerCalls===1){
      return {
        id:"synthetic-bad-shell",provider:"fixture",model,text:"",
        toolCalls:[{id:"shell-bad",namespace:"trebell_terminal",name:"run",arguments:'{"command":"node verify.mjs","shell":"cmd"}'}],
        usage:{},
      };
    }
    if(/invalid arguments|not allowed/i.test(latestToolText)){
      return {
        id:"synthetic-repaired-shell",provider:"fixture",model,text:"",
        toolCalls:[{id:"shell-fixed",namespace:"trebell_terminal",name:"run",arguments:'{"command":"node","args":["verify.mjs"]}'}],
        usage:{},
      };
    }
    assert.match(latestToolText,/BENCH_SHELL_OK/);
    const effective={...request,tools:[],toolChoice:"none",maxOutputTokens:32};
    record.messages=structuredClone(effective.messages);
    record.tools=[];
    record.toolChoice="none";
    record.metrics=nativeRequestMetrics(effective.messages,[]);
    const response=await manager.turn("vyceai",{...effective,provider:"vyceai",model},{signal:request.signal});
    record.usage=response.usage;record.telemetry=response.telemetry;record.text=String(response.text||"");record.toolCalls=structuredClone(response.toolCalls||[]);
    return response;
  },
});

await session.start({providerSessionId:"shell-hint-benchmark",model});
const result=await session.prompt([{type:"text",text:"Run the required terminal check and then return the exact completion marker."}],{
  maxModelTurns:4,maxToolCalls:2,maxWallTimeMs:120_000,
});
const toolUpdates=updates.filter(item=>item.update?.sessionUpdate==="tool_call_update"),failedToolCalls=toolUpdates.filter(item=>item.update?.status==="failed").length;
const final=requests.at(-1);
assert.ok(String(final?.text||"").trim());
assert.equal(final?.toolCalls?.length||0,0);
console.log(JSON.stringify({
  ok:Boolean(String(final?.text||"").trim())&&(final?.toolCalls?.length||0)===0,runtime:"native",provider:"vyceai",model,
  modelTurns:Number(result?.raw?.modelTurns||0),
  toolCalls:Number(result?.raw?.toolCalls||0),
  failedToolCalls,
  providerRequests:requests.length,
  finalRequestInputTokens:Number(final?.usage?.inputTokens||0),
  finalRequestOutputTokens:Number(final?.usage?.outputTokens||0),
  finalRequestCachedInputTokens:Number(final?.usage?.cachedInputTokens||0),
  finalRequestBytes:Number(final?.telemetry?.requestBytes||0),
  finalRequestMessageChars:JSON.stringify(final?.messages||[]).length,
  finalRequestToolResultEstimatedTokens:Number(final?.metrics?.toolResults?.estimatedTokens||0),
  finalAgentText:String(final?.text||"").trim(),
  tools:toolUpdates.map(item=>({
    tool:String(item.update?.namespace||"")+"/"+String(item.update?.tool||""),
    status:item.update?.status||null,
    arguments:item.update?.rawInput||{},
  })),
  repairEvents:events.filter(event=>event.name==="native.tool.call_repaired").length,
},null,2));
