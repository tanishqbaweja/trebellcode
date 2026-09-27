import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { OpenAiResponsesWebSocket } from "../src/openai-responses-websocket.mjs";

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
console.log(JSON.stringify({
  ok:true,benchmark:"openai-responses-websocket-persistence",turns,
  persistentWebSocketConnectionAttempts:persistentConnections,reopenedWebSocketConnectionAttempts:reopenedConnections,
  connectionAttemptsAvoided:reopenedConnections-persistentConnections,requestBytes:persistentBytes,
  note:"Deterministic transport-structure benchmark only; it does not measure live OpenAI latency, HTTP connection pooling, billing, or provider compute.",
},null,2));
