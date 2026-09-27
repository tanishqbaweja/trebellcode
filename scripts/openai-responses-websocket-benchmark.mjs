import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAiResponsesWebSocket } from "../src/openai-responses-websocket.mjs";
import { ProviderManager } from "../src/provider-manager.mjs";

class BenchmarkSocket extends EventEmitter{
  static CONNECTING=0;static OPEN=1;static CLOSING=2;static CLOSED=3;static instances=[];
  constructor(){super();this.readyState=BenchmarkSocket.CONNECTING;this.sent=[];BenchmarkSocket.instances.push(this);queueMicrotask(()=>{this.readyState=BenchmarkSocket.OPEN;this.emit("open")})}
  send(raw){
    assert.equal(this.readyState,BenchmarkSocket.OPEN);const payload=String(raw),event=JSON.parse(payload);this.sent.push(payload);
    queueMicrotask(()=>this.emit("message",JSON.stringify({type:"response.completed",stream_id:event.stream_id,response:{id:`resp-${BenchmarkSocket.instances.indexOf(this)}-${this.sent.length}`,model:event.model,status:"completed",output:[]}})));
  }
  terminate(){this.readyState=BenchmarkSocket.CLOSED}
}

const turns=20,body=index=>({model:"gpt-5.6",input:[{type:"message",role:"user",content:[{type:"input_text",text:`Synthetic coding turn ${index}`}]}],stream:true});

BenchmarkSocket.instances=[];const persistent=new OpenAiResponsesWebSocket({apiKey:"benchmark-key",WebSocketClass:BenchmarkSocket});let persistentBytes=0;
for(let index=0;index<turns;index++)persistentBytes+=(await persistent.request(body(index),{streamId:"native-benchmark"})).requestBytes;
const persistentConnections=BenchmarkSocket.instances.length;persistent.close();

BenchmarkSocket.instances=[];let reopenedBytes=0;
for(let index=0;index<turns;index++){
  const transport=new OpenAiResponsesWebSocket({apiKey:"benchmark-key",WebSocketClass:BenchmarkSocket});reopenedBytes+=(await transport.request(body(index),{streamId:"native-benchmark"})).requestBytes;transport.close();
}
const reopenedConnections=BenchmarkSocket.instances.length;

assert.equal(persistentConnections,1);assert.equal(reopenedConnections,turns);assert.equal(persistentBytes,reopenedBytes);

async function recoveryScenario(retryMs){
  const root=mkdtempSync(join(tmpdir(),"trebell-ws-recovery-bench-"));let now=1_000,factoryCalls=0,httpTurns=0,webSocketTurns=0;
  try{
    const manager=new ProviderManager({env:{TREBELL_HOME:root},nowFn:()=>now,openAiResponsesWebSocketRetryMs:retryMs,openAiResponsesWebSocketFactory:options=>{factoryCalls++;if(factoryCalls===1)return {close:()=>{},request:async()=>{options.onReset?.({reason:"connect_failure"});const error=new Error("synthetic transient connect failure");error.transportFailure=true;error.webSocketFailureKind="transport";error.replaySafe=true;error.retryable=false;error.webSocketTelemetry={requestBytes:0,responseBytes:0,timeToFirstTokenMs:null};throw error}};return {close:()=>{},request:async body=>{webSocketTurns++;return {requestBytes:1,response:{id:`resp-ws-${webSocketTurns}`,model:body.model,status:"completed",output:[]},telemetry:{responseBytes:1,totalLatencyMs:1,timeToFirstTokenMs:null}}}}},fetchFn:async(_url,init={})=>{httpTurns++;const request=JSON.parse(init.body||"{}");return Response.json({id:`resp-http-${httpTurns}`,model:request.model,status:"completed",output:[],usage:{}})}});manager.setKey("openai","benchmark-key");
    for(let index=0;index<turns;index++){if(index>0)now+=31_000;await manager.turn("openai",{model:"gpt-5.6",messages:[{role:"user",content:`Synthetic recovery turn ${index}`}],tools:[],metadata:{sessionId:"native-recovery-benchmark"}},{streamResponses:true})}
    return {httpTurns,webSocketTurns,factoryCalls};
  }finally{rmSync(root,{recursive:true,force:true})}
}

const permanentBreakerBaseline=await recoveryScenario(Number.MAX_SAFE_INTEGER),cooldownBreaker=await recoveryScenario(30_000);
assert.deepEqual(permanentBreakerBaseline,{httpTurns:20,webSocketTurns:0,factoryCalls:1});assert.deepEqual(cooldownBreaker,{httpTurns:1,webSocketTurns:19,factoryCalls:2});
console.log(JSON.stringify({
  ok:true,benchmark:"openai-responses-websocket-persistence",turns,
  persistentWebSocketConnectionAttempts:persistentConnections,reopenedWebSocketConnectionAttempts:reopenedConnections,
  connectionAttemptsAvoided:reopenedConnections-persistentConnections,requestBytes:persistentBytes,
  transientFailureRecovery:{turnSpacingMs:31_000,cooldownMs:30_000,permanentBreakerBaseline,cooldownBreaker,httpTurnsAvoided:permanentBreakerBaseline.httpTurns-cooldownBreaker.httpTurns},
  note:"Deterministic transport-structure benchmark only; it does not measure live OpenAI latency, HTTP connection pooling, billing, or provider compute.",
},null,2));
