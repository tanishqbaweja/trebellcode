import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { OpenAiResponsesWebSocket, openAiResponsesWebSocketStreamId } from "../src/openai-responses-websocket.mjs";

class FakeSocket extends EventEmitter{
  static CONNECTING=0;static OPEN=1;static CLOSING=2;static CLOSED=3;static instances=[];
  constructor(url,options){super();this.url=url;this.options=options;this.readyState=FakeSocket.CONNECTING;this.sent=[];FakeSocket.instances.push(this);queueMicrotask(()=>{this.readyState=FakeSocket.OPEN;this.emit("open")})}
  send(value){if(this.readyState!==FakeSocket.OPEN)throw new Error("closed");this.sent.push(String(value))}
  terminate(){if(this.readyState===FakeSocket.CLOSED)return;this.readyState=FakeSocket.CLOSED;this.emit("close",1006,"terminated")}
  server(event){this.emit("message",JSON.stringify(event))}
}

function reset(){FakeSocket.instances=[]}

test("Responses WebSocket sends response.create with stable lane and store false",async()=>{
  reset();const ws=new OpenAiResponsesWebSocket({apiKey:"secret",baseUrl:"https://api.openai.com/v1",userAgent:"TrebellTest",WebSocketClass:FakeSocket});
  const pending=ws.request({model:"gpt-5.6",input:[{type:"message",role:"user",content:[]}],stream:true,background:true},{streamId:"native_123"});await new Promise(resolve=>setImmediate(resolve));
  const socket=FakeSocket.instances[0],event=JSON.parse(socket.sent[0]);assert.equal(socket.url,"wss://api.openai.com/v1/responses");assert.equal(socket.options.headers.Authorization,"Bearer secret");assert.equal(event.type,"response.create");assert.equal(event.stream_id,"native_123");assert.equal(event.store,false);assert.equal("stream" in event,false);assert.equal("background" in event,false);
  socket.server({type:"response.completed",stream_id:"native_123",response:{id:"resp-1",model:"gpt-5.6",status:"completed",output:[]}});const result=await pending;assert.equal(result.response.id,"resp-1");assert.ok(result.requestBytes>0);ws.close();
});

test("Responses WebSocket multiplexes lanes and reconstructs omitted terminal output",async()=>{
  reset();const ws=new OpenAiResponsesWebSocket({apiKey:"secret",WebSocketClass:FakeSocket}),left=ws.request({model:"gpt-5.6",input:[]},{streamId:"left"}),right=ws.request({model:"gpt-5.6",input:[]},{streamId:"right"});await new Promise(resolve=>setImmediate(resolve));const socket=FakeSocket.instances[0];assert.equal(FakeSocket.instances.length,1);
  socket.server({type:"response.output_item.done",stream_id:"right",output_index:0,item:{type:"message",role:"assistant",content:[{type:"output_text",text:"R"}]}});socket.server({type:"response.completed",stream_id:"right",response:{id:"resp-r",model:"gpt-5.6",status:"completed"}});
  socket.server({type:"response.output_item.done",stream_id:"left",output_index:0,item:{type:"function_call",call_id:"c",name:"tool",arguments:"{}"}});socket.server({type:"response.completed",stream_id:"left",response:{id:"resp-l",model:"gpt-5.6",status:"completed"}});
  assert.equal((await right).response.output[0].content[0].text,"R");assert.equal((await left).response.output[0].call_id,"c");ws.close();
});

test("Responses WebSocket cancellation resets the shared socket and next request reconnects",async()=>{
  reset();let resets=0;const ws=new OpenAiResponsesWebSocket({apiKey:"secret",WebSocketClass:FakeSocket,onReset:()=>resets++}),controller=new AbortController(),first=ws.request({model:"gpt-5.6",input:[]},{streamId:"first",signal:controller.signal});await new Promise(resolve=>setImmediate(resolve));controller.abort();await assert.rejects(first,error=>error?.name==="AbortError");assert.ok(resets>=1);
  const second=ws.request({model:"gpt-5.6",input:[]},{streamId:"second"});await new Promise(resolve=>setImmediate(resolve));assert.equal(FakeSocket.instances.length,2);FakeSocket.instances[1].server({type:"response.completed",stream_id:"second",response:{id:"resp-2",output:[]}});await second;ws.close();
});

