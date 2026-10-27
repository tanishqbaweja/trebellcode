import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { appendFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import spawn from "cross-spawn";
import { WebSocket } from "ws";
import * as runtimes from "../src/agent-runtime-manager.mjs";
import { attachAgentRelay } from "../src/agent-relay.mjs";
import { AgentThreadStore } from "../src/agent-thread-store.mjs";
import { createGuiServer } from "../src/gui-server.mjs";

// Muse Code as a harness of Trebell's: its registration, where Meta's installers put it, the environment it runs with, its status
// check and model list, its sign-in and install text, and a thread that runs on it through the relay. The status check and the
// threads run a stand-in Muse Code (fixtures/muse/fake-muse.cjs) behind a launcher laid out as Meta's installers lay theirs out.
const {AgentRuntimeManager,normalizeAgentRuntime,runtimeCompatibility,runtimeExecutableCandidates}=runtimes;
const parseMuseVersion=output=>runtimes.parseMuseVersion(output),museInstallCommand=platform=>runtimes.museInstallCommand(platform);
const FAKE_MUSE=fileURLToPath(new URL("./fixtures/muse/fake-muse.cjs",import.meta.url));
const MODEL_LIST=fileURLToPath(new URL("./fixtures/muse/model-list-1.4.13.json",import.meta.url));
const windows=process.platform==="win32";

// Meta's layout: muse.cmd in %LOCALAPPDATA%\Programs\muse on Windows, ~/.local/bin/muse elsewhere, here running the stand-in.
async function fakeMuseInstall(root,{extra=""}={}){
  const folder=windows?join(root,"AppData","Local","Programs","muse"):join(root,"home",".local","bin");await mkdir(folder,{recursive:true});
  const launcher=join(folder,windows?"muse.cmd":"muse");
  await writeFile(launcher,windows?`@echo off\r\nsetlocal\r\n"${process.execPath}" "${FAKE_MUSE}" %*\r\nexit /b %ERRORLEVEL%\r\n${extra}`:`#!/bin/sh\nexec "${process.execPath}" "${FAKE_MUSE}" "$@"\n${extra}`);
  if(!windows)await chmod(launcher,0o755);
  return {launcher,env:windows?{LOCALAPPDATA:join(root,"AppData","Local")}:{HOME:join(root,"home")}};
}
// The settings a manager reads: Muse Code active, its default profile with the stand-in's switches as the profile's own variables.
function museState(environment={},extra={}){
  const settings={agentRuntime:"muse",agentRuntimeInstanceId:"muse-default",agentRuntimeInstances:[{id:"muse-default",kind:"muse",displayName:"Muse Code",enabled:true,binaryPath:null,environment}],...extra},meta=new Map();
  return {settings:()=>settings,updateSettings:patch=>Object.assign(settings,patch),threadMeta:id=>meta.get(id)||{},updateThreadMeta:(id,patch)=>{const next={...(meta.get(id)||{}),...patch};meta.set(id,next);return next}};
}
const entries=async log=>(await readFile(log,"utf8").catch(()=>"")).split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
const launches=async log=>(await entries(log)).filter(entry=>entry.start);
const hosts=async log=>(await launches(log)).filter(entry=>entry.start[0]==="serve");
const frames=async(log,method)=>(await entries(log)).filter(entry=>entry.frame?.method===method).map(entry=>entry.frame);
async function eventually(check,label,ms=15_000){const end=Date.now()+ms;while(!(await check())){if(Date.now()>end)throw new Error("timed out waiting for "+label);await new Promise(done=>setTimeout(done,25))}}

// The status checks' CLI runs, as the manager's own runner makes them, for the stand-in only: any other CLI answers as not installed,
// so no harness installed on this machine is ever started here.
function onlyMuse(launcher){
  return (command,args=[],{env,cwd,timeoutMs=6000}={})=>new Promise(resolve=>{
    if(command!==launcher)return resolve({ok:false,code:null,error:`spawn ${command} ENOENT`,stdout:"",stderr:""});
    const child=spawn(command,args,{env,cwd,windowsHide:true,stdio:["ignore","pipe","pipe"]});let stdout="",stderr="";
    child.stdout.on("data",chunk=>{stdout+=chunk});child.stderr.on("data",chunk=>{stderr+=chunk});
    const timer=setTimeout(()=>child.kill(),timeoutMs);
    child.once("error",error=>{clearTimeout(timer);resolve({ok:false,code:null,error:error.message,stdout,stderr})});
    child.once("close",code=>{clearTimeout(timer);resolve({ok:code===0,code,error:null,stdout,stderr})});
  });
}
async function museFixture(prefix,{environment={},models=true,env:extraEnv={}}={}){
  const root=await mkdtemp(join(tmpdir(),prefix)),log=join(root,"muse.log");
  const install=await fakeMuseInstall(root);
  const environmentVars={MUSE_FAKE_LOG:log,...(models?{MUSE_FAKE_MODELS:MODEL_LIST}:{}),...environment};
  const env={...process.env,TREBELL_HOME:join(root,"trebell"),CODEX_HOME:join(root,"codex"),CLAUDE_CONFIG_DIR:join(root,"claude"),MUSE_INSTALL_DIR:"",...install.env,...extraEnv};
  const state=museState(environmentVars);
  const manager=new AgentRuntimeManager({state,env,runFn:onlyMuse(install.launcher)});
  return {root,log,launcher:install.launcher,env,state,manager,close:()=>rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100})};
}

