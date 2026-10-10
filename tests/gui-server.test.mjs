import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { EventEmitter } from "node:events";
import { createGuiServer, offlineE2eFetch, requestAbortController } from "../src/gui-server.mjs";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";
import { ProviderManager } from "../src/provider-manager.mjs";
import { git } from "../src/git-service.mjs";
import { TrebellStateStore } from "../src/trebell-state.mjs";

const packageVersion=JSON.parse(await readFile(new URL("../package.json",import.meta.url),"utf8")).version;
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

test("request cancellation follows client disconnects but ignores a completed response",()=>{
  const request=new EventEmitter(),response=new EventEmitter();response.writableEnded=false;
  const cancelled=requestAbortController(request,response);request.emit("aborted");
  assert.equal(cancelled.signal.aborted,true);assert.equal(cancelled.signal.reason?.name,"AbortError");cancelled.dispose();

  const completedRequest=new EventEmitter(),completedResponse=new EventEmitter();completedResponse.writableEnded=true;
  const completed=requestAbortController(completedRequest,completedResponse);completedResponse.emit("close");
  assert.equal(completed.signal.aborted,false);completed.dispose();
});

test("offline browser E2E fetch allows loopback only",async()=>{
  const requested=[];
  const guarded=offlineE2eFetch(async(input)=>{
    requested.push(input instanceof URL?input.href:String(input?.url||input));
    return new Response("ok",{status:200});
  });
  for(const url of ["http://127.0.0.1:3210/health","http://localhost:23333/state","http://[::1]:8080/"]){
    const response=await guarded(url);
    assert.equal(response.status,200);
  }
  await assert.rejects(()=>guarded("https://api.openai.com/v1/models"),/blocked external network request/);
  await assert.rejects(()=>guarded("https://api.github.com/repos/tanishqbaweja/trebellcode"),/blocked external network request/);
  await assert.rejects(()=>guarded("https://example.com/"),/blocked external network request/);
  assert.equal(requested.length,3);
});

test("offline browser E2E refuses to start a real provider or Codex app-server",async()=>{
  await assert.rejects(
    ()=>createGuiServer({mock:false,env:{...process.env,TREBELL_E2E_OFFLINE:"1"}}),
    /Offline browser E2E forbids starting a real Trebell provider or Codex app-server/,
  );
  const previous=process.env.TREBELL_E2E_OFFLINE;
  process.env.TREBELL_E2E_OFFLINE="1";
  try{
    await assert.rejects(
      ()=>createGuiServer({mock:false,env:{TREBELL_HOME:process.env.TREBELL_HOME||""}}),
      /Offline browser E2E forbids starting a real Trebell provider or Codex app-server/,
    );
  }finally{
    if(previous==null)delete process.env.TREBELL_E2E_OFFLINE;
    else process.env.TREBELL_E2E_OFFLINE=previous;
  }
});

test("runtime install endpoint bundles refresh state only for the active harness",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-runtime-install-refresh-test-"));
  const originalInstall=AgentRuntimeManager.prototype.install;
  const originalProbe=AgentRuntimeManager.prototype.probe;
  const installs=[];
  AgentRuntimeManager.prototype.install=async function(runtime,{environmentId=undefined}={}){
    installs.push({runtime,environmentId:environmentId??null});
    return {ok:true,runtime,status:{id:`${runtime}-default`,kind:runtime,name:runtime,available:true,installed:true,authenticated:true,version:"fixture"}};
  };
  AgentRuntimeManager.prototype.probe=async function(instanceOrKind){
    const instance=typeof instanceOrKind==="string"
      ?this.instances().find(item=>item.id===instanceOrKind||item.kind===instanceOrKind)
      :instanceOrKind;
    const kind=instance?.kind||String(instanceOrKind||"codex");
    return {id:instance?.id||`${kind}-default`,kind,name:kind,available:true,installed:true,authenticated:true,version:"fixture"};
  };
  const env={...process.env,TREBELL_HOME:home,TREBELL_HISTORY_DISABLE_CLAUDE:"1"};
  const [port,appPort]=await Promise.all([freePort(),freePort()]);
  let gui=null;
  try{
    gui=await createGuiServer({port,appPort,mock:true,env});
    const inactive=await fetch(gui.url+"/api/agent-runtimes",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"install",runtime:"claude",environmentId:null})}).then(r=>r.json());
    assert.equal(inactive.selectedRuntime,"codex");
    assert.equal(Object.prototype.hasOwnProperty.call(inactive,"bootstrap"),false);
    assert.equal(Object.prototype.hasOwnProperty.call(inactive,"catalog"),false);

    const selected=await fetch(gui.url+"/api/agent-runtimes",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"select",runtime:"claude",instanceId:"claude-default"})}).then(r=>r.json());
    assert.equal(selected.selectedRuntime,"claude");
    assert.ok(selected.bootstrap);
    assert.ok(selected.catalog);

    const active=await fetch(gui.url+"/api/agent-runtimes",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"install",runtime:"claude",environmentId:null})}).then(r=>r.json());
    assert.equal(active.selectedRuntime,"claude");
    assert.equal(active.installed.runtime,"claude");
    assert.ok(active.bootstrap);
    assert.ok(active.catalog);
    assert.deepEqual(installs,[{runtime:"claude",environmentId:null},{runtime:"claude",environmentId:null}]);
  }finally{
    if(gui)await gui.close();
    AgentRuntimeManager.prototype.install=originalInstall;
    AgentRuntimeManager.prototype.probe=originalProbe;
    await rm(home,{recursive:true,force:true});
  }
});

test("the runtime status poll probes only the active harness",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-runtime-poll-probe-test-"));
  await writeFile(join(home,"ui-state.json"),JSON.stringify({settings:{agentRuntime:"claude",agentRuntimeInstanceId:"claude-default",onboardingComplete:true}}));
  const originalProbe=AgentRuntimeManager.prototype.probe;
  const probes=[];
  AgentRuntimeManager.prototype.probe=async function(instanceOrKind){
    const instance=typeof instanceOrKind==="string"?this.instances().find(item=>item.id===instanceOrKind||item.kind===instanceOrKind):instanceOrKind;
    probes.push(instance?.id||String(instanceOrKind));
    return {id:instance?.id,kind:instance?.kind,name:instance?.kind,available:true,installed:true,authenticated:true,version:"fixture"};
  };
  const env={...process.env,TREBELL_HOME:home,TREBELL_HISTORY_DISABLE_CLAUDE:"1"};
  const [port,appPort]=await Promise.all([freePort(),freePort()]);
  let gui=null;
  try{
    gui=await createGuiServer({port,appPort,mock:true,env});
    probes.length=0;
    const runtime=await fetch(gui.url+"/api/runtime").then(r=>r.json());
    assert.equal(runtime.agentRuntime,"claude");assert.equal(runtime.agentRuntimeInstanceId,"claude-default");
    assert.equal(runtime.agentRuntimeStatus?.id,"claude-default");assert.equal(runtime.agentRuntimeStatus?.available,true);
    assert.deepEqual(probes,["claude-default"],"a status poll must not start every installed harness CLI");
  }finally{
    if(gui)await gui.close();
    AgentRuntimeManager.prototype.probe=originalProbe;
    await rm(home,{recursive:true,force:true,maxRetries:20,retryDelay:100});
  }
});

test("saving a Native provider key does not refetch the live model catalog during the immediate UI refresh",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-provider-refresh-"));
  const env={...process.env,TREBELL_HOME:home,OPENAI_API_KEY:"",ANTHROPIC_API_KEY:"",GEMINI_API_KEY:"",GOOGLE_API_KEY:""};
  const state=new TrebellStateStore(env);
  state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"openai",onboardingComplete:true});
  state.close?.();
  let modelFetches=0;
  const fetchFn=async input=>{
    const url=String(input instanceof URL?input.href:input?.url||input);
    if(url.endsWith("/models")){
      modelFetches++;
      return new Response(JSON.stringify({data:[{id:"gpt-provider-fixture",created:1}]}),{status:200,headers:{"content-type":"application/json"}});
    }
    throw new Error("Unexpected external request: "+url);
  };
  const [port,appPort]=await Promise.all([freePort(),freePort()]);
  const gui=await createGuiServer({port,appPort,mock:false,env,fetchFn});
  try{
    const saved=await fetch(gui.url+"/api/providers",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({provider:"openai",apiKey:"sk-provider-fixture"})}).then(r=>r.json());
    assert.equal(saved.ready,true);assert.deepEqual(saved.models,["gpt-provider-fixture"]);assert.equal(saved.defaultModel,"gpt-provider-fixture");
    assert.equal(modelFetches,1);
    const catalog=await fetch(gui.url+"/api/models").then(r=>r.json());
    assert.equal(catalog.provider,"openai");assert.deepEqual(catalog.models,["gpt-provider-fixture"]);assert.equal(catalog.defaultModel,"gpt-provider-fixture");
  }finally{
    await gui.close();
    await rm(home,{recursive:true,force:true});
  }
});

