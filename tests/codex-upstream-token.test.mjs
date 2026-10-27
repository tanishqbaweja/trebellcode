// The relay in front of each Codex app-server Trebell starts sends that server's own --ws-auth token. It finds the token by the
// route its connection takes (the pool key and the address), not by the address alone: an app-server that died stays in Trebell's
// pool until its thread is used again, and the OS can give its port to a newer app-server, which then refused the dead one's token
// with 401 on every connection to it.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { codexUpstreamToken } from "../src/codex-app-server-auth.mjs";
import { attachCodexRelay } from "../src/codex-relay.mjs";

// A Codex app-server stand-in that, as Codex with --ws-auth capability-token, refuses a handshake without its token with 401.
async function guardedServer(token){
  const http=createServer(),wss=new WebSocketServer({noServer:true}),seen=[];
  http.on("upgrade",(req,socket,head)=>{
    seen.push(req.headers.authorization||null);
    if(req.headers.authorization!==`Bearer ${token}`){socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");return}
    wss.handleUpgrade(req,socket,head,ws=>ws.on("message",raw=>{const message=JSON.parse(String(raw));if(message.id!=null&&message.method)ws.send(JSON.stringify({id:message.id,result:message.method==="initialize"?{userAgent:"guarded"}:{echo:message.method}}))}));
  });
  await new Promise(resolve=>http.listen(0,"127.0.0.1",resolve));
  return {url:"ws://127.0.0.1:"+http.address().port,seen,close:()=>new Promise(resolve=>{for(const client of wss.clients)client.terminate();wss.close(()=>http.close(resolve))})};
}

test("an app-server's token is the one of the pool entry the route names, not of a dead one at the same address",()=>{
  const url="ws://127.0.0.1:50123";
  // The thread's app-server that died is still in the pool, at the address the OS then gave the next thread's app-server.
  const servers=new Map([["thread:old:local:codex-default",{targetUrl:url,wsToken:"dead-server-token"}],["thread:new:local:codex-default",{targetUrl:url,wsToken:"live-server-token"}]]);
  assert.equal([...servers.values()].find(item=>item.targetUrl===url).wsToken,"dead-server-token","by its address alone, the dead one's");
  assert.equal(codexUpstreamToken(servers,{key:"thread:new:local:codex-default",url}),"live-server-token");
  assert.equal(codexUpstreamToken(servers,{key:"thread:old:local:codex-default",url:"ws://127.0.0.1:50999"}),null,"an entry no longer at the route's address lends nothing");
  // The base route (key "default") goes to the catalog app-server.
  assert.equal(codexUpstreamToken(servers,{key:"default",url:"ws://127.0.0.1:50200"},{targetUrl:"ws://127.0.0.1:50200",wsToken:"catalog-token"}),"catalog-token");
  assert.equal(codexUpstreamToken(servers,{key:"default",url:"ws://127.0.0.1:50300"},{targetUrl:"ws://127.0.0.1:50200",wsToken:"catalog-token"}),null,"a remote host's or stand-in's address takes none");
});

test("the relay looks the token up by its connection's route, so a thread on a newer app-server at a dead one's address connects",async()=>{
  const live=await guardedServer("live-server-token");
  const servers=new Map([["thread:old:local:codex-default",{targetUrl:live.url,wsToken:"dead-server-token"}],["thread:new:local:codex-default",{targetUrl:live.url,wsToken:"live-server-token"}]]);
  const relayHttp=createServer((_req,res)=>{res.writeHead(404);res.end()});
  const relay=attachCodexRelay(relayHttp,{targetUrl:()=>live.url,resolveTarget:()=>({key:"thread:new:local:codex-default",url:live.url}),upstreamToken:(url,route)=>codexUpstreamToken(servers,route)});
  await new Promise(resolve=>relayHttp.listen(0,"127.0.0.1",resolve));
  const client=new WebSocket(`ws://127.0.0.1:${relayHttp.address().port}/api/codex/ws`),answers=[];
  try{
    await new Promise((resolve,reject)=>{client.once("open",resolve);client.once("error",reject)});
    client.on("message",raw=>answers.push(JSON.parse(String(raw))));
    client.send(JSON.stringify({id:1,method:"initialize",params:{clientInfo:{name:"upstream-token"}}}));
    for(const deadline=Date.now()+5000;!answers.some(item=>item.id===1)&&Date.now()<deadline;)await new Promise(resolve=>setTimeout(resolve,20));
    assert.deepEqual(live.seen,["Bearer live-server-token"],"the relay sent the newer app-server's own token");
    assert.deepEqual(answers.find(item=>item.id===1)?.result,{userAgent:"guarded"});
  }finally{client.terminate();relay.close();await new Promise(resolve=>relayHttp.close(resolve));await live.close()}
});
