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
