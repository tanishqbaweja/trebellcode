import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import { CodexAppServerClient } from "../src/codex-app-server-client.mjs";

test("backend Codex client initializes experimental RPC and forks external rollout paths",async()=>{
  const http=createServer();const wss=new WebSocketServer({noServer:true});const seen=[];
  http.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws)));
  wss.on("connection",ws=>ws.on("message",raw=>{
    const message=JSON.parse(String(raw));seen.push(message);
    if(message.id!=null&&message.method==="initialize")ws.send(JSON.stringify({id:message.id,result:{userAgent:"fixture"}}));
    if(message.id!=null&&message.method==="thread/fork")ws.send(JSON.stringify({id:message.id,result:{thread:{id:"forked-thread"}}}));
  }));
  await new Promise(resolve=>http.listen(0,"127.0.0.1",resolve));
  const client=new CodexAppServerClient("ws://127.0.0.1:"+http.address().port,{clientVersion:"1.2.3"});
  try{
    await client.connect();const result=await client.forkFromRollout({threadId:"source-thread",path:"C:\\Users\\me\\.codex\\sessions\\rollout.jsonl",cwd:"C:\\work",modelProvider:"freebuff"});
    assert.equal(result.thread.id,"forked-thread");
    const initialize=seen.find(item=>item.method==="initialize");assert.equal(initialize.params.capabilities.experimentalApi,true);
    const fork=seen.find(item=>item.method==="thread/fork");assert.deepEqual(fork.params,{threadId:"source-thread",path:"C:\\Users\\me\\.codex\\sessions\\rollout.jsonl",cwd:"C:\\work",modelProvider:"freebuff",threadSource:"trebell-code",ephemeral:false,excludeTurns:true});
    assert.equal(seen.some(item=>item.method==="initialized"&&item.id==null),true);
  }finally{client.close();await new Promise(resolve=>wss.close(()=>http.close(resolve)))}
});
