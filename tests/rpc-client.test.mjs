import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CodexRpcClient, requestTimeoutMs } from "../ui/src/rpc.js";

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

test("Codex RPC notifications support independent subscribers without replacing the app handler",async()=>{
  const original=globalThis.WebSocket;globalThis.WebSocket=MockWebSocket;
  try{
    const primary=[],secondary=[];const client=new CodexRpcClient("ws://test",{onNotification:message=>primary.push(message.method)});
    const unsubscribe=client.subscribeNotifications(message=>secondary.push(message.method));
    await client.connect();
    client.socket.emit("message",{data:JSON.stringify({method:"app/list/updated",params:{}})});
    assert.deepEqual(primary,["app/list/updated"]);assert.deepEqual(secondary,["app/list/updated"]);
    unsubscribe();
    client.socket.emit("message",{data:JSON.stringify({method:"mcpServer/startupStatus/updated",params:{}})});
    assert.deepEqual(primary,["app/list/updated","mcpServer/startupStatus/updated"]);
    assert.deepEqual(secondary,["app/list/updated"]);
    client.close();
  }finally{globalThis.WebSocket=original}
});

test("Codex RPC notifications are also published to browser surfaces",async()=>{
  const originalSocket=globalThis.WebSocket,originalWindow=globalThis.window;globalThis.WebSocket=MockWebSocket;
  const events=[];
  globalThis.window={
    CustomEvent:class{constructor(type,options={}){this.type=type;this.detail=options.detail}},
    dispatchEvent:event=>{events.push(event);return true},
  };
  try{
    const client=new CodexRpcClient("ws://test");await client.connect();
    client.socket.emit("message",{data:JSON.stringify({method:"turn/diff/updated",params:{threadId:"thread-1",diff:[]}})});
    assert.equal(events.length,1);assert.equal(events[0].type,"trebell:rpc-notification");
    assert.deepEqual(events[0].detail,{method:"turn/diff/updated",params:{threadId:"thread-1",diff:[]}});
    client.close();
  }finally{globalThis.WebSocket=originalSocket;if(originalWindow===undefined)delete globalThis.window;else globalThis.window=originalWindow}
});

test("Codex RPC waits for a request that may start the thread's harness as long as the relay lets that start take, and for others a minute",async t=>{
  const original=globalThis.WebSocket;globalThis.WebSocket=MockWebSocket;
  try{
    const client=new CodexRpcClient("ws://test");await client.connect();
    t.mock.timers.enable({apis:["setTimeout"]});
    const watch=promise=>{const state={settled:false,error:null};promise.then(()=>{state.settled=true},error=>{state.settled=true;state.error=error});return state};
    const settle=()=>new Promise(resolve=>setImmediate(resolve));
    const turn=watch(client.request("turn/start",{threadId:"thread-1"})),list=watch(client.request("thread/list",{}));
    t.mock.timers.tick(60_000);await settle();
    assert.equal(list.settled,true);assert.equal(list.error.message,"thread/list timed out");assert.equal(list.error.rpcTimedOut,true);
    assert.equal(turn.settled,false);
    t.mock.timers.tick(9*60_000-1);await settle();
    assert.equal(turn.settled,false);
    t.mock.timers.tick(1);await settle();
    assert.equal(turn.settled,true);assert.equal(turn.error.message,"turn/start timed out");assert.equal(turn.error.rpcTimedOut,true);
    client.close();
  }finally{globalThis.WebSocket=original}
});

// The relay starts a thread's harness session (ensureSession) inside these requests' handlers, where a start can take minutes. A
// send waits for it through what lets Stop end it first (sessionUnlessStopped), so a call counts however it is awaited.
test("every relay request that may start the thread's harness session waits longer than a minute",()=>{
  const starting=new Set();let method=null;
  for(const line of readFileSync(new URL("../src/agent-relay.mjs",import.meta.url),"utf8").split("\n")){
    const handler=line.match(/if\(method==="([^"]+)"\)/);if(handler)method=handler[1];
    if(method&&/\bensureSession\(/.test(line))starting.add(method);
  }
  assert.ok(["turn/start","thread/start","thread/resume","thread/revert"].every(name=>starting.has(name)),[...starting].join(", "));
  for(const name of starting)assert.ok(requestTimeoutMs(name)>60_000,name+" may start the thread's harness session");
  assert.equal(requestTimeoutMs("thread/list"),60_000);assert.equal(requestTimeoutMs("thread/read"),60_000);
});
