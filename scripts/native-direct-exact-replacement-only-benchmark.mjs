import assert from "node:assert/strict";
import { runNativeAgentTurn } from "../src/native-agent-loop.mjs";
import { nativeRequestMetrics } from "../src/native-request-metrics.mjs";
import { nativeSystemPrompt } from "../src/native-system-prompt.mjs";
import { platformDynamicToolNamespaces } from "../src/platform-tool-catalog.mjs";
import { providerTurnToChat } from "../src/provider-turn.mjs";

const tools=platformDynamicToolNamespaces({repository:true,progressiveRepository:true,workspaceTools:true,terminal:true,browser:false,computer:false,sourceControl:false,delegation:false});
const messages=[
  {role:"system",content:nativeSystemPrompt({tools,permissionMode:"full",projectless:false})},
  {role:"user",content:"Replace exactly `legacy` with `strict` in `src/config.mjs` and report the result."},
];

async function scenario({directExactReplacementStatus}){
  let providerInferences=0,toolCalls=0,value="legacy";const requests=[];
  const result=await runNativeAgentTurn({
    model:"deepseek-v4.1",provider:"fixture",messages,tools,directExactReplacementStatus,maxModelTurns:4,maxToolCalls:4,
    providerTurn:async request=>{
      providerInferences++;
      const requestMessages=Array.isArray(request.messages)?request.messages:[],requestTools=Array.isArray(request.tools)?request.tools:[];
      const wire=providerTurnToChat({...request,model:"deepseek-v4.1"});
      requests.push({tokens:Number(nativeRequestMetrics(requestMessages,requestTools)?.totalLogical?.estimatedTokens||0),wireBytes:Buffer.byteLength(JSON.stringify(wire),"utf8")});
      if(providerInferences===1)return {text:"",toolCalls:[{id:"edit",namespace:"trebell_workspace",name:"replace_text",arguments:{path:"src/config.mjs",old_text:"legacy",new_text:"strict",expected_replacements:1}}],usage:{}};
      assert.equal(providerInferences,2,"baseline should need only one final reporting inference after the exact edit");
      return {text:"Exact replacement completed in src/config.mjs.",toolCalls:[],usage:{}};
    },
    executeTool:async call=>{
      toolCalls++;assert.equal(call.namespace,"trebell_workspace");assert.equal(call.name,"replace_text");
      assert.deepEqual(call.arguments,{path:"src/config.mjs",old_text:"legacy",new_text:"strict",expected_replacements:1});
      if(value!==call.arguments.old_text)return {success:false,error:"Expected exactly one replacement, found zero."};
      value=call.arguments.new_text;return {success:true,path:"src/config.mjs",replacements:1};
    },
  });
  assert.equal(value,"strict");assert.equal(toolCalls,1);assert.equal(result.text,"Exact replacement completed in src/config.mjs.");
  return {providerInferences,toolCalls,modelTurns:result.modelTurns,providerVisibleEstimatedTokens:requests.reduce((sum,item)=>sum+item.tokens,0),wireRequestBytes:requests.reduce((sum,item)=>sum+item.wireBytes,0),exactState:value};
}

const baseline=await scenario({directExactReplacementStatus:false}),candidate=await scenario({directExactReplacementStatus:true});
assert.equal(baseline.providerInferences,2);assert.equal(candidate.providerInferences,0);assert.equal(candidate.modelTurns,0);assert.equal(candidate.toolCalls,baseline.toolCalls);assert.equal(candidate.exactState,baseline.exactState);
console.log(JSON.stringify({ok:true,benchmark:"native-direct-exact-replacement-only-zero-latency",baseline,candidate,savings:{providerInferences:baseline.providerInferences-candidate.providerInferences,providerVisibleEstimatedTokens:baseline.providerVisibleEstimatedTokens-candidate.providerVisibleEstimatedTokens,wireRequestBytes:baseline.wireRequestBytes-candidate.wireRequestBytes}},null,2));
