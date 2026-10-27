// A harness's status check (AgentRuntimeManager probe) as Settings, a harness switch and a chat start read it:
// - each CLI's --version gets T3's budget (Claude Code and Codex 20 s, OpenCode 10 s, the others 6 s), and on this machine one
//   that runs out of time or exits with an error reads installed and may start, never "not installed"; only a command that is not
//   there does;
// - Grok's checks run with its updater off, and its sessions keep their environment;
// - a logged-out `grok models` is read once more, as Grok refreshes an expired token in the same process;
// - a Claude Code profile with a custom API endpoint is not called signed out.
// Stubbed process runners (the manager's runFn, a remote environment's executeArgv) and scripts of the test's own standing in for
// Grok and for Codex's app-server: no real harness is started or signed in.
import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";
import { AgentThreadStore } from "../src/agent-thread-store.mjs";
import { attachAgentRelay } from "../src/agent-relay.mjs";

// What the manager's run() gives: an answer, a check it stopped at its timeout, and a command that exited with an error.
const answered=stdout=>({ok:true,code:0,error:null,stdout,stderr:""});
const TIMED_OUT=Object.freeze({ok:false,code:null,error:"probe timed out",stdout:"",stderr:""});
const exited=(code,stderr)=>({ok:false,code,error:null,stdout:"",stderr});
// A command that answers after ms: its answer within the timeout the manager gave it, and the timeout's answer past it.
const after=(ms,answer,timeoutMs)=>ms<=timeoutMs?answer:TIMED_OUT;

async function tempHome(t,name){
  const home=await mkdtemp(join(tmpdir(),`trebell-status-${name}-`));
  t.after(()=>rm(home,{recursive:true,force:true,maxRetries:20,retryDelay:250}));
  return home;
}
// The settings the runtime manager and the relay read (and a harness switch writes), and the thread metadata the relay keeps.
function memoryState(settings){
  const meta=new Map();
  return {settings:()=>({...settings}),updateSettings:patch=>{Object.assign(settings,patch);return {...settings}},threadMeta:id=>meta.get(id)||{},updateThreadMeta:(id,patch)=>{const next={...(meta.get(id)||{}),...patch};meta.set(id,next);return next},removeThreadMeta:id=>meta.delete(id)};
}
// A profile on this machine whose CLI answers through answer(args, options) (the manager's run() stubbed), its binary a file of the
// test's own, as a real binary's version check is kept until it changes. calls: each launch with its timeout and environment.
async function localHarness(t,kind,answer,{env={},instance={}}={}){
  const home=await tempHome(t,kind),binary=join(home,{cursor:"cursor-agent",antigravity:"agy"}[kind]||kind),calls=[];
  await writeFile(binary,kind+" build 1");
  const state=memoryState({agentRuntime:kind,agentRuntimeInstances:[{id:kind+"-default",kind,binaryPath:binary,environment:{},...instance}]});
  const runFn=async(_command,args,options)=>{calls.push({args:args.join(" "),timeoutMs:options.timeoutMs,env:options.env});return answer(args,options)};
  const manager=new AgentRuntimeManager({state,platform:"linux",env:{PATH:"/usr/bin",HOME:home,TREBELL_HOME:join(home,"trebell"),...env},runFn});
  return {manager,calls,home,state,instance:manager.instances().find(item=>item.id===kind+"-default")};
}
// A profile on an SSH host whose commands answer through executeArgv(command, args, timeoutMs); spawnArgv starts its long-lived
// processes (Codex's app-server).
function remoteHarness(executeArgv,spawnArgv=()=>{throw new Error("nothing is started on the host")}){
  const profile={id:"ssh-status",type:"ssh",cwd:"/srv/app"},asked=[];
  const environments={
    get:id=>id===profile.id?profile:null,
    executeArgv:async(_id,{command,args,timeoutMs})=>{asked.push({line:[command,...args].join(" "),timeoutMs});return executeArgv(command,args,timeoutMs)},
    spawnArgv:(_id,options)=>spawnArgv(options),
  };
  const manager=new AgentRuntimeManager({state:{settings:()=>({activeEnvironmentId:profile.id})},environments,platform:"linux",env:{PATH:"/usr/bin",HOME:"/home/test"}});
  return {manager,asked,profile};
}

