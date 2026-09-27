import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeAgentSession } from "../src/native-agent-session.mjs";
import { nativeRequestMetrics } from "../src/native-request-metrics.mjs";
import { NativeToolOutputStore } from "../src/native-tool-output-store.mjs";
import { ProviderManager } from "../src/provider-manager.mjs";

const apiKey=String(process.env.TREBELL_TEST_VYCE_API_KEY||process.env.VYCEAI_API_KEY||process.env.VYCE_API_KEY||"").trim();
if(!apiKey)throw new Error("Set TREBELL_TEST_VYCE_API_KEY, VYCEAI_API_KEY, or VYCE_API_KEY before running the Native hot-history benchmark.");

const env={...process.env,VYCEAI_API_KEY:apiKey},manager=new ProviderManager({env});
const catalog=await manager.models("vyceai"),requested=String(process.env.VYCE_MODEL||"deepseek-v4.1").trim(),model=catalog.models.includes(requested)?requested:catalog.models[0];
if(!model)throw new Error("Vyce did not advertise any model for the Native hot-history benchmark.");

const tools=[
  {type:"namespace",name:"trebell_terminal",tools:[{type:"function",name:"run",description:"Run a command.",inputSchema:{type:"object",properties:{command:{type:"string"}}}}]},
  {type:"namespace",name:"trebell_workspace",tools:[{type:"function",name:"read_file",description:"Read a workspace file.",inputSchema:{type:"object",properties:{path:{type:"string"}}}}]},
];

function toolContent(request,toolCallId){
  return String((request?.messages||[]).find(message=>message?.role==="tool"&&message?.toolCallId===toolCallId)?.content||"");
}

const root=await mkdtemp(join(tmpdir(),"trebell-hot-history-bench-")),requests=[],events=[];
try{
  const outputStore=new NativeToolOutputStore({directory:join(root,"output"),maxHotBytes:4096,environment:env});
  const session=new NativeAgentSession({
    cwd:root,provider:"vyceai",model,tools,toolOutputStore:outputStore,onEvent:event=>events.push(event),
    initialMessages:[{role:"system",content:"Use the supplied tool evidence. When the tool steps are complete, reply exactly HISTORY_COOLING_OK."}],
    executeTool:async call=>call.id==="big"
      ?{exitCode:1,stdout:"x".repeat(40_000),stderr:"CRITICAL_ASSERTION expected strict but received legacy"}
      :{path:"small.txt",size:8,content:"small-ok"},
    providerTurn:async request=>{
      const requestNumber=requests.length+1,finalRequest=requestNumber===3?{...request,tools:[],toolChoice:"none"}:request;
      const record={messages:structuredClone(finalRequest.messages),metrics:nativeRequestMetrics(finalRequest.messages,finalRequest.tools),usage:null};requests.push(record);
      if(requestNumber===1)return {id:"synthetic-big",provider:"fixture",model,text:"",toolCalls:[{id:"big",namespace:"trebell_terminal",name:"run",arguments:'{"command":"verify"}'}],usage:{}};
      if(requestNumber===2)return {id:"synthetic-small",provider:"fixture",model,text:"",toolCalls:[{id:"small",namespace:"trebell_workspace",name:"read_file",arguments:'{"path":"small.txt"}'}],usage:{}};
      const response=await manager.turn("vyceai",{...finalRequest,provider:"vyceai",model,maxOutputTokens:64},{signal:request.signal});record.usage=response.usage;return response;
    },
  });
  await session.start({providerSessionId:"hot-history-benchmark",model});
  const result=await session.prompt([{type:"text",text:"Run the required tool sequence and then return the exact completion marker."}],{maxModelTurns:3,maxToolCalls:2,maxWallTimeMs:120_000});
  assert.equal(requests.length,3);assert.match(String(result?.raw?.provider||"vyceai"),/vyceai/);
  const hotBig=toolContent(requests[1],"big"),thirdBig=toolContent(requests[2],"big"),thirdSmall=toolContent(requests[2],"small");
  assert.ok(hotBig.length>3000);assert.match(hotBig,/CRITICAL_ASSERTION/);assert.match(thirdBig,/CRITICAL_ASSERTION/);assert.match(thirdSmall,/small-ok/);
  const cooling=events.filter(event=>event.name==="native.tool.history_cooled"&&event.data?.phase==="same_turn");
  console.log(JSON.stringify({
    ok:true,runtime:"native",provider:"vyceai",model,
    thirdRequestInputTokens:Number(requests[2].usage?.inputTokens||0),
    thirdRequestMessageChars:JSON.stringify(requests[2].messages).length,
    thirdRequestToolResultEstimatedTokens:Number(requests[2].metrics?.toolResults?.estimatedTokens||0),
    hotBigChars:hotBig.length,thirdBigChars:thirdBig.length,thirdSmallChars:thirdSmall.length,
    sameTurnCooledOutputs:cooling.reduce((sum,event)=>sum+Number(event.data?.count||0),0),
    sameTurnCooledChars:cooling.reduce((sum,event)=>sum+Number(event.data?.savedChars||0),0),
  },null,2));
}finally{await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