test("Muse Code is a runtime kind of its own, never read as Codex, with profiles of its own",()=>{
  assert.equal(normalizeAgentRuntime("muse"),"muse");
  assert.equal(normalizeAgentRuntime(" Muse "),"muse");
  const manager=new AgentRuntimeManager({state:museState(),env:{PATH:""},platform:"linux"});
  const definition=manager.definitions().find(item=>item.id==="muse");
  assert.deepEqual({id:definition.id,name:definition.name,protocol:definition.protocol,command:definition.command,multipleInstances:definition.multipleInstances},{id:"muse",name:"Muse Code",protocol:"msp",command:"muse",multipleInstances:true});
  assert.equal(manager.instances().find(item=>item.id==="muse-default").kind,"muse");
  assert.equal(manager.upsertInstance({id:"muse-work",kind:"muse",displayName:"Muse work"}).kind,"muse","a second Muse Code profile is kept as Muse Code");
  assert.equal(manager.capabilities("muse").steering,true);
  for(const now of ["mcpInjection","usageReporting","contextReporting","detachedTasks","fork","compaction"])assert.equal(manager.capabilities("muse")[now],true,now);
  assert.equal(manager.capabilities("muse").rewind,false,"Muse Code has no conversation rewind, as Cursor has none");
});

test("Muse Code is found where Meta's installers put it, without a PATH entry: MUSE_INSTALL_DIR, else %LOCALAPPDATA%\\Programs\\muse or ~/.local/bin",async()=>{
  assert.deepEqual(runtimeExecutableCandidates("muse",{platform:"win32",env:{LOCALAPPDATA:"C:\\Users\\me\\AppData\\Local"}}),[join("C:\\Users\\me\\AppData\\Local","Programs","muse","muse.cmd")]);
  assert.deepEqual(runtimeExecutableCandidates("muse",{platform:"linux",env:{HOME:"/home/me"}}),[join("/home/me",".local","bin","muse")]);
  assert.deepEqual(runtimeExecutableCandidates("muse",{platform:"win32",env:{LOCALAPPDATA:"C:\\L",MUSE_INSTALL_DIR:"D:\\tools\\muse"}}),[join("D:\\tools\\muse","muse.cmd")]);
  assert.deepEqual(runtimeExecutableCandidates("muse",{platform:"darwin",env:{}}),[]);
  const root=await mkdtemp(join(tmpdir(),"trebell-muse-find-"));
  try{
    const local=join(root,"Local"),folder=join(local,"Programs","muse");await mkdir(folder,{recursive:true});
    await writeFile(join(folder,"muse.cmd"),"@echo off\r\nsetlocal\r\n\"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -NoProfile -ExecutionPolicy Bypass -File \"%~dp0.muse-launcher.ps1\" %*\r\nexit /b %ERRORLEVEL%\r\n");
    const onWindows=new AgentRuntimeManager({state:museState(),env:{PATH:"",LOCALAPPDATA:local},platform:"win32"});
    assert.equal(onWindows.executable({id:"muse-default",kind:"muse"}),join(folder,"muse.cmd"),"Meta's launcher itself: it starts PowerShell, which starts muse-bin");
    const home=join(root,"home"),bin=join(home,".local","bin");await mkdir(bin,{recursive:true});await writeFile(join(bin,"muse"),"#!/bin/sh\n");
    const elsewhere=new AgentRuntimeManager({state:museState(),env:{PATH:"",HOME:home},platform:"linux"});
    assert.equal(elsewhere.executable({id:"muse-default",kind:"muse"}),join(bin,"muse"));
    assert.equal(new AgentRuntimeManager({state:museState(),env:{PATH:""},platform:"linux"}).executable({id:"muse-default",kind:"muse"}),"muse","no install: the command on PATH");
    assert.equal(onWindows.executable({id:"muse-own",kind:"muse",binaryPath:"E:\\muse\\muse.exe"}),"E:\\muse\\muse.exe","a profile's own path wins");
  }finally{await rm(root,{recursive:true,force:true})}
});

