import assert from "node:assert/strict";
import { NativeAgentSession } from "../src/native-agent-session.mjs";
import { nativeRequestMetrics, attachNativePromptProvenance } from "../src/native-request-metrics.mjs";
import { ProviderManager } from "../src/provider-manager.mjs";

const apiKey=String(process.env.TREBELL_TEST_VYCE_API_KEY||process.env.VYCEAI_API_KEY||process.env.VYCE_API_KEY||"").trim();
if(!apiKey)throw new Error("Set TREBELL_TEST_VYCE_API_KEY, VYCEAI_API_KEY, or VYCE_API_KEY before running the mixed prior-context benchmark.");
const env={...process.env,VYCEAI_API_KEY:apiKey},manager=new ProviderManager({env});
const catalog=await manager.models("vyceai"),requested=String(process.env.VYCE_MODEL||"deepseek-v4.1").trim(),model=catalog.models.includes(requested)?requested:catalog.models[0];
if(!model)throw new Error("Vyce did not advertise any model for the mixed prior-context benchmark.");

function generated(label,count){
  return Array.from({length:count},(_,index)=>`${label}_${String(index).padStart(3,"0")} :: ${"x".repeat(72)}`).join("\n");
}
function packet(entries){
  const contextText="Trebell supplied bounded working context.\n\n"+entries.map(entry=>`[${entry.kind} context · ${entry.source}]\n${entry.value}`).join("\n\n");
  return attachNativePromptProvenance({type:"text",text:contextText},{kind:"working_context",contextText,contextEntries:entries});
}
function prompt(entries,text){
  return [packet(entries),attachNativePromptProvenance({type:"text",text},{kind:"user_input",userParts:[text]})];
}

const oldRepo=generated("OLD_REPO",150),oldGoal=generated("OLD_GOAL",70),repair="ONE_OFF_REPAIR_EVIDENCE\n"+generated("REPAIR",45);
const newRepo=generated("NEW_REPO",150),newGoal=generated("NEW_GOAL",70);
const oldEntries=[
  {source:"trebell.repository_knowledge",kind:"application",value:oldRepo},
  {source:"trebell.goal",kind:"application",value:oldGoal},
  {source:"trebell.verification_repair",kind:"application",value:repair},
],newEntries=[
  {source:"trebell.repository_knowledge",kind:"application",value:newRepo},
  {source:"trebell.goal",kind:"application",value:newGoal},
];

const requests=[],events=[];let calls=0;
const session=new NativeAgentSession({
  provider:"vyceai",model,tools:[],onEvent:event=>events.push(event),
  initialMessages:[{role:"system",content:"Answer from the supplied Trebell context and user request. Keep the final response concise."}],
  executeTool:async()=>{throw new Error("No tools are used in this benchmark.")},
  providerTurn:async request=>{
    calls++;
    const record={messages:structuredClone(request.messages),metrics:nativeRequestMetrics(request.messages,request.tools),usage:null,telemetry:null,text:null};requests.push(record);
    if(calls===1)return {id:"synthetic-first",provider:"fixture",model,text:"first turn complete",toolCalls:[],usage:{}};
    const response=await manager.turn("vyceai",{...request,provider:"vyceai",model,tools:[],toolChoice:"none",maxOutputTokens:32},{signal:request.signal});
    record.usage=response.usage;record.telemetry=response.telemetry;record.text=String(response.text||"");return response;
  },
});

await session.start({providerSessionId:"mixed-prior-context-benchmark",model});
await session.prompt(prompt(oldEntries,"Repair using the old task context."),{maxModelTurns:1,maxToolCalls:0,maxWallTimeMs:120_000});
await session.prompt(prompt(newEntries,"Continue using the refreshed repository and goal context."),{maxModelTurns:1,maxToolCalls:0,maxWallTimeMs:120_000});
assert.equal(requests.length,2);assert.ok(String(requests[1].text||"").trim());
const second=requests[1],wire=JSON.stringify(second.messages),cooling=events.filter(event=>event.name==="native.context.history_cooled");
assert.ok(wire.includes("ONE_OFF_REPAIR_EVIDENCE"),"one-off repair evidence must remain available");
console.log(JSON.stringify({
  ok:true,runtime:"native",provider:"vyceai",model,
  secondRequestInputTokens:Number(second.usage?.inputTokens||0),
  secondRequestOutputTokens:Number(second.usage?.outputTokens||0),
  secondRequestCachedInputTokens:Number(second.usage?.cachedInputTokens||0),
  secondRequestBytes:Number(second.telemetry?.requestBytes||0),
  secondRequestMessageChars:wire.length,
  oldRepoStillHot:wire.includes("OLD_REPO_149"),
  oldGoalStillHot:wire.includes("OLD_GOAL_069"),
  oneOffRepairRetained:wire.includes("ONE_OFF_REPAIR_EVIDENCE"),
  newRepoPresent:wire.includes("NEW_REPO_149"),
  newGoalPresent:wire.includes("NEW_GOAL_069"),
  priorContextCoolingEvents:cooling.length,
  priorContextSavedChars:cooling.reduce((sum,event)=>sum+Number(event.data?.savedChars||0),0),
  finalAgentText:String(second.text||"").trim(),
},null,2));
