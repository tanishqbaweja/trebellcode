import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OFFLINE_E2E_CODE_HOST_CLIS, OFFLINE_E2E_HOST, offlineE2eClaudeCapabilities, offlineE2eDiscoveryRun, offlineE2eHarnessRun, offlineE2eSourceControlExecutor } from "../src/offline-e2e-host.mjs";
import { listPullRequests, sourceControlDiagnostics, withSourceControlExecutor } from "../src/source-control-service.mjs";
import { EnvironmentManager } from "../src/environment-manager.mjs";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";
import { TrebellStateStore } from "../src/trebell-state.mjs";
import { createGuiServer } from "../src/gui-server.mjs";

// A source-control executor that answers git as a GitHub checkout at /repo would, and notes every command it is asked to run.
function recordingExecutor(){
  const calls=[];
  const answer=(command,args)=>{
    calls.push([command,...args].join(" "));
    if(command!=="git")return {ok:true,code:0,stdout:command+" version 9.9.9\n",stderr:""};
    if(args[0]==="--version")return {ok:true,code:0,stdout:"git version 2.47.1\n",stderr:""};
    if(args[0]==="rev-parse"&&args[1]==="--show-toplevel")return {ok:true,code:0,stdout:"/repo\n",stderr:""};
    if(args[0]==="branch")return {ok:true,code:0,stdout:"main\n",stderr:""};
    if(args[0]==="remote")return {ok:true,code:0,stdout:"origin\thttps://github.com/owner/repo.git (fetch)\norigin\thttps://github.com/owner/repo.git (push)\n",stderr:""};
    return {ok:true,code:0,stdout:"",stderr:""};
  };
  return {calls,executor:{run:async(command,args)=>answer(command,args),runStdin:async(command,args)=>answer(command,args)}};
}
const codeHostCalls=calls=>calls.filter(call=>OFFLINE_E2E_CODE_HOST_CLIS.includes(call.split(" ")[0]));

test("offline E2E answers every code-host CLI as not installed, and still runs git",async()=>{
  const {calls,executor}=recordingExecutor();
  const diagnostics=await withSourceControlExecutor(offlineE2eSourceControlExecutor(executor),()=>sourceControlDiagnostics("/repo"));
  assert.equal(diagnostics.detectedProvider,"github");
  assert.equal(diagnostics.git.installed,true);
  assert.equal(diagnostics.git.version,"git version 2.47.1");
  for(const provider of ["github","gitlab","forgejo","azure-devops"]){
    assert.equal(diagnostics.providers[provider].installed,false,provider+" installed");
    assert.equal(diagnostics.providers[provider].authenticated,false,provider+" signed in");
  }
  assert.deepEqual(codeHostCalls(calls),[],"no code-host CLI reached the executor");
  assert.ok(calls.includes("git --version"));
  // gh pr list fails as a missing gh does, and says why.
  calls.length=0;
  const listed=await withSourceControlExecutor(offlineE2eSourceControlExecutor(executor),()=>listPullRequests("/repo"));
  assert.equal(listed.ok,false);
  assert.equal(listed.provider,"github");
  assert.match(listed.error,/^spawn gh ENOENT \(offline browser E2E answers gh as not installed\)$/);
  assert.deepEqual(codeHostCalls(calls),[]);
  // Without the offline executor the same reads ask the CLIs.
  calls.length=0;
  await withSourceControlExecutor(executor,()=>sourceControlDiagnostics("/repo"));
  assert.deepEqual([...new Set(codeHostCalls(calls).map(call=>call.split(" ")[0]))].sort(),[...OFFLINE_E2E_CODE_HOST_CLIS].sort());
});

test("the offline code-host answer covers each CLI however it is named, and nothing else",async()=>{
  const {calls,executor}=recordingExecutor(),offline=offlineE2eSourceControlExecutor(executor);
  for(const command of ["gh","GH.exe","C:\\tools\\glab.cmd","/usr/local/bin/tea","fj","az.bat"]){
    const result=await offline.run(command,["--version"]);
    assert.equal(result.ok,false,command);
    assert.match(result.stderr,/ENOENT \(offline browser E2E answers (gh|glab|tea|fj|az) as not installed\)$/,command);
    assert.equal((await offline.runStdin(command,["api","x"],"{}")).ok,false,command);
  }
  assert.deepEqual(calls,[]);
  for(const command of ["git","github-helper","ghx","azure"])assert.equal((await offline.run(command,["--version"])).ok,true,command);
  assert.deepEqual(calls,["git --version","github-helper --version","ghx --version","azure --version"]);
  assert.deepEqual(await offline.readFjKeys(),{hosts:{},aliases:{}});
});

const discoveryState={environments:()=>[]};
test("offline E2E host discovery answers as its fixed host, dropping Docker Desktop's distro as a real host does",async()=>{
  const asked=[],discoveryRun=async(command,args,options)=>{asked.push(command);return offlineE2eDiscoveryRun(command,args,options)};
  const windows=await new EnvironmentManager({state:discoveryState,platform:"win32",discoveryRun}).capabilities();
  assert.deepEqual(windows.ssh,{available:true,version:OFFLINE_E2E_HOST.ssh,error:null});
  assert.deepEqual(windows.wsl,{available:true,distros:["Ubuntu-24.04"],error:null});
  assert.deepEqual(asked,["ssh.exe","wsl.exe"]);
  const linux=await new EnvironmentManager({state:discoveryState,platform:"linux",discoveryRun:offlineE2eDiscoveryRun}).capabilities();
  assert.deepEqual(linux.ssh,{available:true,version:OFFLINE_E2E_HOST.ssh,error:null});
  assert.deepEqual(linux.wsl,{available:false,distros:[],error:null});
  assert.equal((await offlineE2eDiscoveryRun("docker",["ps"])).exitCode,1);
});

