import assert from "node:assert/strict";
import { runNativeAgentTurn } from "../src/native-agent-loop.mjs";
import { nativeRequestMetrics } from "../src/native-request-metrics.mjs";
import { nativeSystemPrompt } from "../src/native-system-prompt.mjs";
import { platformDynamicToolNamespaces } from "../src/platform-tool-catalog.mjs";
import { providerTurnToChat } from "../src/provider-turn.mjs";

const tools=platformDynamicToolNamespaces({repository:true,progressiveRepository:true,workspaceTools:true,terminal:true,browser:false,computer:false,sourceControl:false,delegation:false});
const messages=[
  {role:"system",content:nativeSystemPrompt({tools,permissionMode:"full",projectless:false})},
  {role:"user",content:"Write exactly `mode=strict` to `src/config.mjs` and report the result."},
];

async function scenario({directExactWriteStatus}){
  let providerInferences=0,toolCalls=0,value="legacy";const requests=[];
  const result=await runNativeAgentTurn({
    model:"deepseek-v4.1",provider:"fixture",messages,tools,directExactWriteStatus,maxModelTurns:4,maxToolCalls:4,
    providerTurn:async request=>{
      providerInferences++;const requestMessages=Array.isArray(request.messages)?request.messages:[],requestTools=Array.isArray(request.tools)?request.tools:[],wire=providerTurnToChat({...request,model:"deepseek-v4.1"});
      requests.push({tokens:Number(nativeRequestMetrics(requestMessages,requestTools)?.totalLogical?.estimatedTokens||0),wireBytes:Buffer.byteLength(JSON.stringify(wire),"utf8")});
      if(providerInferences===1)return {text:"",toolCalls:[{id:"write",namespace:"trebell_workspace",name:"write_file",arguments:{path:"src/config.mjs",content:"mode=strict"}}],usage:{}};
      assert.equal(providerInferences,2,"baseline should need only one final reporting inference after the exact write");return {text:"Exact file write completed in src/config.mjs.",toolCalls:[],usage:{}};
    },
    executeTool:async call=>{toolCalls++;assert.equal(call.namespace,"trebell_workspace");assert.equal(call.name,"write_file");assert.deepEqual(call.arguments,{path:"src/config.mjs",content:"mode=strict"});value=call.arguments.content;return {success:true,path:"src/config.mjs",size:Buffer.byteLength(value,"utf8"),createdOrReplaced:true}},
  });
  assert.equal(value,"mode=strict");assert.equal(toolCalls,1);assert.equal(result.text,"Exact file write completed in src/config.mjs.");
  return {providerInferences,toolCalls,modelTurns:result.modelTurns,providerVisibleEstimatedTokens:requests.reduce((sum,item)=>sum+item.tokens,0),wireRequestBytes:requests.reduce((sum,item)=>sum+item.wireBytes,0),exactState:value};
}

const baseline=await scenario({directExactWriteStatus:false}),candidate=await scenario({directExactWriteStatus:true});
assert.equal(baseline.providerInferences,2);assert.equal(candidate.providerInferences,0);assert.equal(candidate.modelTurns,0);assert.equal(candidate.toolCalls,baseline.toolCalls);assert.equal(candidate.exactState,baseline.exactState);
console.log(JSON.stringify({ok:true,benchmark:"native-direct-exact-write-zero-latency",baseline,candidate,savings:{providerInferences:baseline.providerInferences-candidate.providerInferences,providerVisibleEstimatedTokens:baseline.providerVisibleEstimatedTokens-candidate.providerVisibleEstimatedTokens,wireRequestBytes:baseline.wireRequestBytes-candidate.wireRequestBytes}},null,2));
