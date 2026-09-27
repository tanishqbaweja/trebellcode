import assert from "node:assert/strict";
import { runNativeAgentTurn } from "../src/native-agent-loop.mjs";
import { nativeRequestMetrics } from "../src/native-request-metrics.mjs";

const tools=[{type:"namespace",name:"trebell_terminal",description:"Run bounded argv commands.",tools:[{name:"run",description:"Run one command.",inputSchema:{type:"object",properties:{command:{type:"string"},args:{type:"array",items:{type:"string"}},cwd:{type:"string"}},required:["command"]}}]}];
const prompts=[
  ["In ./packages/api, run npm test and report the result.","packages/api"],
  ["Run npm test in packages/api/ and report the result.","packages/api"],
  ["In `api`, run npm test and report the result.","api"],
];
async function scenario(directTerminalStatusCommands){
  let providerInferences=0,toolCalls=0;const requests=[];
  let modelTurns=0;
  for(const [prompt,cwd] of prompts){
    const messages=[{role:"system",content:"system"},{role:"user",content:prompt}];
    const result=await runNativeAgentTurn({model:"fixture",provider:"fixture",messages,tools,synthesizeTerminalReports:true,directTerminalStatusCommands,
      providerTurn:async request=>{providerInferences++;const m=nativeRequestMetrics(request.messages,request.tools);requests.push({tokens:Number(m.totalLogical?.estimatedTokens||0),bytes:Buffer.byteLength(JSON.stringify({messages:request.messages,tools:request.tools}),"utf8")});return {text:"",toolCalls:[{id:"run",namespace:"trebell_terminal",name:"run",arguments:{command:"npm",args:["test"],cwd}}],usage:{}}},
      executeTool:async call=>{toolCalls++;assert.deepEqual(call.arguments,{command:"npm",args:["test"],cwd});return {exitCode:0,stdout:"PASS"}},maxModelTurns:3,maxToolCalls:3});
    modelTurns+=result.modelTurns;assert.match(result.text,/completed successfully/i);
  }
  assert.equal(toolCalls,prompts.length);return {providerInferences,modelTurns,toolCalls,providerVisibleEstimatedTokens:requests.reduce((s,x)=>s+x.tokens,0),requestBytes:requests.reduce((s,x)=>s+x.bytes,0)};
}
const baseline=await scenario(false),candidate=await scenario(true);assert.equal(baseline.providerInferences,prompts.length);assert.equal(candidate.providerInferences,0);assert.equal(candidate.modelTurns,0);assert.equal(candidate.toolCalls,baseline.toolCalls);
console.log(JSON.stringify({ok:true,benchmark:"native-direct-terminal-cwd-zero-latency",baseline,candidate,savings:{providerInferences:baseline.providerInferences-candidate.providerInferences,providerVisibleEstimatedTokens:baseline.providerVisibleEstimatedTokens-candidate.providerVisibleEstimatedTokens,requestBytes:baseline.requestBytes-candidate.requestBytes}},null,2));