test("direct chat never sends another harness's prompt to the Native provider",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-direct-chat-harness-"));
  await writeFile(join(home,"ui-state.json"),JSON.stringify({settings:{agentRuntime:"claude",agentRuntimeInstanceId:"claude-default",modelProvider:"openai",onboardingComplete:true}}));
  const env={...process.env,TREBELL_HOME:home,TREBELL_HISTORY_DISABLE_CLAUDE:"1",OPENAI_API_KEY:"sk-direct-chat-fixture",ANTHROPIC_API_KEY:"",GEMINI_API_KEY:"",GOOGLE_API_KEY:""};
  const requests=[];
  const fetchFn=async input=>{requests.push(String(input instanceof URL?input.href:input?.url||input));throw new Error("No model provider request is expected")};
  const [port,appPort]=await Promise.all([freePort(),freePort()]);
  const gui=await createGuiServer({port,appPort,mock:false,env,fetchFn});
  try{
    const response=await fetch(gui.url+"/api/chat/direct",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({prompt:"A prompt meant for Claude Code",model:"sonnet"})});
    assert.equal(response.status,409);
    assert.equal((await response.json()).error,"Direct chat is only available when Trebell Native is the active harness.");
    assert.deepEqual(requests,[],"the prompt never reaches a model provider");
  }finally{
    await gui.close();
    await rm(home,{recursive:true,force:true,maxRetries:30,retryDelay:100});
  }
});

test("Git commit and review text use the active harness and never the Native provider",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-harness-git-text-"));
  const repo=join(home,"repo");await mkdir(repo,{recursive:true});
  await git(repo,["init"]);await git(repo,["config","user.email","git-text@example.test"]);await git(repo,["config","user.name","Git Text"]);
  await writeFile(join(repo,"notes.txt"),"before\n");await git(repo,["add","notes.txt"]);await git(repo,["commit","-m","Initial notes"]);
  await writeFile(join(repo,"notes.txt"),"after: harness-diff-marker\n");
  await writeFile(join(home,"ui-state.json"),JSON.stringify({settings:{agentRuntime:"claude",agentRuntimeInstanceId:"claude-default",modelProvider:"openai",onboardingComplete:true}}));
  // The boot-time Codex app-server gets its own empty home, so the test never touches the user's Codex state.
  await mkdir(join(home,"codex"),{recursive:true});
  const env={...process.env,TREBELL_HOME:home,CODEX_HOME:join(home,"codex"),TREBELL_HISTORY_DISABLE_CLAUDE:"1",OPENAI_API_KEY:"sk-git-text-fixture",ANTHROPIC_API_KEY:"",GEMINI_API_KEY:"",GOOGLE_API_KEY:""};
  const providerRequests=[],directChats=[],harnessCalls=[];
  const fetchFn=async input=>{providerRequests.push(String(input instanceof URL?input.href:input?.url||input));throw new Error("No model provider request is expected")};
  const originalDirectChat=ProviderManager.prototype.directChat;
  ProviderManager.prototype.directChat=async function(providerId,{model,prompt}){directChats.push({providerId,model,prompt});return {text:"chore: native provider subject",model,provider:providerId}};
  let failNext=null;
  const harnessTextGenerator=async options=>{
    harnessCalls.push(options);
    if(failNext){const error=failNext;failNext=null;throw error}
    return {text:/pull request/.test(options.prompt)?"```json\n{\"title\":\"Harness review\",\"body\":\"Written by the harness.\"}\n```":"\n\"feat: harness subject\"\n",model:"sonnet",runtime:options.instance.kind,name:"Claude Code"};
  };
  const [port,appPort]=await Promise.all([freePort(),freePort()]);
  const gui=await createGuiServer({port,appPort,mock:false,env,fetchFn,harnessTextGenerator});
  const post=(path,body)=>fetch(gui.url+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  try{
    const commitResponse=await post("/api/git/commit-message",{cwd:repo,environmentId:null,model:"sonnet"});
    assert.equal(commitResponse.status,200);
    assert.deepEqual(await commitResponse.json(),{message:"feat: harness subject",style:"repository",model:"sonnet",runtime:"claude",generatedWith:"Claude Code"});
    const commitCall=harnessCalls[0];
    assert.equal(commitCall.instance.id,"claude-default");assert.equal(commitCall.instance.kind,"claude");assert.equal(commitCall.cwd,repo);assert.equal(commitCall.environmentId,null);
    assert.ok(commitCall.timeoutMs>0&&commitCall.timeoutMs<=90_000,"the harness request is bounded by 90 seconds");
    assert.deepEqual(commitCall.models,["sonnet"]);assert.equal(typeof commitCall.codexAppServer,"function");assert.ok(commitCall.signal);
    assert.match(commitCall.prompt,/Write one Git commit subject/);assert.match(commitCall.prompt,/harness-diff-marker/);
    const reviewResponse=await post("/api/git/review-text",{cwd:repo,environmentId:null,model:"sonnet"});
    assert.equal(reviewResponse.status,200);
    assert.deepEqual(await reviewResponse.json(),{title:"Harness review",body:"Written by the harness.",style:"repository",model:"sonnet",runtime:"claude",generatedWith:"Claude Code"});
    assert.match(harnessCalls[1].prompt,/Generate a pull request title and description/);
    failNext=Object.assign(new Error("Claude Code did not return the Git text within 90 seconds. Try again, or choose a faster Claude Code model."),{code:"HARNESS_TEXT_TIMEOUT"});
    const timedOut=await post("/api/git/commit-message",{cwd:home,environmentId:null,model:"sonnet"});
    assert.equal(timedOut.status,504);assert.match((await timedOut.json()).error,/did not return the Git text within 90 seconds/);
    failNext=new Error("Claude Code is installed but not authenticated");
    const unavailable=await post("/api/git/review-text",{cwd:home,environmentId:null});
    assert.equal(unavailable.status,400);assert.equal((await unavailable.json()).error,"Claude Code is installed but not authenticated");
    assert.equal(harnessCalls.length,4);
    assert.deepEqual(directChats,[],"a non-Native harness never sends Git text to the Native provider, even when it fails");
    assert.deepEqual(providerRequests,[]);

    const native=await post("/api/settings",{agentRuntime:"native",agentRuntimeInstanceId:"native-default"});
    assert.equal(native.status,200);
    const nativeCommit=await post("/api/git/commit-message",{cwd:repo,environmentId:null,model:"gpt-native-fixture"}).then(r=>r.json());
    assert.deepEqual(nativeCommit,{message:"chore: native provider subject",style:"repository",model:"gpt-native-fixture",runtime:"native",generatedWith:"OpenAI API"});
    assert.equal(directChats.length,1);assert.equal(directChats[0].providerId,"openai");assert.match(directChats[0].prompt,/harness-diff-marker/);
    assert.equal(harnessCalls.length,4,"Trebell Native keeps the provider path");
  }finally{
    ProviderManager.prototype.directChat=originalDirectChat;
    await gui.close();
    await rm(home,{recursive:true,force:true,maxRetries:30,retryDelay:100});
  }
});

// A stand-in for `codex app-server --listen ws://127.0.0.1:PORT`: it answers the readiness probe and records each start.
const FAKE_CODEX_APP_SERVER=String.raw`
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
const [record,...args]=process.argv.slice(2);const listen=args[args.indexOf("--listen")+1]||"";
if(args[0]!=="app-server"||!listen){process.stdout.write("codex-cli 0.155.1-fixture\n");process.exit(0)}
const port=Number(new URL(listen).port);
const server=createServer((req,res)=>{res.writeHead(req.url==="/readyz"||req.url==="/healthz"?200:404);res.end("ok")});
server.on("upgrade",(_req,socket)=>socket.destroy());
server.listen(port,"127.0.0.1",()=>appendFileSync(record,JSON.stringify({port,pid:process.pid})+"\n"));
`;

