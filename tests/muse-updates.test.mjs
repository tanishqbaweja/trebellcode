// Muse Code's updates in Settings, as AgentRuntimeManager plans, runs and lists them (installPlan, install, and the update reading of
// Settings' harness list): Meta's channel manifest names the newest release, and Meta's
// launcher, which has no update command, updates the Muse Code it runs when it runs its --version with its update on, synchronous
// and due, on the profile's channel. Every Trebell launch keeps that update off, so this is the one way Muse Code updates under it.
// On Windows the launcher is Meta's own muse.cmd beside a stand-in .muse-launcher.ps1 that updates as Meta's does
// (fixtures/muse/fake-muse-launcher.mjs), run through cmd.exe and Windows PowerShell as Meta's is, in a folder of the test's own; on
// macOS and Linux the launcher script is planned from its file. Nothing of Meta's runs and no Muse Code on this machine is touched.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import spawn from "cross-spawn";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";
import { fakeMetaMuse } from "./fixtures/muse/fake-muse-launcher.mjs";

const WINDOWS_ONLY={skip:process.platform!=="win32"&&"lays out Meta's Windows install and runs it through Windows PowerShell"};
const FAKE_MUSE=fileURLToPath(new URL("./fixtures/muse/fake-muse.cjs",import.meta.url));
const MODEL_LIST=fileURLToPath(new URL("./fixtures/muse/model-list-1.4.13.json",import.meta.url));
const STABLE="https://api.meta.ai/muse-code/channels/muse-stable",CANARY="https://api.meta.ai/muse-code/channels/muse-canary";
const UPDATE_SWITCHES="MUSE_NO_AUTO_UPDATE=0, MUSE_SYNC_UPDATE=1 and MUSE_UPDATE_INTERVAL_SECONDS=0";
const missing=command=>({ok:false,code:null,error:`spawn ${command} ENOENT`,stdout:"",stderr:""});

// The CLI runs of a manager, made as its own runner makes them but only for the files in runnable (calls lists every one with the
// Muse switches it ran with): any other CLI answers as not installed, so no harness installed on this machine runs.
function runOnly(runnable,calls){
  return (command,args=[],{env={},cwd,timeoutMs=6000}={})=>new Promise(resolve=>{
    calls.push({command,args:[...args],env:{MUSE_NO_AUTO_UPDATE:env.MUSE_NO_AUTO_UPDATE,MUSE_SYNC_UPDATE:env.MUSE_SYNC_UPDATE,MUSE_UPDATE_INTERVAL_SECONDS:env.MUSE_UPDATE_INTERVAL_SECONDS,MUSE_CHANNEL:env.MUSE_CHANNEL}});
    if(!runnable.has(command))return resolve(missing(command));
    const child=spawn(command,args,{env,cwd,windowsHide:true,stdio:["ignore","pipe","pipe"]});let stdout="",stderr="";
    child.stdout.on("data",chunk=>{stdout+=chunk});child.stderr.on("data",chunk=>{stderr+=chunk});
    const timer=setTimeout(()=>child.kill(),timeoutMs);
    child.once("error",error=>{clearTimeout(timer);resolve({ok:false,code:null,error:error.message,stdout,stderr})});
    child.once("close",code=>{clearTimeout(timer);resolve({ok:code===0,code,error:null,stdout,stderr})});
  });
}
// A Windows machine of the test's own: Muse Code from Meta's installer in %LOCALAPPDATA%\Programs\muse at version, its launcher's
// channels naming releases, Meta's channel manifests naming channels[url], and one Muse Code profile (its environment and fields).
async function museMachine(t,{version="1.4.13-R6996.1",releases={"muse-stable":"1.4.14-R7010.1"},channels={[STABLE]:"1.4.14-R7010.1"},environment={},profile={}}={}){
  const root=await mkdtemp(join(tmpdir(),"trebell-muse-updates-"));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250}));
  const folder=join(root,"AppData","Local","Programs","muse"),launcher=await fakeMetaMuse(folder,{version,releases});
  const env={USERPROFILE:join(root,"home"),HOME:join(root,"home"),APPDATA:join(root,"AppData","Roaming"),LOCALAPPDATA:join(root,"AppData","Local"),PATH:"",PATHEXT:".COM;.EXE;.BAT;.CMD",SystemRoot:process.env.SystemRoot,COMSPEC:process.env.COMSPEC,TEMP:root,TMP:root,TREBELL_HOME:join(root,"trebell"),CODEX_HOME:join(root,"home",".codex")};
  const settings={agentRuntime:"native",agentRuntimeInstanceId:"native-default",agentRuntimeInstances:[{id:"muse-default",kind:"muse",displayName:"Muse Code",enabled:true,binaryPath:null,environment:{MUSE_FAKE_MODELS:MODEL_LIST,...environment},...profile}]};
  const calls=[],fetched=[],runnable=new Set([launcher]);
  const fetchImpl=async url=>{fetched.push(String(url));const release=channels[String(url)];return release?Response.json({channel:String(url).split("/").pop(),version:release}):new Response("unavailable",{status:503})};
  const manager=new AgentRuntimeManager({state:{settings:()=>({...settings}),updateSettings:patch=>Object.assign(settings,patch)},env,platform:"win32",runFn:runOnly(runnable,calls),fetchImpl});
  return {root,folder,launcher,manager,calls,fetched,channels,runnable,settings,
    updates:async()=>(await readFile(join(folder,"updates.log"),"utf8").catch(()=>"")).split(/\r?\n/).filter(Boolean),
    updateRuns:()=>calls.filter(call=>call.env.MUSE_SYNC_UPDATE==="1")};
}
const museStatus=list=>list.statuses.find(item=>item.kind==="muse");

