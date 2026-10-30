import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import net from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as configuration from "../src/native-configuration.mjs";
import { nativeProviderConnectFailure, nativeProviderNetworkFailure, nativeProviderRetryable, runNativeAgentTurn } from "../src/native-agent-loop.mjs";
import * as longRequest from "../src/provider-long-request-fetch.mjs";
import { ProviderManager } from "../src/provider-manager.mjs";
import { TREBELL_USER_AGENT } from "../src/version.mjs";

// The transport Native's Meta stream goes through, against a real HTTP server on 127.0.0.1 standing in for api.meta.ai. Meta sends no
// byte while the model writes one output item (its reasoning, a tool call's arguments), and Node's fetch (undici) ends a response body
// after 300 s without a byte, so through Node's fetch a long silent item failed at about 300 s on every attempt, whatever the lane's idle
// bound (NATIVE_META_STREAM_IDLE_TIMEOUT_MS, 600 s) said. Here Node's fetch gets a 400 ms body timeout in place of its 300 s one, the
// silences are a few seconds (undici checks its timeouts about every half second), and the lane's bound is set in milliseconds. No request leaves the machine.

const { providerLongRequestFetch }=longRequest;
const fixture=JSON.parse(readFileSync(new URL("./fixtures/meta-responses-stream.json",import.meta.url),"utf8"));
const MODEL="muse-spark-1.3-contributor";
const frame=({event,data})=>`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const home=()=>mkdtempSync(join(tmpdir(),"trebell-meta-transport-"));

// The stand-in: the recorded text answer's first three events at once, then silenceMs with no byte, then the rest and "data: [DONE]".
// Any other path answers "ok" at once (the warm-up that makes Node's fetch set up its dispatcher).
async function startMeta(){
  const state={silenceMs:0,requests:[],closed:0};
  const server=createServer((req,res)=>{
    const chunks=[];req.on("data",chunk=>chunks.push(chunk));
    req.on("end",()=>{
      if(req.url!=="/v1/responses"){res.writeHead(200,{"content-type":"text/plain"});res.end("ok");return}
      state.requests.push({url:req.url,headers:req.headers,body:JSON.parse(Buffer.concat(chunks).toString("utf8")||"{}")});
      res.writeHead(200,{"content-type":"text/event-stream","cache-control":"no-cache","x-request-id":"req-meta-local"});
      const events=fixture.text.events;for(const item of events.slice(0,3))res.write(frame(item));
      const timer=setTimeout(()=>{for(const item of events.slice(3))res.write(frame(item));res.end("data: [DONE]\n\n")},state.silenceMs);
      res.on("close",()=>{clearTimeout(timer);if(!res.writableFinished)state.closed++});
    });
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  return {state,origin,local:url=>String(url).replace("https://api.meta.ai",origin),close:()=>new Promise(resolve=>{server.closeAllConnections?.();server.close(()=>resolve())})};
}

// Node's fetch with a body timeout of ms (its global dispatcher, undici's Agent, replaced for the test and put back after it).
const DISPATCHER=Symbol.for("undici.globalDispatcher.1");
async function withFetchBodyTimeout(meta,ms,run){
  await (await fetch(meta.origin+"/warm",{method:"POST",body:"{}"})).text().catch(()=>{});
  const original=globalThis[DISPATCHER];assert.ok(original?.constructor,"Node's fetch has a global dispatcher");
  const short=new original.constructor({bodyTimeout:ms});globalThis[DISPATCHER]=short;
  try{return await run()}finally{globalThis[DISPATCHER]=original;await short.close().catch(()=>{})}
}

// The transport an app's or a runner's manager (Node's own fetch, nothing injected) sends Meta's stream through, pointed at the stand-in.
function managerFor(root,meta){
  const transport=new ProviderManager({env:{TREBELL_HOME:root}}).longRequestFetchFn;
  return new ProviderManager({env:{TREBELL_HOME:root,META_API_KEY:"meta-test-key"},fetchFn:(url,init)=>fetch(meta.local(url),init),...(typeof transport==="function"?{longRequestFetchFn:(url,init)=>transport(meta.local(url),init)}:{})});
}
const metaTurn=(manager,{idleMs,signal}={})=>manager.turn("meta",{model:MODEL,messages:[{role:"user",content:fixture.text.prompt}],tools:[]},{...configuration.nativeProviderTurnOptions("meta"),...(idleMs?{streamIdleTimeoutMs:idleMs}:{}),...(signal?{signal}:{})});

test("the stand-in's silence is longer than Node fetch's body timeout here: read through Node's fetch, it fails",async()=>{
  const meta=await startMeta();
  try{
    meta.state.silenceMs=2_500;
    await withFetchBodyTimeout(meta,400,async()=>{
      const response=await fetch(meta.origin+"/v1/responses",{method:"POST",body:"{}"});
      await assert.rejects(response.text(),error=>error?.cause?.code==="UND_ERR_BODY_TIMEOUT");
    });
  }finally{await meta.close()}
});

test("a Meta stream silent for longer than Node fetch's body timeout completes within the lane's idle bound",async()=>{
  const root=home(),meta=await startMeta();
  try{
    meta.state.silenceMs=2_500;
    const result=await withFetchBodyTimeout(meta,400,async()=>{const started=Date.now(),result=await metaTurn(managerFor(root,meta),{idleMs:5_000});result.elapsedMs=Date.now()-started;return result});
    assert.equal(result.text,"208");assert.equal(result.telemetry.streaming,true);assert.equal(result.telemetry.providerRequestId,"req-meta-local");
    assert.ok(result.elapsedMs>=2_450,`the answer came after the silence (${result.elapsedMs} ms)`);
    assert.equal(meta.state.requests.length,1);
    const [sent]=meta.state.requests;
    assert.equal(sent.url,"/v1/responses");assert.equal(sent.body.stream,true);assert.equal(sent.body.model,MODEL);
    assert.equal(sent.headers.authorization,"Bearer meta-test-key");assert.equal(sent.headers.accept,"text/event-stream, application/json");
    assert.equal(sent.headers["content-type"],"application/json");assert.equal(sent.headers["user-agent"],TREBELL_USER_AGENT);
  }finally{await meta.close();rmSync(root,{recursive:true,force:true})}
});

test("the lane's idle bound, not the transport, ends a Meta stream that stalls, and its connection is closed",async()=>{
  const root=home(),meta=await startMeta();
  try{
    meta.state.silenceMs=6_000;
    const started=Date.now();
    await withFetchBodyTimeout(meta,400,()=>assert.rejects(metaTurn(managerFor(root,meta),{idleMs:2_000}),error=>{
      assert.equal(error.name,"TimeoutError");assert.match(error.message,/Meta Model API Responses stream idle timeout exceeded/);
      assert.equal(error.retryable,true);assert.equal(error.telemetry?.streaming,true);return true;
    }));
    const elapsed=Date.now()-started;
    assert.ok(elapsed>=1_950&&elapsed<4_500,`ended at the lane's 2 s bound (${elapsed} ms)`);
    for(let wait=0;wait<40&&!meta.state.closed;wait++)await new Promise(resolve=>setTimeout(resolve,25));
    assert.equal(meta.state.closed,1,"the stalled connection is closed");
  }finally{await meta.close();rmSync(root,{recursive:true,force:true})}
});

