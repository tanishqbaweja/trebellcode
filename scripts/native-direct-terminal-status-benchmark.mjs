import assert from "node:assert/strict";
import { runNativeAgentTurn } from "../src/native-agent-loop.mjs";
import { nativeRequestMetrics } from "../src/native-request-metrics.mjs";
import { nativeSystemPrompt } from "../src/native-system-prompt.mjs";

const tools=[{type:"namespace",name:"trebell_terminal",description:"Run bounded terminal commands.",tools:[{name:"run",description:"Run one command.",inputSchema:{type:"object",properties:{command:{type:"string"},args:{type:"array",items:{type:"string"}}},required:["command","args"]}}]}];
const messages=[{role:"system",content:nativeSystemPrompt({tools,permissionMode:"full",projectless:false})},{role:"user",content:"Run node verify.mjs and report the result."}];

async function scenario({directTerminalStatusCommands}){
  let providerInferences=0,toolCalls=0;const requests=[];
  const result=await runNativeAgentTurn({
    model:"fixture",provider:"fixture",messages,tools,synthesizeTerminalReports:true,directTerminalStatusCommands,
    providerTurn:async request=>{
      providerInferences++;
      const requestMessages=Array.isArray(request.messages)?request.messages:[],requestTools=Array.isArray(request.tools)?request.tools:[];
      requests.push({bytes:Buffer.byteLength(JSON.stringify({messages:requestMessages,tools:requestTools,toolChoice:request.toolChoice}),"utf8"),tokens:Number(nativeRequestMetrics(requestMessages,requestTools)?.totalLogical?.estimatedTokens||0)});
      return {text:"I'll run the verifier now.",toolCalls:[{id:"verify",namespace:"trebell_terminal",name:"run",arguments:{command:"node",args:["verify.mjs"]}}],usage:{}};
    },
    executeTool:async call=>{toolCalls++;assert.equal(call.namespace,"trebell_terminal");assert.equal(call.name,"run");assert.deepEqual(call.arguments,{command:"node",args:["verify.mjs"]});return {exitCode:1,stderr:"AssertionError: expected strict but received legacy"}},
    maxModelTurns:4,maxToolCalls:4,
  });
  assert.equal(toolCalls,1);assert.match(result.text,/failed \(exit code 1\)/i);assert.match(result.text,/expected strict but received legacy/i);
  return {providerInferences,toolCalls,modelTurns:result.modelTurns,providerVisibleEstimatedTokens:requests.reduce((sum,item)=>sum+item.tokens,0),requestBytes:requests.reduce((sum,item)=>sum+item.bytes,0),verifiedEvidence:true,finalText:result.text};
}

const baseline=await scenario({directTerminalStatusCommands:false}),candidate=await scenario({directTerminalStatusCommands:true});
assert.equal(baseline.toolCalls,candidate.toolCalls);assert.equal(baseline.providerInferences,1);assert.equal(candidate.providerInferences,0);assert.equal(candidate.modelTurns,0);
console.log(JSON.stringify({ok:true,benchmark:"native-direct-terminal-status-zero-latency",baseline,candidate,savings:{providerInferences:baseline.providerInferences-candidate.providerInferences,providerVisibleEstimatedTokens:baseline.providerVisibleEstimatedTokens-candidate.providerVisibleEstimatedTokens,requestBytes:baseline.requestBytes-candidate.requestBytes}},null,2));
