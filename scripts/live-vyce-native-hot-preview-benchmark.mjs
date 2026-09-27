import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeAgentSession } from "../src/native-agent-session.mjs";
import { NativeToolOutputStore } from "../src/native-tool-output-store.mjs";
import { nativeRequestMetrics } from "../src/native-request-metrics.mjs";
import { ProviderManager } from "../src/provider-manager.mjs";

const apiKey=String(process.env.TREBELL_TEST_VYCE_API_KEY||process.env.VYCEAI_API_KEY||process.env.VYCE_API_KEY||"").trim();
if(!apiKey)throw new Error("Set TREBELL_TEST_VYCE_API_KEY, VYCEAI_API_KEY, or VYCE_API_KEY before running the Native hot-preview benchmark.");
const model=String(process.env.VYCE_MODEL||"deepseek-v4.1").trim(),manager=new ProviderManager({env:{...process.env,VYCEAI_API_KEY:apiKey}}),root=await mkdtemp(join(tmpdir(),"trebell-hot-preview-live-"));
let calls=0,record=null;
try{
  const store=new NativeToolOutputStore({directory:root,maxHotBytes:4096});
  const stdout=Array.from({length:900},(_,i)=>"setup-noise-"+String(i).padStart(4,"0")+" xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx").join("\n")+"\n"+
    Array.from({length:900},(_,i)=>"cleanup-noise-"+String(i).padStart(4,"0")+" yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy").join("\n");
  const session=new NativeAgentSession({
    model,provider:"vyceai",toolOutputStore:store,tools:[{type:"namespace",name:"trebell_terminal",tools:[{name:"run"}]}],
    providerTurn:async request=>{
      calls++;
      if(calls===1)return {id:"synthetic-tool",provider:"fixture",model,text:"",toolCalls:[{id:"big",namespace:"trebell_terminal",name:"run",arguments:'{"command":"node","args":["noisy-verify.mjs"]}'}],usage:{}};
      const messages=structuredClone(request.messages),metrics=nativeRequestMetrics(messages,[]),response=await manager.turn("vyceai",{...request,provider:"vyceai",model,tools:[],toolChoice:"none",maxOutputTokens:192},{signal:request.signal});
      record={messages,metrics,usage:response.usage,telemetry:response.telemetry,text:String(response.text||"")};return response;
    },
    executeTool:async()=>({exitCode:1,stdout,stderr:"CRITICAL_ASSERTION expected mode=strict but received legacy; inspect src/config.mjs"}),
  });
  await session.start({providerSessionId:"hot-preview-live",model});
  await session.prompt([{type:"text",text:"Run the verifier once, inspect the failure evidence, then summarize the failure."}],{maxModelTurns:2,maxToolCalls:2,maxWallTimeMs:120000});
  assert.ok(record);const tool=record.messages.find(message=>message.role==="tool"&&message.toolCallId==="big"),content=String(tool?.content||"");
  assert.match(content,/CRITICAL_ASSERTION/);assert.match(content,/out_[a-zA-Z0-9-]+/);assert.match(record.text,/strict/i);assert.match(record.text,/legacy/i);
  console.log(JSON.stringify({
    ok:true,runtime:"native",provider:"vyceai",model,
    finalRequestInputTokens:Number(record.usage?.inputTokens||0),finalRequestOutputTokens:Number(record.usage?.outputTokens||0),
    finalRequestCachedInputTokens:Number(record.usage?.cachedInputTokens||0),finalRequestBytes:Number(record.telemetry?.requestBytes||0),
    finalRequestMessageChars:JSON.stringify(record.messages).length,toolContentChars:content.length,
    toolResultEstimatedTokens:record.metrics.toolResults.estimatedTokens,criticalEvidencePresent:true,outputHandlePresent:true,
    finalAgentText:record.text,
  },null,2));
}finally{await rm(root,{recursive:true,force:true})}