test("a stop during a Meta stream's silence ends it at once, as a stop and not a retry",async()=>{
  const root=home(),meta=await startMeta();
  try{
    meta.state.silenceMs=4_000;
    const controller=new AbortController(),started=Date.now();setTimeout(()=>controller.abort(),300);
    await assert.rejects(metaTurn(managerFor(root,meta),{idleMs:60_000,signal:controller.signal}),error=>error.name==="AbortError"&&error.retryable!==true);
    assert.ok(Date.now()-started<2_000);
    for(let wait=0;wait<40&&!meta.state.closed;wait++)await new Promise(resolve=>setTimeout(resolve,25));
    assert.equal(meta.state.closed,1,"the stopped connection is closed");
  }finally{await meta.close();rmSync(root,{recursive:true,force:true})}
});

test("the Meta stream's transport is not Node's fetch, and a fetch the caller brings stays the transport",async()=>{
  const root=home();
  try{
    assert.equal(new ProviderManager({env:{TREBELL_HOME:root}}).longRequestFetchFn,providerLongRequestFetch);
    assert.equal(new ProviderManager({env:{TREBELL_HOME:root},fetchFn:globalThis.fetch}).longRequestFetchFn,providerLongRequestFetch);
    // A test's stand-in or the offline E2E guard (gui-server.mjs offlineE2eFetch) is the transport for every request, this one too.
    const injected=async()=>{throw new Error("stand-in")};
    assert.equal(new ProviderManager({env:{TREBELL_HOME:root},fetchFn:injected}).longRequestFetchFn,injected);
    // So is a guard that replaced the global fetch before the manager was made (the perf tap, a spec's offline guard), named fetch or
    // not: the manager's default fetch is then the guard, and the Meta stream goes through it as every other request does.
    const nodeFetch=globalThis.fetch,guard=async(input,init)=>nodeFetch(input,init),namedGuard={async fetch(input,init){return nodeFetch(input,init)}}.fetch;
    for(const stand of [guard,namedGuard]){
      globalThis.fetch=stand;
      try{assert.equal(new ProviderManager({env:{TREBELL_HOME:root}}).longRequestFetchFn,stand,stand.name)}finally{globalThis.fetch=nodeFetch}
    }
    // A connection that cannot be made fails as Node's fetch fails it, so the loop reads it as a network failure.
    const closed=createServer();await new Promise(resolve=>closed.listen(0,"127.0.0.1",resolve));const port=closed.address().port;await new Promise(resolve=>closed.close(resolve));
    await assert.rejects(providerLongRequestFetch(`http://127.0.0.1:${port}/v1/responses`,{method:"POST",body:"{}"}),error=>{
      assert.equal(error.name,"TypeError");assert.equal(error.message,"fetch failed");assert.equal(error.cause?.code,"ECONNREFUSED");
      assert.equal(nativeProviderNetworkFailure(error),true);return true;
    });
  }finally{rmSync(root,{recursive:true,force:true})}
});

