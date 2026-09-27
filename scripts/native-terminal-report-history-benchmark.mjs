import assert from "node:assert/strict";
import { runNativeAgentTurn } from "../src/native-agent-loop.mjs";
import { coolNativeProviderHistory } from "../src/native-tool-history.mjs";
import { nativeRequestMetrics } from "../src/native-request-metrics.mjs";

const handle="out_12345678-abcd",signal="CRITICAL_ASSERTION expected strict but received legacy",preview=("noise line\n".repeat(240)+signal+"\n"+"tail noise\n".repeat(120)).slice(0,3600);
const firstTurnTools=[{type:"namespace",name:"trebell_terminal",tools:[{name:"run"}]}],nextTurnTools=[...firstTurnTools,{type:"namespace",name:"trebell_workspace",tools:[{name:"read_file"},{name:"replace_text"}]}];
async function measure(coolSyntheticTerminalReportOutput){
  let providerInferences=0,toolCalls=0;
  const result=await runNativeAgentTurn({
    model:"fixture",provider:"fixture",messages:[{role:"system",content:"system"},{role:"user",content:"Run node noisy-verify.mjs and report the result."}],tools:firstTurnTools,synthesizeTerminalReports:true,coolSyntheticTerminalReportOutput,
    providerTurn:async()=>{providerInferences++;return {text:"Running it now.",toolCalls:[{id:"verify",namespace:"trebell_terminal",name:"run",arguments:{command:"node",args:["noisy-verify.mjs"]}}],usage:{}}},
    executeTool:async()=>{toolCalls++;return {exitCode:1,preview,_trebell_output:{handle,totalBytes:92129,totalLines:1801,note:"Full redacted output remains stored by Trebell."}}},maxModelTurns:2,maxToolCalls:2,
  });
  assert.equal(providerInferences,1);assert.equal(toolCalls,1);assert.match(result.text,/failed \(exit code 1\)/i);assert.match(result.text,/CRITICAL_ASSERTION/);
  const persisted=coolNativeProviderHistory(result.messages).messages,nextMessages=[...persisted,{role:"user",content:"Now fix it and rerun until it passes."}],metrics=nativeRequestMetrics(nextMessages,nextTurnTools),tool=persisted.find(message=>message.role==="tool"&&message.toolCallId==="verify")?.content||"";
  assert.match(tool,new RegExp(handle));
  if(coolSyntheticTerminalReportOutput===false)assert.match(tool,/CRITICAL_ASSERTION/);else assert.doesNotMatch(tool,/CRITICAL_ASSERTION/);
  return {firstTurnProviderInferences:providerInferences,toolCalls,nextRequestEstimatedTokens:Number(metrics.totalLogical?.estimatedTokens||0),nextRequestBytes:Buffer.byteLength(JSON.stringify({messages:nextMessages,tools:nextTurnTools}),"utf8"),carriedToolResultChars:tool.length,handlePreserved:true,assistantEvidencePreserved:/CRITICAL_ASSERTION/.test(result.text)};
}
const baseline=await measure(false),candidate=await measure(true);assert.equal(candidate.firstTurnProviderInferences,baseline.firstTurnProviderInferences);assert.equal(candidate.toolCalls,baseline.toolCalls);assert.ok(candidate.nextRequestEstimatedTokens<baseline.nextRequestEstimatedTokens);assert.ok(candidate.nextRequestBytes<baseline.nextRequestBytes);
console.log(JSON.stringify({ok:true,benchmark:"native-terminal-report-history-zero-latency",baseline,candidate,savings:{nextRequestEstimatedTokens:baseline.nextRequestEstimatedTokens-candidate.nextRequestEstimatedTokens,nextRequestBytes:baseline.nextRequestBytes-candidate.nextRequestBytes,carriedToolResultChars:baseline.carriedToolResultChars-candidate.carriedToolResultChars}},null,2));