test("a newer release on the channel offers Update for the Muse Code Meta's launcher runs, which runs the launcher's own synchronous update and checks the version moved",WINDOWS_ONLY,async t=>{
  const fx=await museMachine(t);
  // The listings that answer a switch or a save read no channel: until Settings' own listing has, no newer release is known.
  assert.equal(museStatus(await fx.manager.snapshot()).update?.latest,null);
  assert.deepEqual(fx.fetched,[]);
  const listed=museStatus(await fx.manager.snapshot({refresh:true}));
  assert.deepEqual([listed.version,listed.available],["1.4.13-R6996.1",true]);
  assert.deepEqual(listed.update,{current:"1.4.13-R6996.1",latest:"1.4.14-R7010.1",newer:true,canUpdate:true,command:`${fx.launcher} --version (with ${UPDATE_SWITCHES})`,binary:realpathSync.native(fx.launcher),message:null});
  assert.deepEqual(fx.fetched,[STABLE]);
  const installed=await fx.manager.install("muse",{instanceId:"muse-default"});
  assert.deepEqual([installed.runtime,installed.method,installed.packageName,installed.targetVersion,installed.status.version],["muse","launcher",null,"1.4.14-R7010.1","1.4.14-R7010.1"]);
  // Meta's launcher itself ran, its update on, synchronous and due, and updated; every other run of it had its update off.
  assert.deepEqual(fx.updateRuns().map(call=>[call.command,call.args,call.env]),[[fx.launcher,["--version"],{MUSE_NO_AUTO_UPDATE:"0",MUSE_SYNC_UPDATE:"1",MUSE_UPDATE_INTERVAL_SECONDS:"0",MUSE_CHANNEL:undefined}]]);
  assert.ok(fx.calls.filter(call=>call.command===fx.launcher&&call.env.MUSE_SYNC_UPDATE!=="1").every(call=>call.env.MUSE_NO_AUTO_UPDATE==="1"));
  assert.deepEqual(await fx.updates(),["muse-stable interval=0"]);
  assert.deepEqual(fx.fetched,[STABLE,STABLE],"the update reads the channel again");
  // Now the newest: no newer release, and Update pressed from an older page runs nothing.
  const current=museStatus(await fx.manager.snapshot()).update;
  assert.deepEqual([current.current,current.latest,current.newer],["1.4.14-R7010.1","1.4.14-R7010.1",false]);
  assert.equal((await fx.manager.install("muse")).output,"Muse Code 1.4.14-R7010.1 is already the newest Muse Code release.");
  assert.equal(fx.updateRuns().length,1);assert.deepEqual(await fx.updates(),["muse-stable interval=0"]);
});

test("an update the launcher did not follow says what the Muse Code still reports, and one Muse Code update runs at a time",WINDOWS_ONLY,async t=>{
  // The channel names 1.4.14, but the launcher's own channel read has nothing newer for it (a CDN that lags, a release pulled).
  const fx=await museMachine(t,{releases:{}});
  const first=fx.manager.install("muse"),second=fx.manager.install("muse");
  await assert.rejects(()=>second,{code:"install-running",message:"Muse Code is already being installed or updated. Wait for it to finish first."});
  await assert.rejects(()=>first,{message:`\`muse.cmd --version\` finished, but the Muse Code this profile runs (${fx.launcher}) still reports 1.4.13-R6996.1.`});
  assert.deepEqual(await fx.updates(),["muse-stable interval=0"],"the launcher's update ran once");
  assert.equal(fx.manager.installs().ended.find(item=>item.runtime==="muse").ok,false);
});

