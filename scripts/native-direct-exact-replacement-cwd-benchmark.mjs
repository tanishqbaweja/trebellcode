import assert from "node:assert/strict";
import { runNativeAgentTurn } from "../src/native-agent-loop.mjs";
import { nativeRequestMetrics } from "../src/native-request-metrics.mjs";
import { nativeSystemPrompt } from "../src/native-system-prompt.mjs";
import { platformDynamicToolNamespaces } from "../src/platform-tool-catalog.mjs";
import { providerTurnToChat } from "../src/provider-turn.mjs";

const tools=platformDynamicToolNamespaces({repository:true,progressiveRepository:true,workspaceTools:true,terminal:true,browser:false,computer:false,sourceControl:false,delegation:false});
const edit={path:"packages/api/src/config.mjs",old_text:"legacy",new_text:"strict",expected_replacements:1};
const verify={command:"npm",args:["test"],cwd:"packages/api"};
const messages=[
  {role:"system",content:nativeSystemPrompt({tools,permissionMode:"full",projectless:false})},
  {role:"user",content:"Replace exactly `legacy` with `strict` in `packages/api/src/config.mjs`, then run `npm test` in `packages/api` and report the result."},
];

async function scenario({directExactReplacementStatus}){
  let providerInferences=0,toolCalls=0,value="legacy";const requests=[];
  const result=await runNativeAgentTurn({
    model:"deepseek-v4.1",provider:"fixture",messages,tools,directExactReplacementStatus,maxModelTurns:4,maxToolCalls:8,
    providerTurn:async request=>{
      providerInferences++;
      const requestMessages=Array.isArray(request.messages)?request.messages:[],requestTools=Array.isArray(request.tools)?request.tools:[],wire=providerTurnToChat({...request,model:"deepseek-v4.1"});
      requests.push({tokens:Number(nativeRequestMetrics(requestMessages,requestTools)?.totalLogical?.estimatedTokens||0),wireBytes:Buffer.byteLength(JSON.stringify(wire),"utf8")});
      if(providerInferences===1)return {text:"",toolCalls:[{id:"edit",namespace:"trebell_workspace",name:"replace_text",arguments:edit},{id:"verify",namespace:"trebell_terminal",name:"run",arguments:verify}],usage:{}};
      assert.equal(providerInferences,2,"baseline should need only one final reporting inference after the efficient two-tool batch");
      return {text:"Exact replacement completed in packages/api/src/config.mjs.\nCommand completed successfully (exit code 0).",toolCalls:[],usage:{}};
    },
    executeTool:async call=>{
      toolCalls++;
      if(call.namespace==="trebell_workspace"&&call.name==="replace_text"){
        assert.deepEqual(call.arguments,edit);if(value!==call.arguments.old_text)return {success:false,error:"Expected exactly one replacement, found zero."};
        value=call.arguments.new_text;return {success:true,path:edit.path,replacements:1};
      }
      assert.equal(call.namespace,"trebell_terminal");assert.equal(call.name,"run");assert.deepEqual(call.arguments,verify);
      return value==="strict"?{success:true,exitCode:0,stdout:"VERIFY_OK"}:{success:true,exitCode:1,stderr:"expected strict"};
    },
  });
  assert.equal(value,"strict");assert.equal(toolCalls,2);assert.match(result.text,/Exact replacement completed/i);assert.match(result.text,/exit code 0/i);
  return {providerInferences,toolCalls,modelTurns:result.modelTurns,providerVisibleEstimatedTokens:requests.reduce((sum,item)=>sum+item.tokens,0),wireRequestBytes:requests.reduce((sum,item)=>sum+item.wireBytes,0),independentlyVerified:value==="strict",finalText:result.text};
}

const baseline=await scenario({directExactReplacementStatus:false}),candidate=await scenario({directExactReplacementStatus:true});
assert.equal(baseline.providerInferences,2);assert.equal(candidate.providerInferences,0);assert.equal(candidate.modelTurns,0);assert.equal(baseline.toolCalls,candidate.toolCalls);assert.equal(candidate.independentlyVerified,true);
console.log(JSON.stringify({ok:true,benchmark:"native-direct-exact-replacement-cwd-zero-latency",baseline,candidate,savings:{providerInferences:baseline.providerInferences-candidate.providerInferences,providerVisibleEstimatedTokens:baseline.providerVisibleEstimatedTokens-candidate.providerVisibleEstimatedTokens,wireRequestBytes:baseline.wireRequestBytes-candidate.wireRequestBytes}},null,2));
