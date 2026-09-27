import assert from "node:assert/strict";
import { NativeAgentSession, nativeMessagesFromThread } from "../src/native-agent-session.mjs";
import { nativeRequestMetrics } from "../src/native-request-metrics.mjs";

const tools=[{type:"namespace",name:"trebell_terminal",tools:[{name:"run"}]},{type:"namespace",name:"trebell_workspace",tools:[{name:"replace_text"}]}];
const thread={turns:[{items:[
  {type:"userMessage",content:[{type:"text",text:"Run node verify.mjs and report the result."}]},
  {type:"dynamicToolCall",id:"verify-old",namespace:"trebell_terminal",tool:"run",arguments:{command:"node",args:["verify.mjs"]},status:"completed",rawOutput:{exitCode:1,stderr:"expected strict"}},
  {type:"agentMessage",text:"Verifier failed."},
]}]};

async function scenario({recoverPersistedEvidence}){
  let config='export const mode="legacy";\n',providerInferences=0,toolCalls=0;const requests=[];
  const responses=[
    {text:"",toolCalls:[{id:"edit",namespace:"trebell_workspace",name:"replace_text",arguments:{path:"src/config.mjs",old_text:"legacy",new_text:"strict",expected_replacements:1}}],usage:{}},
    {text:"",toolCalls:[{id:"verify-new",namespace:"trebell_terminal",name:"run",arguments:{command:"node",args:["verify.mjs"]}}],usage:{}},
    {text:"Fixed and verified.",toolCalls:[],usage:{}},
  ];
  const session=new NativeAgentSession({
    provider:"fixture",model:"fixture",tools,initialMessages:nativeMessagesFromThread(thread),
    providerTurn:async request=>{providerInferences++;const messages=Array.isArray(request.messages)?request.messages:[],requestTools=Array.isArray(request.tools)?request.tools:[];requests.push({tokens:Number(nativeRequestMetrics(messages,requestTools)?.totalLogical?.estimatedTokens||0),bytes:Buffer.byteLength(JSON.stringify({messages,tools:requestTools,toolChoice:request.toolChoice}),"utf8")});const response=responses.shift();if(!response)throw new Error("Unexpected extra inference");return response},
    executeTool:async call=>{
      toolCalls++;
      if(call.namespace==="trebell_workspace"){config=config.replace("legacy","strict");return {path:"src/config.mjs",replacements:1}}
      return {exitCode:config.includes('mode="strict"')?0:1,stdout:config.includes('mode="strict"')?"PASS":"",stderr:config.includes('mode="strict"')?"":"expected strict"};
    },
  });
  if(!recoverPersistedEvidence)session.previousTerminalRuns=[];
  await session.start({providerSessionId:"restart-bench",model:"fixture"});
  const result=await session.prompt([{type:"text",text:"Now replace only legacy with strict and rerun node verify.mjs until it passes."}],{maxModelTurns:6,maxToolCalls:8});
  assert.equal(config,'export const mode="strict";\n');assert.equal(toolCalls,2);assert.equal(result.raw?.toolCalls,2);
  return {providerInferences,toolCalls,providerVisibleEstimatedTokens:requests.reduce((sum,item)=>sum+item.tokens,0),requestBytes:requests.reduce((sum,item)=>sum+item.bytes,0),verificationPassed:true};
}

const baseline=await scenario({recoverPersistedEvidence:false}),candidate=await scenario({recoverPersistedEvidence:true});
assert.ok(candidate.providerInferences<baseline.providerInferences);assert.equal(candidate.toolCalls,baseline.toolCalls);
console.log(JSON.stringify({ok:true,benchmark:"native-restart-verifier-zero-latency",baseline,candidate,savings:{providerInferences:baseline.providerInferences-candidate.providerInferences,providerVisibleEstimatedTokens:baseline.providerVisibleEstimatedTokens-candidate.providerVisibleEstimatedTokens,requestBytes:baseline.requestBytes-candidate.requestBytes}},null,2));
