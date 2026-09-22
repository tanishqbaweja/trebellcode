import test from "node:test";
import assert from "node:assert/strict";
import { CodexRpcClient } from "../ui/src/rpc.js";

class MockWebSocket {
  static OPEN=1;
  constructor(){
    this.readyState=MockWebSocket.OPEN;
    this.listeners=new Map();
    this.sent=[];
    queueMicrotask(()=>this.emit("open",{}));
  }
  addEventListener(name,handler,options={}){
    const list=this.listeners.get(name)||[];list.push({handler,once:Boolean(options.once)});this.listeners.set(name,list);
  }
  send(raw){
    const message=JSON.parse(raw);this.sent.push(message);
    if(message.method==="initialize"&&message.id!=null)queueMicrotask(()=>this.emit("message",{data:JSON.stringify({id:message.id,result:{userAgent:"test"}})}));
  }
  close(){this.readyState=3;this.emit("close",{})}
  emit(name,event){
    const list=[...(this.listeners.get(name)||[])];
    for(const entry of list){entry.handler(event);if(entry.once)this.listeners.set(name,(this.listeners.get(name)||[]).filter(item=>item!==entry))}
  }
}

test("Codex RPC initialization advertises MCP form elicitation support",async()=>{
  const original=globalThis.WebSocket;globalThis.WebSocket=MockWebSocket;
  try{
    const client=new CodexRpcClient("ws://test",{clientVersion:"1.2.3"});
    await client.connect();
    const initialize=client.socket.sent.find(message=>message.method==="initialize");
    assert.equal(initialize.params.capabilities.experimentalApi,true);
    assert.equal(initialize.params.capabilities.mcpServerOpenaiFormElicitation,true);
    assert.deepEqual(initialize.params.capabilities.extensions,{
      "openai/form":{},
      "openai/elicitation":{form:{}},
    });
    assert.equal(client.socket.sent.some(message=>message.method==="initialized"),true);
    client.close();
  }finally{globalThis.WebSocket=original}
});