test("on the canary channel the newest canary release is read, and the update keeps MUSE_CHANNEL",WINDOWS_ONLY,async t=>{
  const fx=await museMachine(t,{environment:{MUSE_CHANNEL:"muse-canary"},releases:{"muse-canary":"1.4.15-R7102.2"},channels:{[STABLE]:"1.4.14-R7010.1",[CANARY]:"1.4.15-R7102.2"}});
  const listed=museStatus(await fx.manager.snapshot({refresh:true})).update;
  assert.deepEqual([listed.latest,listed.newer,listed.command],["1.4.15-R7102.2",true,`${fx.launcher} --version (with MUSE_CHANNEL=muse-canary, ${UPDATE_SWITCHES})`]);
  assert.equal((await fx.manager.install("muse")).status.version,"1.4.15-R7102.2");
  assert.deepEqual(fx.updateRuns().map(call=>call.env.MUSE_CHANNEL),["muse-canary"]);
  assert.deepEqual(await fx.updates(),["muse-canary interval=0"]);
  assert.deepEqual(fx.fetched,[CANARY,CANARY]);
});

test("a Muse Code that Meta's launcher does not run gets no Update but the release and the file it runs, and its update is refused",WINDOWS_ONLY,async t=>{
  const fx=await museMachine(t);
  // The profile runs a wrapper of its own (not Meta's muse.cmd, and no launcher beside it).
  const wrapper=join(fx.root,"tools","muse","muse.cmd");await mkdir(dirname(wrapper),{recursive:true});
  await writeFile(wrapper,`@echo off\r\nsetlocal\r\n"${process.execPath}" "${FAKE_MUSE}" %*\r\nexit /b %ERRORLEVEL%\r\n`);
  fx.settings.agentRuntimeInstances[0].binaryPath=wrapper;fx.runnable.add(wrapper);
  const real=realpathSync.native(wrapper),update=museStatus(await fx.manager.snapshot({refresh:true})).update;
  assert.deepEqual(update,{current:"1.4.13-R6996.1",latest:"1.4.14-R7010.1",newer:true,canUpdate:false,command:null,binary:real,message:`Muse Code 1.4.14-R7010.1 is available. This profile runs ${real}, and Trebell Code cannot tell what installed it: update it the way you installed it.`});
  await assert.rejects(()=>fx.manager.install("muse"),{message:`Trebell Code updates Muse Code only through Meta's launcher, which Meta's installer puts in place, and ${real} is not it: update it the way you installed it. Nothing was installed.`});
  assert.deepEqual([fx.updateRuns(),await fx.updates()],[[],[]]);
});

test("a channel that cannot be read leaves no newer release known and installs nothing, and a channel Meta does not publish is not read",WINDOWS_ONLY,async t=>{
  const fx=await museMachine(t,{channels:{}});
  const listed=museStatus(await fx.manager.snapshot({refresh:true})).update;
  assert.deepEqual([listed.current,listed.latest,listed.newer],["1.4.13-R6996.1",null,false]);
  await assert.rejects(()=>fx.manager.install("muse"),{message:`Trebell Code could not read the newest Muse Code release from ${STABLE}. Nothing was installed.`});
  fx.settings.agentRuntimeInstances[0].environment={...fx.settings.agentRuntimeInstances[0].environment,MUSE_CHANNEL:"muse-nightly"};fx.fetched.length=0;
  await assert.rejects(()=>fx.manager.install("muse"),{message:"This Muse Code runs on the channel muse-nightly (MUSE_CHANNEL), which Meta does not publish: Meta's launcher runs only on muse-stable or muse-canary. Nothing was installed."});
  assert.deepEqual([fx.fetched,fx.updateRuns()],[[],[]]);
});

// Meta's launcher downloads the whole muse-bin (about 419 MB) before it answers, bounding each of its own requests: its update gets
// half an hour, not the 5 minutes of the other updaters. Stopped then, the launcher never removes its staging file, so the failure
// says the update ran out of time and where a partial download may be left, instead of only that Muse Code could not be updated.
test("Muse Code's update has half an hour, and one that runs out of time says so and where it may have left a partial download",WINDOWS_ONLY,async t=>{
  const fx=await museMachine(t),limits=[],run=fx.manager.runFn;
  fx.manager.runFn=async(command,args,options)=>{
    if(options?.env?.MUSE_SYNC_UPDATE!=="1")return run(command,args,options);
    limits.push(options.timeoutMs);
    return {ok:false,code:null,signal:null,error:"probe timed out",stdout:"",stderr:"\r  12% Complete (50.3 MB of 419.0 MB)   "};
  };
  await assert.rejects(()=>fx.manager.install("muse"),{message:`The update did not finish within 30 minutes, so Trebell Code stopped it. Meta's launcher may have left a partial download (a .muse-update file) in ${dirname(realpathSync.native(fx.launcher))}, which can be deleted.`});
  assert.deepEqual(limits,[1_800_000]);
});

