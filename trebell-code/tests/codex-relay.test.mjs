import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { attachCodexRelay } from "../src/codex-relay.mjs";

test("Codex relay removes the browser Origin header before upstream", async () => {
  const upstreamHttp=createServer();
  const upstreamWss=new WebSocketServer({noServer:true});
  let sawOrigin=true;
  upstreamHttp.on("upgrade",(req,socket,head)=>{
    sawOrigin=Boolean(req.headers.origin);
    upstreamWss.handleUpgrade(req,socket,head,ws=>upstreamWss.emit("connection",ws,req));
  });
  upstreamWss.on("connection",ws=>ws.on("message",data=>ws.send(data)));
  await new Promise(resolve=>upstreamHttp.listen(0,"127.0.0.1",resolve));
  const upstreamPort=upstreamHttp.address().port;

  const relayHttp=createServer((_req,res)=>{res.statusCode=404;res.end();});
  const relay=attachCodexRelay(relayHttp,{targetUrl:`ws://127.0.0.1:${upstreamPort}`});
  await new Promise(resolve=>relayHttp.listen(0,"127.0.0.1",resolve));
  const relayPort=relayHttp.address().port;

  try{
    const client=new WebSocket(`ws://127.0.0.1:${relayPort}/api/codex/ws`,{origin:"http://renderer.local"});
    await new Promise((resolve,reject)=>{client.once("open",resolve);client.once("error",reject);});
    const echoed=new Promise((resolve,reject)=>{client.once("message",data=>resolve(String(data)));client.once("error",reject);});
    client.send('{"hello":"world"}');
    assert.equal(await echoed,'{"hello":"world"}');
    assert.equal(sawOrigin,false);
    client.close();
  } finally {
    relay.close();
    upstreamWss.close();
    await new Promise(resolve=>relayHttp.close(resolve));
    await new Promise(resolve=>upstreamHttp.close(resolve));
  }
});

test("Codex relay exposes parsed client and server messages without changing payloads", async()=>{
  const upstreamHttp=createServer();const upstreamWss=new WebSocketServer({noServer:true});
  upstreamHttp.on("upgrade",(req,socket,head)=>upstreamWss.handleUpgrade(req,socket,head,ws=>upstreamWss.emit("connection",ws,req)));
  upstreamWss.on("connection",ws=>ws.on("message",data=>ws.send(JSON.stringify({method:"thread/tokenUsage/updated",params:{echo:JSON.parse(String(data))}}))));
  await new Promise(resolve=>upstreamHttp.listen(0,"127.0.0.1",resolve));
  const relayHttp=createServer((_req,res)=>{res.statusCode=404;res.end();});const seenClient=[],seenServer=[];
  const relay=attachCodexRelay(relayHttp,{targetUrl:`ws://127.0.0.1:${upstreamHttp.address().port}`,onClientMessage:message=>seenClient.push(message),onServerMessage:message=>seenServer.push(message)});
  await new Promise(resolve=>relayHttp.listen(0,"127.0.0.1",resolve));
  try{
    const client=new WebSocket(`ws://127.0.0.1:${relayHttp.address().port}/api/codex/ws`);await new Promise((resolve,reject)=>{client.once("open",resolve);client.once("error",reject)});
    const response=new Promise((resolve,reject)=>{client.once("message",data=>resolve(JSON.parse(String(data))));client.once("error",reject)});
    client.send(JSON.stringify({method:"turn/start",params:{threadId:"t1",model:"m1"}}));
    const message=await response;
    assert.equal(message.method,"thread/tokenUsage/updated");
    assert.equal(seenClient[0].params.model,"m1");
    assert.equal(seenServer[0].method,"thread/tokenUsage/updated");
    client.close();
  }finally{relay.close();upstreamWss.close();await new Promise(resolve=>relayHttp.close(resolve));await new Promise(resolve=>upstreamHttp.close(resolve))}
});

async function routedUpstream(name){
  const http=createServer();const wss=new WebSocketServer({noServer:true});const received=[];const sockets=new Set();
  http.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>{
    sockets.add(ws);ws.on("close",()=>sockets.delete(ws));
    ws.on("message",data=>{
      const message=JSON.parse(String(data));received.push(message);
      if(message.method==="initialize")ws.send(JSON.stringify({id:message.id,result:{name}}));
      else if(message.id!=null&&message.method)ws.send(JSON.stringify({id:message.id,result:{name,method:message.method}}));
    });
  });
  await new Promise(resolve=>http.listen(0,"127.0.0.1",resolve));
  return {name,http,wss,received,sockets,url:`ws://127.0.0.1:${http.address().port}`,async close(){for(const ws of sockets)try{ws.terminate()}catch{}wss.close();await new Promise(resolve=>http.close(resolve))}};
}