test("Muse Code runs with its release channel and MUSE_NO_AUTO_UPDATE=1, and Trebell's own META_API_KEY reaches it only when its profile approves it",()=>{
  const parent={PATH:"/usr/bin",HOME:"/home/me",XDG_CONFIG_HOME:"/home/me/.config",META_API_KEY:"meta-key-in-trebells-env",MUSE_CHANNEL:"muse-canary",OPENAI_API_KEY:"not-for-muse"};
  const manager=new AgentRuntimeManager({state:museState(),env:parent,platform:"linux"});
  const env=manager.childEnv({id:"muse-default",kind:"muse"});
  assert.equal(env.MUSE_CHANNEL,"muse-canary");assert.equal(env.MUSE_NO_AUTO_UPDATE,"1");
  assert.equal(env.HOME,"/home/me");assert.equal(env.XDG_CONFIG_HOME,"/home/me/.config");
  assert.equal("META_API_KEY" in env,false,"a key in Trebell's environment never replaces the person's Muse sign-in");
  assert.equal("OPENAI_API_KEY" in env,false);
  assert.ok(manager.childEnvironmentKeys({kind:"muse"}).includes("MUSE_CHANNEL"));
  const approved=manager.childEnv({id:"muse-key",kind:"muse",approvedEnvironmentKeys:["META_API_KEY"]});
  assert.equal(approved.META_API_KEY,"meta-key-in-trebells-env","a profile that approves META_API_KEY forwards it");
  assert.equal(manager.childEnv({id:"muse-updates",kind:"muse",environment:{MUSE_NO_AUTO_UPDATE:"0"}}).MUSE_NO_AUTO_UPDATE,"0","a profile's own value wins");
});

test("Muse Code's X.Y.Z-R<revision> version is read as Muse names it, and 1.4.2 and later are supported with the revision left out",()=>{
  assert.equal(parseMuseVersion("1.4.13-R6996.1"),"1.4.13-R6996.1");
  assert.equal(parseMuseVersion("muse 1.4.6-R5018"),"1.4.6-R5018");
  assert.equal(parseMuseVersion("Muse Code 1.4.13 (1.4.13-R6996.1)\n"),"1.4.13-R6996.1","Muse 1.4.13's own --version");
  assert.equal(parseMuseVersion("muse 1.4.2"),"1.4.2");
  assert.equal(parseMuseVersion("no version here"),null);
  const supported=runtimeCompatibility("muse","1.4.13-R6996.1");
  assert.deepEqual([supported.status,supported.version,supported.recommendedRange],["supported","1.4.13",">=1.4.2"]);
  assert.equal(runtimeCompatibility("muse","muse 1.4.6-R5018").status,"supported");
  assert.equal(runtimeCompatibility("muse","1.4.2").status,"supported");
  const older=runtimeCompatibility("muse","1.4.1-R4100.2");
  assert.deepEqual([older.status,older.message],["unknown",null],"an older Muse Code is not refused, only not known to work");
  assert.equal(runtimeCompatibility("muse",null).status,"unknown");
});

test("Muse Code's status check: not found, a failed --version (no host, nothing it printed), no models (not ready, sign in), and models (ready, sign-in unknown)",{timeout:60_000},async()=>{
  // Not found: Meta's install page and its one-liner, and no host.
  const missing=new AgentRuntimeManager({state:museState(),env:{PATH:""},platform:"linux",runFn:async()=>({ok:false,code:null,error:"spawn muse ENOENT",stdout:"",stderr:""})});
  const notFound=await missing.probe("muse",{fresh:true});
  assert.deepEqual([notFound.available,notFound.installed,notFound.authenticated],[false,false,null]);
  assert.equal(notFound.message,"Muse Code (muse) was not found. Install it with curl -fsSL https://dev.meta.ai/install.sh | sh (https://dev.meta.ai/docs/muse-code), then sign in with muse login.");
  const fixture=await museFixture("trebell-muse-status-",{environment:{MUSE_FAKE_VERSION:"muse failed: token=abc123secret",MUSE_FAKE_VERSION_EXIT:"3"}});
  try{
    const failed=await fixture.manager.probe("muse",{fresh:true});
    assert.deepEqual([failed.available,failed.installed,failed.authenticated],[false,true,null]);
    assert.equal(failed.message,"Muse Code is installed, but `muse --version` failed with exit code 3. Check its executable path, or install Muse Code again.");
    assert.doesNotMatch(JSON.stringify(failed),/abc123secret/,"what Muse printed stays out of the answer");
    assert.equal((await hosts(fixture.log)).length,0,"a failed version check starts no host");
  }finally{await fixture.close()}
  const signedOut=await museFixture("trebell-muse-signed-out-",{models:false});
  try{
    const empty=await signedOut.manager.probe("muse",{fresh:true});
    assert.deepEqual([empty.available,empty.installed,empty.authenticated,empty.version],[false,true,null,"1.4.13-R6996.1"]);
    assert.equal(empty.message,"Muse Code listed no models. Sign in with muse login, then press Refresh.");
    const [host]=await hosts(signedOut.log);
    assert.deepEqual(host.start,["serve","--disable-shell","--disable-write","--no-session-log"],"a short read-only host with no session log");
    assert.equal(host.env.MUSE_NO_AUTO_UPDATE,"1");
    const [initialize]=await frames(signedOut.log,"initialize");
    assert.deepEqual(initialize.params.capabilities.requestedCapabilities,[],"the listing host asks for no session capabilities");
    assert.equal(initialize.params.clientInfo.name,"trebell_code");
    assert.deepEqual((await frames(signedOut.log,"model/list")).map(frame=>frame.params),[{}]);
    assert.equal((await frames(signedOut.log,"session/start")).length,0,"listing models starts no session");
    const models=await signedOut.manager.models("muse");
    assert.deepEqual(models.models,[]);assert.match(models.error,/listed no models/);
  }finally{await signedOut.close()}
  const ready=await museFixture("trebell-muse-ready-");
  try{
    const status=await ready.manager.probe("muse",{fresh:true});
    assert.deepEqual([status.available,status.installed,status.authenticated,status.version,status.compatibility.status],[true,true,null,"1.4.13-R6996.1","supported"]);
    assert.equal(status.binary,ready.launcher);
    assert.equal(status.message,"Muse Code checks its sign-in when a turn runs. Sign in with muse login if a turn says it is signed out.");
    assert.equal((await launches(ready.log)).every(entry=>entry.env.META_API_KEY===null),true);
  }finally{await ready.close()}
});