// A server that takes the TCP connection and never answers on it: an https request to it never gets its TLS handshake done, so the
// connection is never made, as with a server that never accepts it (on Windows a listener that never calls accept() still has its
// connections made by the system, so the handshake is where a connection can be held unmade here).
async function startSilent(){
  const sockets=new Set();let connected=null;const firstConnection=new Promise(resolve=>{connected=resolve});
  const server=net.createServer(socket=>{sockets.add(socket);socket.on("error",()=>{});socket.on("close",()=>sockets.delete(socket));connected()});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  return {port:server.address().port,firstConnection,close:()=>new Promise(resolve=>{for(const socket of sockets)socket.destroy();server.close(()=>resolve())})};
}

// Every socket a call opens, and the keepalive state Node records on each (its kSetKeepAlive symbols, which it applies to the
// connection), whichever way it was set.
async function socketsOpenedBy(run){
  const sockets=[],connect=net.Socket.prototype.connect;
  net.Socket.prototype.connect=function(...args){sockets.push(this);return connect.apply(this,args)};
  try{await run()}finally{net.Socket.prototype.connect=connect}
  return sockets;
}
const keepAliveState=socket=>Object.fromEntries(Object.getOwnPropertySymbols(socket).filter(symbol=>/^kSetKeepAlive/.test(String(symbol.description))).map(symbol=>[String(symbol.description),socket[symbol]]));

test("every connection the Meta stream's transport opens has TCP keepalive on after 60 s without traffic, as Node's fetch has on its own",async()=>{
  const meta=await startMeta(),silent=await startSilent();
  try{
    // Node's fetch, to a server it has no connection to yet.
    const byFetch=await socketsOpenedBy(async()=>{await (await fetch(meta.origin+"/warm",{method:"POST",body:"{}"})).text()});
    assert.equal(byFetch.length,1);
    assert.deepEqual(keepAliveState(byFetch[0]),{kSetKeepAlive:true,kSetKeepAliveInitialDelay:60},"Node's fetch: keepalive after 60 s");
    // The transport over http, a whole answer read, and over https, looked at once its connection is open, then stopped.
    const byTransport=await socketsOpenedBy(async()=>{await (await providerLongRequestFetch(meta.origin+"/v1/responses",{method:"POST",body:"{}"})).text()});
    const controller=new AbortController();
    byTransport.push(...await socketsOpenedBy(async()=>{
      const pending=providerLongRequestFetch(`https://127.0.0.1:${silent.port}/v1/responses`,{method:"POST",body:"{}",signal:controller.signal});
      await silent.firstConnection;await new Promise(resolve=>setImmediate(resolve));controller.abort();
      await assert.rejects(pending,error=>error.name==="AbortError");
    }));
    assert.equal(byTransport.length,2,"one connection a request");
    for(const socket of byTransport)assert.deepEqual(keepAliveState(socket),keepAliveState(byFetch[0]),socket.constructor.name);
    assert.equal(longRequest.PROVIDER_LONG_REQUEST_KEEPALIVE_DELAY_MS,60_000);
  }finally{await meta.close();await silent.close()}
});