test("offline E2E harness checks find no harness CLI and start none",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-offline-e2e-harness-"));
  try{
    const env={TREBELL_HOME:home,HOME:home,USERPROFILE:home,PATH:""},asked=[];
    const runFn=async(command,args,options)=>{asked.push([command,...args].join(" "));return offlineE2eHarnessRun(command,args,options)};
    const manager=new AgentRuntimeManager({state:new TrebellStateStore(env),env,runFn,claudeCapabilitiesCache:offlineE2eClaudeCapabilities});
    const codex=await manager.probe("codex",{fresh:true});
    assert.equal(codex.installed,false);assert.equal(codex.available,false);
    assert.match(codex.message,/^Codex CLI was not found\./);
    for(const kind of ["claude","cursor","grok","opencode"]){
      const status=await manager.probe(kind,{fresh:true});
      assert.equal(status.installed,false,kind);assert.equal(status.available,false,kind);
      assert.match(status.message,/executable was not found\.$/,kind);
    }
    assert.ok(asked.length>=5);
    assert.ok(asked.every(call=>/ --version$/.test(call)),"only the version checks were asked, of the offline runner: "+asked.join(", "));
    // The Usage page's read of Claude Code's plan usage fails as it does without Claude Code, instead of starting it.
    const usage=await manager.usageLimits("claude");
    assert.deepEqual(usage.windows,[]);
    assert.equal(usage.unavailable.reason,"probeFailed");
    await assert.rejects(offlineE2eClaudeCapabilities.load({command:"claude"}),/^Error: spawn claude ENOENT \(offline browser E2E answers claude as not installed\)$/);
  }finally{await rm(home,{recursive:true,force:true})}
});

async function freePort(){
  const server=createServer();
  await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const port=server.address().port;
  await new Promise(resolve=>server.close(resolve));
  return port;
}
test("the offline E2E server answers the code hosts, host discovery and the harness checks from offline-e2e-host",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-offline-e2e-server-")),folder=await mkdtemp(join(tmpdir(),"trebell-offline-e2e-folder-"));
  const [port,appPort]=await Promise.all([freePort(),freePort()]),env={...process.env,TREBELL_HOME:home,TREBELL_E2E_OFFLINE:"1"};
  new TrebellStateStore(env).updateSettings({agentRuntime:"claude",agentRuntimeInstanceId:"claude-default"});
  const gui=await createGuiServer({port,appPort,mock:true,env});
  try{
    const read=async path=>{const response=await fetch(gui.url+path);assert.equal(response.ok,true,path);return response.json()};
    const diagnostics=await read("/api/source-control/diagnostics?path="+encodeURIComponent(folder));
    assert.equal(diagnostics.git.installed,true,"git still runs");
    for(const provider of ["github","gitlab","forgejo","azure-devops"])assert.equal(diagnostics.providers[provider].installed,false,provider);
    const environments=await read("/api/environments");
    assert.deepEqual(environments.capabilities.ssh,{available:true,version:OFFLINE_E2E_HOST.ssh,error:null});
    if(process.platform==="win32")assert.deepEqual(environments.capabilities.wsl.distros,["Ubuntu-24.04"]);
    const harnesses=await read("/api/agent-runtimes");
    const external=harnesses.statuses.filter(status=>status.kind!=="native");
    assert.ok(external.length>0);
    for(const status of external)assert.equal(status.installed,false,status.kind);
    // Claude Code is the active harness (saved before the server started: a harness that is not installed cannot be chosen), and
    // the Usage page's plan usage is unavailable instead of read from a Claude Code started here.
    const usage=await read("/api/agent-runtime-usage");
    assert.equal(usage.runtime,"claude");
    assert.equal(usage.unavailable?.reason,"probeFailed");
  }finally{
    await gui.close();
    await Promise.all([rm(home,{recursive:true,force:true,maxRetries:20,retryDelay:100}),rm(folder,{recursive:true,force:true})]);
  }
});

// The server also reads TREBELL_E2E_OFFLINE from its own process, so this runs only where that is not set.
test("a mock server that is not offline E2E still asks this host",{skip:process.env.TREBELL_E2E_OFFLINE==="1"&&"TREBELL_E2E_OFFLINE=1 is set for this process"},async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-online-mock-server-"));
  const [port,appPort]=await Promise.all([freePort(),freePort()]);
  const gui=await createGuiServer({port,appPort,mock:true,env:{...process.env,TREBELL_HOME:home,TREBELL_E2E_OFFLINE:""}});
  try{
    const environments=await (await fetch(gui.url+"/api/environments")).json();
    assert.notEqual(environments.capabilities.ssh.version,OFFLINE_E2E_HOST.ssh);
  }finally{
    await gui.close();
    await rm(home,{recursive:true,force:true,maxRetries:20,retryDelay:100});
  }
});
