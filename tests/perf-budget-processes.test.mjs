import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";

// Process budgets for the child processes Trebell starts while it sits idle (goal.md section 6; perf plan budgets B6-B8). Each one
// counts launches through an injected runner, so the numbers do not depend on how busy the machine is.

// A `codex app-server` that answers initialize and account/read as a signed-out Codex does, over the same stdio JSON lines.
function fakeCodexAppServer(){
  const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
  let buffer="";
  child.stdin.on("data",chunk=>{
    buffer+=String(chunk);let index;
    while((index=buffer.indexOf("\n"))>=0){
      const message=JSON.parse(buffer.slice(0,index));buffer=buffer.slice(index+1);
      if(message.id===undefined)continue;
      const result=message.method==="initialize"?{userAgent:"codex_cli_rs/0.200.0"}:{account:null,requiresOpenaiAuth:true};
      child.stdout.write(JSON.stringify({id:message.id,result})+"\n");
    }
  });
  child.kill=()=>{setImmediate(()=>child.emit("exit",0))};
  return child;
}
// Every harness CLI launch a probe makes, by runtime, through a remote environment (the runner the manager already takes).
function countingEnvironment(){
  const launches={},count=command=>{launches[command]=(launches[command]||0)+1};
  const profile={id:"ssh-budget",type:"ssh",cwd:"/srv/app"};
  const answers={
    cursor:args=>args[0]==="about"?JSON.stringify({userEmail:"dev@example.test"}):"2026.09.26-dd393fe\n",
    grok:args=>args[0]==="models"?"You are logged in\n- grok-4.6\n":"grok 1.2.0\n",
    opencode:args=>args[0]==="auth"?"— 2 credentials\n":"1.18.31\n",
    claude:args=>args[0]==="auth"?JSON.stringify({loggedIn:true}):"2.1.0 (Claude Code)\n",
    codex:()=>"codex-cli 0.200.0\n",
  };
  const runtime=command=>command==="cursor-agent"?"cursor":command;
  return {launches,profile,environments:{
    get:id=>id===profile.id?profile:null,
    executeArgv:async(_id,{command,args})=>{count(runtime(command));return {exitCode:0,stdout:answers[runtime(command)]?.(args)??"",stderr:""}},
    spawnArgv:(_id,{command})=>{count(runtime(command));return fakeCodexAppServer()},
  }};
}

test("B7: twelve Settings polls in a minute launch each harness CLI at most 3 times",async()=>{
  const {launches,profile,environments}=countingEnvironment();
  let clock=1_000_000;
  const manager=new AgentRuntimeManager({state:{settings:()=>({activeEnvironmentId:profile.id})},environments,platform:"linux",env:{PATH:"/usr/bin",HOME:"/home/test"},now:()=>clock});
  for(const kind of ["codex","claude","cursor","grok","opencode"]){
    // /api/runtime probes the active harness on every 5-s poll; a thread start's probe in the same minute is one more of these.
    for(let poll=0;poll<12;poll++){const status=await manager.probe(kind);assert.equal(status.installed,true,kind);clock+=5000}
  }
  // Before the probe cache every poll probed again: 24 launches in 12 polls for each.
  for(const kind of ["codex","claude","cursor","grok","opencode"])assert.ok((launches[kind]||0)<=3,kind+" launched "+launches[kind]+" times in 12 polls");
  // The answer is reused for a minute whatever it says (Codex here is signed out), then the harness is asked again.
  const before={...launches};clock+=61_000;
  assert.equal((await manager.probe("codex")).authenticated,false);
  assert.equal(launches.codex,before.codex+2,"after a minute the version check and the account read run again");
});

test("B7: Settings' own check asks again at once, and probes that overlap share one launch",async()=>{
  const {launches,profile,environments}=countingEnvironment();
  const manager=new AgentRuntimeManager({state:{settings:()=>({activeEnvironmentId:profile.id})},environments,platform:"linux",env:{PATH:"/usr/bin",HOME:"/home/test"}});
  const [first,second]=await Promise.all([manager.probe("grok"),manager.probe("grok")]);
  assert.equal(launches.grok,2,"two overlapping probes run one version check and one models check");
  assert.deepEqual(first,second);assert.notEqual(first,second,"each caller gets its own copy");
  await manager.probe("grok",{fresh:true});
  assert.equal(launches.grok,4,"a fresh probe launches again");
  await manager.snapshot();
  assert.equal(launches.grok,6,"the Settings listing checks every harness again");
  await manager.probe("grok");
  assert.equal(launches.grok,6,"and what it found is reused");
});