test("Claude Code gets 20 s to answer --version: one that answers after 19 s reads ready",async t=>{
  const fx=await localHarness(t,"claude",(args,{timeoutMs})=>args[0]==="--version"
    ?after(19_000,answered("2.1.310 (Claude Code)\n"),timeoutMs)
    :answered(JSON.stringify({loggedIn:true,authMethod:"claude.ai",apiProvider:"firstParty"})));
  const status=await fx.manager.probe("claude");
  assert.deepEqual([status.installed,status.available,status.authenticated,status.version],[true,true,true,"2.1.310 (Claude Code)"],status.message);
  assert.deepEqual(fx.calls.map(call=>[call.args,call.timeoutMs]),[["--version",20_000],["auth status",8000]]);
});

// What each harness's check waits for, and the name its message gives the command.
const BUDGETS=[["claude","Claude Code","claude",20],["cursor","Cursor","cursor-agent",6],["grok","Grok Build","grok",6],["opencode","OpenCode","opencode",10],["antigravity","Antigravity","agy",6]];
for(const [kind,name,command,seconds] of BUDGETS){
  test(`${name} reads installed and may start when its --version never answers, says how long it waited, and is asked again next time`,async t=>{
    const fx=await localHarness(t,kind,args=>args[0]==="--version"?TIMED_OUT:answered("unexpected"));
    const status=await fx.manager.probe(kind);
    assert.deepEqual([status.installed,status.available,status.authenticated,status.version],[true,true,null,null]);
    assert.equal(status.message,`${name} is installed but did not answer \`${command} --version\` within ${seconds} seconds.`);
    assert.deepEqual(fx.calls.map(call=>[call.args,call.timeoutMs]),[["--version",seconds*1000]],"its sign-in is not read");
    // Settings' next poll, a harness switch and a chat start do not reuse it, and a version check that answers is kept as before.
    await fx.manager.probe(kind);
    assert.equal(fx.calls.length,2,"the answer was not kept");
    await fx.manager.setActive({runtime:kind});
    assert.equal(fx.calls.length,3,"a switch to it is not refused");
  });
}

test("a harness whose --version exits with an error reads installed and may start, with what it said",async t=>{
  const fx=await localHarness(t,"cursor",()=>exited(1,"\u001b[31mError: Cannot find module 'index.js'\u001b[0m\n    at Module._resolveFilename (node:internal/modules/cjs/loader:1207:15)\n"));
  const status=await fx.manager.probe("cursor");
  assert.deepEqual([status.installed,status.available,status.authenticated],[true,true,null]);
  assert.equal(status.message,"Cursor is installed but `cursor-agent --version` exited with code 1: Error: Cannot find module 'index.js'");
  assert.deepEqual(fx.calls.map(call=>call.args),["--version"]);
  await fx.manager.probe("cursor");
  assert.equal(fx.calls.length,2,"the answer was not kept");
});

test("only a command that is not there reads not installed; one that cannot start is installed but not ready",async t=>{
  for(const [kind,result,message] of [
    ["claude",{ok:false,code:null,error:"spawn C:\\tools\\claude.exe ENOENT",stdout:"",stderr:""},"Claude Code executable was not found."],
    ["opencode",exited(1,"'opencode' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n"),"OpenCode executable was not found."],
  ]){
    const status=await (await localHarness(t,kind,()=>result)).manager.probe(kind);
    assert.deepEqual([status.installed,status.available,status.message],[false,false,message],kind);
  }
  // A launcher Node cannot start is there, but cannot run until it is reinstalled or updated.
  const launcher=await (await localHarness(t,"claude",()=>({ok:false,code:null,error:"spawn EINVAL",stdout:"",stderr:""}))).manager.probe("claude");
  assert.deepEqual([launcher.installed,launcher.available,launcher.message],[true,false,"Claude Code launcher could not start on this system. Reinstall or update the CLI, then refresh."]);
});

