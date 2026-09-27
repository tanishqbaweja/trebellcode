import assert from "node:assert/strict";
import { NativeAgentSession } from "../src/native-agent-session.mjs";
import { nativeRequestMetrics, attachNativePromptProvenance } from "../src/native-request-metrics.mjs";
import { ProviderManager } from "../src/provider-manager.mjs";

const apiKey=String(process.env.TREBELL_TEST_VYCE_API_KEY||process.env.VYCEAI_API_KEY||process.env.VYCE_API_KEY||"").trim();
if(!apiKey)throw new Error("Set TREBELL_TEST_VYCE_API_KEY, VYCEAI_API_KEY, or VYCE_API_KEY before running the Native prior-context benchmark.");

const env={...process.env,VYCEAI_API_KEY:apiKey},manager=new ProviderManager({env});
const catalog=await manager.models("vyceai"),requested=String(process.env.VYCE_MODEL||"deepseek-v4.1").trim(),model=catalog.models.includes(requested)?requested:catalog.models[0];
if(!model)throw new Error("Vyce did not advertise any model for the Native prior-context benchmark.");

function generatedContext(label){
  return "Trebell supplied generated "+label+" context.\n"+Array.from({length:180},(_,index)=>{
    const id=String(index).padStart(3,"0");
    return `[${label}] src/module-${id}.mjs :: symbol_${label}_${id} :: evidence_${id}_${"x".repeat(48)}`;
  }).join("\n");
}

function prompt(context,text){
  return [
    attachNativePromptProvenance({type:"text",text:context},{kind:"working_context",contextText:context,contextEntries:[{source:"repository",kind:"application",value:context}]}),
    attachNativePromptProvenance({type:"text",text},{kind:"user_input",userParts:[text]}),
  ];
}

const oldContext=generatedContext("OLD"),newContext=generatedContext("NEW"),requests=[],events=[];let calls=0;
const session=new NativeAgentSession({
  provider:"vyceai",model,tools:[],onEvent:event=>events.push(event),
  initialMessages:[{role:"system",content:"Answer from the supplied Trebell context and user request. Keep the final response concise."}],
  executeTool:async()=>{throw new Error("No tools are used in this benchmark.")},
  providerTurn:async request=>{
    calls++;
    const record={messages:structuredClone(request.messages),metrics:nativeRequestMetrics(request.messages,request.tools),usage:null,telemetry:null,text:null};requests.push(record);
    if(calls===1)return {id:"synthetic-first",provider:"fixture",model,text:"first turn complete",toolCalls:[],usage:{}};
    const response=await manager.turn("vyceai",{...request,provider:"vyceai",model,tools:[],toolChoice:"none",maxOutputTokens:48},{signal:request.signal});
    record.usage=response.usage;record.telemetry=response.telemetry;record.text=String(response.text||"");return response;
  },
});

await session.start({providerSessionId:"prior-context-benchmark",model});
await session.prompt(prompt(oldContext,"Inspect the old task context."),{maxModelTurns:1,maxToolCalls:0,maxWallTimeMs:120_000});
await session.prompt(prompt(newContext,"Now answer using the new task context."),{maxModelTurns:1,maxToolCalls:0,maxWallTimeMs:120_000});
assert.equal(requests.length,2);assert.ok(String(requests[1].text||"").trim());
const second=requests[1],wire=JSON.stringify(second.messages),cooling=events.filter(event=>event.name==="native.context.history_cooled");
console.log(JSON.stringify({
  ok:true,runtime:"native",provider:"vyceai",model,
  oldContextChars:oldContext.length,newContextChars:newContext.length,
  secondRequestInputTokens:Number(second.usage?.inputTokens||0),
  secondRequestOutputTokens:Number(second.usage?.outputTokens||0),
  secondRequestCachedInputTokens:Number(second.usage?.cachedInputTokens||0),
  secondRequestBytes:Number(second.telemetry?.requestBytes||0),
  secondRequestMessageChars:wire.length,
  oldContextStillHot:wire.includes("symbol_OLD_179"),
  newContextPresent:wire.includes("symbol_NEW_179"),
  priorContextCoolingEvents:cooling.length,
  priorContextSavedChars:cooling.reduce((sum,event)=>sum+Number(event.data?.savedChars||0),0),
  finalAgentText:String(second.text||"").trim(),
},null,2));
