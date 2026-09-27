import assert from "node:assert/strict";
import { runNativeAgentTurn } from "../src/native-agent-loop.mjs";
import { nativeRequestMetrics } from "../src/native-request-metrics.mjs";
import { nativeSystemPrompt } from "../src/native-system-prompt.mjs";

const tools=[{type:"namespace",name:"trebell_terminal",description:"Run bounded terminal commands.",tools:[{name:"run",description:"Run one command.",inputSchema:{type:"object",properties:{command:{type:"string"},args:{type:"array",items:{type:"string"}}},required:["command","args"]}}]}];

function record(request={}){
  const messages=Array.isArray(request.messages)?request.messages:[],requestTools=Array.isArray(request.tools)?request.tools:[];
  return {
    bytes:Buffer.byteLength(JSON.stringify({messages,tools:requestTools,toolChoice:request.toolChoice}),"utf8"),
    tokens:Number(nativeRequestMetrics(messages,requestTools)?.totalLogical?.estimatedTokens||0),
  };
}

async function scenario({synthesizeTerminalReports}){
  let calls=0,toolsRun=0;const requests=[];
  const responses=[
    {text:"",toolCalls:[{id:"verify",namespace:"trebell_terminal",name:"run",arguments:{command:"node",args:["verify.mjs"]}}],usage:{}},
    {text:"The command failed with exit code 1 because strict mode was expected.",toolCalls:[],usage:{}},
  ];
  const result=await runNativeAgentTurn({
    model:"fixture",provider:"fixture",messages:[{role:"system",content:nativeSystemPrompt({tools,permissionMode:"full",projectless:false})},{role:"user",content:"Run node verify.mjs and report the result."}],tools,synthesizeTerminalReports,
    providerTurn:async request=>{calls++;requests.push(record(request));const next=responses.shift();if(!next)throw new Error("Unexpected extra provider inference");return next},
    executeTool:async()=>{toolsRun++;return {exitCode:1,stderr:"AssertionError: expected strict but received legacy"}},maxModelTurns:4,maxToolCalls:4,
  });
  assert.equal(toolsRun,1);assert.match(result.text,/exit code 1/i);
  return {providerInferences:calls,toolCalls:toolsRun,providerVisibleEstimatedTokens:requests.reduce((sum,item)=>sum+item.tokens,0),requestBytes:requests.reduce((sum,item)=>sum+item.bytes,0),verifiedEvidence:true,finalText:result.text};
}

const baseline=await scenario({synthesizeTerminalReports:false}),candidate=await scenario({synthesizeTerminalReports:true});
assert.equal(baseline.toolCalls,candidate.toolCalls);assert.ok(candidate.providerInferences<baseline.providerInferences);
console.log(JSON.stringify({ok:true,benchmark:"native-terminal-report-zero-latency",baseline,candidate,savings:{providerInferences:baseline.providerInferences-candidate.providerInferences,providerVisibleEstimatedTokens:baseline.providerVisibleEstimatedTokens-candidate.providerVisibleEstimatedTokens,requestBytes:baseline.requestBytes-candidate.requestBytes}},null,2));
