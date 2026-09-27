import assert from "node:assert/strict";
import { runNativeAgentTurn } from "../src/native-agent-loop.mjs";
import { compactDirectTerminalStatusProviderHistory } from "../src/native-tool-history.mjs";
import { nativeRequestMetrics } from "../src/native-request-metrics.mjs";
import { providerTurnToChat } from "../src/provider-turn.mjs";

const handle="out_12345678-direct",signal="CRITICAL_ASSERTION expected strict but received legacy";
const firstTools=[{type:"namespace",name:"trebell_terminal",tools:[{name:"run"}]}];
const nextTools=[
  {type:"namespace",name:"trebell_terminal",tools:[{name:"run"}]},
  {type:"namespace",name:"trebell_workspace",tools:[{name:"read_file"},{name:"replace_text"}]},
  {type:"namespace",name:"trebell_output",tools:[{name:"inspect"}]},
];

const first=await runNativeAgentTurn({
  model:"fixture",provider:"fixture",messages:[{role:"system",content:"system"},{role:"user",content:"Run node noisy-verify.mjs and report the result."}],tools:firstTools,
  directTerminalStatusCommands:true,synthesizeTerminalReports:true,
  providerTurn:async()=>{throw new Error("Explicit direct status must not call the provider")},
  executeTool:async()=>({exitCode:1,preview:"noise\n"+signal+"\nmore noise",_trebell_output:{handle,totalBytes:92129,totalLines:1801,note:"stored"}}),
  maxModelTurns:2,maxToolCalls:2,
});
assert.equal(first.modelTurns,0);assert.equal(first.toolCalls,1);assert.match(first.text,/failed \(exit code 1\)/i);assert.match(first.text,/CRITICAL_ASSERTION/);

const baselineMessages=[...first.messages,{role:"user",content:"Now diagnose the failure, fix it, and rerun until it passes."}];
const compacted=compactDirectTerminalStatusProviderHistory(baselineMessages),candidateMessages=compacted.messages;
assert.equal(compacted.count,1);assert.ok(compacted.savedChars>0);
assert.ok(baselineMessages.some(message=>message.role==="tool"&&message.toolCallId==="native-direct-terminal-status-1"));
assert.equal(candidateMessages.some(message=>message.role==="tool"&&message.toolCallId==="native-direct-terminal-status-1"),false);
const receipt=candidateMessages.find(message=>message.role==="assistant"&&String(message.content||"").includes(signal))?.content||"";
assert.match(receipt,new RegExp(handle));assert.match(receipt,/trebell_output\/inspect/);

function measure(messages){
  const metrics=nativeRequestMetrics(messages,nextTools),wire=providerTurnToChat({model:"fixture",messages,tools:nextTools});
  return {
    messageCount:messages.length,
    estimatedTokens:Number(metrics.totalLogical?.estimatedTokens||0),
    conversationHistoryTokens:Number(metrics.conversationHistory?.estimatedTokens||0),
    toolResultTokens:Number(metrics.toolResults?.estimatedTokens||0),
    requestBytes:Buffer.byteLength(JSON.stringify({messages,tools:nextTools}),"utf8"),
    wireMessageChars:JSON.stringify(wire.messages||[]).length,
    wireRequestBytes:Buffer.byteLength(JSON.stringify(wire),"utf8"),
  };
}
const baseline=measure(baselineMessages),candidate=measure(candidateMessages);
assert.ok(candidate.estimatedTokens<baseline.estimatedTokens);assert.ok(candidate.requestBytes<baseline.requestBytes);assert.ok(candidate.wireRequestBytes<baseline.wireRequestBytes);
console.log(JSON.stringify({ok:true,benchmark:"native-direct-terminal-history-zero-latency",baseline,candidate,savings:{
  estimatedTokens:baseline.estimatedTokens-candidate.estimatedTokens,
  conversationHistoryTokens:baseline.conversationHistoryTokens-candidate.conversationHistoryTokens,
  toolResultTokens:baseline.toolResultTokens-candidate.toolResultTokens,
  requestBytes:baseline.requestBytes-candidate.requestBytes,
  wireMessageChars:baseline.wireMessageChars-candidate.wireMessageChars,
  wireRequestBytes:baseline.wireRequestBytes-candidate.wireRequestBytes,
}},null,2));