test("Muse Code's models are its own list, read once per binary and version: polls and thread starts reuse it, and Refresh reads it again",{timeout:60_000},async()=>{
  const fixture=await museFixture("trebell-muse-models-");
  try{
    const listed=await fixture.manager.models("muse");
    assert.equal(listed.source,"live");
    assert.deepEqual(listed.models,["muse-wonder-1.0","muse-spark-1.3","muse-spark-1.2","muse-spark-1.3-contributor"]);
    assert.deepEqual(listed.metadata.map(row=>row.name),["Muse Wonder 1.0","Muse Spark 1.3","Muse Spark 1.2","Muse Spark 1.3 Contributor"]);
    assert.equal(listed.preferred,"muse-spark-1.2","Muse's own default row");
    assert.equal((await hosts(fixture.log)).length,1);
    // The 5-second polls, a thread start and the model list again: no host.
    for(let poll=0;poll<5;poll++)assert.equal((await fixture.manager.probe("muse")).available,true);
    await fixture.manager.models("muse");
    assert.equal((await hosts(fixture.log)).length,1,"polls and model lists reuse the list");
    assert.deepEqual(fixture.manager.museModelCatalog({id:"muse-default"}).models,listed.models,"the list a session resolves its model against");
    // A fresh check (a harness switch's) reuses it too; Settings' open and Refresh (its own listing) read it again.
    assert.equal((await fixture.manager.probe("muse",{fresh:true})).available,true);
    assert.equal((await hosts(fixture.log)).length,1);
    assert.equal((await fixture.manager.snapshot({refresh:true})).statuses.find(item=>item.kind==="muse").available,true);
    assert.equal((await hosts(fixture.log)).length,2);
    // A new Muse Code (the launcher replaced, and another version) reads it again at the next poll.
    fixture.state.settings().agentRuntimeInstances[0].environment.MUSE_FAKE_VERSION="Muse Code 1.4.14 (1.4.14-R7100.1)";
    await appendFile(fixture.launcher,windows?"rem 1.4.14\r\n":"# 1.4.14\n");
    const updated=await fixture.manager.probe("muse");
    assert.equal(updated.version,"1.4.14-R7100.1");
    assert.equal((await hosts(fixture.log)).length,3,"another version lists its models again");
  }finally{await fixture.close()}
});

test("a model list Muse Code could not read is kept for a minute and then read again: the checks of that minute start no host and say to press Refresh",{timeout:60_000},async()=>{
  const fixture=await museFixture("trebell-muse-failed-list-");
  try{
    // While this file is there, the stand-in's host exits as Muse does with a malformed settings file.
    const failing=join(fixture.root,"serve-fails");await writeFile(failing,"3");
    fixture.state.settings().agentRuntimeInstances[0].environment.MUSE_FAKE_SERVE_FAIL=failing;
    let clock=Date.now();
    const manager=new AgentRuntimeManager({state:fixture.state,env:fixture.env,runFn:onlyMuse(fixture.launcher),now:()=>clock});
    const failed=await manager.probe("muse");
    assert.deepEqual([failed.available,failed.installed,failed.version],[false,true,"1.4.13-R6996.1"]);
    assert.match(failed.message,/^Muse Code could not list its models: Muse Code could not load its settings; check ~\/\.config\/muse\/settings\.json \(exit code 3\): load settings for serve composition: malformed settings file at .*settings\.json\. Press Refresh to check it again\.$/);
    assert.equal((await hosts(fixture.log)).length,1);
    // Muse Code works again (its settings mended in the person's own editor). The polls, thread starts and model lists of the next
    // minute keep the failure, and start no host.
    await rm(failing);
    clock+=30_000;
    for(let poll=0;poll<3;poll++)assert.equal((await manager.probe("muse")).message,failed.message);
    assert.equal((await manager.models("muse")).error,failed.message);
    assert.equal((await hosts(fixture.log)).length,1,"no host within the minute");
    clock+=31_000;
    const ready=await manager.probe("muse");
    assert.equal(ready.available,true,"the first check after the minute reads the list again");
    assert.equal((await hosts(fixture.log)).length,2);
  }finally{await fixture.close()}
});

