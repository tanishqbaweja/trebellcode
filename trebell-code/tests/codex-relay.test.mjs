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
