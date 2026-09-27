import assert from "node:assert/strict";
import { runNativeAgentTurn } from "../src/native-agent-loop.mjs";
import { nativeRequestMetrics } from "../src/native-request-metrics.mjs";
import { nativeSystemPrompt } from "../src/native-system-prompt.mjs";
import { platformDynamicToolNamespaces } from "../src/platform-tool-catalog.mjs";
import { providerTurnToChat } from "../src/provider-turn.mjs";

const processId="123e4567-e89b-12d3-a456-426614174000";
const tools=platformDynamicToolNamespaces({repository:true,progressiveRepository:true,workspaceTools:true,terminal:true,process:true,browser:false,computer:false,sourceControl:false,delegation:false});
const status={processId,running:true,command:"node server.mjs",cwd:"C:/repo",stdout:"server ready\n",stderr:""};
const expectedText=`Background process ${processId} is running.`,messages=[{role:"system",content:nativeSystemPrompt({tools,permissionMode:"full",projectless:false})},{role:"user",content:`Is background process \`${processId}\` still running?`}];

async function scenario({directProcessRunningStatus}){
  let providerInferences=0,toolCalls=0;const requests=[];
  const result=await runNativeAgentTurn({model:"deepseek-v4.1",provider:"fixture",messages,tools,directProcessRunningStatus,maxModelTurns:4,maxToolCalls:4,providerTurn:async request=>{providerInferences++;const requestMessages=Array.isArray(request.messages)?request.messages:[],requestTools=Array.isArray(request.tools)?request.tools:[],wire=providerTurnToChat({...request,model:"deepseek-v4.1"});requests.push({tokens:Number(nativeRequestMetrics(requestMessages,requestTools)?.totalLogical?.estimatedTokens||0),wireBytes:Buffer.byteLength(JSON.stringify(wire),"utf8")});if(providerInferences===1)return {text:"",toolCalls:[{id:"status",namespace:"trebell_process",name:"status",arguments:{process_id:processId}}],usage:{}};assert.equal(providerInferences,2,"baseline should need one final reporting inference after process status");return {text:expectedText,toolCalls:[],usage:{}}},executeTool:async call=>{toolCalls++;assert.equal(call.namespace,"trebell_process");assert.equal(call.name,"status");assert.deepEqual(call.arguments,{process_id:processId});return status}});
  assert.equal(toolCalls,1);assert.equal(result.text,expectedText);return {providerInferences,toolCalls,modelTurns:result.modelTurns,providerVisibleEstimatedTokens:requests.reduce((sum,item)=>sum+item.tokens,0),wireRequestBytes:requests.reduce((sum,item)=>sum+item.wireBytes,0)};
}

const baseline=await scenario({directProcessRunningStatus:false}),candidate=await scenario({directProcessRunningStatus:true});assert.equal(baseline.providerInferences,2);assert.equal(candidate.providerInferences,0);assert.equal(candidate.modelTurns,0);assert.equal(candidate.toolCalls,baseline.toolCalls);
console.log(JSON.stringify({ok:true,benchmark:"native-direct-process-status-zero-latency",baseline,candidate,savings:{providerInferences:baseline.providerInferences-candidate.providerInferences,providerVisibleEstimatedTokens:baseline.providerVisibleEstimatedTokens-candidate.providerVisibleEstimatedTokens,wireRequestBytes:baseline.wireRequestBytes-candidate.wireRequestBytes}},null,2));