test("Responses WebSocket exposes connection generation across reconnects",async()=>{
  reset();const ws=new OpenAiResponsesWebSocket({apiKey:"secret",WebSocketClass:FakeSocket});assert.deepEqual(ws.connectionState(),{generation:0,open:false});
  const first=ws.request({model:"gpt-5.6",input:[]},{streamId:"lane"});await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(ws.connectionState(),{generation:1,open:true});FakeSocket.instances[0].server({type:"response.completed",stream_id:"lane",response:{id:"resp-1",output:[]}});await first;
  FakeSocket.instances[0].emit("error",new Error("connection replaced"));assert.equal(ws.connectionState().open,false);const resetGeneration=ws.connectionState().generation;assert.ok(resetGeneration>1);
  const second=ws.request({model:"gpt-5.6",input:[]},{streamId:"lane"});await new Promise(resolve=>setImmediate(resolve));assert.equal(ws.connectionState().open,true);assert.ok(ws.connectionState().generation>resetGeneration);FakeSocket.instances[1].server({type:"response.completed",stream_id:"lane",response:{id:"resp-2",output:[]}});await second;ws.close();
});

test("Responses WebSocket idle timeout resets after progress instead of enforcing an absolute deadline",async()=>{
  reset();const ws=new OpenAiResponsesWebSocket({apiKey:"secret",WebSocketClass:FakeSocket}),pending=ws.request({model:"gpt-5.6",input:[]},{streamId:"lane",idleTimeoutMs:100});await new Promise(resolve=>setImmediate(resolve));const socket=FakeSocket.instances[0],started=Date.now();
  await new Promise(resolve=>setTimeout(resolve,60));socket.server({type:"response.output_text.delta",stream_id:"lane",delta:"still working"});
  await new Promise(resolve=>setTimeout(resolve,60));socket.server({type:"response.completed",stream_id:"lane",response:{id:"resp-progress",status:"completed",output:[]}});
  const result=await pending;assert.equal(result.response.id,"resp-progress");assert.ok(Date.now()-started>100,"total response time should be allowed to exceed the idle timeout while events keep arriving");ws.close();
});

test("Responses WebSocket idle timeout rejects a post-send lane with timeout telemetry",async()=>{
  reset();const resets=[];const ws=new OpenAiResponsesWebSocket({apiKey:"secret",WebSocketClass:FakeSocket,onReset:event=>resets.push(event)}),pending=ws.request({model:"gpt-5.6",input:[]},{streamId:"lane",idleTimeoutMs:30});await new Promise(resolve=>setImmediate(resolve));
  await assert.rejects(pending,error=>error?.name==="TimeoutError"&&error?.replaySafe===false&&error?.webSocketFailureKind==="timeout"&&error?.webSocketTelemetry?.requestBytes>0);assert.ok(resets.some(event=>event.reason==="timeout_failure"));ws.close();
});

test("Responses WebSocket transport failure rejects pending lanes and reports reset",async()=>{
  reset();const resets=[];const ws=new OpenAiResponsesWebSocket({apiKey:"secret",WebSocketClass:FakeSocket,onReset:event=>resets.push(event)}),pending=ws.request({model:"gpt-5.6",input:[]},{streamId:"lane"});await new Promise(resolve=>setImmediate(resolve));FakeSocket.instances[0].emit("error",new Error("boom"));await assert.rejects(pending,error=>error?.transportFailure===true);assert.ok(resets.some(event=>event.reason==="transport_failure"));ws.close();
});