test("a --version a signal stopped reads installed and may start, and what a CLI that ran printed never makes it not installed",async t=>{
  const cases=[
    // A crash, or the OOM killer, ends the check with a signal and no exit code.
    ["claude",{ok:false,code:null,signal:"SIGKILL",error:null,stdout:"",stderr:""},[true,true,true,"Claude Code is installed but `claude --version` was stopped by SIGKILL."]],
    // A CLI that ran and exited with an ENOENT of its own (a file it could not open) or a "command not found" of a command it ran.
    ["claude",exited(1,"Error: ENOENT: no such file or directory, open '/home/me/.claude/settings.json'\n    at Object.openSync (node:fs:573:18)\n"),[true,true,true,"Claude Code is installed but `claude --version` exited with code 1: Error: ENOENT: no such file or directory, open '/home/me/.claude/settings.json'"]],
    ["cursor",exited(1,"sh: 1: git: command not found\nError: could not read the repository\n"),[true,true,true,"Cursor is installed but `cursor-agent --version` exited with code 1: sh: 1: git: command not found"]],
    // The command itself not being there: a shell's 127 (the spawn's ENOENT and cmd.exe's line are in the test above).
    ["claude",exited(127,"/bin/sh: 1: claude: command not found\n"),[false,false,undefined,"Claude Code executable was not found."]],
  ];
  const read=[];
  for(const [kind,result] of cases){const status=await (await localHarness(t,kind,()=>result)).manager.probe(kind);read.push([status.installed,status.available,status.versionCheckFailed,status.message])}
  assert.deepEqual(read,cases.map(([,,expected])=>expected));
});

test("on a host a failed version check reads unavailable as before, with the budgets of this machine",async()=>{
  // ssh's own failures (a host it cannot reach) end a check as a slow or failing CLI does, and are no answer of the harness's.
  let answer={exitCode:null,timedOut:true,stdout:"",stderr:""};
  const fx=remoteHarness(()=>answer);
  const slow=await fx.manager.probe("claude");
  assert.deepEqual([slow.installed,slow.available,slow.message],[false,false,"probe timed out"]);
  answer={exitCode:255,stdout:"",stderr:"ssh: connect to host build-box port 22: Connection timed out\n"};
  const unreachable=await fx.manager.probe("cursor");
  assert.deepEqual([unreachable.installed,unreachable.available,unreachable.message],[false,false,"ssh: connect to host build-box port 22: Connection timed out"]);
  answer={exitCode:127,stdout:"",stderr:"env: 'codex': No such file or directory\n"};
  const codex=await fx.manager.probe("codex");
  assert.deepEqual([codex.installed,codex.available],[false,false]);assert.match(codex.message,/^Codex CLI was not found\./);
  assert.deepEqual(fx.asked.map(item=>[item.line,item.timeoutMs]),[["claude --version",20_000],["cursor-agent --version",6000],["codex --version",20_000]]);
});