test("a connection the Meta stream's transport cannot make in 10 s fails as Node's fetch fails it, and the loop waits it out as it does Node fetch's",async()=>{
  const silent=await startSilent();
  try{
    const url=`https://127.0.0.1:${silent.port}/v1/responses`;
    // Each call is stopped after 20 s, so a transport with no connect timeout fails here instead of hanging.
    const attempt=async send=>{
      const controller=new AbortController(),guard=setTimeout(()=>controller.abort(new Error("no answer in 20 s")),20_000),started=Date.now();
      try{await send({method:"POST",body:"{}",signal:controller.signal});return {error:null,ms:Date.now()-started}}
      catch(error){return {error,ms:Date.now()-started}}
      finally{clearTimeout(guard)}
    };
    const [transport,node]=await Promise.all([attempt(init=>providerLongRequestFetch(url,init)),attempt(init=>fetch(url,init))]);
    for(const [name,{error,ms}] of [["the transport",transport],["Node's fetch",node]]){
      assert.equal(error?.cause?.code,"UND_ERR_CONNECT_TIMEOUT",`${name} failed with ${error?.message} (${error?.cause?.code})`);
      assert.ok(ms>=9_900&&ms<19_000,`${name} gave up at the 10 s connect timeout (${ms} ms)`);
    }
    // The same error: a TypeError "fetch failed" over undici's ConnectTimeoutError.
    const shape=error=>({name:error.name,message:error.message,causeName:error.cause.name,causeCode:error.cause.code});
    assert.deepEqual(shape(transport.error),shape(node.error));
    for(const {error} of [transport,node])assert.match(error.cause.message,/^Connect Timeout Error \(attempted address: 127\.0\.0\.1:\d+, timeout: 10000ms\)$/);
    // The loop's classes: a network failure, a connection that could not be made, retryable.
    const classes=error=>({network:nativeProviderNetworkFailure(error),connect:nativeProviderConnectFailure(error),retryable:nativeProviderRetryable(error)});
    assert.deepEqual(classes(transport.error),{network:true,connect:true,retryable:true});
    assert.deepEqual(classes(transport.error),classes(node.error));
    // In the loop: past the quick retries and the four stepped waits, a connection that could not be made is waited out every minute
    // (5 ms here) until the request gets through, for this error as for Node fetch's.
    const waitedOut=async failure=>{
      const events=[];let attempts=0;
      const result=await runNativeAgentTurn({model:MODEL,messages:[{role:"user",content:"through the outage"}],retryBaseDelayMs:0,networkRetryDelaysMs:[1,2,3,4],networkWaitIntervalMs:5,onEvent:event=>events.push(event),
        providerTurn:async()=>{attempts++;if(attempts<=10)throw failure;return {text:"back",toolCalls:[],usage:{inputTokens:2,outputTokens:1,totalTokens:3}}},executeTool:async()=>""});
      return {text:result.text,attempts,retries:events.filter(event=>event.name==="native.model.retrying").map(({data})=>({delayMs:data.delayMs,networkRetry:data.networkRetry??null,waitingForNetwork:data.waitingForNetwork??null}))};
    };
    const viaTransport=await waitedOut(transport.error),viaNode=await waitedOut(node.error);
    assert.equal(viaTransport.text,"back");assert.equal(viaTransport.attempts,11);
    assert.deepEqual(viaTransport.retries.map(item=>item.delayMs),[0,0,1,2,3,4,5,5,5,5]);
    assert.deepEqual(viaTransport.retries.slice(6).map(item=>item.waitingForNetwork),[true,true,true,true],"waited out as a network that is away");
    assert.deepEqual(viaTransport,viaNode);
    assert.equal(longRequest.PROVIDER_LONG_REQUEST_CONNECT_TIMEOUT_MS,10_000);
  }finally{await silent.close()}
});
