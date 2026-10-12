import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { WebSocket } from "ws";
import { createGuiServer, offlineE2eFetch } from "../src/gui-server.mjs";
import { TrebellStateStore } from "../src/trebell-state.mjs";
import { EnvironmentManager } from "../src/environment-manager.mjs";

const require=createRequire(import.meta.url);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}
async function waitFor(check,timeoutMs=10000){const started=Date.now();while(Date.now()-started<timeoutMs){if(await check())return true;await sleep(50)}return false}
const alive=pid=>{try{process.kill(pid,0);return true}catch{return false}};

// A Codex CLI stand-in for the catalog app-server. `app-server --listen ws://127.0.0.1:<port>` logs its pid, answers /readyz once the
// ready file exists and answers every JSON-RPC request over a WebSocket. Anything else (`--version`, the account probe's stdio
// app-server) exits with an error, so the runtime probe finds no Codex and starts nothing.
const fakeCodexSource=({log,readyFile,wsModule})=>`import { createServer } from "node:http";
import { appendFileSync, existsSync } from "node:fs";
import ws from ${JSON.stringify(wsModule)};
const args=process.argv.slice(2),listen=args[0]==="app-server"?String(args[args.indexOf("--listen")+1]||""):"";
if(!listen.startsWith("ws://"))process.exit(1);
appendFileSync(${JSON.stringify(log)},process.pid+"\\n");
const server=createServer((req,res)=>{res.writeHead(req.url==="/readyz"&&existsSync(${JSON.stringify(readyFile)})?200:503);res.end()});
const wss=new ws.WebSocketServer({noServer:true});
server.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,client=>client.on("message",raw=>{
  const message=JSON.parse(String(raw));if(message.id==null||!message.method)return;
  client.send(JSON.stringify({id:message.id,result:message.method==="initialize"?{userAgent:"fake-codex"}:{data:[]}}));
})));
server.listen(Number(new URL(listen).port),"127.0.0.1");
`;