// A `codex app-server` as a signed-in Codex runs one, standing in for Codex here: a node script behind a launcher of the test's own,
// which answers initialize (its version in its user agent) and account/read, and ends with its input.
async function codexAppServerLauncher(home){
  const windows=process.platform==="win32",fixture=join(home,"codex-app-server.mjs"),launcher=join(home,windows?"codex.cmd":"codex");
  await writeFile(fixture,String.raw`
import readline from "node:readline";
readline.createInterface({input:process.stdin}).on("line",line=>{const m=JSON.parse(line);if(m.id===undefined)return;
  const result=m.method==="initialize"?{userAgent:"codex_cli_rs/0.162.0 (fixture)"}:m.method==="account/read"?{account:{type:"chatgpt",planType:"plus"},requiresOpenaiAuth:true}:{};
  process.stdout.write(JSON.stringify({id:m.id,result})+"\n");
});
`,"utf8");
  await writeFile(launcher,windows?["@echo off",`"${process.execPath}" "${fixture}" %*`,""].join("\r\n"):`#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`,"utf8");
  if(!windows)await chmod(launcher,0o755);
  return launcher;
}
test("Codex gets 20 s to answer --version, and one that runs out of time leaves the answer to its account read",async t=>{
  const home=await tempHome(t,"codex"),binaryPath=await codexAppServerLauncher(home),calls=[];
  let version=()=>TIMED_OUT;
  const runFn=async(_command,args,{timeoutMs})=>{calls.push([args.join(" "),timeoutMs]);return version()};
  const env={PATH:process.env.PATH,PATHEXT:process.env.PATHEXT,SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,COMSPEC:process.env.COMSPEC,TEMP:home,TMP:home,HOME:home,USERPROFILE:home,CODEX_HOME:join(home,"codex-home"),TREBELL_HOME:join(home,"trebell")};
  const manager=new AgentRuntimeManager({state:memoryState({agentRuntimeInstances:[{id:"codex-default",kind:"codex",binaryPath}]}),env,runFn});
  const status=await manager.probe("codex");
  assert.deepEqual([status.installed,status.available,status.authenticated,status.version,status.message],[true,true,true,"0.162.0","Signed in with ChatGPT Plus"]);
  assert.deepEqual(calls,[["--version",20_000]]);
  await manager.probe("codex");
  assert.equal(calls.length,2,"the answer was not kept: the next poll asks for the version again");
  // A Codex whose --version exits with an error is there, but not ready; one that is not there is not installed.
  version=()=>exited(1,"error: unexpected argument found\n");
  const failed=await manager.probe("codex",{fresh:true});
  assert.deepEqual([failed.installed,failed.available,failed.message],[true,false,"error: unexpected argument found"]);
  version=()=>({ok:false,code:null,error:"spawn codex ENOENT",stdout:"",stderr:""});
  const missing=await manager.probe("codex",{fresh:true});
  assert.deepEqual([missing.installed,missing.available],[false,false]);
  assert.match(missing.message,/^Codex CLI was not found\./);
});

test("OpenCode gets 10 s to answer --version, in its status check and in its install plan",async()=>{
  // An OpenCode behind a slow wrapper: its --version answers after 8 s.
  const fx=remoteHarness((command,args,timeoutMs)=>{
    if(command==="opencode"&&args[0]==="--version")return 8000<=timeoutMs?{exitCode:0,stdout:"1.14.25\n",stderr:""}:{exitCode:null,timedOut:true,stdout:"",stderr:""};
    if(command==="opencode"&&args[0]==="auth")return {exitCode:0,stdout:"2 credentials\n0 environment variables\n",stderr:""};
    if(command==="npm"&&args[0]==="--version")return {exitCode:0,stdout:"11.0.0\n",stderr:""};
    if(command==="npm"&&args[0]==="view")return {exitCode:0,stdout:"\"1.14.30\"\n",stderr:""};
    return {exitCode:1,stdout:"",stderr:"unexpected command"};
  });
  const status=await fx.manager.probe("opencode");
  assert.deepEqual([status.installed,status.available,status.version],[true,true,"1.14.25"],status.message);
  const plan=await fx.manager.openCodeInstallPlan({environmentId:fx.profile.id});
  assert.deepEqual([plan.installedVersion,plan.targetVersion],["1.14.25","1.14.30"]);
  assert.deepEqual(fx.asked.filter(item=>item.line==="opencode --version").map(item=>item.timeoutMs),[10_000,10_000]);
});