test("Trebell does not install a Muse Code that is not there, nor update one in a WSL or SSH environment",WINDOWS_ONLY,async t=>{
  const fx=await museMachine(t);
  fx.settings.agentRuntimeInstances[0].binaryPath=join(fx.root,"nowhere","muse.cmd");
  await assert.rejects(()=>fx.manager.install("muse"),{message:"Muse Code is not installed, and Trebell Code only updates it: install it, then refresh."});
  // The host has no harness: each command there is not found.
  const hostRuns=[],environments={get:id=>id==="ssh-fixture"?{id,type:"ssh",cwd:"/srv/app"}:null,executeArgv:async(_id,{command})=>{hostRuns.push(command);return {exitCode:127,stdout:"",stderr:`sh: ${command}: not found`}},spawnArgv:()=>{throw new Error("nothing starts on the host")}};
  const remote=new AgentRuntimeManager({state:{settings:()=>({activeEnvironmentId:"ssh-fixture"})},environments,platform:"win32",env:{PATH:""},runFn:async command=>{throw new Error("ran "+command)},fetchImpl:async url=>{throw new Error("fetched "+url)}});
  await assert.rejects(()=>remote.install("muse"),{message:"Muse Code runs only on this machine in Trebell Code. Switch to the local environment to use it."});
  assert.equal(museStatus(await remote.snapshot()).update,undefined);
  assert.ok(!hostRuns.includes("muse"),"Muse Code is not looked for on the host");
  assert.deepEqual(fx.updateRuns(),[]);
});

test("on macOS and Linux the launcher script install.sh puts in ~/.local/bin is updated the same way, and a standalone binary is the person's",async t=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-muse-updates-unix-"));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250}));
  const launcher=join(root,"home",".local","bin","muse");await mkdir(dirname(launcher),{recursive:true});
  await writeFile(launcher,'#!/usr/bin/env bash\nuser_agent="muse-code/launcher-4"\nif [[ "${MUSE_SYNC_UPDATE:-0}" == 1 ]]; then update_binary; fi\nexec "$binary" "$@"\n');
  const standalone=join(root,"opt","muse-bin");await mkdir(dirname(standalone),{recursive:true});await writeFile(standalone,"\u007fELF");
  const calls=[],settings={agentRuntimeInstances:[{id:"muse-default",kind:"muse",enabled:true,binaryPath:null,environment:{MUSE_CHANNEL:"muse-canary"}}]};
  // Only the launcher's --version answers; the plan runs nothing else, and Meta's canary manifest names 1.4.15.
  const runFn=async(command,args,{env})=>{calls.push([command,...args,env.MUSE_NO_AUTO_UPDATE]);return [launcher,standalone].includes(command)&&args[0]==="--version"?{ok:true,code:0,error:null,stdout:"Muse Code 1.4.13 (1.4.13-R6996.1)\n",stderr:""}:missing(command)};
  const fetchImpl=async url=>String(url)===CANARY?Response.json({version:"1.4.15-R7102.2"}):new Response("",{status:404});
  const manager=new AgentRuntimeManager({state:{settings:()=>settings},env:{HOME:join(root,"home"),PATH:""},platform:"linux",runFn,fetchImpl});
  const plan=await manager.installPlan("muse");
  assert.deepEqual([plan.method,plan.installedVersion,plan.targetVersion,plan.command,plan.args,plan.pinned],["launcher","1.4.13-R6996.1","1.4.15-R7102.2",launcher,["--version"],false]);
  assert.deepEqual([plan.env.MUSE_CHANNEL,plan.env.MUSE_NO_AUTO_UPDATE,plan.env.MUSE_SYNC_UPDATE,plan.env.MUSE_UPDATE_INTERVAL_SECONDS,plan.env.HOME],["muse-canary","0","1","0",join(root,"home")]);
  assert.equal(plan.shown,`${launcher.includes(" ")?`'${launcher}'`:launcher} --version (with MUSE_CHANNEL=muse-canary, ${UPDATE_SWITCHES})`);
  assert.deepEqual(calls,[[launcher,"--version","1"]],"planning runs only the version check, the launcher's update off");
  settings.agentRuntimeInstances[0].binaryPath=standalone;
  await assert.rejects(()=>manager.installPlan("muse"),{message:`Trebell Code updates Muse Code only through Meta's launcher, which Meta's installer puts in place, and ${realpathSync(standalone)} is not it: update it the way you installed it. Nothing was installed.`});
});