test("Muse Code's list is read again only by Settings' own listing, a failed turn's recheck and picking a Muse Code that listed no models: the listings after a switch, a profile saved or one removed start no host",{timeout:90_000},async()=>{
  const fixture=await museFixture("trebell-muse-listings-");
  try{
    const manager=fixture.manager,count=async()=>(await hosts(fixture.log)).length;
    assert.equal((await manager.snapshot({refresh:true})).statuses.find(item=>item.kind==="muse").available,true,"Settings opens");
    assert.equal(await count(),1);
    // A switch to another harness (the answer lists every harness after it), a profile saved and one removed, and a switch back.
    await manager.setActive({runtime:"native"});await manager.snapshot();
    manager.upsertInstance({id:"codex-spare",kind:"codex",displayName:"Spare Codex"});await manager.snapshot();
    manager.removeInstance("codex-spare");await manager.snapshot();
    await manager.setActive({runtime:"muse"});await manager.snapshot();
    assert.equal(await count(),1,"those listings reuse the list");
    await manager.recheck("muse");
    assert.equal(await count(),2,"a failed turn's recheck reads it again");
    await manager.snapshot({refresh:true});
    assert.equal(await count(),3,"so does Settings' Refresh");
    // A change to what the profile runs Muse Code with reads it again at the next check.
    fixture.state.settings().agentRuntimeInstances[0].approvedEnvironmentKeys=["META_API_KEY"];
    await manager.snapshot();
    assert.equal(await count(),4,"a profile saved with other approved names");
  }finally{await fixture.close()}
  const signedOut=await museFixture("trebell-muse-listings-signed-out-",{models:false});
  try{
    const manager=signedOut.manager,count=async()=>(await hosts(signedOut.log)).length;
    await manager.snapshot({refresh:true});
    await manager.setActive({runtime:"native"});await manager.snapshot();
    assert.equal(await count(),1,"an empty list is reused too: a Muse Code installed but signed out costs a switch nothing");
    await assert.rejects(manager.setActive({runtime:"muse"}),/^Error: Muse Code listed no models\. Sign in with muse login, then press Refresh\.$/);
    assert.equal(await count(),2,"picking a Muse Code that listed no models reads its list again");
  }finally{await signedOut.close()}
});

async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}
test("the GUI server's own harness listing (Settings' open and Refresh) reads Muse Code's list again, and its answers to a switch, a profile saved and one removed reuse it",{timeout:120_000},async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-muse-routes-")),log=join(root,"muse.log"),install=await fakeMuseInstall(root);
  // Nothing but the stand-in can run: PATH holds node and the system's own folders, and every home is the test's.
  const system=process.env.SystemRoot||"C:\\Windows";await mkdir(join(root,"tmp"),{recursive:true});
  const env={
    PATH:[dirname(process.execPath),...(windows?[join(system,"System32"),system]:["/usr/bin","/bin"])].join(windows?";":":"),
    ...(windows?{SystemRoot:system,ComSpec:process.env.ComSpec||join(system,"System32","cmd.exe"),PATHEXT:process.env.PATHEXT||".COM;.EXE;.BAT;.CMD"}:{}),
    TEMP:join(root,"tmp"),TMP:join(root,"tmp"),TMPDIR:join(root,"tmp"),HOME:join(root,"home"),USERPROFILE:join(root,"home"),APPDATA:join(root,"AppData","Roaming"),
    XDG_CONFIG_HOME:join(root,"home",".config"),...install.env,MUSE_INSTALL_DIR:"",TREBELL_HOME:join(root,"trebell"),CODEX_HOME:join(root,"codex"),
    CLAUDE_CONFIG_DIR:join(root,"claude"),TREBELL_CODEX_BIN:join(root,"no-codex","codex.exe"),TREBELL_HISTORY_DISABLE_CLAUDE:"1",HARBOR_TELEMETRY:"0",
  };
  const [port,appPort]=await Promise.all([freePort(),freePort()]);
  const gui=await createGuiServer({port,appPort,mock:true,env});
  const call=async(method,body)=>{
    const response=await fetch(gui.url+"/api/agent-runtimes"+(method==="DELETE"?"?id="+encodeURIComponent(body):""),{method,...(method==="POST"?{headers:{"content-type":"application/json"},body:JSON.stringify(body)}:{})});
    const value=await response.json();if(!response.ok)throw new Error(value.error);return value;
  };
  const count=async()=>(await hosts(log)).length;
  try{
    await call("POST",{action:"upsert",instance:{id:"muse-default",kind:"muse",displayName:"Muse Code",environment:{MUSE_FAKE_LOG:log,MUSE_FAKE_MODELS:MODEL_LIST}}});
    assert.equal(await count(),1,"the profile saved lists its models once");
    const listed=await call("GET");
    assert.equal(listed.statuses.find(item=>item.kind==="muse").available,true);
    assert.equal(await count(),2,"Settings opens");
    await call("POST",{action:"select",runtime:"native",instanceId:"native-default"});
    await call("POST",{action:"upsert",instance:{id:"codex-spare",kind:"codex",displayName:"Spare Codex"}});
    await call("DELETE","codex-spare");
    assert.equal(await count(),2,"a switch, a profile saved and one removed start no Muse Code");
    await call("GET");
    assert.equal(await count(),3,"Settings' Refresh");
  }finally{
    await gui.close();
    await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100});
  }
});