test("Grok's version and sign-in checks run with its updater off, and its sessions keep their environment",async t=>{
  const fx=await localHarness(t,"grok",args=>answered(args[0]==="models"?"You are logged in with grok.com.\n":"grok 1.0.41\n"));
  const status=await fx.manager.probe("grok");
  assert.equal(status.authenticated,true);
  assert.deepEqual(fx.calls.map(call=>[call.args,call.env.GROK_DISABLE_AUTOUPDATER]),[["--version","1"],["models","1"]]);
  assert.equal(fx.manager.childEnv(fx.instance).GROK_DISABLE_AUTOUPDATER,undefined,"what sessions, Git text and the sign-in terminal run with");
  assert.equal(fx.calls[0].env.HOME,fx.manager.childEnv(fx.instance).HOME,"the rest of the environment is the profile's");
  // Another harness's checks get nothing of Grok's.
  const claude=await localHarness(t,"claude",args=>answered(args[0]==="auth"?JSON.stringify({loggedIn:true}):"2.1.310 (Claude Code)\n"));
  await claude.manager.probe("claude");
  assert.deepEqual(claude.calls.map(call=>"GROK_DISABLE_AUTOUPDATER" in call.env),[false,false]);
});

test("Grok's model listing runs with its updater off too",async t=>{
  const home=await tempHome(t,"grok-acp"),fixture=join(home,"grok.mjs"),log=join(home,"launches.jsonl"),windows=process.platform==="win32";
  // Grok as far as its checks and its listing go: each launch logs its arguments and the updater switch it was given.
  await writeFile(fixture,String.raw`
import { appendFileSync } from "node:fs";
import readline from "node:readline";
const args=process.argv.slice(2),send=message=>process.stdout.write(JSON.stringify(message)+"\n");
appendFileSync(process.env.TREBELL_STATUS_LOG,JSON.stringify({args,updater:process.env.GROK_DISABLE_AUTOUPDATER??null})+"\n");
if(args[0]==="--version")process.stdout.write("grok 1.0.41-fixture\n");
else if(args[0]==="models")process.stdout.write("You are logged in with grok.com.\n");
else readline.createInterface({input:process.stdin}).on("line",line=>{const m=JSON.parse(line);
  if(m.method==="initialize")send({jsonrpc:"2.0",id:m.id,result:{protocolVersion:1,agentCapabilities:{},_meta:{modelState:{currentModelId:"grok-4.7",availableModels:[{modelId:"grok-4.7",name:"Grok 4.7"}]}}}});
  else if(m.id!=null)send({jsonrpc:"2.0",id:m.id,result:{}});
});
`,"utf8");
  const launcher=join(home,windows?"grok.cmd":"grok");
  await writeFile(launcher,windows?["@echo off",`"${process.execPath}" "${fixture}" %*`,""].join("\r\n"):`#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`,"utf8");
  if(!windows)await chmod(launcher,0o755);
  const env={PATH:process.env.PATH,PATHEXT:process.env.PATHEXT,SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,COMSPEC:process.env.COMSPEC,TEMP:home,TMP:home,HOME:home,USERPROFILE:home,TREBELL_HOME:join(home,"trebell")};
  const settings={agentRuntimeInstances:[{id:"grok-default",kind:"grok",binaryPath:launcher,environment:{TREBELL_STATUS_LOG:log}}]};
  const manager=new AgentRuntimeManager({state:{settings:()=>settings},env});
  const listed=await manager.models("grok");
  assert.equal(listed.error,undefined);assert.deepEqual(listed.models,["grok-4.7"]);
  const launches=(await readFile(log,"utf8")).trim().split("\n").map(line=>JSON.parse(line));
  assert.deepEqual(launches.map(item=>[item.args[0]==="--version"||item.args[0]==="models"?item.args[0]:"agent stdio",item.updater]),[["--version","1"],["models","1"],["agent stdio","1"]]);
});

