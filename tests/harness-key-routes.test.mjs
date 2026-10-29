// Settings' routes for how a profile signs in, outside mock mode, with a stand-in for the Codex CLI (TREBELL_CODEX_BIN):
// - the method route changes only the profile its row names: an id no profile has (a row another window removed) changes none;
// - a Codex profile that is not the active one stops the app-servers its threads run on once its method changes, or the OpenAI key it
//   runs on is saved or removed, so none goes on serving a thread on the sign-in or key the person moved off;
// - no Codex home of Trebell's own for a key keeps a copy of the OpenAI key once its profile is removed, or the key is.
// The stand-in answers `codex login --with-api-key` (writing its home's auth.json, as Codex does), `codex logout` (deleting it) and
// `codex app-server` (a WebSocket that answers every request), and logs each call with its CODEX_HOME. Fixture keys, fresh folders.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocket } from "ws";
import { createGuiServer, offlineE2eFetch } from "../src/gui-server.mjs";
import { TrebellStateStore } from "../src/trebell-state.mjs";
import { ProviderManager } from "../src/provider-manager.mjs";
import { codexApiKeyHome } from "../src/agent-runtime-manager.mjs";

const require=createRequire(import.meta.url);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const alive=pid=>{try{process.kill(pid,0);return true}catch{return false}};
async function waitFor(check,timeoutMs=15_000){const end=Date.now()+timeoutMs;while(Date.now()<end){if(await check())return true;await sleep(50)}return false}
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}
const KEY="sk-fixture-openai-routes";

const fakeCodexSource=({log,wsModule})=>`import { createServer } from "node:http";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ws from ${JSON.stringify(wsModule)};
const args=process.argv.slice(2),home=process.env.CODEX_HOME||"";
const note=entry=>appendFileSync(${JSON.stringify(log)},JSON.stringify({...entry,home,pid:process.pid})+"\\n");
if(args[0]==="login"&&args[1]==="--with-api-key"){
  let input="";process.stdin.on("data",chunk=>{input+=chunk});
  process.stdin.on("end",()=>{mkdirSync(home,{recursive:true});writeFileSync(join(home,"auth.json"),JSON.stringify({auth_mode:"apikey",OPENAI_API_KEY:input.trim()}));note({call:"login"});process.exit(0)});
}else if(args[0]==="logout"){rmSync(join(home,"auth.json"),{force:true});note({call:"logout"});process.exit(0)}
else if(args[0]==="app-server"){
  const listen=String(args[args.indexOf("--listen")+1]||"");note({call:"app-server"});
  const server=createServer((req,res)=>{res.writeHead(req.url==="/readyz"?200:404);res.end()});
  const wss=new ws.WebSocketServer({noServer:true});
  server.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,client=>client.on("message",raw=>{
    const message=JSON.parse(String(raw));if(message.id==null||!message.method)return;
    client.send(JSON.stringify({id:message.id,result:message.method==="initialize"?{userAgent:"fake-codex"}:message.method==="thread/read"?{thread:{id:message.params?.threadId,turns:[]}}:{data:[]}}));
  })));
  server.listen(Number(new URL(listen).port),"127.0.0.1");
}else process.exit(1);
`;