test("a Muse Code that updated itself beside a launcher left as it was, as Meta's ~/.local/bin/muse keeps it, is checked again at the next poll",{timeout:60_000},async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-muse-unix-update-")),log=join(root,"muse.log"),bin=join(root,"home",".local","bin");
  try{
    await mkdir(bin,{recursive:true});
    // The launcher runs the build its .muse-version names; written for node, so the test runs it on every platform, and CommonJS
    // wherever the temporary folder is (a package.json above it can make an extensionless file a module).
    await writeFile(join(root,"package.json"),"{\"type\":\"commonjs\"}\n");
    const launcher=join(bin,"muse");
    await writeFile(launcher,`#!/usr/bin/env node\nconst {readFileSync}=require("node:fs"),{join}=require("node:path");\nprocess.env.MUSE_FAKE_VERSION="Muse Code "+readFileSync(join(__dirname,".muse-version"),"utf8").trim();\nrequire(${JSON.stringify(FAKE_MUSE)});\n`);
    await chmod(launcher,0o755);
    const install=async version=>{await writeFile(join(bin,".muse-version"),version+"\n");await writeFile(join(bin,"muse-bin-"+version),"")};
    await install("1.4.13-R6996.1");
    const manager=new AgentRuntimeManager({state:museState({MUSE_FAKE_LOG:log,MUSE_FAKE_MODELS:MODEL_LIST}),env:{...process.env,HOME:join(root,"home"),MUSE_INSTALL_DIR:"",TREBELL_HOME:join(root,"trebell")},platform:"linux",runFn:onlyMuse(launcher)});
    assert.equal(manager.executable({id:"muse-default",kind:"muse"}),launcher);
    const versionRuns=async()=>(await launches(log)).filter(entry=>entry.start[0]==="--version").length;
    for(let poll=0;poll<2;poll++)assert.equal((await manager.probe("muse")).version,"1.4.13-R6996.1");
    assert.equal(await versionRuns(),1,"a poll reuses the check");
    // Muse Code updates itself from the person's own shell: a new build and .muse-version beside the launcher, which stays as it was.
    await rm(join(bin,"muse-bin-1.4.13-R6996.1"));await install("1.4.14-R7100.1");
    const updated=await manager.probe("muse");
    assert.deepEqual([updated.version,updated.available],["1.4.14-R7100.1",true]);
    assert.equal(await versionRuns(),2);
    assert.equal((await hosts(log)).length,2,"the new build lists its models again");
  }finally{await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100})}
});

test("Muse Code signs in with `muse login` in a Trebell terminal, offers Meta's installer as text and is never installed by Trebell",async()=>{
  const fixture=await museFixture("trebell-muse-auth-");
  try{
    assert.deepEqual(fixture.manager.authCommand("muse"),{runtime:"muse",instanceId:"muse-default",name:"Muse Code",command:fixture.launcher,args:["login"]});
    assert.equal(fixture.manager.installable("muse"),null);
    await assert.rejects(()=>fixture.manager.install("muse"),/Muse Code is not installable from Trebell Code/);
    // Settings' harness list, with every harness answering as not installed (nothing on this machine is started).
    for(const [platform,command] of [["win32","irm https://dev.meta.ai/install.ps1 | iex"],["linux","curl -fsSL https://dev.meta.ai/install.sh | sh"],["darwin","curl -fsSL https://dev.meta.ai/install.sh | sh"]]){
      assert.equal(museInstallCommand(platform),command);
      const manager=new AgentRuntimeManager({state:museState(),env:{PATH:"",TREBELL_HOME:join(fixture.root,"trebell-"+platform)},platform,runFn:async()=>({ok:false,code:null,error:"spawn muse ENOENT",stdout:"",stderr:""})});
      const snapshot=await manager.snapshot(),definition=snapshot.definitions.find(item=>item.id==="muse");
      assert.deepEqual({installable:definition.installable,installCommand:definition.installCommand,canAuthenticate:definition.canAuthenticate,packageName:definition.packageName},{installable:false,installCommand:command,canAuthenticate:true,packageName:null},platform);
      assert.equal(snapshot.statuses.find(item=>item.kind==="muse").installed,false);
    }
  }finally{await fixture.close()}
});