test("a logged-out `grok models` is read once more, and the second answer decides unless it says nothing",async t=>{
  for(const [answers,expected,calls] of [
    // An access token that has just expired: Grok prints the logged-out line, then refreshes it.
    [["Not authenticated. Run grok login.\n","You are logged in with grok.com.\n"],[true,true,"Ready"],2],
    [["Not logged in\n","Not logged in\n"],[false,false,"Grok CLI is installed but not logged in. Run grok login."],2],
    // A second read that times out keeps the first answer.
    [["Not logged in\n",null],[false,false,"Grok CLI is installed but not logged in. Run grok login."],2],
    [["You are logged in with grok.com.\n"],[true,true,"Ready"],1],
  ]){
    const left=[...answers];
    const fx=await localHarness(t,"grok",args=>{if(args[0]!=="models")return answered("grok 1.0.41\n");const next=left.shift();return next==null?TIMED_OUT:answered(next)});
    const status=await fx.manager.probe("grok");
    assert.deepEqual([status.available,status.authenticated,status.message],expected,answers.join(" then "));
    assert.equal(fx.calls.filter(call=>call.args==="models").length,calls,answers.join(" then "));
  }
  // With an xAI API key Grok's own sign-in is not asked.
  const keyed=await localHarness(t,"grok",args=>args[0]==="models"?answered("Not logged in\n"):answered("grok 1.0.41\n"),{env:{XAI_API_KEY:"xai-test-not-a-key"}});
  const status=await keyed.manager.probe("grok");
  assert.deepEqual([status.available,status.authenticated],[true,true]);
  assert.deepEqual(keyed.calls.map(call=>call.args),["--version"]);
});

test("a Claude Code profile with a custom API endpoint is not called signed out; one on Anthropic's own API is",async t=>{
  const signedOut=args=>args[0]==="auth"?{...exited(1,""),stdout:JSON.stringify({loggedIn:false,authMethod:"none",apiProvider:"firstParty"})}:answered("2.1.310 (Claude Code)\n");
  const CUSTOM="Claude Code is configured for a custom API endpoint; authentication will be verified when a session starts.";
  const ADVICE="Claude Code is not authenticated. Run `claude auth login` and try again.";
  for(const [where,options,expected] of [
    ["ANTHROPIC_BASE_URL from Trebell's own environment",{env:{ANTHROPIC_BASE_URL:"https://proxy.example"}},[true,null,CUSTOM]],
    ["the profile's own ANTHROPIC_BASE_URL",{instance:{environment:{ANTHROPIC_BASE_URL:"http://localhost:4000/v1"}}},[true,null,CUSTOM]],
    ["Anthropic's own API",{env:{ANTHROPIC_BASE_URL:"https://api.anthropic.com"}},[false,false,ADVICE]],
    ["a value that is no http(s) URL",{env:{ANTHROPIC_BASE_URL:"proxy.example"}},[false,false,ADVICE]],
    ["no endpoint",{},[false,false,ADVICE]],
  ]){
    const fx=await localHarness(t,"claude",signedOut,options);
    const status=await fx.manager.probe("claude");
    assert.deepEqual([status.available,status.authenticated,status.message],expected,where);
    if(expected[1]===null)assert.deepEqual([status.account.type,status.account.label,status.account.loggedIn],["customEndpoint","Custom API endpoint",false],where);
  }
  // A profile on a host runs with the host's own variables, which this machine's ANTHROPIC_BASE_URL says nothing of.
  const remote=remoteHarness((command,args)=>args[0]==="auth"?{exitCode:1,stdout:JSON.stringify({loggedIn:false,authMethod:"none"}),stderr:""}:{exitCode:0,stdout:"2.1.310 (Claude Code)\n",stderr:""});
  remote.manager.env.ANTHROPIC_BASE_URL="https://proxy.example";
  const host=await remote.manager.probe("claude");
  assert.deepEqual([host.available,host.authenticated],[false,false]);
});