// A fresh home with the runtime given active and the fake as the Codex CLI (TREBELL_CODEX_BIN), Codex history in its own CODEX_HOME.
async function codexFixture(prefix,{runtime,ready=true}={}){
  const root=await mkdtemp(join(tmpdir(),prefix)),log=join(root,"starts.log"),readyFile=join(root,"ready"),script=join(root,"fake-codex.mjs");
  await mkdir(join(root,"codex-home"),{recursive:true});await writeFile(log,"");if(ready)await writeFile(readyFile,"");
  await writeFile(script,fakeCodexSource({log,readyFile,wsModule:pathToFileURL(require.resolve("ws")).href}));
  const bin=join(root,process.platform==="win32"?"fake-codex.cmd":"fake-codex");
  await writeFile(bin,process.platform==="win32"?`@"${process.execPath}" "${script}" %*\r\n`:`#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,{mode:0o755});
  const env={...process.env,TREBELL_HOME:join(root,"home"),CODEX_HOME:join(root,"codex-home"),TREBELL_CODEX_BIN:bin,TREBELL_GUI_MOCK:"",TREBELL_E2E_OFFLINE:"",TREBELL_HISTORY_DISABLE_CLAUDE:"1"};
  const state=new TrebellStateStore(env);state.updateSettings({agentRuntime:runtime,agentRuntimeInstanceId:runtime+"-default",onboardingComplete:true});state.close();
  const [port,appPort]=await Promise.all([freePort(),freePort()]);
  return {
    root,env,port,appPort,readyFile,
    start:()=>createGuiServer({port,appPort,mock:false,env,fetchFn:offlineE2eFetch()}),
    starts:async()=>(await readFile(log,"utf8")).split(/\r?\n/).filter(Boolean).map(Number),
    cleanup:()=>rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100}),
  };
}
async function codexSocket(gui){
  const ws=new WebSocket(gui.url.replace(/^http/,"ws")+"/api/codex/ws");
  await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});
  let next=1;
  ws.rpc=(method,params={})=>new Promise((resolve,reject)=>{
    const id=next++,timer=setTimeout(()=>reject(new Error(method+" timed out")),20000);
    ws.on("message",function reply(raw){const message=JSON.parse(String(raw));if(message.id!==id)return;clearTimeout(timer);ws.off("message",reply);message.error?reject(new Error(message.error.message)):resolve(message.result)});
    ws.send(JSON.stringify({id,method,params}));
  });
  return ws;
}

// The catalog app-server serves only the Codex harness, so with another runtime active it starts with the first Codex request.
test("with Native active the catalog Codex app-server starts with the first Codex request, and close stops it",{timeout:60000},async()=>{
  const fixture=await codexFixture("trebell-codex-catalog-native-",{runtime:"native"});let gui=null,ws=null;
  try{
    gui=await fixture.start();
    const boot=await fetch(gui.url+"/api/bootstrap").then(response=>response.json());
    assert.equal(boot.agentRuntime,"native");assert.equal(boot.agentRuntimeReady,true);assert.equal(boot.appServerReady,false);assert.equal(boot.activeEnvironment,null);
    await sleep(300);assert.deepEqual(await fixture.starts(),[],"no Codex app-server before a Codex request");
    ws=await codexSocket(gui);
    assert.equal((await ws.rpc("initialize",{clientInfo:{name:"catalog-test",version:"1"}})).userAgent,"fake-codex");
    assert.deepEqual(await ws.rpc("model/list"),{data:[]});
    const starts=await fixture.starts();assert.equal(starts.length,1,"one catalog app-server for both requests");
    assert.equal((await fetch(gui.url+"/api/bootstrap").then(response=>response.json())).appServerReady,true);
    ws.close();ws=null;await gui.close();gui=null;
    assert.ok(await waitFor(()=>!alive(starts[0]),5000),"close stops the catalog app-server");
  }finally{ws?.close();await gui?.close();await fixture.cleanup()}
});

test("with Codex active the server listens before the catalog app-server is ready, and the Codex bootstrap waits for it",{timeout:60000},async()=>{
  const fixture=await codexFixture("trebell-codex-catalog-boot-",{runtime:"codex",ready:false});let gui=null,ws=null;
  try{
    gui=await fixture.start();
    // The server answers while the catalog it started is still booting.
    assert.ok(await waitFor(async()=>(await fixture.starts()).length===1),"the catalog app-server starts with Codex active");
    assert.equal((await fetch(gui.url+"/api/health")).status,200);
    let answered=false;const bootstrap=fetch(gui.url+"/api/bootstrap").then(response=>response.json()).then(body=>{answered=true;return body});
    await sleep(700);assert.equal(answered,false,"a Codex bootstrap waits for the catalog");
    await writeFile(fixture.readyFile,"");
    const boot=await bootstrap;
    assert.equal(boot.agentRuntime,"codex");assert.equal(boot.appServerReady,true);assert.equal(boot.appServerError,null);
    ws=await codexSocket(gui);assert.equal((await ws.rpc("initialize",{clientInfo:{name:"catalog-test",version:"1"}})).userAgent,"fake-codex");
    const starts=await fixture.starts();assert.equal(starts.length,1);
    ws.close();ws=null;await gui.close();gui=null;
    assert.ok(await waitFor(()=>!alive(starts[0]),5000),"close stops the catalog app-server");
  }finally{ws?.close();await gui?.close();await fixture.cleanup()}
});

test("closing the server while the catalog app-server boots stops it without waiting the boot out",{timeout:60000},async()=>{
  const fixture=await codexFixture("trebell-codex-catalog-close-",{runtime:"codex",ready:false});let gui=null;
  try{
    gui=await fixture.start();
    assert.ok(await waitFor(async()=>(await fixture.starts()).length===1));
    const [pid]=await fixture.starts(),started=performance.now();
    await gui.close();gui=null;
    // The boot would wait 15 s for a server that never answers.
    assert.ok(performance.now()-started<8000,"close took "+Math.round(performance.now()-started)+" ms");
    assert.ok(await waitFor(()=>!alive(pid),5000),"no Codex app-server outlives the server");
  }finally{await gui?.close();await fixture.cleanup()}
});

// Two things the catalog app-server reported while it ran for every runtime, which the server now knows without starting it.
test("with Native active the bootstrap names the active remote environment without starting a Codex app-server",{timeout:60000},async()=>{
  const fixture=await codexFixture("trebell-codex-catalog-environment-",{runtime:"native"});let gui=null;
  try{
    const state=new TrebellStateStore(fixture.env),profile=new EnvironmentManager({state,env:fixture.env}).upsert({type:"ssh",name:"Build box",host:"build.invalid",user:"dev",cwd:"/srv/app"});
    state.updateSettings({activeEnvironmentId:profile.id});state.close();
    gui=await fixture.start();
    const boot=await fetch(gui.url+"/api/bootstrap").then(response=>response.json());
    assert.deepEqual(boot.activeEnvironment,{id:profile.id,name:"Build box",type:"ssh",cwd:"/srv/app"});
    assert.deepEqual((await fetch(gui.url+"/api/runtime").then(response=>response.json())).activeEnvironment,boot.activeEnvironment);
    assert.deepEqual(await fixture.starts(),[]);
  }finally{await gui?.close();await fixture.cleanup()}
});

test("with Native active the history scan leaves out the Codex home the catalog app-server would run on",{timeout:60000},async()=>{
  const fixture=await codexFixture("trebell-codex-catalog-history-",{runtime:"native"});let gui=null;
  try{
    const sessions=join(fixture.env.CODEX_HOME,"sessions","2026","10","12");await mkdir(sessions,{recursive:true});
    await writeFile(join(sessions,"rollout-catalog.jsonl"),[
      {timestamp:"2026-10-12T08:00:00.000Z",type:"session_meta",payload:{id:"codex-session-catalog",cwd:fixture.root}},
      {timestamp:"2026-10-12T08:00:01.000Z",type:"event_msg",payload:{type:"user_message",message:"Fix the build"}},
    ].map(line=>JSON.stringify(line)).join("\n")+"\n");
    const codexSessions=async()=>(await fetch(gui.url+"/api/history-import").then(response=>response.json())).sessions.filter(item=>item.source==="codex");
    // The default Codex profile runs on CODEX_HOME, whose sessions Codex lists itself.
    gui=await fixture.start();assert.deepEqual(await codexSessions(),[]);await gui.close();gui=null;
    // A profile on a home of its own leaves CODEX_HOME's sessions to import.
    const state=new TrebellStateStore(fixture.env);
    state.updateSettings({agentRuntimeInstances:[{id:"codex-default",kind:"codex",displayName:"Codex",enabled:true,homePath:join(fixture.root,"codex-profile-home"),shadowHomePath:"",environment:{}}]});state.close();
    gui=await fixture.start();assert.deepEqual((await codexSessions()).map(item=>item.providerSessionId),["codex-session-catalog"]);
    assert.deepEqual(await fixture.starts(),[]);
  }finally{await gui?.close();await fixture.cleanup()}
});