test("Muse Code runs only on this machine: a WSL or SSH environment answers so, and its sign-in is not run there",async()=>{
  const runs=[];
  const environments={get:id=>id==="ssh-box"?{id,name:"SSH box",type:"ssh",cwd:"/srv/app"}:null,executeArgv:async(_id,call)=>{runs.push(call);return {exitCode:1,stdout:"",stderr:"unexpected"}},spawnArgv:()=>{throw new Error("nothing spawns remotely")}};
  const manager=new AgentRuntimeManager({state:museState({}, {activeEnvironmentId:"ssh-box"}),env:{PATH:""},environments,platform:"linux"});
  const status=await manager.probe("muse",{fresh:true});
  assert.deepEqual([status.available,status.message],[false,"Muse Code runs only on this machine in Trebell Code. Switch to the local environment to use it."]);
  assert.throws(()=>manager.authCommand("muse"),/runs only on this machine/);
  assert.deepEqual(runs,[],"nothing ran on the remote host");
});

// The relay with the real runtime manager on the stand-in Muse Code: a thread started on Muse Code, its turns' models and Thinking
// levels, a model Muse refuses, the catalog default, steering, and a thread reopened without starting Muse.
async function museRelay(prefix,{environment={},env={}}={}){
  const fixture=await museFixture(prefix,{environment,env});
  const threadStore=new AgentThreadStore(fixture.env);
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});
  const relay=attachAgentRelay(server,{runtimeManager:fixture.manager,threadStore,terminals:{},state:fixture.state,version:"1.6.0-test"});
  await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const ws=new WebSocket("ws://127.0.0.1:"+server.address().port+"/api/agent/ws");await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});
  const notifications=[];ws.on("message",raw=>{const message=JSON.parse(String(raw));if(message.method&&message.id==null)notifications.push(message)});
  let id=0;
  const rpc=(method,params={})=>new Promise((resolve,reject)=>{
    const requestId=++id,onMessage=raw=>{const message=JSON.parse(String(raw));if(message.id!==requestId)return;ws.off("message",onMessage);message.error?reject(new Error(message.error.message)):resolve(message.result)};
    ws.on("message",onMessage);ws.send(JSON.stringify({id:requestId,method,params}));
  });
  const completed=async(threadId,count)=>eventually(()=>notifications.filter(item=>item.method==="turn/completed"&&item.params.threadId===threadId).length>=count,`turn ${count} to complete`);
  const close=async()=>{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));threadStore.close?.();await fixture.close()};
  return {...fixture,threadStore,rpc,notifications,completed,close};
}
const replyOf=(threadStore,threadId)=>threadStore.get(threadId).turns.at(-1).items.filter(item=>item.type==="agentMessage").map(item=>item.text).join("");