test("Responses WebSocket gives multiplexed lanes independent error telemetry",async()=>{
  reset();const ws=new OpenAiResponsesWebSocket({apiKey:"secret",WebSocketClass:FakeSocket}),left=ws.request({model:"gpt-5.6",input:[]},{streamId:"left"}),right=ws.request({model:"gpt-5.6",input:[]},{streamId:"right"});await new Promise(resolve=>setImmediate(resolve));const socket=FakeSocket.instances[0];
  socket.server({type:"response.output_text.delta",stream_id:"left",delta:"x"});socket.emit("error",new Error("boom"));const [leftResult,rightResult]=await Promise.allSettled([left,right]);
  assert.equal(leftResult.status,"rejected");assert.equal(rightResult.status,"rejected");assert.notEqual(leftResult.reason,rightResult.reason);assert.ok(leftResult.reason.webSocketTelemetry.responseBytes>rightResult.reason.webSocketTelemetry.responseBytes);assert.equal(leftResult.reason.retryable,false);ws.close();
});

test("Responses WebSocket response.failed is request-level and does not reset a healthy socket",async()=>{
  reset();const resets=[];const ws=new OpenAiResponsesWebSocket({apiKey:"secret",WebSocketClass:FakeSocket,onReset:event=>resets.push(event)}),first=ws.request({model:"gpt-5.6",input:[]},{streamId:"lane"});await new Promise(resolve=>setImmediate(resolve));const socket=FakeSocket.instances[0];
  socket.server({type:"response.failed",stream_id:"lane",response:{id:"resp-fail",status:"failed",error:{code:"model_error",message:"request failed"}}});await assert.rejects(first,error=>error?.webSocketFailureKind==="response_failed"&&error?.retryable===false&&error?.replaySafe===false);assert.equal(resets.length,0);
  const second=ws.request({model:"gpt-5.6",input:[]},{streamId:"lane"});await new Promise(resolve=>setImmediate(resolve));assert.equal(FakeSocket.instances.length,1);socket.server({type:"response.completed",stream_id:"lane",response:{id:"resp-ok",status:"completed",output:[]}});assert.equal((await second).response.id,"resp-ok");ws.close();
});

test("Responses WebSocket server errors are retryable while request-level model errors stay terminal",async()=>{
  reset();const ws=new OpenAiResponsesWebSocket({apiKey:"secret",WebSocketClass:FakeSocket}),serverFailure=ws.request({model:"gpt-5.6",input:[]},{streamId:"lane"});await new Promise(resolve=>setImmediate(resolve));const socket=FakeSocket.instances[0];
  socket.server({type:"error",stream_id:"lane",error:{type:"server_error",code:null,message:"Sorry, something went wrong."}});await assert.rejects(serverFailure,error=>error?.retryable===true&&error?.webSocketFailureKind==="api_error"&&error?.replaySafe===false);
  const modelFailure=ws.request({model:"gpt-5.6",input:[]},{streamId:"lane"});await new Promise(resolve=>setImmediate(resolve));socket.server({type:"response.failed",stream_id:"lane",response:{id:"resp-model",status:"failed",error:{type:"invalid_request_error",code:"model_error",message:"request failed"}}});await assert.rejects(modelFailure,error=>error?.retryable===false&&error?.webSocketFailureKind==="response_failed");ws.close();
});

test("Responses WebSocket returns response.incomplete without treating it as transport failure",async()=>{
  reset();const resets=[];const ws=new OpenAiResponsesWebSocket({apiKey:"secret",WebSocketClass:FakeSocket,onReset:event=>resets.push(event)}),pending=ws.request({model:"gpt-5.6",input:[]},{streamId:"lane"});await new Promise(resolve=>setImmediate(resolve));FakeSocket.instances[0].server({type:"response.incomplete",stream_id:"lane",response:{id:"resp-inc",status:"incomplete",incomplete_details:{reason:"max_output_tokens"},output:[]}});const result=await pending;assert.equal(result.response.status,"incomplete");assert.equal(resets.length,0);ws.close();
});