// The relay over its socket, as a window speaks to it: rpc requests, and a send settled as turn/completed reports it.
async function startRelay(t,options){
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()}),relay=attachAgentRelay(server,{version:"test",...options});
  await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const ws=new WebSocket("ws://127.0.0.1:"+server.address().port+"/api/agent/ws");await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});
  let id=0;const seen=[],waiters=[];
  ws.on("message",raw=>{const message=JSON.parse(String(raw));if(!message.method)return;seen.push(message);for(const waiter of [...waiters])if(waiter.match(message)){waiters.splice(waiters.indexOf(waiter),1);waiter.resolve(message)}});
  const rpc=(method,params={})=>new Promise((resolve,reject)=>{
    const requestId=++id,onMessage=raw=>{const message=JSON.parse(String(raw));if(message.id!==requestId)return;ws.off("message",onMessage);message.error?reject(new Error(message.error.message)):resolve(message.result)};
    ws.on("message",onMessage);ws.send(JSON.stringify({id:requestId,method,params}));
  });
  const next=match=>{const found=seen.find(match);if(found)return Promise.resolve(found);return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("timed out waiting for a relay notification")),20_000);waiters.push({match,resolve:value=>{clearTimeout(timer);resolve(value)}})})};
  const turn=async(threadId,text="Hello")=>{
    const started=await rpc("turn/start",{threadId,input:[{type:"text",text}]}),turnId=started.turn.id;
    return (await next(message=>message.method==="turn/completed"&&message.params.turn?.id===turnId)).params.turn;
  };
  t.after(async()=>{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()))});
  return {rpc,turn};
}
// The SDK's Query as the Claude session drives it: each user message is answered with one reply.
function fakeClaudeSdk(){
  const query=({prompt,options})=>{
    const items=[],waiters=[];let done=false;
    const push=value=>{const waiter=waiters.shift();if(waiter)waiter({value,done:false});else items.push(value)};
    const end=()=>{done=true;for(const waiter of waiters.splice(0))waiter({value:undefined,done:true})};
    void (async()=>{
      let index=0;
      for await(const message of prompt){
        if(index===0)push({type:"system",subtype:"init",session_id:options.sessionId||options.resume,model:"claude-test",permissionMode:options.permissionMode,tools:[],mcp_servers:[],slash_commands:[],agents:[],capabilities:[]});
        const id="msg-"+index++;
        push({type:"assistant",uuid:"assistant-"+id,parent_tool_use_id:null,message:{id,content:[{type:"text",text:"PELICAN"}]}});
        push({type:"result",subtype:"success",is_error:false,result:"PELICAN",user_message_uuid:message.uuid,total_cost_usd:0,usage:{input_tokens:3,output_tokens:1}});
      }
      end();
    })();
    const next=()=>items.length?Promise.resolve({value:items.shift(),done:false}):done?Promise.resolve({value:undefined,done:true}):new Promise(resolve=>waiters.push(resolve));
    return {next,return:()=>{end();return Promise.resolve({value:undefined,done:true})},[Symbol.asyncIterator](){return this},async interrupt(){},close(){end()},async setPermissionMode(){},initializationResult:async()=>({commands:[],agents:[],models:[]})};
  };
  return {query,getSessionInfo:async id=>({sessionId:id}),forkSession:async()=>({}),renameSession:async()=>{},getSessionMessages:async()=>[],deleteSession:async()=>{}};
}
test("a chat starts on a Claude Code whose --version did not answer in time, and its sign-in is read once it answers",async t=>{
  let slow=true;
  const fx=await localHarness(t,"claude",args=>args[0]==="--version"?(slow?TIMED_OUT:answered("2.1.310 (Claude Code)\n")):answered(JSON.stringify({loggedIn:true,authMethod:"claude.ai"})));
  const threadStore=new AgentThreadStore({...process.env,TREBELL_HOME:join(fx.home,"trebell-home")});
  const relay=await startRelay(t,{runtimeManager:fx.manager,threadStore,state:fx.state,claudeSdk:fakeClaudeSdk()});
  const {thread}=await relay.rpc("thread/start",{cwd:fx.home});
  const turn=await relay.turn(thread.id);
  assert.equal(turn.status,"completed",JSON.stringify(turn.error||null));
  // Once the CLI answers again, the next check reads its version and its sign-in, and keeps that answer.
  slow=false;
  const status=await fx.manager.probe("claude");
  assert.deepEqual([status.available,status.authenticated,status.version],[true,true,"2.1.310 (Claude Code)"]);
  const asked=fx.calls.length;await fx.manager.probe("claude");
  assert.equal(fx.calls.length,asked,"a ready answer is kept as before");
});