test("a profile or environment restart leaves an in-flight Codex Git text app-server running",{skip:/\s/.test(tmpdir())&&"the Codex launcher path is passed through a shell"},async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-git-text-restart-"));
  const repo=join(home,"repo");await mkdir(repo,{recursive:true});
  await git(repo,["init"]);await git(repo,["config","user.email","git-text@example.test"]);await git(repo,["config","user.name","Git Text"]);
  await writeFile(join(repo,"notes.txt"),"before\n");await git(repo,["add","notes.txt"]);await git(repo,["commit","-m","Initial notes"]);
  await writeFile(join(repo,"notes.txt"),"after\n");
  await writeFile(join(home,"ui-state.json"),JSON.stringify({settings:{agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",onboardingComplete:true}}));
  await mkdir(join(home,"codex"),{recursive:true});
  const fixture=join(home,"fake-codex.mjs"),record=join(home,"codex-starts.jsonl"),launcher=join(home,process.platform==="win32"?"codex.cmd":"codex");
  await writeFile(fixture,FAKE_CODEX_APP_SERVER,"utf8");
  if(process.platform==="win32")await writeFile(launcher,["@echo off",`"${process.execPath}" "${fixture}" "${record}" %*`,""].join("\r\n"),"utf8");
  else{await writeFile(launcher,`#!/bin/sh\nexec "${process.execPath}" "${fixture}" "${record}" "$@"\n`,"utf8");await chmod(launcher,0o755)}
  const env={...process.env,TREBELL_HOME:home,CODEX_HOME:join(home,"codex"),TREBELL_CODEX_BIN:launcher,TREBELL_HISTORY_DISABLE_CLAUDE:"1",OPENAI_API_KEY:"",ANTHROPIC_API_KEY:"",GEMINI_API_KEY:"",GOOGLE_API_KEY:""};
  const originalProbe=AgentRuntimeManager.prototype.probe;
  AgentRuntimeManager.prototype.probe=async function(instanceOrKind){
    const instance=typeof instanceOrKind==="string"?this.instances().find(item=>item.kind===instanceOrKind):instanceOrKind;
    return {id:instance?.id,kind:instance?.kind,name:instance?.kind,available:true,installed:true,authenticated:true,version:"fixture"};
  };
  const readyz=url=>fetch(String(url).replace(/^ws:/,"http:")+"/readyz",{signal:AbortSignal.timeout(2000)}).then(response=>response.ok,()=>false);
  let serverReady=null,proceed=null,aliveAfterRestart=null;
  const dedicated=new Promise(resolve=>{serverReady=resolve}),restarted=new Promise(resolve=>{proceed=resolve});
  const harnessTextGenerator=async options=>{
    const server=await options.codexAppServer();serverReady(server);await restarted;
    aliveAfterRestart=await readyz(server.url);await server.release();
    return {text:"fix: keep Git text through restarts",model:null,runtime:"codex",name:"Codex"};
  };
  const [port,appPort]=await Promise.all([freePort(),freePort()]);
  let gui=null;
  try{
    gui=await createGuiServer({port,appPort,mock:false,env,harnessTextGenerator});
    const post=(path,body)=>fetch(gui.url+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
    const pending=post("/api/git/commit-message",{cwd:repo,environmentId:null});
    const server=await dedicated;
    assert.equal(await readyz(server.url),true);
    // Activating an environment restarts every pooled Codex app-server except the one an in-flight Git text request is using.
    const activated=await post("/api/environment/activate",{id:null});assert.equal(activated.status,200);
    const starts=(await readFile(record,"utf8")).trim().split(/\r?\n/).map(line=>JSON.parse(line));
    assert.equal(starts.length,3,"boot catalog, Git text and restarted catalog app-servers");
    proceed();
    const response=await pending;assert.equal(response.status,200);
    assert.equal((await response.json()).message,"fix: keep Git text through restarts");
    assert.equal(aliveAfterRestart,true,"the dedicated Git text app-server outlived the restart");
    assert.equal(await readyz(server.url),false,"the request stops its own app-server afterwards");
  }finally{
    proceed?.();AgentRuntimeManager.prototype.probe=originalProbe;
    if(gui)await gui.close();
    await rm(home,{recursive:true,force:true,maxRetries:30,retryDelay:100});
  }
});

test("mock GUI server serves the default Native provider catalog and direct replies without provider requests",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-mock-provider-"));
  await writeFile(join(home,"ui-state.json"),JSON.stringify({settings:{agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"retired-provider-fixture",onboardingComplete:true}}));
  const env={...process.env,TREBELL_HOME:home,TREBELL_HISTORY_DISABLE_CLAUDE:"1",OPENAI_API_KEY:"",ANTHROPIC_API_KEY:"",GEMINI_API_KEY:"",GOOGLE_API_KEY:""};
  const requests=[];
  const fetchFn=async input=>{requests.push(String(input instanceof URL?input.href:input?.url||input));throw new Error("Mock mode must not contact a model provider")};
  const [port,appPort]=await Promise.all([freePort(),freePort()]);
  const gui=await createGuiServer({port,appPort,mock:true,env,fetchFn});
  try{
    assert.equal(JSON.parse(await readFile(join(home,"ui-state.json"),"utf8")).settings.modelProvider,"openai","an unknown stored provider must boot and persist as the default provider");
    const boot=await fetch(gui.url+"/api/bootstrap").then(r=>r.json());
    assert.equal(boot.mock,true);assert.equal(boot.agentRuntime,"native");assert.equal(boot.provider,"openai");assert.equal(boot.providerReady,true);
    assert.deepEqual(Object.keys(boot).filter(key=>/bridge|logged/i.test(key)),[],"the bootstrap payload carries no provider bridge or account sign-in state");
    const runtime=await fetch(gui.url+"/api/runtime").then(r=>r.json());
    assert.equal(runtime.provider,"openai");assert.equal(runtime.providerReady,true);assert.deepEqual(Object.keys(runtime).filter(key=>/bridge/i.test(key)),[]);
    const diagnostics=await fetch(gui.url+"/api/diagnostics?"+new URLSearchParams({path:home})).then(r=>r.json());
    assert.equal(diagnostics.runtime.provider,"openai");assert.equal(diagnostics.runtime.providerReady,true);assert.deepEqual(Object.keys(diagnostics.runtime).filter(key=>/bridge/i.test(key)),[]);
    const models=await fetch(gui.url+"/api/models").then(r=>r.json());
    assert.equal(models.provider,"openai");assert.equal(models.agentRuntime,"native");assert.equal(models.ready,true);
    assert.deepEqual(models.models,["test/coding-fast","test/coding-large"]);assert.equal(models.defaultModel,"test/coding-fast");
    assert.deepEqual(models.metadata.models.map(row=>[row.id,row.provider]),[["test/coding-fast","openai"],["test/coding-large","openai"]]);
    const anthropic=await fetch(gui.url+"/api/settings",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({modelProvider:"anthropic"})}).then(r=>r.json());
    assert.equal(anthropic.modelProvider,"anthropic");
    const anthropicModels=await fetch(gui.url+"/api/models").then(r=>r.json());
    assert.equal(anthropicModels.provider,"anthropic");assert.deepEqual(anthropicModels.models,["test/coding-fast","test/coding-large"]);assert.equal(anthropicModels.defaultModel,"test/coding-fast");
    const unknownProvider=await fetch(gui.url+"/api/settings",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({modelProvider:"unknown-provider-fixture"})}).then(r=>r.json());
    assert.equal(unknownProvider.modelProvider,"openai");
    const providerStatus=await fetch(gui.url+"/api/providers").then(r=>r.json());
    assert.equal(providerStatus.selected,"openai");assert.equal(providerStatus.ready,true);
    assert.deepEqual(providerStatus.providers.map(item=>item.id),["openai","anthropic","gemini","agentrouter","justworker","hcnsec","vyceai"]);
    const directResponse=await fetch(gui.url+"/api/chat/direct",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({prompt:"Summarize the release notes",model:"test/coding-large"})});
    assert.equal(directResponse.status,200);
    const direct=await directResponse.json();
    assert.equal(direct.text,"Mock direct reply: Summarize the release notes");assert.equal(direct.model,"test/coding-large");assert.equal(direct.provider,"openai");
    const misroutedKey=await fetch(gui.url+"/api/providers",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({provider:"unknown-provider-fixture",apiKey:"unknown-provider-key-fixture"})});
    assert.equal(misroutedKey.status,400);assert.match((await misroutedKey.json()).error,/Unknown model provider/);
    assert.equal((await fetch(gui.url+"/api/providers").then(r=>r.json())).status.hasKey,false,"a key sent with an unknown provider id must not be saved for another provider");
    assert.deepEqual(requests,[],"mock mode must not contact a model provider");
  }finally{
    await gui.close();
    await rm(home,{recursive:true,force:true,maxRetries:30,retryDelay:100});
  }
});

test("harness catalogs report the OpenCode preferred model as their default model",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-harness-default-model-"));
  const originalProbe=AgentRuntimeManager.prototype.probe,originalModels=AgentRuntimeManager.prototype.models;
  AgentRuntimeManager.prototype.probe=async function(instanceOrKind){
    const instance=typeof instanceOrKind==="string"
      ?this.instances().find(item=>item.id===instanceOrKind||item.kind===instanceOrKind)
      :instanceOrKind;
    const kind=instance?.kind||String(instanceOrKind||"codex");
    return {id:instance?.id||`${kind}-default`,kind,name:kind,available:true,installed:true,authenticated:true,version:"fixture"};
  };
  AgentRuntimeManager.prototype.models=async function(instanceOrKind,options){
    const kind=typeof instanceOrKind==="string"?instanceOrKind:instanceOrKind?.kind;
    // Claude Code's own model list (its capability probe), with "default" as Claude Code's default model.
    if(kind==="claude")return {models:["default","haiku"],metadata:[{id:"default",provider:"claude",agent:"Claude Code"},{id:"haiku",provider:"claude",agent:"Claude Code"}],source:"live",preferred:"default",inventory:{commands:[{name:"review"}],agents:[{name:"Plan"}]}};
    if(kind!=="opencode")return originalModels.call(this,instanceOrKind,options);
    const models=["fixture/other","fixture/preferred"];
    return {models,metadata:models.map(id=>({id,provider:"opencode",agent:"OpenCode"})),source:"live-connected",preferred:"fixture/preferred",connectedProviders:["fixture"]};
  };
  const env={...process.env,TREBELL_HOME:home,TREBELL_HISTORY_DISABLE_CLAUDE:"1"};
  const [port,appPort]=await Promise.all([freePort(),freePort()]);
  let gui=null;
  try{
    gui=await createGuiServer({port,appPort,mock:true,env});
    const codexModels=await fetch(gui.url+"/api/models").then(r=>r.json());
    assert.equal(codexModels.agentRuntime,"codex");assert.ok(codexModels.models.length>=1);assert.equal(codexModels.defaultModel,null);
    const opencode=await fetch(gui.url+"/api/agent-runtimes",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"select",runtime:"opencode",instanceId:"opencode-default"})}).then(r=>r.json());
    assert.equal(opencode.selectedRuntime,"opencode");assert.deepEqual(opencode.catalog.models,["fixture/other","fixture/preferred"]);assert.equal(opencode.catalog.defaultModel,"fixture/preferred");
    const opencodeModels=await fetch(gui.url+"/api/models").then(r=>r.json());
    assert.equal(opencodeModels.agentRuntime,"opencode");assert.equal(opencodeModels.defaultModel,"fixture/preferred");
    const claude=await fetch(gui.url+"/api/agent-runtimes",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"select",runtime:"claude",instanceId:"claude-default"})}).then(r=>r.json());
    assert.equal(claude.selectedRuntime,"claude");assert.deepEqual(claude.catalog.models,["default","haiku"]);assert.equal(claude.catalog.defaultModel,"default");
    assert.deepEqual(claude.catalog.inventory,{commands:[{name:"review"}],agents:[{name:"Plan"}]},"a new chat's slash commands and agents come with the catalog");
  }finally{
    if(gui)await gui.close();
    AgentRuntimeManager.prototype.probe=originalProbe;
    AgentRuntimeManager.prototype.models=originalModels;
    await rm(home,{recursive:true,force:true,maxRetries:30,retryDelay:100});
  }
});