// A Trebell home with Native active, Codex profiles of the test's own (codex-default and the others given) and the thread named in
// threads on its profile, the OpenAI key saved in Trebell's store, and the stand-in as the Codex CLI.
async function fixture(t,{profiles=[],threads={},settings={}}={}){
  const root=await mkdtemp(join(tmpdir(),"trebell-key-routes-")),log=join(root,"codex-calls.jsonl"),script=join(root,"fake-codex.mjs");
  let gui=null;t.after(async()=>{await gui?.close();await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100})});
  await mkdir(join(root,"codex-home"),{recursive:true});await writeFile(log,"");
  await writeFile(script,fakeCodexSource({log,wsModule:pathToFileURL(require.resolve("ws")).href}));
  const bin=join(root,process.platform==="win32"?"fake-codex.cmd":"fake-codex");
  await writeFile(bin,process.platform==="win32"?`@"${process.execPath}" "${script}" %*\r\n`:`#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,{mode:0o755});
  // Every other harness is missing from this machine as the server sees it: a person's home, PATH, temp folder and Trebell home of the
  // test's own, and no key or sign-in of the shell that runs the tests.
  const person=join(root,"person"),windows=process.platform==="win32";
  await mkdir(join(person,"AppData","Roaming"),{recursive:true});await mkdir(join(person,"AppData","Local"),{recursive:true});await mkdir(join(root,"tmp"),{recursive:true});
  const system=windows?{SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,COMSPEC:process.env.COMSPEC,PATHEXT:process.env.PATHEXT,PATH:[dirname(process.execPath),join(process.env.SystemRoot||"C:\\Windows","System32")].join(";")}:{PATH:[dirname(process.execPath),"/usr/bin","/bin"].join(":")};
  const env={...system,TEMP:join(root,"tmp"),TMP:join(root,"tmp"),TMPDIR:join(root,"tmp"),USERPROFILE:person,HOME:person,APPDATA:join(person,"AppData","Roaming"),LOCALAPPDATA:join(person,"AppData","Local"),
    TREBELL_HOME:join(root,"home"),CODEX_HOME:join(root,"codex-home"),TREBELL_CODEX_BIN:bin,TREBELL_HISTORY_DISABLE_CLAUDE:"1"};
  const state=new TrebellStateStore(env);
  state.updateSettings({onboardingComplete:true,agentRuntime:"native",agentRuntimeInstanceId:"native-default",agentRuntimeInstances:[{id:"codex-default",kind:"codex",displayName:"Codex",enabled:true,environment:{}},...profiles],...settings});
  for(const [threadId,runtimeInstanceId] of Object.entries(threads))state.updateThreadMeta(threadId,{runtime:"codex",runtimeInstanceId,environmentId:null});
  state.close();
  new ProviderManager({env}).setKey("openai",KEY);
  const [port,appPort]=await Promise.all([freePort(),freePort()]);
  gui=await createGuiServer({port,appPort,mock:false,env,fetchFn:offlineE2eFetch()});
  const calls=async()=>(await readFile(log,"utf8")).split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
  const post=async(path,body)=>{const response=await fetch(gui.url+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});return {status:response.status,body:await response.json().catch(()=>null)}};
  const methods=async()=>Object.fromEntries(((await fetch(gui.url+"/api/agent-runtimes").then(response=>response.json())).instances||[]).filter(item=>item.signIn).map(item=>[item.id,item.signIn.method]));
  // A window's Codex socket, whose request about a thread starts that thread's own app-server on the thread's profile.
  async function codexRequest(method,params){
    const ws=new WebSocket(gui.url.replace(/^http/,"ws")+"/api/codex/ws");
    await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});
    try{
      return await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error(method+" timed out")),30_000);
        ws.on("message",raw=>{const message=JSON.parse(String(raw));if(message.id!==1)return;clearTimeout(timer);message.error?reject(new Error(message.error.message)):resolve(message.result)});
        ws.send(JSON.stringify({id:1,method,params}));
      });
    }finally{ws.close()}
  }
  const settingsNow=async()=>fetch(gui.url+"/api/settings").then(response=>response.json());
  return {root,env,gui,calls,post,methods,codexRequest,settingsNow,keyHome:id=>codexApiKeyHome(env,{id})};
}
const serversOf=(calls,home)=>calls.filter(entry=>entry.call==="app-server"&&(!home||resolve(entry.home)===resolve(home)));

test("Settings' method for a profile no one has changes no profile, and answers that it was not found",{timeout:60_000},async t=>{
  const fx=await fixture(t,{profiles:[{id:"codex-b",kind:"codex",displayName:"Codex B",enabled:true,environment:{}}]});
  const before=await fx.methods();
  assert.ok(Object.values(before).every(method=>method==="sign-in"));
  // A Claude Code row another window removed, posting its id (and its harness, as Settings' rows do).
  const removed=await fx.post("/api/agent-runtime-auth",{action:"method",runtime:"codex",instanceId:"claude-1790000000000",method:"api-key"});
  assert.equal(removed.status,404);assert.equal(removed.body.error,"Runtime profile was not found");
  const unnamed=await fx.post("/api/agent-runtime-auth",{action:"method",runtime:"codex",method:"api-key"});
  assert.equal(unnamed.status,404);
  assert.deepEqual(await fx.methods(),before,"no profile moved to its key");
  assert.deepEqual((await fx.calls()).filter(entry=>entry.call==="login"),[],"no Codex signed in with the key");
  // The profile named is the one that changes.
  const named=await fx.post("/api/agent-runtime-auth",{action:"method",runtime:"codex",instanceId:"codex-b",method:"api-key"});
  assert.equal(named.status,200);assert.equal(named.body.instanceId,"codex-b");
  assert.deepEqual(await fx.methods(),{...before,"codex-b":"api-key"});
});

test("a Codex profile that is not the active one stops its threads' app-servers when its method changes or its OpenAI key is removed",{timeout:120_000},async t=>{
  const fx=await fixture(t,{profiles:[{id:"codex-b",kind:"codex",displayName:"Codex B",enabled:true,environment:{}}],threads:{"thread-b":"codex-b"}});
  assert.equal((await fx.codexRequest("thread/read",{threadId:"thread-b"})).thread.id,"thread-b");
  const [onSignIn]=serversOf(await fx.calls(),fx.env.CODEX_HOME);
  assert.ok(onSignIn&&alive(onSignIn.pid),"the thread's app-server runs on the profile's own sign-in");
  // Settings moves Codex B, which is not the active profile, to its API key.
  const moved=await fx.post("/api/agent-runtime-auth",{action:"method",runtime:"codex",instanceId:"codex-b",method:"api-key"});
  assert.equal(moved.status,200);
  assert.ok(await waitFor(()=>!alive(onSignIn.pid)),"the app-server on the sign-in the person moved off stopped");
  // The thread's next request starts Codex B on the key, in its home of Trebell's own.
  assert.equal((await fx.codexRequest("thread/read",{threadId:"thread-b"})).thread.id,"thread-b");
  const [onKey]=serversOf(await fx.calls(),fx.keyHome("codex-b"));
  assert.ok(onKey&&alive(onKey.pid),"the thread's app-server runs on the key");
  assert.ok((await fx.calls()).some(entry=>entry.call==="login"&&resolve(entry.home)===resolve(fx.keyHome("codex-b"))));
  assert.equal(existsSync(join(fx.keyHome("codex-b"),"auth.json")),true);
  // The OpenAI key removed from the Model provider card: the app-server on it stops, and its home keeps no copy of the key.
  const removed=await fx.post("/api/providers",{provider:"openai",apiKey:"",select:false});
  assert.equal(removed.status,200);
  assert.ok(await waitFor(()=>!alive(onKey.pid)),"the app-server on the removed key stopped");
  assert.equal(existsSync(join(fx.keyHome("codex-b"),"auth.json")),false);
});

test("no Codex home of Trebell's own for a key keeps the OpenAI key once its profile is removed, or the key is",{timeout:90_000},async t=>{
  const fx=await fixture(t,{profiles:[{id:"codex-c",kind:"codex",displayName:"Codex C",enabled:true,environment:{},auth:"api-key"}]});
  // Homes a key sign-in left: the listed profile's, and one of a profile removed before (whose row is gone).
  for(const id of ["codex-c","codex-gone"]){await mkdir(fx.keyHome(id),{recursive:true});await writeFile(join(fx.keyHome(id),"auth.json"),JSON.stringify({auth_mode:"apikey",OPENAI_API_KEY:KEY}))}
  const response=await fetch(fx.gui.url+"/api/agent-runtimes?id=codex-c",{method:"DELETE"});
  assert.equal(response.status,200);
  assert.equal(existsSync(join(fx.keyHome("codex-c"),"auth.json")),false,"the removed profile's home signed out");
  assert.ok((await fx.calls()).some(entry=>entry.call==="logout"&&resolve(entry.home)===resolve(fx.keyHome("codex-c"))),"with codex logout");
  assert.equal(existsSync(join(fx.keyHome("codex-gone"),"auth.json")),true,"another home is left until the key goes");
  assert.equal((await fx.post("/api/providers",{provider:"openai",apiKey:"",select:false})).status,200);
  assert.equal(existsSync(join(fx.keyHome("codex-gone"),"auth.json")),false,"a removed profile's home signs out with the key");
  assert.ok((await fx.calls()).some(entry=>entry.call==="logout"&&resolve(entry.home)===resolve(fx.keyHome("codex-gone"))));
});

test("what the move of Antigravity's old key said on its row ends once the Gemini key or Antigravity's method changes",{timeout:60_000},async t=>{
  const note="The other key Antigravity's old key form held was not kept: one Google Gemini API key serves Trebell Native and Antigravity, and the one saved in Trebell Code stays.";
  const fx=await fixture(t,{profiles:[{id:"antigravity-default",kind:"antigravity",displayName:"Antigravity",enabled:true,environment:{},auth:"api-key"}],settings:{antigravityKeyNote:note}});
  assert.equal((await fx.settingsNow()).antigravityKeyNote,note);
  assert.equal((await fx.post("/api/providers",{provider:"xai",apiKey:"",select:false})).status,200);
  assert.equal((await fx.settingsNow()).antigravityKeyNote,note,"another provider's key changes nothing of it");
  assert.equal((await fx.post("/api/providers",{provider:"gemini",apiKey:"",select:false})).status,200);
  assert.equal((await fx.settingsNow()).antigravityKeyNote??null,null);
  const again=await fixture(t,{profiles:[{id:"antigravity-default",kind:"antigravity",displayName:"Antigravity",enabled:true,environment:{},auth:"api-key"}],settings:{antigravityKeyNote:note}});
  assert.equal((await again.post("/api/agent-runtime-auth",{action:"method",runtime:"antigravity",instanceId:"antigravity-default",method:"sign-in"})).status,200);
  assert.equal((await again.settingsNow()).antigravityKeyNote??null,null);
});
