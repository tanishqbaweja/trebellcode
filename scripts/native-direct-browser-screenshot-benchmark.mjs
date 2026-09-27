import assert from "node:assert/strict";
import { runNativeAgentTurn } from "../src/native-agent-loop.mjs";
import { nativeRequestMetrics } from "../src/native-request-metrics.mjs";
import { nativeSystemPrompt } from "../src/native-system-prompt.mjs";
import { platformDynamicToolNamespaces } from "../src/platform-tool-catalog.mjs";
import { providerTurnToChat } from "../src/provider-turn.mjs";

const tools=platformDynamicToolNamespaces({repository:true,progressiveRepository:true,workspaceTools:true,terminal:true,browser:true,computer:false,sourceControl:false,delegation:false});
const screenshot={dataUrl:"data:image/png;base64,AAAA",width:1280,height:800};
const expectedText="Browser screenshot captured.",messages=[{role:"system",content:nativeSystemPrompt({tools,permissionMode:"full",projectless:false})},{role:"user",content:"Take a browser screenshot."}];

async function scenario({directBrowserScreenshot}){
  let providerInferences=0,toolCalls=0;const requests=[];
  const result=await runNativeAgentTurn({model:"deepseek-v4.1",provider:"fixture",messages,tools,directBrowserScreenshot,maxModelTurns:4,maxToolCalls:4,providerTurn:async request=>{providerInferences++;const requestMessages=Array.isArray(request.messages)?request.messages:[],requestTools=Array.isArray(request.tools)?request.tools:[],wire=providerTurnToChat({...request,model:"deepseek-v4.1"});requests.push({tokens:Number(nativeRequestMetrics(requestMessages,requestTools)?.totalLogical?.estimatedTokens||0),wireBytes:Buffer.byteLength(JSON.stringify(wire),"utf8")});if(providerInferences===1)return {text:"",toolCalls:[{id:"shot",namespace:"trebell_browser",name:"screenshot",arguments:{}}],usage:{}};assert.equal(providerInferences,2,"baseline should need one final reporting inference after screenshot");return {text:expectedText,toolCalls:[],usage:{}}},executeTool:async call=>{toolCalls++;assert.equal(call.namespace,"trebell_browser");assert.equal(call.name,"screenshot");assert.deepEqual(call.arguments,{});return screenshot}});
  assert.equal(toolCalls,1);assert.equal(result.text,expectedText);return {providerInferences,toolCalls,modelTurns:result.modelTurns,providerVisibleEstimatedTokens:requests.reduce((sum,item)=>sum+item.tokens,0),wireRequestBytes:requests.reduce((sum,item)=>sum+item.wireBytes,0)};
}

const baseline=await scenario({directBrowserScreenshot:false}),candidate=await scenario({directBrowserScreenshot:true});assert.equal(baseline.providerInferences,2);assert.equal(candidate.providerInferences,0);assert.equal(candidate.modelTurns,0);assert.equal(candidate.toolCalls,baseline.toolCalls);
console.log(JSON.stringify({ok:true,benchmark:"native-direct-browser-screenshot-zero-latency",baseline,candidate,savings:{providerInferences:baseline.providerInferences-candidate.providerInferences,providerVisibleEstimatedTokens:baseline.providerVisibleEstimatedTokens-candidate.providerVisibleEstimatedTokens,wireRequestBytes:baseline.wireRequestBytes-candidate.wireRequestBytes}},null,2));