test("a model list still loading when the harness switches is named for the harness it was asked for",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-catalog-switch-race-"));
  const originalProbe=AgentRuntimeManager.prototype.probe,originalModels=AgentRuntimeManager.prototype.models;
  let openCodeLists=0,release=()=>{},reached=()=>{};
  const gate=new Promise(resolve=>{release=resolve}),waiting=new Promise(resolve=>{reached=resolve});
  AgentRuntimeManager.prototype.probe=async function(instanceOrKind){
    const instance=typeof instanceOrKind==="string"?this.instances().find(item=>item.id===instanceOrKind||item.kind===instanceOrKind):instanceOrKind;
    const kind=instance?.kind||String(instanceOrKind||"codex");
    return {id:instance?.id||`${kind}-default`,kind,name:kind,available:true,installed:true,authenticated:true,version:"fixture"};
  };
  AgentRuntimeManager.prototype.models=async function(instanceOrKind,options){
    const kind=typeof instanceOrKind==="string"?instanceOrKind:instanceOrKind?.kind;
    if(kind==="opencode"){
      // The list the switch to OpenCode loads answers at once; the next one is still loading when the user switches to Cursor.
      if(++openCodeLists>1){reached();await gate}
      return {models:["opencode/slow"],metadata:[{id:"opencode/slow",provider:"opencode",agent:"OpenCode"}],source:"live-connected",preferred:"opencode/slow"};
    }
    if(kind==="cursor")return {models:["default"],metadata:[{id:"default",provider:"cursor",agent:"Cursor"}],source:"live",preferred:"default"};
    return originalModels.call(this,instanceOrKind,options);
  };
  const env={...process.env,TREBELL_HOME:home,TREBELL_HISTORY_DISABLE_CLAUDE:"1"};
  const [port,appPort]=await Promise.all([freePort(),freePort()]);
  const select=runtime=>fetch(gui.url+"/api/agent-runtimes",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"select",runtime,instanceId:runtime+"-default"})}).then(r=>r.json());
  let gui=null;
  try{
    gui=await createGuiServer({port,appPort,mock:true,env});
    assert.equal((await select("opencode")).selectedRuntime,"opencode");
    const loading=fetch(gui.url+"/api/models").then(r=>r.json());
    await waiting;
    const cursor=await select("cursor");
    assert.equal(cursor.selectedRuntime,"cursor");assert.deepEqual(cursor.catalog.models,["default"]);
    release();
    const stale=await loading;
    assert.equal(stale.agentRuntime,"opencode","OpenCode's list is never shown as Cursor's");assert.deepEqual(stale.models,["opencode/slow"]);
    const current=await fetch(gui.url+"/api/models").then(r=>r.json());
    assert.equal(current.agentRuntime,"cursor");assert.deepEqual(current.models,["default"]);assert.equal(current.defaultModel,"default");
  }finally{
    release();
    if(gui)await gui.close();
    AgentRuntimeManager.prototype.probe=originalProbe;
    AgentRuntimeManager.prototype.models=originalModels;
    await rm(home,{recursive:true,force:true,maxRetries:30,retryDelay:100});
  }
});

