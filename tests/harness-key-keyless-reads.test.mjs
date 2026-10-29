// A profile set to its API key while Trebell has no key of its vendor is answered after its version check: its status says the key is
// missing and no sign-in check, account read or model-list host of the harness starts for it, as each would run on the person's own
// login (`muse serve` listing the models of `muse login`, OpenCode's catalog server its stored logins, `claude auth status` the
// claude.ai login). Its Usage card reads no usage either: Claude Code's capability probe would show the person's own plan. With the
// key saved, each reads as before, on the key. Fakes only: the repo's stand-in Muse Code, stubbed CLI answers, fixture keys, fresh
// folders.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";
import { ProviderManager } from "../src/provider-manager.mjs";

const spawn=createRequire(import.meta.url)("cross-spawn");
const FAKE_MUSE=fileURLToPath(new URL("./fixtures/muse/fake-muse.cjs",import.meta.url)),MODEL_LIST=fileURLToPath(new URL("./fixtures/muse/model-list-1.4.13.json",import.meta.url));
const windows=process.platform==="win32";
const MISSING=name=>new RegExp(`^${name} is set to run on (?:the|an) .+, and Trebell Code has none\\.`);

async function freshRoot(t,prefix){const root=await mkdtemp(join(tmpdir(),prefix));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100}));return root}
function managerFor(root,profiles,{runFn,claudeCapabilitiesCache}={}){
  const env={PATH:"",HOME:join(root,"home"),USERPROFILE:join(root,"home"),TREBELL_HOME:join(root,"trebell"),CODEX_HOME:join(root,"codex")};
  const settings={agentRuntime:"native",agentRuntimeInstanceId:"native-default",agentRuntimeInstances:profiles};
  const state={settings:()=>settings,updateSettings:patch=>Object.assign(settings,patch)};
  const providers=new ProviderManager({env});
  return {env,providers,runtimes:new AgentRuntimeManager({state,env,providers,runFn,platform:"linux",...(claudeCapabilitiesCache?{claudeCapabilitiesCache}:{})})};
}

test("Muse Code on its API key with no Meta key says so without starting `muse serve` on the person's own login",async t=>{
  const root=await freshRoot(t,"trebell-keyless-muse-"),log=join(root,"muse.log");
  const folder=windows?join(root,"AppData","Local","Programs","muse"):join(root,"home",".local","bin");await mkdir(folder,{recursive:true});
  const launcher=join(folder,windows?"muse.cmd":"muse");
  await writeFile(launcher,windows?`@echo off\r\nsetlocal\r\n"${process.execPath}" "${FAKE_MUSE}" %*\r\nexit /b %ERRORLEVEL%\r\n`:`#!/bin/sh\nexec "${process.execPath}" "${FAKE_MUSE}" "$@"\n`);
  if(!windows)await chmod(launcher,0o755);
  await mkdir(join(root,"tmp"),{recursive:true});
  const system=windows?{SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,COMSPEC:process.env.COMSPEC,PATHEXT:process.env.PATHEXT,PATH:[dirname(process.execPath),join(process.env.SystemRoot||"C:\\Windows","System32")].join(";")}:{PATH:[dirname(process.execPath),"/usr/bin","/bin"].join(":")};
  const env={...system,TEMP:join(root,"tmp"),TMP:join(root,"tmp"),HOME:join(root,"home"),USERPROFILE:join(root,"home"),LOCALAPPDATA:join(root,"AppData","Local"),APPDATA:join(root,"AppData","Roaming"),TREBELL_HOME:join(root,"trebell"),CODEX_HOME:join(root,"codex"),MUSE_INSTALL_DIR:""};
  const profile={id:"muse-default",kind:"muse",displayName:"Muse Code",enabled:true,binaryPath:null,auth:"api-key",environment:{MUSE_FAKE_LOG:log,MUSE_FAKE_MODELS:MODEL_LIST}};
  const settings={agentRuntime:"muse",agentRuntimeInstanceId:"muse-default",agentRuntimeInstances:[profile]};
  const runFn=(command,args=[],{env:childEnv,cwd,timeoutMs=6000}={})=>new Promise(resolve=>{
    if(command!==launcher)return resolve({ok:false,code:null,error:`spawn ${command} ENOENT`,stdout:"",stderr:""});
    const child=spawn(command,args,{env:childEnv,cwd,windowsHide:true,stdio:["ignore","pipe","pipe"]});let stdout="",stderr="";
    child.stdout.on("data",chunk=>{stdout+=chunk});child.stderr.on("data",chunk=>{stderr+=chunk});
    const timer=setTimeout(()=>child.kill(),timeoutMs);
    child.once("error",error=>{clearTimeout(timer);resolve({ok:false,code:null,error:error.message,stdout,stderr})});
    child.once("close",code=>{clearTimeout(timer);resolve({ok:code===0,code,error:null,stdout,stderr})});
  });
  const providers=new ProviderManager({env});
  const runtimes=new AgentRuntimeManager({state:{settings:()=>settings,updateSettings:patch=>Object.assign(settings,patch)},env,providers,runFn,fetchImpl:async()=>new Response("unavailable",{status:503})});
  const starts=async()=>(await readFile(log,"utf8").catch(()=>"")).split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line)).filter(entry=>entry.start).map(entry=>({args:entry.start,key:entry.env?.META_API_KEY??null}));
  const status=await runtimes.probe(profile,{fresh:true});
  assert.deepEqual([status.available,status.installed,status.keyMissing],[false,true,true]);assert.match(status.message,MISSING("Muse Code"));
  assert.ok(status.version,"its version was read");
  assert.deepEqual((await starts()).filter(entry=>entry.args[0]==="serve"),[],"no `muse serve` started without the key the person chose");
  // Settings' own listing (its open and Refresh) reads the list again: still no host without the key.
  await runtimes.snapshot({refresh:true});
  assert.deepEqual((await starts()).filter(entry=>entry.args[0]==="serve"),[]);
  // With the key saved, Muse lists its models on it.
  providers.setKey("meta","meta-fixture-key");
  const ready=await runtimes.probe(profile,{fresh:true});
  assert.equal(ready.available,true,ready.message);
  assert.deepEqual((await starts()).filter(entry=>entry.args[0]==="serve").map(entry=>entry.key),["set"],"one host, on the key (the stand-in logs only that it is set)");
});