async function relayClient(relayHttp){
  const client=new WebSocket(`ws://127.0.0.1:${relayHttp.address().port}/api/codex/ws`);
  await new Promise((resolve,reject)=>{client.once("open",resolve);client.once("error",reject)});
  let nextId=1;
  const request=(method,params={})=>new Promise((resolve,reject)=>{
    const id=nextId++;const timer=setTimeout(()=>reject(new Error(method+" timed out")),5000);
    const onMessage=data=>{const message=JSON.parse(String(data));if(message.id!==id)return;clearTimeout(timer);client.off("message",onMessage);message.error?reject(new Error(message.error.message)):resolve(message.result)};
    client.on("message",onMessage);client.send(JSON.stringify({id,method,params}));
  });
  return {client,request};
}

test("Codex relay initializes and routes secondary app-server connections per thread",async()=>{
  const work=await routedUpstream("work"),personal=await routedUpstream("personal");
  const relayHttp=createServer((_req,res)=>{res.statusCode=404;res.end()});
  const relay=attachCodexRelay(relayHttp,{
    targetUrl:work.url,
    resolveTarget:message=>message?.params?.threadId==="personal-thread"?{key:"personal",url:personal.url}:{key:"work",url:work.url},
  });
  await new Promise(resolve=>relayHttp.listen(0,"127.0.0.1",resolve));
  let session;
  try{
    session=await relayClient(relayHttp);
    assert.equal((await session.request("initialize",{clientInfo:{name:"relay-test"},capabilities:{experimentalApi:true}})).name,"work");
    session.client.send(JSON.stringify({method:"initialized",params:{}}));
    assert.equal((await session.request("thread/read",{threadId:"work-thread"})).name,"work");
    assert.equal((await session.request("thread/read",{threadId:"personal-thread"})).name,"personal");
    assert.equal((await session.request("turn/start",{threadId:"personal-thread"})).name,"personal");
    assert.equal(work.received.filter(message=>message.method==="initialize").length,1);
    assert.equal(personal.received.filter(message=>message.method==="initialize").length,1);
    assert.equal(personal.received.filter(message=>message.method==="initialized").length,1);
  }finally{try{session?.client.close()}catch{}relay.close();await Promise.all([work.close(),personal.close(),new Promise(resolve=>relayHttp.close(resolve))])}
});

test("Codex relay namespaces server request ids and returns replies to the originating app-server",async()=>{
  const work=await routedUpstream("work"),personal=await routedUpstream("personal");
  const relayHttp=createServer((_req,res)=>{res.statusCode=404;res.end()});
  const relay=attachCodexRelay(relayHttp,{
    targetUrl:work.url,
    resolveTarget:message=>message?.params?.threadId==="personal-thread"?{key:"personal",url:personal.url}:{key:"work",url:work.url},
  });
  await new Promise(resolve=>relayHttp.listen(0,"127.0.0.1",resolve));
  let session;
  try{
    session=await relayClient(relayHttp);await session.request("initialize",{clientInfo:{name:"relay-test"},capabilities:{experimentalApi:true}});session.client.send(JSON.stringify({method:"initialized",params:{}}));
    await session.request("thread/read",{threadId:"personal-thread"});
    const workSocket=[...work.sockets][0],personalSocket=[...personal.sockets][0];
    const requests=[];
    const collect=data=>{const message=JSON.parse(String(data));if(message.method==="item/tool/requestUserInput")requests.push(message)};
    session.client.on("message",collect);
    workSocket.send(JSON.stringify({id:7,method:"item/tool/requestUserInput",params:{threadId:"work-thread"}}));
    personalSocket.send(JSON.stringify({id:7,method:"item/tool/requestUserInput",params:{threadId:"personal-thread"}}));
    for(let i=0;i<50&&requests.length<2;i++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(requests.length,2);assert.notEqual(requests[0].id,requests[1].id);
    session.client.send(JSON.stringify({id:requests.find(item=>item.params.threadId==="work-thread").id,result:{answers:{from:"work"}}}));
    session.client.send(JSON.stringify({id:requests.find(item=>item.params.threadId==="personal-thread").id,result:{answers:{from:"personal"}}}));
    for(let i=0;i<50&&(work.received.filter(item=>item.result).length<1||personal.received.filter(item=>item.result).length<1);i++)await new Promise(resolve=>setTimeout(resolve,10));
    const workReply=work.received.find(item=>item.id===7&&item.result),personalReply=personal.received.find(item=>item.id===7&&item.result);
    assert.deepEqual(workReply?.result,{answers:{from:"work"}});assert.deepEqual(personalReply?.result,{answers:{from:"personal"}});
    session.client.off("message",collect);
  }finally{try{session?.client.close()}catch{}relay.close();await Promise.all([work.close(),personal.close(),new Promise(resolve=>relayHttp.close(resolve))])}
});