test("Responses WebSocket request deadline interrupts a hanging initial connection",async()=>{
  class HangingSocket extends EventEmitter{static CONNECTING=0;static OPEN=1;static CLOSING=2;static CLOSED=3;constructor(){super();this.readyState=HangingSocket.CONNECTING}terminate(){this.readyState=HangingSocket.CLOSED}}
  const ws=new OpenAiResponsesWebSocket({apiKey:"secret",WebSocketClass:HangingSocket,connectTimeoutMs:5000}),started=Date.now(),signal=AbortSignal.timeout(30);
  await assert.rejects(ws.request({model:"gpt-5.6",input:[]},{streamId:"lane",signal}),error=>error?.name==="TimeoutError"&&error?.replaySafe===true);assert.ok(Date.now()-started<500,"request deadline should beat the 5s connection timeout");ws.close();
});

test("Responses WebSocket close safely aborts a socket that is still connecting",async()=>{
  class ConnectingSocket extends EventEmitter{
    static CONNECTING=0;static OPEN=1;static CLOSING=2;static CLOSED=3;
    constructor(){super();this.readyState=ConnectingSocket.CONNECTING}
    terminate(){this.readyState=ConnectingSocket.CLOSED;queueMicrotask(()=>{this.emit("error",new Error("WebSocket was closed before the connection was established"));this.emit("close",1006,"terminated")})}
  }
  const ws=new OpenAiResponsesWebSocket({apiKey:"secret",WebSocketClass:ConnectingSocket,connectTimeoutMs:5000}),pending=ws.request({model:"gpt-5.6",input:[]},{streamId:"lane"});
  await new Promise(resolve=>setImmediate(resolve));ws.close();await assert.rejects(pending);await new Promise(resolve=>setImmediate(resolve));
});

test("Responses WebSocket connect timeout safely terminates a still-connecting socket",async()=>{
  class ConnectingSocket extends EventEmitter{
    static CONNECTING=0;static OPEN=1;static CLOSING=2;static CLOSED=3;
    constructor(){super();this.readyState=ConnectingSocket.CONNECTING}
    terminate(){this.readyState=ConnectingSocket.CLOSED;queueMicrotask(()=>{this.emit("error",new Error("WebSocket was closed before the connection was established"));this.emit("close",1006,"terminated")})}
  }
  const ws=new OpenAiResponsesWebSocket({apiKey:"secret",WebSocketClass:ConnectingSocket,connectTimeoutMs:1000});
  await assert.rejects(ws.request({model:"gpt-5.6",input:[]},{streamId:"lane"}),error=>error?.transportFailure===true&&error?.replaySafe===true);
  await new Promise(resolve=>setImmediate(resolve));ws.close();
});

test("Responses WebSocket fails closed on malformed terminal events",async()=>{
  reset();const resets=[];const ws=new OpenAiResponsesWebSocket({apiKey:"secret",WebSocketClass:FakeSocket,onReset:event=>resets.push(event)}),pending=ws.request({model:"gpt-5.6",input:[]},{streamId:"lane"});await new Promise(resolve=>setImmediate(resolve));FakeSocket.instances[0].server({type:"response.completed",stream_id:"lane",response:{status:"completed",output:[{type:"message",role:"assistant",content:[{type:"output_text",text:17}]}]}});await assert.rejects(pending,error=>error?.protocolFailure===true&&error?.retryable===false);assert.ok(resets.some(event=>event.reason==="protocol_failure"));ws.close();
});

test("Responses WebSocket fails closed on malformed completed output items",async()=>{
  reset();const ws=new OpenAiResponsesWebSocket({apiKey:"secret",WebSocketClass:FakeSocket}),pending=ws.request({model:"gpt-5.6",input:[]},{streamId:"lane"});await new Promise(resolve=>setImmediate(resolve));FakeSocket.instances[0].server({type:"response.output_item.done",stream_id:"lane",output_index:0,item:{role:"assistant",content:[]}});await assert.rejects(pending,error=>error?.protocolFailure===true&&error?.webSocketFailureKind==="protocol");ws.close();
});

test("Responses WebSocket stream IDs are bounded and safe",()=>{
  assert.equal(openAiResponsesWebSocketStreamId("native abc/123"),"native-abc-123");assert.equal(openAiResponsesWebSocketStreamId(""),null);assert.ok(openAiResponsesWebSocketStreamId("x".repeat(400)).length<=256);
});