test("OpenCode on its API keys with none saved says so without starting its catalog server on its stored logins",async t=>{
  const root=await freshRoot(t,"trebell-keyless-opencode-"),opencode={id:"opencode-default",kind:"opencode",displayName:"OpenCode",enabled:true,environment:{},auth:"api-key",binaryPath:"/no/opencode/here"};
  const asked=[],{providers,runtimes}=managerFor(root,[opencode],{runFn:async(_command,args)=>{asked.push(args.join(" "));return args[0]==="--version"?{ok:true,code:0,error:null,stdout:"2.2.1\n",stderr:""}:{ok:false,code:null,error:"spawn ENOENT",stdout:"",stderr:""}}});
  const reads=[];
  runtimes.openCodeCatalogReader=async options=>{reads.push(options);return {models:["anthropic/model"],metadata:[{id:"anthropic/model",name:"Model",provider:"opencode",agent:"OpenCode"}],preferred:"anthropic/model",connectedProviders:["anthropic"],inventory:{commands:[],skills:[],agents:[{name:"build"}]},source:"live-connected"}};
  const status=await runtimes.probe(opencode,{fresh:true,refresh:true});
  assert.deepEqual([status.available,status.installed,status.keyMissing,status.version],[false,true,true,"2.2.1"]);assert.match(status.message,MISSING("OpenCode"));
  assert.equal(reads.length,0,"no catalog server started");assert.deepEqual(asked,["--version"]);
  assert.deepEqual((await runtimes.models(opencode)).models,[]);assert.equal(reads.length,0);
  providers.setKey("anthropic","sk-ant-fixture");
  assert.equal((await runtimes.probe(opencode,{fresh:true})).available,true);
  assert.equal(reads.length,1);assert.equal(reads[0].env.ANTHROPIC_API_KEY,"sk-ant-fixture");
});

test("Claude Code on its API key with no Anthropic key runs no sign-in check, and its Usage card reads none of the person's plan",async t=>{
  const root=await freshRoot(t,"trebell-keyless-claude-"),claude={id:"claude-default",kind:"claude",displayName:"Claude Code",enabled:true,environment:{},auth:"api-key",binaryPath:process.execPath};
  const asked=[],probes=[];
  const runFn=async(_command,args,options)=>{asked.push([args.join(" "),options?.env?.ANTHROPIC_API_KEY||null]);
    return args[0]==="--version"?{ok:true,code:0,error:null,stdout:"2.1.300 (Claude Code)\n",stderr:""}:{ok:true,code:0,error:null,stdout:JSON.stringify(options?.env?.ANTHROPIC_API_KEY?{loggedIn:true,authMethod:"api_key",apiKeySource:"ANTHROPIC_API_KEY"}:{loggedIn:true,authMethod:"claude.ai",subscriptionType:"max"}),stderr:""}};
  // Claude Code's capability probe, as the cache hands it on: on the person's own login it would report the claude.ai plan's usage.
  const claudeCapabilitiesCache={load:async input=>{probes.push(input.env?.ANTHROPIC_API_KEY||null);return {models:[],commands:[],agents:[],account:input.env?.ANTHROPIC_API_KEY?{apiKeySource:"ANTHROPIC_API_KEY"}:{tokenSource:"claude.ai",subscriptionType:"max"},usage:input.env?.ANTHROPIC_API_KEY?null:{rate_limits_available:true,rate_limits:{five_hour:{utilization:40,resets_at:"2026-10-29T12:00:00Z"}}},usageError:null}},peek:()=>null,drop:()=>{}};
  const {providers,runtimes}=managerFor(root,[claude],{runFn,claudeCapabilitiesCache});
  const status=await runtimes.probe(claude,{fresh:true});
  assert.deepEqual([status.available,status.keyMissing,status.version],[false,true,"2.1.300 (Claude Code)"]);assert.match(status.message,MISSING("Claude Code"));
  assert.deepEqual(asked,[["--version",null]],"no `claude auth status` on the person's own login");
  const usage=await runtimes.usageLimits(claude);
  assert.deepEqual(probes,[],"no capability probe ran");assert.deepEqual(usage.windows,[]);
  assert.equal(usage.unavailable?.reason,"unsupported");assert.match(usage.unavailable?.message||"",MISSING("Claude Code"));
  // With the key saved, both read on the key.
  providers.setKey("anthropic","sk-ant-fixture");
  assert.equal((await runtimes.probe(claude,{fresh:true})).available,true);
  assert.deepEqual(asked.at(-1),["auth status","sk-ant-fixture"]);
  await runtimes.usageLimits(claude);
  assert.deepEqual(probes,["sk-ant-fixture"]);
});