test("a Muse Code thread runs on Muse Code: the turn takes the composer's Thinking level as the model lists it, a model change is sent once before the next turn, and a refused model leaves the thread's",{timeout:90_000},async()=>{
  const relay=await museRelay("trebell-muse-relay-",{environment:{MUSE_FAKE_REFUSE:"muse-spark-1.3"}});
  try{
    const {thread}=await relay.rpc("thread/start",{cwd:relay.root,model:"muse-wonder-1.0"});
    assert.equal(thread.runtime,"muse");
    const [start]=await frames(relay.log,"session/start");
    assert.deepEqual([start.params.modelId,start.params.providerId],["muse-wonder-1.0","meta"]);
    await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"Hello Muse"}],model:"muse-wonder-1.0",reasoningEffort:"xhigh",permissionProfile:"supervised"});
    await relay.completed(thread.id,1);
    assert.equal(replyOf(relay.threadStore,thread.id),"Muse fixture reply on muse-wonder-1.0 at xhigh effort.");
    assert.equal((await frames(relay.log,"turn/start"))[0].params.reasoningEffort,"xhigh");
    assert.equal((await frames(relay.log,"session/setModel")).length,0,"the session already runs the thread's model");
    // Another model: session/setModel once, then the turn at the level that model lists (Max is not one of the contributor model's).
    await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"Again"}],model:"muse-spark-1.3-contributor",reasoningEffort:"max"});
    await relay.completed(thread.id,2);
    const switches=await frames(relay.log,"session/setModel");
    assert.deepEqual(switches.map(frame=>frame.params.model),[{modelId:"muse-spark-1.3-contributor",providerId:"meta"}]);
    assert.equal((await frames(relay.log,"turn/start"))[1].params.reasoningEffort,"medium","the model's own default for a level it does not list");
    assert.equal(relay.threadStore.get(thread.id).model,"muse-spark-1.3-contributor");
    await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"Same model"}],model:"muse-spark-1.3-contributor",reasoningEffort:"low"});
    await relay.completed(thread.id,3);
    assert.equal((await frames(relay.log,"session/setModel")).length,1,"an equal model is not sent again");
    assert.equal((await frames(relay.log,"turn/start"))[2].params.reasoningEffort,"low");
    // A model Muse refuses: the turn fails with Muse's reason, and the thread keeps its model.
    await assert.rejects(()=>relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"Refused"}],model:"muse-spark-1.3"}),/Muse Code could not switch to the thread's model: model muse-spark-1\.3 does not exist or you lack access/);
    assert.equal(relay.threadStore.get(thread.id).model,"muse-spark-1.3-contributor");
    await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"Back on the thread's model"}],model:"muse-spark-1.3-contributor",reasoningEffort:null});
    await relay.completed(thread.id,4);
    assert.match(replyOf(relay.threadStore,thread.id),/on muse-spark-1\.3-contributor at Muse's default effort/,"no choice leaves Muse's own level");
    // "default" is the catalog's default row, and never goes to Muse as a model id.
    await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"Default"}],model:"default"});
    await relay.completed(thread.id,5);
    assert.deepEqual((await frames(relay.log,"session/setModel")).map(frame=>frame.params.model.modelId),["muse-spark-1.3-contributor","muse-spark-1.3","muse-spark-1.2"]);
    assert.equal(relay.threadStore.get(thread.id).model,"muse-spark-1.2");
    assert.equal((await hosts(relay.log)).filter(entry=>entry.start.includes("--trust-workspace")).length,1,"every turn ran on the thread's one host");
  }finally{await relay.close()}
});

test("Trebell's own META_API_KEY reaches the hosts of a Muse Code thread and of its model list only when the profile approves it",{timeout:90_000},async()=>{
  for(const approved of [false,true]){
    const relay=await museRelay(approved?"trebell-muse-key-approved-":"trebell-muse-key-",{env:{META_API_KEY:"meta-key-in-trebells-env"}});
    try{
      if(approved)relay.state.settings().agentRuntimeInstances[0].approvedEnvironmentKeys=["META_API_KEY"];
      const {thread}=await relay.rpc("thread/start",{cwd:relay.root,model:"muse-wonder-1.0"});
      await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"Hello Muse"}]});
      await relay.completed(thread.id,1);
      const started=await hosts(relay.log);
      assert.deepEqual(started.map(entry=>[entry.start.includes("--no-session-log")?"model list":"thread",entry.env.META_API_KEY]),[["model list",approved?"set":null],["thread",approved?"set":null]],approved?"approved":"not approved");
    }finally{await relay.close()}
  }
});

test("a message sent while a Muse Code turn runs steers that turn, and a Muse Code thread reopened later starts no Muse Code",{timeout:60_000},async()=>{
  const relay=await museRelay("trebell-muse-steer-");
  try{
    const {thread}=await relay.rpc("thread/start",{cwd:relay.root,model:"muse-wonder-1.0"});
    const {turn}=await relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"Please hold until steered"}]});
    await eventually(async()=>(await frames(relay.log,"turn/start")).length===1,"the turn to reach Muse");
    await eventually(()=>relay.notifications.some(item=>item.method==="item/agentMessage/delta"&&item.params.threadId===thread.id),"the reply to stream");
    const steered=await relay.rpc("turn/steer",{threadId:thread.id,expectedTurnId:turn.id,input:[{type:"text",text:"use the second file"}]});
    assert.deepEqual([steered.turnId,steered.accepted],[turn.id,true]);
    await relay.completed(thread.id,1);
    const [steer]=await frames(relay.log,"turn/steer");
    assert.equal(steer.params.expectedTurnId,(await frames(relay.log,"turn/start"))[0].params.commandId,"the steer names the running turn");
    assert.match(replyOf(relay.threadStore,thread.id),/Steered: use the second file\./);
    // A saved Muse Code thread opened again shows its transcript; Muse Code starts with its next turn.
    const saved=relay.threadStore.create({runtime:"muse",cwd:relay.root,providerSessionId:"01a11a6a-bbb5-7000-ad0b-0c9e728406e5",model:"muse-wonder-1.0",providerMeta:{runtimeInstanceId:"muse-default"}});
    const before=(await hosts(relay.log)).length;
    const opened=await relay.rpc("thread/resume",{threadId:saved.id,cwd:relay.root});
    assert.equal(opened.thread.id,saved.id);
    assert.equal((await hosts(relay.log)).length,before,"reopening a Muse Code thread launches no Muse Code");
  }finally{await relay.close()}
});