test("GUI server exposes mock bootstrap, provider models, and health", async () => {
  const home=await mkdtemp(join(tmpdir(),"trebell-gui-test-"));
  const externalCodexHome=join(home,"external-codex");const externalRollouts=join(externalCodexHome,"sessions","2026","09","23");await mkdir(externalRollouts,{recursive:true});
  const externalSessionId="12345678-1234-4abc-8123-123456789abc";
  await writeFile(join(externalRollouts,"rollout-import.jsonl"),[
    JSON.stringify({timestamp:"2026-09-23T01:00:00Z",type:"session_meta",payload:{id:externalSessionId,cwd:process.cwd()}}),
    JSON.stringify({type:"event_msg",payload:{type:"user_message",message:"Imported GUI history fixture"}}),
  ].join("\n"));
  const env={...process.env,TREBELL_HOME:home,CODEX_HOME:externalCodexHome,TREBELL_HISTORY_DISABLE_CLAUDE:"1"};
  const [port,appPort]=await Promise.all([freePort(),freePort()]);
  const gui=await createGuiServer({port,appPort,mock:true,env});
  try{
    const boot=await fetch(gui.url+"/api/bootstrap").then(r=>r.json());
    assert.equal(boot.mock,true);
    assert.deepEqual(Object.keys(boot).filter(key=>/bridge|logged/i.test(key)),[],"the bootstrap payload carries no provider bridge or account sign-in state");
    assert.equal(boot.version,packageVersion);
    assert.equal(boot.runtimeCapabilities.nativeSandbox,true);
    assert.equal(boot.runtimeCapabilities.dynamicTools,true);

    const publicSettings=await fetch(gui.url+"/api/settings").then(r=>r.json());
    const publicState=await fetch(gui.url+"/api/state").then(r=>r.json());
    for(const retired of ["remoteAccessToken","remoteAccessEnabled","remoteAccessPort"])assert.equal(Object.prototype.hasOwnProperty.call(publicSettings,retired),false);
    for(const retired of ["remoteAccessToken","remoteAccessEnabled","remoteAccessPort"])assert.equal(Object.prototype.hasOwnProperty.call(publicState.settings||{},retired),false);
    for(const key of ["checkpoints","usageRecords","verificationRecords","repositoryKnowledge"])assert.equal(Object.prototype.hasOwnProperty.call(publicState,key),false,key+" should be queried through its indexed API instead of the general state payload");
    const compatibilityToken=["older","client","remote","credential"].join("-");
    const updatedSettings=await fetch(gui.url+"/api/settings",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({remoteAccessToken:compatibilityToken,remoteAccessEnabled:true,remoteAccessPort:4555})}).then(r=>r.json());
    for(const retired of ["remoteAccessToken","remoteAccessEnabled","remoteAccessPort"])assert.equal(Object.prototype.hasOwnProperty.call(updatedSettings,retired),false);
    assert.doesNotMatch(await readFile(join(home,"ui-state.json"),"utf8"),new RegExp(compatibilityToken));

    await fetch(gui.url+"/api/thread-meta",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({threadId:"catalog-meta-fixture",patch:{runtime:"native",runtimeInstanceId:"native-default",cwd:home,projectless:true,branch:"feature/catalog",threadSnapshot:{id:"catalog-meta-fixture",name:"Catalog fixture",preview:"Compact bootstrap row",cwd:home,updatedAt:100,createdAt:90,status:{type:"idle"},runtime:"native"},delegation:{parentThreadId:"parent",task:"Child fixture",status:"running",ownership:["src/app.js"]},goal:{objective:"Heavy goal"},trebellQueue:[{id:"queue-heavy",input:[{type:"text",text:"heavy queued input"}]}],trebellContext:{task:"active-only",exactInjectedContext:"large context that should not be bootstrapped"},reviewedFiles:["src/app.js"]}})});
    const compactState=await fetch(gui.url+"/api/state").then(r=>r.json()),compactMeta=compactState.threadMeta["catalog-meta-fixture"];
    assert.equal(compactMeta.runtime,"native");assert.equal(compactMeta.threadSnapshot.name,"Catalog fixture");assert.equal(compactMeta.delegation.parentThreadId,"parent");
    for(const heavy of ["goal","trebellQueue","trebellContext","reviewedFiles"])assert.equal(Object.prototype.hasOwnProperty.call(compactMeta,heavy),false,heavy+" must not ride the general bootstrap payload");
    const fullMeta=await fetch(gui.url+"/api/thread-meta?threadId=catalog-meta-fixture").then(r=>r.json());assert.equal(fullMeta.goal.objective,"Heavy goal");assert.equal(fullMeta.trebellQueue[0].id,"queue-heavy");assert.equal(fullMeta.trebellContext.task,"active-only");

    const models=await fetch(gui.url+"/api/models").then(r=>r.json());
    assert.ok(models.models.length>=1);
    assert.ok(models.metadata.models.length>=1);for(const row of models.metadata.models){assert.ok(row.capabilities);assert.equal(Object.prototype.hasOwnProperty.call(row.capabilities,"contextWindow"),true);assert.equal(Object.prototype.hasOwnProperty.call(row.capabilities,"vision"),true);assert.equal(Object.prototype.hasOwnProperty.call(row.capabilities,"protocolCompatibility"),true);assert.equal(Object.prototype.hasOwnProperty.call(row.capabilities,"pricing"),true)}
    const traces=await fetch(gui.url+"/api/traces?limit=20").then(r=>r.json());
    assert.ok(Array.isArray(traces.items));
    assert.equal(traces.journal.lastError,null);
    assert.equal(typeof traces.journal.records,"number");
    const checkpointRepo=join(home,"checkpoint-trace-repo");await mkdir(checkpointRepo,{recursive:true});
    await git(checkpointRepo,["init"]);await git(checkpointRepo,["config","user.email","trace@example.test"]);await git(checkpointRepo,["config","user.name","Trace Test"]);await writeFile(join(checkpointRepo,"fixture.txt"),"before\n");await git(checkpointRepo,["add","fixture.txt"]);await git(checkpointRepo,["commit","-m","fixture"]);
    const checkpoint=await fetch(gui.url+"/api/checkpoints",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({cwd:checkpointRepo,threadId:"checkpoint-trace-thread",label:"Trace checkpoint"})}).then(r=>r.json());
    assert.equal(checkpoint.supported,true);assert.ok(checkpoint.id);
    const checkpointLinked=await fetch(gui.url+"/api/checkpoints/link",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:checkpoint.id,patch:{turnId:"trace-turn"}})}).then(r=>r.json());
    assert.equal(checkpointLinked.checkpoint.turnId,"trace-turn");
    const failedRestore=await fetch(gui.url+"/api/checkpoints/restore",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:checkpoint.id,threadId:"wrong-thread"})});
    assert.equal(failedRestore.status,400);
    await writeFile(join(checkpointRepo,"fixture.txt"),"after\n");await mkdir(join(checkpointRepo,"ui"),{recursive:true});await writeFile(join(checkpointRepo,"ui","panel.jsx"),"export function Panel(){ return <button>Save</button>; }\n");
    const plannedTurnResponse=await fetch(gui.url+"/api/verification/plan-turn",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({threadId:"checkpoint-trace-thread",turnId:"trace-turn"})});
    assert.equal(plannedTurnResponse.status,200);
    const plannedTurn=await plannedTurnResponse.json();
    assert.equal(plannedTurn.supported,true);assert.deepEqual(plannedTurn.changedPaths,["fixture.txt","ui/panel.jsx"]);
    assert.equal(plannedTurn.record.status,"incomplete");assert.equal(plannedTurn.record.risk,"medium");assert.equal(plannedTurn.nextAction.action,"verify");assert.equal(plannedTurn.nextAction.nextStep.id,"browser_runtime");
    const automaticDiagnostics=plannedTurn.record.evidence.find(item=>item.stepId==="diagnostics");assert.equal(automaticDiagnostics?.status,"passed");assert.equal(automaticDiagnostics?.source,"harness-diagnostics");
    assert.ok(plannedTurn.record.plan.steps.some(step=>step.id==="browser_interaction"&&step.required===true));
    assert.ok(plannedTurn.record.plan.steps.some(step=>step.id==="visual"&&step.required===true));
    const plannedHistory=await fetch(gui.url+"/api/verification-records?"+new URLSearchParams({threadId:"checkpoint-trace-thread"})).then(r=>r.json());
    assert.equal(plannedHistory.records.length,1);assert.equal(plannedHistory.records[0].turnId,"trace-turn");
    const plannedTraces=await fetch(gui.url+"/api/traces?"+new URLSearchParams({threadId:"checkpoint-trace-thread",limit:"20"})).then(r=>r.json());
    const plannedTrace=plannedTraces.items.find(item=>item.name==="verification.planned");
    assert.ok(plannedTrace);assert.equal(plannedTrace.data.changedPathCount,2);assert.equal(plannedTrace.data.nextStepId,"browser_runtime");assert.equal(plannedTrace.data.automaticEvidenceCount,1);assert.equal(Object.prototype.hasOwnProperty.call(plannedTrace.data,"evidence"),false);
    assert.ok(plannedTraces.items.some(item=>item.name==="diagnostics.generated"&&item.status==="passed"&&item.data?.recordId===plannedTurn.record.id));
    const checkpointTraces=await fetch(gui.url+"/api/traces?limit=100").then(r=>r.json());
    const checkpointEvents=checkpointTraces.items.filter(item=>item.category==="checkpoint"&&item.data?.checkpointId===checkpoint.id);
    assert.ok(checkpointEvents.some(item=>item.name==="checkpoint.created"&&item.status==="completed"));
    assert.ok(checkpointEvents.some(item=>item.name==="checkpoint.linked"&&item.turnId==="trace-turn"));
    assert.ok(checkpointEvents.some(item=>item.name==="checkpoint.restore_failed"&&item.status==="error"));
    const privateCommitMessage="trace-message-must-not-be-journaled";await writeFile(join(checkpointRepo,"fixture.txt"),"after\n");
    const commitMutation=await fetch(gui.url+"/api/git/action",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"commit",cwd:checkpointRepo,message:privateCommitMessage})});
    assert.equal(commitMutation.status,200);
    const pushMutation=await fetch(gui.url+"/api/git/action",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"push",cwd:checkpointRepo})});
    assert.equal(pushMutation.status,400);
    const sourceControlTraces=await fetch(gui.url+"/api/traces?limit=100").then(r=>r.json()),sourceControlEvents=sourceControlTraces.items.filter(item=>item.category==="source-control");
    assert.ok(sourceControlEvents.some(item=>item.name==="source_control.git.commit"&&item.status==="completed"&&item.data?.externalSideEffect===false));
    assert.ok(sourceControlEvents.some(item=>item.name==="source_control.push"&&item.status==="failed"&&item.data?.externalSideEffect===true));
    assert.doesNotMatch(JSON.stringify(sourceControlEvents),new RegExp(privateCommitMessage));
    assert.equal(models.metadata.provider,"codex");
    assert.equal(models.agentRuntime,"codex");
    assert.equal(Object.prototype.hasOwnProperty.call(models,"provider"),false,"external harness catalogs must not masquerade as Trebell Native provider catalogs");
    assert.ok(models.metadata.models.every(model=>model.provider==="codex"));
    const runtimeUsage=await fetch(gui.url+"/api/agent-runtime-usage").then(r=>r.json());
    assert.equal(runtimeUsage.runtime,"codex");
    assert.deepEqual(runtimeUsage.windows,[]);
    assert.equal(runtimeUsage.unavailable.reason,"unsupported");
    const runtimeAuth=await fetch(gui.url+"/api/agent-runtime-auth",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"login",runtime:"claude",environmentId:null,cwd:process.cwd()})}).then(r=>r.json());
    assert.equal(runtimeAuth.ok,true);
    assert.deepEqual(runtimeAuth.auth.args,["auth","login"]);
    assert.equal(runtimeAuth.session.id,"mock-runtime-auth");
    assert.equal(runtimeAuth.session.environmentId,null);
    const directRuntimeAuth=await fetch(gui.url+"/api/agent-runtime-auth",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"login",runtime:"antigravity",environmentId:null,cwd:process.cwd()})}).then(r=>r.json());
    assert.equal(directRuntimeAuth.authenticated,true);
    assert.ok(Array.isArray(directRuntimeAuth.agentSnapshot?.definitions));
    assert.ok(Array.isArray(directRuntimeAuth.agentSnapshot?.instances));
    assert.ok(Array.isArray(directRuntimeAuth.agentSnapshot?.statuses));

    const projectsBefore=await fetch(gui.url+"/api/projects").then(r=>r.json());
    assert.ok(Array.isArray(projectsBefore.projects));
    const historyImport=await fetch(gui.url+"/api/history-import").then(r=>r.json());
    const codexHistory=historyImport.sessions.find(item=>item.providerSessionId===externalSessionId);
    assert.equal(codexHistory.source,"codex");assert.equal(codexHistory.title,"Imported GUI history fixture");assert.equal(codexHistory.alreadyImported,false);assert.equal(Object.prototype.hasOwnProperty.call(codexHistory,"sourcePath"),false);
    const projectPath=process.cwd();
    const projectSaved=await fetch(gui.url+"/api/projects",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({
      path:projectPath,
      scripts:[{id:"dev",name:"Dev server",command:"npm run dev",previewUrl:"http://localhost:5173",autoOpenPreview:true}],
      preferredScriptId:"dev",
    })}).then(r=>r.json());
    assert.equal(projectSaved.project.scripts[0].id,"dev");
    const remoteEnvironment=await fetch(gui.url+"/api/environments",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({
      id:"ssh-test",name:"Remote test",type:"ssh",host:"example.invalid",cwd:"/srv/app",
    })}).then(r=>r.json());
    assert.equal(remoteEnvironment.profile.id,"ssh-test");
    assert.equal(remoteEnvironment.profile.enabled,true);
    const disabledEnvironment=await fetch(gui.url+"/api/environment/enabled",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:"ssh-test",enabled:false})}).then(r=>r.json());
    assert.equal(disabledEnvironment.profile.enabled,false);
    const disabledActivationResponse=await fetch(gui.url+"/api/environment/activate",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:"ssh-test"})});
    assert.equal(disabledActivationResponse.status,400);
    assert.match((await disabledActivationResponse.json()).error,/switched off/i);
    const environmentsWhileDisabled=await fetch(gui.url+"/api/environments").then(r=>r.json());
    assert.equal(environmentsWhileDisabled.profiles.find(profile=>profile.id==="ssh-test").enabled,false);
    const enabledEnvironment=await fetch(gui.url+"/api/environment/enabled",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:"ssh-test",enabled:true})}).then(r=>r.json());
    assert.equal(enabledEnvironment.profile.enabled,true);
    const activatedEnvironment=await fetch(gui.url+"/api/environment/activate",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:"ssh-test"})}).then(r=>r.json());
    assert.equal(activatedEnvironment.activeEnvironmentId,"ssh-test");
    assert.equal(activatedEnvironment.agentRuntime,"codex");
    assert.equal(activatedEnvironment.agentRuntimeReady,true);
    assert.equal(activatedEnvironment.appServerReady,true);
    assert.ok(activatedEnvironment.agentRuntimeInstanceId);
    const disabledActiveEnvironment=await fetch(gui.url+"/api/environment/enabled",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:"ssh-test",enabled:false})}).then(r=>r.json());
    assert.equal(disabledActiveEnvironment.activeEnvironmentId,null);
    const afterActiveDisable=await fetch(gui.url+"/api/environments").then(r=>r.json());
    assert.equal(afterActiveDisable.activeEnvironmentId,null);
    await fetch(gui.url+"/api/environment/enabled",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:"ssh-test",enabled:true})});
    const remoteProject=await fetch(gui.url+"/api/projects",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({
      path:"/srv/app",environmentId:"ssh-test",
      scripts:[{id:"remote-dev",name:"Remote dev",command:"npm run dev"}],
    })}).then(r=>r.json());
    assert.equal(remoteProject.project.path,"/srv/app");
    assert.equal(remoteProject.project.environmentId,"ssh-test");
    const projectsAfter=await fetch(gui.url+"/api/projects").then(r=>r.json());
    assert.equal(projectsAfter.projects.find(project=>project.id===remoteProject.project.id).environment.name,"Remote test");
    const remoteAction=await fetch(gui.url+"/api/project-script/run",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({path:"/srv/app",environmentId:"ssh-test",scriptId:"remote-dev"})}).then(r=>r.json());
    assert.equal(remoteAction.ok,true);
    assert.equal(remoteAction.session.environmentId,"ssh-test");
    assert.equal(remoteAction.session.environmentType,"ssh");
    const actionRun=await fetch(gui.url+"/api/project-script/run",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({path:projectPath,scriptId:"dev"})}).then(r=>r.json());
    assert.equal(actionRun.ok,true);
    assert.equal(actionRun.session.id,"mock-project-action");
    assert.equal(actionRun.previewUrl,"http://localhost:5173");
    const previewServers=await fetch(gui.url+"/api/preview/servers").then(r=>r.json());
    assert.ok(Array.isArray(previewServers.servers));
    const suggested=await fetch(gui.url+"/api/project-actions/suggestions?path="+encodeURIComponent(projectPath)).then(r=>r.json());
    assert.ok(Array.isArray(suggested.scripts));
    assert.ok(suggested.scripts.some(script=>script.source==="package.json"));
    const configProject=join(home,"t3-project");await import("node:fs/promises").then(fs=>fs.mkdir(configProject,{recursive:true}));
    await writeFile(join(configProject,"t3.json"),JSON.stringify({defaultThreadEnvMode:"worktree",worktreeSubmodules:"top-level",scripts:[]}));
    await mkdir(join(configProject,"src"),{recursive:true});
    await mkdir(join(configProject,"tests"),{recursive:true});
    await writeFile(join(configProject,"AGENTS.md"),"Prefer deterministic repository context.\n");
    await writeFile(join(configProject,"package.json"),JSON.stringify({packageManager:"pnpm@10.0.0",scripts:{test:"node --test",build:"vite build"}}));
    await writeFile(join(configProject,"src","session.js"),"export class RefreshSession { refresh(token) { return token; } }\n");
    await writeFile(join(configProject,"src","broken.ts"),"export const broken: string = ;\n");
    await writeFile(join(configProject,"tests","session.test.js"),"import { RefreshSession } from \"../src/session.js\";\nexport function testSession() { return new RefreshSession().refresh(\"x\"); }\n");
    const contextPacketResponse=await fetch(gui.url+"/api/context/packet",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({path:configProject,task:"Fix refresh session",userTask:"Fix refresh session",deliveryProjection:"seed",maxTokens:1200,maxFiles:6,environmentId:null})});
    assert.equal(contextPacketResponse.status,200);
    const contextPacket=await contextPacketResponse.json();
    assert.ok(contextPacket.items.some(item=>item.path==="src/session.js"));
    assert.match(contextPacket.injection,/Prefer deterministic repository context/);
    assert.equal(contextPacket.deliveryProjection,"seed");
    assert.doesNotMatch(contextPacket.untrustedInjection,/Task: Fix refresh session/);
    assert.ok(contextPacket.tokenEstimate<=1200);
    const symbolResponse=await fetch(gui.url+"/api/context/symbols?"+new URLSearchParams({path:configProject,q:"RefreshSession"}));
    assert.equal(symbolResponse.status,200);
    const symbolResult=await symbolResponse.json();
    assert.equal(symbolResult.data[0].name,"RefreshSession");
    assert.equal(symbolResult.data[0].path,"src/session.js");
    const fileResponse=await fetch(gui.url+"/api/context/files?"+new URLSearchParams({path:configProject,q:"session",limit:"10"}));
    assert.equal(fileResponse.status,200);
    const fileResult=await fileResponse.json();
    assert.ok(fileResult.data.some(item=>item.path==="src/session.js"&&item.indexedSource===true));
    const mapResponse=await fetch(gui.url+"/api/context/map?"+new URLSearchParams({path:configProject,q:"refresh session",limit:"10"}));
    assert.equal(mapResponse.status,200);
    const mapResult=await mapResponse.json();
    assert.ok(mapResult.data.some(item=>item.path==="src/session.js"&&item.definitions.some(definition=>definition.name==="RefreshSession")));
    const commandsResponse=await fetch(gui.url+"/api/context/commands?"+new URLSearchParams({path:configProject,limit:"10"}));
    assert.equal(commandsResponse.status,200);
    const commandsResult=await commandsResponse.json();
    assert.ok(commandsResult.declared.some(item=>item.command==="pnpm run test"&&item.confidence==="declared"));
    assert.ok(commandsResult.declared.some(item=>item.command==="pnpm run build"));
    const verificationResponse=await fetch(gui.url+"/api/context/verification?"+new URLSearchParams({path:configProject,file:"src/session.js",semantic:"true"}));
    assert.equal(verificationResponse.status,200);
    const verificationResult=await verificationResponse.json();
    assert.equal(verificationResult.pathSource,"explicit");
    assert.deepEqual(verificationResult.paths,["src/session.js"]);
    assert.deepEqual(verificationResult.relatedTests,["tests/session.test.js"]);
    assert.ok(verificationResult.steps.some(item=>item.id==="targeted_tests"&&item.command==="pnpm run test"));
    const assessmentResponse=await fetch(gui.url+"/api/context/verification/assess",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({plan:{risk:"medium",steps:[{id:"tests",kind:"tests",required:true}]},evidence:[{stepId:"tests",exitCode:0}]})});
    assert.equal(assessmentResponse.status,200);
    const assessmentResult=await assessmentResponse.json();
    assert.equal(assessmentResult.status,"verified");assert.equal(assessmentResult.verified,true);assert.equal(assessmentResult.summary.passed,1);
    const verificationNextResponse=await fetch(gui.url+"/api/context/verification/next",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({plan:{risk:"medium",steps:[{id:"diagnostics",kind:"diagnostics",cost:"low",required:true},{id:"tests",kind:"tests",cost:"medium",required:true}]},evidence:[{stepId:"diagnostics",errorCount:0}]})});
    assert.equal(verificationNextResponse.status,200);
    const verificationNext=await verificationNextResponse.json();
    assert.equal(verificationNext.action,"verify");assert.equal(verificationNext.nextStep.id,"tests");
    const persistedVerificationResponse=await fetch(gui.url+"/api/verification-records",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({projectPath:configProject,threadId:"thread-verification",turnId:"turn-verification",plan:{risk:"medium",steps:[{id:"tests",kind:"tests",required:true}]},evidence:[{stepId:"tests",exitCode:0}]})});
    assert.equal(persistedVerificationResponse.status,200);
    const persistedPayload=await persistedVerificationResponse.json(),persistedVerification=persistedPayload.record;
    assert.equal(persistedVerification.status,"verified");assert.equal(persistedVerification.assessment.verified,true);assert.equal(persistedVerification.threadId,"thread-verification");
    assert.equal(persistedPayload.nextAction.action,"complete");
    const verificationHistoryResponse=await fetch(gui.url+"/api/verification-records?"+new URLSearchParams({threadId:"thread-verification",projectPath:configProject}));
    assert.equal(verificationHistoryResponse.status,200);
    const verificationHistory=(await verificationHistoryResponse.json()).records;
    assert.equal(verificationHistory.length,1);assert.equal(verificationHistory[0].id,persistedVerification.id);assert.equal(verificationHistory[0].status,"verified");
    const verificationTraces=await fetch(gui.url+"/api/traces?"+new URLSearchParams({threadId:"thread-verification",limit:"20"})).then(r=>r.json());
    const verificationTrace=verificationTraces.items.find(item=>item.name==="verification.completed");
    assert.ok(verificationTrace);assert.equal(verificationTrace.status,"verified");assert.equal(verificationTrace.data.verified,true);assert.equal(verificationTrace.data.summary.passed,1);assert.equal(verificationTrace.data.nextAction,"complete");assert.equal(Object.prototype.hasOwnProperty.call(verificationTrace.data,"evidence"),false);
    const relationResponse=await fetch(gui.url+"/api/context/relations?"+new URLSearchParams({path:configProject,file:"src/session.js"}));
    assert.equal(relationResponse.status,200);
    const relationResult=await relationResponse.json();
    assert.equal(relationResult.path,"src/session.js");
    assert.ok(relationResult.definitions.some(item=>item.name==="RefreshSession"));
    const relatedTestsResponse=await fetch(gui.url+"/api/context/tests?"+new URLSearchParams({path:configProject,file:"src/session.js"}));
    assert.equal(relatedTestsResponse.status,200);
    const relatedTests=await relatedTestsResponse.json();
    assert.deepEqual(relatedTests.data.map(item=>item.path),["tests/session.test.js"]);
    const callsResponse=await fetch(gui.url+"/api/context/calls?"+new URLSearchParams({path:configProject,name:"RefreshSession",limit:"10"}));
    assert.equal(callsResponse.status,200);
    const callsResult=await callsResponse.json();
    assert.equal(callsResult.semantic,false);
    assert.ok(callsResult.callers.some(item=>item.path==="tests/session.test.js"&&item.caller==="testSession"&&item.kind==="construct"));
    const diagnosticsResponse=await fetch(gui.url+"/api/context/diagnostics?"+new URLSearchParams({path:configProject,file:"src/broken.ts",limit:"10"}));
    assert.equal(diagnosticsResponse.status,200);
    const diagnosticsResult=await diagnosticsResponse.json();
    assert.equal(diagnosticsResult.supported,true);assert.equal(diagnosticsResult.engine,"babel-parser");assert.equal(diagnosticsResult.semantic,false);assert.ok(diagnosticsResult.diagnostics.length>=1);
    const semanticDiagnosticsResponse=await fetch(gui.url+"/api/context/diagnostics?"+new URLSearchParams({path:configProject,file:"src/session.js",semantic:"true",limit:"10"}));
    assert.equal(semanticDiagnosticsResponse.status,200);
    const semanticDiagnosticsResult=await semanticDiagnosticsResponse.json();
    assert.equal(semanticDiagnosticsResult.semanticRequested,true);assert.equal(semanticDiagnosticsResult.semantic,false);assert.equal(semanticDiagnosticsResult.semanticInfo.available,false);
    const languageSymbolResponse=await fetch(gui.url+"/api/context/language-symbol?"+new URLSearchParams({path:configProject,file:"src/session.js",line:"1",column:"14",operation:"definition",limit:"10"}));
    assert.equal(languageSymbolResponse.status,200);
    const languageSymbolResult=await languageSymbolResponse.json();
    assert.equal(languageSymbolResult.supported,false);assert.equal(languageSymbolResult.semantic,false);assert.match(languageSymbolResult.reason,/TypeScript/i);
    const codeActionsResponse=await fetch(gui.url+"/api/context/code-actions?"+new URLSearchParams({path:configProject,file:"src/session.js",line:"1",column:"14",codes:"2322",limit:"10"}));
    assert.equal(codeActionsResponse.status,200);
    const codeActionsResult=await codeActionsResponse.json();
    assert.equal(codeActionsResult.supported,false);assert.equal(codeActionsResult.semantic,false);assert.deepEqual(codeActionsResult.actions,[]);assert.match(codeActionsResult.reason,/TypeScript/i);
    const organizeImportsResponse=await fetch(gui.url+"/api/context/organize-imports?"+new URLSearchParams({path:configProject,file:"src/session.js",limit:"10"}));
    assert.equal(organizeImportsResponse.status,200);
    const organizeImportsResult=await organizeImportsResponse.json();
    assert.equal(organizeImportsResult.supported,false);assert.equal(organizeImportsResult.semantic,false);assert.deepEqual(organizeImportsResult.changes,[]);assert.match(organizeImportsResult.reason,/TypeScript/i);
    const renameResponse=await fetch(gui.url+"/api/context/rename-preview?"+new URLSearchParams({path:configProject,file:"src/session.js",line:"1",column:"14",newName:"RenamedSession",limit:"10"}));
    assert.equal(renameResponse.status,200);
    const renameResult=await renameResponse.json();
    assert.equal(renameResult.supported,false);assert.equal(renameResult.semantic,false);assert.equal(renameResult.canRename,false);assert.deepEqual(renameResult.locations,[]);assert.match(renameResult.reason,/TypeScript/i);
    const referencesResponse=await fetch(gui.url+"/api/context/references?"+new URLSearchParams({path:configProject,name:"RefreshSession",limit:"10"}));
    assert.equal(referencesResponse.status,200);
    const referencesResult=await referencesResponse.json();
    assert.ok(referencesResult.data.some(item=>item.path==="src/session.js"&&item.definition===true&&item.precision==="ast"));
    const codeSearchResponse=await fetch(gui.url+"/api/context/search?"+new URLSearchParams({path:configProject,q:"RefreshSession",limit:"10"}));
    assert.equal(codeSearchResponse.status,200);
    const codeSearch=await codeSearchResponse.json();
    assert.ok(codeSearch.data.some(item=>item.path==="src/session.js"&&item.line===1));
    const sourceResponse=await fetch(gui.url+"/api/context/source?"+new URLSearchParams({path:configProject,file:"src/session.js",startLine:"1",endLine:"1"}));
    assert.equal(sourceResponse.status,200);
    const sourceRange=await sourceResponse.json();
    assert.equal(sourceRange.path,"src/session.js");assert.equal(sourceRange.startLine,1);assert.equal(sourceRange.endLine,1);assert.match(sourceRange.content,/RefreshSession/);
    const gitContextResponse=await fetch(gui.url+"/api/context/git?"+new URLSearchParams({path:configProject}));
    assert.equal(gitContextResponse.status,200);assert.equal((await gitContextResponse.json()).isGit,false);
    const historyResponse=await fetch(gui.url+"/api/context/history?"+new URLSearchParams({path:configProject,file:"src/session.js",limit:"5"}));
    assert.equal(historyResponse.status,200);assert.deepEqual((await historyResponse.json()).data,[]);
    const blameResponse=await fetch(gui.url+"/api/context/blame?"+new URLSearchParams({path:configProject,file:"src/session.js",startLine:"1",endLine:"1"}));
    assert.equal(blameResponse.status,400);
    const missingRelationResponse=await fetch(gui.url+"/api/context/relations?"+new URLSearchParams({path:configProject,file:"../outside.js"}));
    assert.equal(missingRelationResponse.status,400);
    const remoteContextResponse=await fetch(gui.url+"/api/context/packet",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({path:"/srv/app",task:"remote task",environmentId:"ssh-test"})});
    assert.equal(remoteContextResponse.status,400);
    assert.doesNotMatch((await remoteContextResponse.json()).error,/local workspaces only/i);
    const t3Suggested=await fetch(gui.url+"/api/project-actions/suggestions?path="+encodeURIComponent(configProject)).then(r=>r.json());
    assert.equal(t3Suggested.t3.defaultThreadEnvMode,"worktree");assert.equal(t3Suggested.t3.worktreeSubmodules,"top-level");
    const visualizationDir=join(configProject,"artifacts");await mkdir(visualizationDir,{recursive:true});
    const visualizationPath=join(visualizationDir,"chart.html");await writeFile(visualizationPath,"<!doctype html><style>body{margin:0}</style><script>document.body.dataset.ready='1'</script>","utf8");
    const visualizationResponse=await fetch(gui.url+"/api/visualization?"+new URLSearchParams({root:configProject,path:visualizationPath}));
    assert.equal(visualizationResponse.status,200);assert.match(await visualizationResponse.text(),/dataset\.ready/);
    assert.match(visualizationResponse.headers.get("content-security-policy")||"",/connect-src 'none'/);
    assert.match(visualizationResponse.headers.get("content-security-policy")||"",/script-src 'unsafe-inline'/);
    const outsideVisualization=join(home,"outside.html");await writeFile(outsideVisualization,"<p>outside</p>","utf8");
    const blockedVisualization=await fetch(gui.url+"/api/visualization?"+new URLSearchParams({root:configProject,path:outsideVisualization}));
    assert.equal(blockedVisualization.status,400);
    const settings=await fetch(gui.url+"/api/settings",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({followUpMode:"steer"})}).then(r=>r.json());
    assert.equal(settings.followUpMode,"steer");
    const customCodexId="codex-settings-test";
    const customCodex=await fetch(gui.url+"/api/agent-runtimes",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"upsert",instance:{id:customCodexId,kind:"codex",displayName:"Settings API test",homePath:join(home,"codex-settings-test")}})}).then(r=>r.json());
    assert.equal(customCodex.instance.id,customCodexId);
    const codexSettingsResponse=await fetch(gui.url+"/api/settings",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({agentRuntime:"codex",agentRuntimeInstanceId:customCodexId})});
    assert.equal(codexSettingsResponse.status,200);
    const codexSettings=await codexSettingsResponse.json();
    assert.equal(codexSettings.agentRuntime,"codex");assert.equal(codexSettings.agentRuntimeInstanceId,customCodexId);
    const codexRuntimeSnapshot=await fetch(gui.url+"/api/agent-runtimes").then(r=>r.json());
    assert.equal(codexRuntimeSnapshot.selectedRuntime,"codex");assert.equal(codexRuntimeSnapshot.selectedInstanceId,customCodexId);
    const codexBootstrap=await fetch(gui.url+"/api/bootstrap").then(r=>r.json());
    assert.equal(codexBootstrap.agentRuntime,"codex");assert.equal(codexBootstrap.agentRuntimeInstanceId,customCodexId);
    const nativeRuntimeSelection=await fetch(gui.url+"/api/agent-runtimes",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"select",runtime:"native",instanceId:"native-default"})}).then(r=>r.json());
    assert.equal(nativeRuntimeSelection.selectedRuntime,"native");assert.equal(nativeRuntimeSelection.selectedInstanceId,"native-default");
    assert.equal(nativeRuntimeSelection.bootstrap.agentRuntime,"native");assert.equal(nativeRuntimeSelection.bootstrap.agentRuntimeInstanceId,"native-default");
    assert.equal(nativeRuntimeSelection.catalog.agentRuntime,"native");assert.ok(nativeRuntimeSelection.catalog.models.length>=1);
    const restoredCodexSelection=await fetch(gui.url+"/api/agent-runtimes",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"select",runtime:"codex",instanceId:customCodexId})}).then(r=>r.json());
    assert.equal(restoredCodexSelection.selectedRuntime,"codex");assert.equal(restoredCodexSelection.selectedInstanceId,customCodexId);
    assert.equal(restoredCodexSelection.bootstrap.agentRuntime,"codex");assert.equal(restoredCodexSelection.bootstrap.agentRuntimeInstanceId,customCodexId);
    assert.equal(restoredCodexSelection.catalog.agentRuntime,"codex");assert.ok(restoredCodexSelection.catalog.models.length>=1);
    const activeCodexUpdate=await fetch(gui.url+"/api/agent-runtimes",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"upsert",instance:{id:customCodexId,kind:"codex",displayName:"Settings API updated",homePath:join(home,"codex-settings-test")}})}).then(r=>r.json());
    assert.equal(activeCodexUpdate.selectedInstanceId,customCodexId);assert.equal(activeCodexUpdate.bootstrap.agentRuntimeInstanceId,customCodexId);assert.equal(activeCodexUpdate.catalog.agentRuntime,"codex");
    const spareCodexId="codex-delete-test";
    const spareCodex=await fetch(gui.url+"/api/agent-runtimes",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"upsert",instance:{id:spareCodexId,kind:"codex",displayName:"Delete API test",homePath:join(home,"codex-delete-test")}})}).then(r=>r.json());
    assert.equal(spareCodex.instance.id,spareCodexId);assert.equal(Object.prototype.hasOwnProperty.call(spareCodex,"bootstrap"),false);
    const spareSelection=await fetch(gui.url+"/api/agent-runtimes",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"select",runtime:"codex",instanceId:spareCodexId})}).then(r=>r.json());
    assert.equal(spareSelection.selectedInstanceId,spareCodexId);
    const removedActiveSpare=await fetch(gui.url+"/api/agent-runtimes?id="+encodeURIComponent(spareCodexId),{method:"DELETE"}).then(r=>r.json());
    assert.equal(removedActiveSpare.resetTo,"codex-default");assert.equal(removedActiveSpare.selectedInstanceId,"codex-default");assert.equal(removedActiveSpare.bootstrap.agentRuntimeInstanceId,"codex-default");assert.equal(removedActiveSpare.catalog.agentRuntime,"codex");
    const reselectedCustomCodex=await fetch(gui.url+"/api/agent-runtimes",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"select",runtime:"codex",instanceId:customCodexId})}).then(r=>r.json());
    assert.equal(reselectedCustomCodex.selectedInstanceId,customCodexId);
    const unavailableClaude=await fetch(gui.url+"/api/settings",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({agentRuntime:"claude",agentRuntimeInstanceId:"claude-default"})});
    if(unavailableClaude.status===400){
      const afterRejectedRuntime=await fetch(gui.url+"/api/agent-runtimes").then(r=>r.json());
      assert.equal(afterRejectedRuntime.selectedRuntime,"codex");assert.equal(afterRejectedRuntime.selectedInstanceId,customCodexId);
    }
    const resetCodex=await fetch(gui.url+"/api/settings",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({agentRuntime:"codex",agentRuntimeInstanceId:"codex-default"})});
    assert.equal(resetCodex.status,200);
    const storageBefore=await fetch(gui.url+"/api/storage-cleanup").then(r=>r.json());
    assert.deepEqual(storageBefore.settings,{attachmentsAfterDays:null,terminalHistoryAfterDays:null});
    const storageSettings=await fetch(gui.url+"/api/settings",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({storageCleanup:{attachmentsAfterDays:7,terminalHistoryAfterDays:30}})}).then(r=>r.json());
    assert.deepEqual(storageSettings.storageCleanup,{attachmentsAfterDays:7,terminalHistoryAfterDays:30});
    const storageSweep=await fetch(gui.url+"/api/storage-cleanup",{method:"POST",headers:{"content-type":"application/json"},body:"{}"}).then(r=>r.json());
    assert.equal(storageSweep.attachments.enabled,true);assert.equal(storageSweep.attachments.removed,0);
    assert.equal(storageSweep.terminalHistory.enabled,false);
    const sourceDefaults=await fetch(gui.url+"/api/scoped-settings",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({environmentId:null,projectId:projectSaved.project.id,patch:{sourceControlMergeMethod:"rebase",sourceControlTextStyle:"repository",sourceControlTextModel:"test/coding-fast"},resetKeys:[]})}).then(r=>r.json());
    assert.equal(sourceDefaults.effective.sourceControlMergeMethod,"rebase");
    assert.equal(sourceDefaults.effective.sourceControlTextStyle,"repository");
    assert.equal(sourceDefaults.effective.sourceControlTextModel,"test/coding-fast");
    const commitText=await fetch(gui.url+"/api/git/commit-message",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({cwd:projectPath,environmentId:null,model:"test/coding-large"})}).then(r=>r.json());
    assert.equal(commitText.message,"Mock generated commit");assert.equal(commitText.style,"repository");assert.equal(commitText.model,"test/coding-fast");
    const reviewText=await fetch(gui.url+"/api/git/review-text",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({cwd:projectPath,environmentId:null,model:"test/coding-large"})}).then(r=>r.json());
    assert.equal(reviewText.title,"Mock generated review");assert.equal(reviewText.body,"Mock generated description.");assert.equal(reviewText.style,"repository");assert.equal(reviewText.model,"test/coding-fast");
    const meta=await fetch(gui.url+"/api/thread-meta",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({threadId:"thread-test",patch:{pinned:true}})}).then(r=>r.json());
    assert.equal(meta.pinned,true);
    const general=await fetch(gui.url+"/api/general-workspace",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({environmentId:null})}).then(r=>r.json());
    assert.equal(general.environmentId,null);
    assert.equal(general.remote,false);
    assert.equal(general.environmentName,"Local machine");
    assert.equal((await stat(general.path)).isDirectory(),true);
    assert.match(general.path,/general$/);
    await fetch(gui.url+"/api/thread-meta",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({threadId:"thread-branch",patch:{
      cwd:projectPath,environmentId:null,branch:"feature/x",sectionName:"Active",
      branchPullRequest:{identity:{provider:"github",host:"github.com",repository:"acme/widget",number:21},number:21,title:"Detected review",state:"OPEN",url:"https://github.com/acme/widget/pull/21",headRefName:"feature/x",baseRefName:"main"},
      lastBranchPullRequestSyncAt:123,
    }})});
    const branchReviews=await fetch(gui.url+"/api/source-control/branch-reviews").then(r=>r.json());
    const detectedReview=branchReviews.items.find(item=>item.threadId==="thread-branch");
    assert.equal(detectedReview.branch,"feature/x");assert.equal(detectedReview.review.number,21);assert.equal(detectedReview.lastSyncedAt,123);
    const linked=await fetch(gui.url+"/api/source-control/thread-link",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({
      action:"link",threadId:"thread-test",refresh:false,source:"manual",pr:{
        identity:{provider:"github",host:"github.com",repository:"acme/widget",number:17},
        number:17,title:"Linked review",state:"OPEN",url:"https://github.com/acme/widget/pull/17",headRefName:"feature",baseRefName:"main",
      },
    })}).then(r=>r.json());
    assert.equal(linked.ok,true);assert.equal(linked.links.length,1);assert.equal(linked.link.identity.repository,"acme/widget");
    const threadLinks=await fetch(gui.url+"/api/source-control/thread-link?threadId=thread-test").then(r=>r.json());
    assert.equal(threadLinks.links[0].snapshot.title,"Linked review");
    const reverse=await fetch(gui.url+"/api/source-control/thread-link?host=github.com&repository=acme%2Fwidget&number=17&provider=github").then(r=>r.json());
    assert.equal(reverse.threads.some(thread=>thread.threadId==="thread-test"),true);
    const unlinked=await fetch(gui.url+"/api/source-control/thread-link",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({
      action:"unlink",threadId:"thread-test",identity:{provider:"github",host:"github.com",repository:"acme/widget",number:17},
    })}).then(r=>r.json());
    assert.equal(unlinked.links.length,0);
    await fetch(gui.url+"/api/settings",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({autoSettleMergedThreads:true})});
    await fetch(gui.url+"/api/source-control/thread-link",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({
      action:"link",threadId:"thread-settle",refresh:false,source:"manual",pr:{
        identity:{provider:"github",host:"github.com",repository:"acme/widget",number:18},
        number:18,title:"Finished review",state:"MERGED",url:"https://github.com/acme/widget/pull/18",headRefName:"done",baseRefName:"main",mergedAt:"2026-09-22T10:00:00Z",
      },
    })});
    const syncedTerminal=await fetch(gui.url+"/api/source-control/thread-link",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"sync",threadId:"thread-settle"})}).then(r=>r.json());
    assert.equal(syncedTerminal.lifecycle.terminal,true);assert.ok(syncedTerminal.pendingSettlement?.signature);
    const settlements=await fetch(gui.url+"/api/source-control/settlements").then(r=>r.json());
    assert.equal(settlements.enabled,true);assert.equal(settlements.items.some(item=>item.threadId==="thread-settle"),true);

    for(const retiredRoute of ["/api/login/start","/api/logout"]){
      const retiredResponse=await fetch(gui.url+retiredRoute,{method:"POST",headers:{"content-type":"application/json"},body:"{}"});
      assert.equal(retiredResponse.status,404,retiredRoute+" must not remain an API surface");
      assert.deepEqual(await retiredResponse.json(),{error:"API route not found"});
    }

    const health=await fetch(gui.url+"/api/health").then(r=>r.json());
    assert.equal(health.ok,true);

    const retiredDeviceApi=await fetch(gui.url+"/api/devices");
    assert.equal(retiredDeviceApi.status,404,"retired mobile-device control must not remain an API surface");
    assert.deepEqual(await retiredDeviceApi.json(),{error:"API route not found"});
  } finally {
    await gui.close();
    await rm(home,{recursive:true,force:true,maxRetries:30,retryDelay:100});
  }
});
