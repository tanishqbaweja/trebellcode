// A harness probe answer is kept for a minute (PROBE_REUSE_MS), and the 5-s poll and the relay's session start read it. A harness
// that fails where it runs in that minute is asked again at once, so a sign-out made outside Trebell (`claude auth logout` in the
// person's own terminal) shows at the next poll and the failure carries the probe's advice beside the harness's own message.
// Stubbed probes (a remote environment's executeArgv, a local runFn) and scripted harnesses only: no real harness is started,
// signed in or signed out.
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { WebSocket } from "ws";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";
import { AgentThreadStore } from "../src/agent-thread-store.mjs";
import { attachAgentRelay } from "../src/agent-relay.mjs";

const CLAUDE_ADVICE="Claude Code is not authenticated. Run `claude auth login` and try again.";
const GROK_ADVICE="Grok CLI is installed but not logged in. Run grok login.";
const CLAUDE_EXIT="Claude Code process exited with code 1";
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// A request the relay refuses, with exactly this message.
const refusedWith=(promise,message,note)=>assert.rejects(promise,error=>{assert.equal(error.message,message,note);return true});

// Cleanups run newest first, so the relay stops before its folder goes.
const cleanups=new WeakMap();
function onCleanup(t,step){
  let stack=cleanups.get(t);
  if(!stack){stack=[];cleanups.set(t,stack);t.after(async()=>{let failure=null;for(const next of stack.reverse()){try{await next()}catch(error){failure??=error}}if(failure)throw failure})}
  stack.push(step);
}
// The settings both the runtime manager and the relay read, and the thread metadata the relay keeps.
function memoryState(settings){
  const meta=new Map();
  return {settings:()=>({...settings}),threadMeta:id=>meta.get(id)||{},updateThreadMeta:(id,patch)=>{const next={...(meta.get(id)||{}),...patch};meta.set(id,next);return next}};
}
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
  // The first notification that matches, already seen or still to come.
  const next=match=>{const found=seen.find(match);if(found)return Promise.resolve(found);return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("timed out waiting for a relay notification")),20_000);waiters.push({match,resolve:value=>{clearTimeout(timer);resolve(value)}})})};
  // A send, settled: the turn as turn/completed reports it, and the error notification it ended with (if any).
  const turn=async(threadId,text="Hello")=>{
    const started=await rpc("turn/start",{threadId,input:[{type:"text",text}]}),turnId=started.turn.id;
    const completed=(await next(message=>message.method==="turn/completed"&&message.params.turn?.id===turnId)).params.turn;
    return {turn:completed,shown:seen.find(message=>message.method==="error"&&message.params.turnId===turnId)?.params.message??null};
  };
  const close=async()=>{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()))};
  onCleanup(t,close);
  return {rpc,turn,seen,next};
}

// The SDK's Query as the Claude session drives it (the shape of tests/agent-relay-resume-fallback.test.mjs's fake): each user
// message is answered, unless the CLI fails. failing: the error the CLI process ends with on the next message (as a signed-out
// Claude Code exits); lost: a resumed conversation Claude Code says it has no transcript for.
class Channel{
  constructor(){this.items=[];this.waiters=[];this.done=false;this.error=null}
  push(value){if(this.done)return;const waiter=this.waiters.shift();if(waiter)waiter.resolve({value,done:false});else this.items.push(value)}
  end(error=null){if(this.done)return;this.done=true;this.error=error;for(const waiter of this.waiters.splice(0))error?waiter.reject(error):waiter.resolve({value:undefined,done:true})}
  next(){
    if(this.items.length)return Promise.resolve({value:this.items.shift(),done:false});
    if(this.done)return this.error?Promise.reject(this.error):Promise.resolve({value:undefined,done:true});
    return new Promise((resolve,reject)=>this.waiters.push({resolve,reject}));
  }
}
function fakeClaudeSdk(){
  const claude={queries:0,failed:0,failing:null,lost:false};
  const query=({prompt,options})=>{
    const out=new Channel();claude.queries++;
    void (async()=>{
      let index=0;
      for await(const message of prompt){
        const failure=claude.lost&&options.resume?new Error(`${CLAUDE_EXIT}. stderr: No conversation found with session ID: ${options.resume}`):claude.failing;
        if(failure){await sleep(10);claude.failed++;out.end(failure);return}
        const sessionId=options.sessionId||options.resume;
        if(index===0)out.push({type:"system",subtype:"init",session_id:sessionId,model:"claude-test",permissionMode:options.permissionMode,tools:[],mcp_servers:[],slash_commands:[],agents:[],capabilities:[]});
        const id=`msg-${claude.queries}-${index++}`;
        out.push({type:"assistant",uuid:`assistant-${id}`,parent_tool_use_id:null,message:{id,content:[{type:"text",text:"PELICAN"}]}});
        out.push({type:"result",subtype:"success",is_error:false,result:"PELICAN",user_message_uuid:message.uuid,total_cost_usd:0,usage:{input_tokens:3,output_tokens:1}});
      }
      out.end();
    })();
    return {next:()=>out.next(),return:()=>{out.end();return Promise.resolve({value:undefined,done:true})},[Symbol.asyncIterator](){return this},async interrupt(){},close(){out.end()},async setPermissionMode(){},initializationResult:async()=>({commands:[],agents:[],models:[]})};
  };
  claude.sdk={query,getSessionInfo:async id=>({sessionId:id}),forkSession:async()=>({}),renameSession:async()=>{},getSessionMessages:async()=>[],deleteSession:async()=>{}};
  return claude;
}

// A Claude Code profile whose probes answer from auth (`claude auth status`), on an SSH environment (its executeArgv stubbed) or on
// this machine (the manager's runFn stubbed, with the profile's binary a file of the test's own). launches: each probe launch, as
// "<command> <args>". hold: a promise the sign-in check waits on before it answers.
async function claudeFixture(t,where){
  const root=await mkdtemp(join(tmpdir(),`trebell-recheck-claude-${where}-`));onCleanup(t,()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const auth={loggedIn:true,hold:null},launches=[],binary=join(root,"claude");
  const answer=async args=>{
    launches.push("claude "+args.join(" "));
    if(args[0]!=="auth")return {stdout:"2.1.0 (Claude Code)\n"};
    const loggedIn=auth.loggedIn;await auth.hold;return {stdout:JSON.stringify({loggedIn})};
  };
  let environments=null,runFn=undefined,settings;
  if(where==="ssh"){
    const profile={id:"ssh-recheck",type:"ssh",cwd:"/srv/app"};
    environments={
      get:id=>id===profile.id?profile:null,
      executeArgv:async(_id,{args})=>({exitCode:0,stderr:"",...await answer(args)}),
      spawnArgv:()=>{throw new Error("the scripted Claude SDK starts no process")},
    };
    settings={activeEnvironmentId:profile.id,agentRuntime:"claude"};
  }else{
    await writeFile(binary,"claude build 1");
    runFn=async(_command,args)=>({ok:true,code:0,error:null,stderr:"",...await answer(args)});
    settings={activeEnvironmentId:null,agentRuntime:"claude",agentRuntimeInstances:[{id:"claude-default",kind:"claude",binaryPath:binary}]};
  }
  const state=memoryState(settings),env={PATH:"/usr/bin",HOME:join(root,"home")};
  const manager=new AgentRuntimeManager({state,environments,platform:"linux",env,...(runFn?{runFn}:{})});
  const claude=fakeClaudeSdk(),threadStore=new AgentThreadStore({...process.env,TREBELL_HOME:join(root,"trebell-home")});
  const relay=await startRelay(t,{runtimeManager:manager,threadStore,state,environments,claudeSdk:claude.sdk});
  // What Settings' 5-s poll and the bootstrap read: the active profile's probe, without fresh.
  const poll=()=>manager.probe(manager.activeInstance());
  return {root,auth,launches,manager,claude,relay,poll,threadStore};
}

// A Grok Build ACP agent as a remote environment's spawnArgv starts it, over the same JSON lines a real one speaks. It refuses
// session/new while signedIn is false (ACP auth_required, as a signed-out Grok does) and with newError when that is set, answers
// session/load with a missing session while lostLoad is set, and, while holdPrompts is set, answers a prompt only once it is
// cancelled, with an error.
function fakeGrokAgent(grok){
  const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.exitCode=null;
  // A process answers after the request is written, never inside the write.
  const send=message=>setImmediate(()=>{if(child.exitCode===null)child.stdout.write(JSON.stringify(message)+"\n")});
  let buffer="",held=null;
  child.stdin.on("data",chunk=>{
    buffer+=String(chunk);let index;
    while((index=buffer.indexOf("\n"))>=0){
      const message=JSON.parse(buffer.slice(0,index));buffer=buffer.slice(index+1);
      if(message.method==="session/cancel"){held?.();held=null;continue}
      if(message.id===undefined||!message.method)continue;
      const reply=result=>send({jsonrpc:"2.0",id:message.id,result}),fail=error=>send({jsonrpc:"2.0",id:message.id,error});
      if(message.method==="initialize")reply({protocolVersion:1,agentInfo:{name:"fixture",version:"1"},agentCapabilities:{loadSession:true}});
      else if(message.method==="session/load")grok.lostLoad?fail({code:-32603,message:"Internal error",data:{message:"Session not found"}}):reply({});
      else if(message.method==="session/new"){
        if(grok.newError)fail(grok.newError);
        else if(!grok.signedIn)fail({code:-32000,message:"Authentication required"});
        else reply({sessionId:"grok-session-"+(++grok.sessions),models:{currentModelId:"grok-4.6",availableModels:[{modelId:"grok-4.6",name:"Grok 4.6"}]}});
      }
      else if(message.method==="session/prompt"){
        if(grok.holdPrompts){held=()=>fail({code:-32603,message:"Internal error",data:{message:"The prompt was aborted"}});continue}
        send({jsonrpc:"2.0",method:"session/update",params:{sessionId:message.params.sessionId,update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"PELICAN"}}}});
        reply({stopReason:"end_turn"});
      }else reply({});
    }
  });
  child.kill=()=>{if(child.exitCode===null){child.exitCode=0;setImmediate(()=>{child.emit("exit",0,null);child.emit("close",0,null)})}return true};
  setImmediate(()=>child.emit("spawn"));
  return child;
}
// A Grok Build profile on an SSH environment: probes run `grok --version` and `grok models` through executeArgv (launches), and
// each session start launches the scripted agent through spawnArgv (harnessLaunches).
async function grokFixture(t){
  const root=await mkdtemp(join(tmpdir(),"trebell-recheck-grok-"));onCleanup(t,()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  const grok={signedIn:true,newError:null,lostLoad:false,holdPrompts:false,sessions:0,harnessLaunches:0},launches=[];
  const profile={id:"ssh-recheck-grok",type:"ssh",cwd:"/srv/app"};
  const environments={
    get:id=>id===profile.id?profile:null,
    executeArgv:async(_id,{command,args})=>{
      launches.push(command+" "+args.join(" "));
      if(args[0]==="--version")return {exitCode:0,stdout:"grok 1.2.0\n",stderr:""};
      if(args[0]==="models")return {exitCode:0,stdout:grok.signedIn?"You are logged in\n- grok-4.6\n":"Not logged in\n",stderr:""};
      return {exitCode:1,stdout:"",stderr:"unexpected command"};
    },
    spawnArgv:()=>{grok.harnessLaunches++;return fakeGrokAgent(grok)},
  };
  const state=memoryState({activeEnvironmentId:profile.id,agentRuntime:"grok"});
  const manager=new AgentRuntimeManager({state,environments,platform:"linux",env:{PATH:"/usr/bin",HOME:join(root,"home")}});
  const threadStore=new AgentThreadStore({...process.env,TREBELL_HOME:join(root,"trebell-home")});
  const relay=await startRelay(t,{runtimeManager:manager,threadStore,state,environments});
  return {grok,launches,manager,relay,threadStore,profile,poll:()=>manager.probe(manager.activeInstance())};
}

for(const where of ["ssh","local"]){
  test(`a Claude Code sign-out outside Trebell (${where}) shows at the next poll once a turn fails, and the failed turn says how to sign in`,async t=>{
    const fx=await claudeFixture(t,where);
    assert.equal((await fx.poll()).available,true,"Settings' poll finds Claude Code ready and keeps that answer");
    const {thread}=await fx.relay.rpc("thread/start",{cwd:fx.root});
    // `claude auth logout` in the person's own terminal: the CLI the next turn starts exits as a signed-out Claude Code does.
    fx.auth.loggedIn=false;fx.claude.failing=new Error(CLAUDE_EXIT);
    assert.equal((await fx.poll()).available,true,"the poll keeps showing the kept answer until something fails");
    const {turn,shown}=await fx.relay.turn(thread.id);
    assert.equal(turn.status,"failed");
    assert.equal(turn.error.message,`${CLAUDE_EXIT}. ${CLAUDE_ADVICE}`,"the harness's own message, then the probe's advice");
    assert.equal(shown,turn.error.message,"the window is shown what the turn keeps");
    assert.equal(fx.threadStore.get(thread.id).turns.at(-1).error.message,turn.error.message);
    const poll=await fx.poll();
    assert.deepEqual([poll.available,poll.authenticated],[false,false],"the next poll asks again");
    assert.equal(poll.message,CLAUDE_ADVICE);
  });
}

test("a harness session that does not start after a sign-out outside Trebell fails with its probe's advice, and the next poll reads it",async t=>{
  const fx=await grokFixture(t);
  assert.equal((await fx.poll()).available,true);
  // The person signs out with Grok's own CLI; its agent now refuses a new session.
  fx.grok.signedIn=false;
  const before=fx.launches.length;
  await refusedWith(fx.relay.rpc("thread/start",{cwd:"/srv/app"}),`Authentication required. ${GROK_ADVICE}`,"the harness's own message, then the probe's advice");
  assert.deepEqual(fx.launches.slice(before),["grok --version","grok models"],"the start found the kept answer, and the failure asked once");
  assert.equal(fx.threadStore.list().length,0,"a thread whose session never started is not kept");
  const poll=await fx.poll();
  assert.deepEqual([poll.available,poll.authenticated],[false,false]);
  // The next send starts no harness: the start's own probe now refuses it with the advice.
  const launched=fx.grok.harnessLaunches;
  await refusedWith(fx.relay.rpc("thread/start",{cwd:"/srv/app"}),GROK_ADVICE);
  assert.equal(fx.grok.harnessLaunches,launched);
});

test("a failure whose harness still probes ready shows the harness's own message unchanged",async t=>{
  const fx=await claudeFixture(t,"ssh");
  await fx.poll();const {thread}=await fx.relay.rpc("thread/start",{cwd:fx.root});
  fx.claude.failing=new Error(CLAUDE_EXIT);
  const before=fx.launches.length,{turn,shown}=await fx.relay.turn(thread.id);
  assert.deepEqual([turn.status,turn.error.message,shown],["failed",CLAUDE_EXIT,CLAUDE_EXIT]);
  assert.deepEqual(fx.launches.slice(before),["claude --version","claude auth status"],"one fresh probe");
  const poll=await fx.poll();assert.equal(poll.available,true);
  assert.equal(fx.launches.length,before+2,"and the poll reuses what it found");
  // A session that does not start while its harness still probes ready fails with the harness's message as before.
  const grok=await grokFixture(t);await grok.poll();
  grok.grok.newError={code:-32603,message:"Internal error",data:{message:"The model service is unavailable"}};
  await refusedWith(grok.relay.rpc("thread/start",{cwd:"/srv/app"}),"The model service is unavailable");
  assert.deepEqual(grok.launches,["grok --version","grok models","grok --version","grok models"],"one fresh probe");
  // A conversation the harness lost is no failure of the harness: it ran to say so, and nothing is asked.
  grok.grok.newError=null;grok.grok.lostLoad=true;
  const seeded=grok.threadStore.create({runtime:"grok",cwd:"/srv/app",providerSessionId:"grok-saved",model:"grok-4.6",providerMeta:{runtimeInstanceId:"grok-default",environmentId:grok.profile.id,permissionProfile:"supervised"}});
  grok.threadStore.update(seeded.id,{runtimeInstanceId:"grok-default"});
  await refusedWith(grok.relay.rpc("thread/fork",{threadId:seeded.id}),"Grok Build could not resume this conversation: Session not found");
  assert.equal(grok.launches.length,4);
});

test("B7: a ready harness's turns launch no probe, each failure asks once, and failures that overlap or retry share one probe",async t=>{
  const fx=await claudeFixture(t,"ssh"),launched=()=>fx.launches.length;
  await fx.poll();const base=launched();assert.equal(base,2);
  const one=(await fx.relay.rpc("thread/start",{cwd:fx.root})).thread,two=(await fx.relay.rpc("thread/start",{cwd:fx.root})).thread;
  for(let i=0;i<3;i++)assert.equal((await fx.relay.turn(one.id)).turn.status,"completed");
  assert.equal(launched(),base,"no probe launches while the harness works");
  // The harness keeps failing while it still probes ready: one probe per failed turn, never more.
  fx.claude.failing=new Error(CLAUDE_EXIT);
  for(let i=0;i<3;i++)assert.equal((await fx.relay.turn(one.id)).turn.error.message,CLAUDE_EXIT);
  assert.equal(launched(),base+3*2,"each failed turn asks once (a version check and a sign-in check)");
  // Two threads failing at once share one probe.
  let release;fx.auth.hold=new Promise(resolve=>{release=resolve});
  const failedBefore=fx.claude.failed,both=Promise.all([fx.relay.turn(one.id),fx.relay.turn(two.id)]);
  while(fx.claude.failed<failedBefore+2)await sleep(5);
  await sleep(50);fx.auth.hold=null;release();
  assert.deepEqual((await both).map(item=>item.turn.status),["failed","failed"]);
  assert.equal(launched(),base+4*2,"the two failures asked once between them");
  // Claude Code says it has no conversation, and the fresh conversation's send fails too: one turn, one probe.
  fx.claude.lost=true;const queries=fx.claude.queries;
  const resent=await fx.relay.turn(one.id);
  assert.equal(fx.claude.queries,queries+2,"the lost resume, then the fresh conversation");
  assert.deepEqual([resent.turn.status,resent.turn.error.message],["failed",CLAUDE_EXIT]);
  assert.equal(launched(),base+5*2,"the relay's resend asked once");
});

test("B7: a session start the relay retries in a fresh session asks once when that fails, and a Stop is no failure",async t=>{
  const fx=await grokFixture(t);
  await fx.poll();const base=fx.launches.length;
  // A thread whose saved conversation Grok no longer has: the send's start resumes it, then retries in a fresh session, which the
  // signed-out Grok refuses.
  const seeded=fx.threadStore.create({runtime:"grok",cwd:"/srv/app",providerSessionId:"grok-saved",model:"grok-4.6",providerMeta:{runtimeInstanceId:"grok-default",environmentId:fx.profile.id,permissionProfile:"supervised"}});
  fx.threadStore.update(seeded.id,{runtimeInstanceId:"grok-default"});
  fx.grok.lostLoad=true;fx.grok.signedIn=false;
  await refusedWith(fx.relay.rpc("turn/start",{threadId:seeded.id,input:[{type:"text",text:"Hello"}]}),`Authentication required. ${GROK_ADVICE}`);
  assert.equal(fx.grok.harnessLaunches,2,"the resume and the fresh session");
  assert.equal(fx.launches.length,base+2,"one probe for the one failed start");
  // Signed in again (Settings' Refresh asks fresh): a turn the person stops, which the harness ends with an error, asks nothing.
  fx.grok.signedIn=true;fx.grok.lostLoad=false;fx.grok.holdPrompts=true;
  assert.equal((await fx.manager.probe(fx.manager.activeInstance(),{fresh:true})).available,true);
  const thread=(await fx.relay.rpc("thread/start",{cwd:"/srv/app"})).thread,asked=fx.launches.length;
  const started=await fx.relay.rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"Hello"}]});
  await fx.relay.rpc("turn/interrupt",{threadId:thread.id});
  const stopped=(await fx.relay.next(message=>message.method==="turn/completed"&&message.params.turn?.id===started.turn.id)).params.turn;
  assert.equal(stopped.status,"failed","Grok ended the stopped turn with an error");
  assert.equal(stopped.error.message.includes(GROK_ADVICE),false);
  assert.equal(fx.launches.length,asked,"a Stop asks the harness nothing");
});

test("a recheck replaces the kept answer at once, overlapping rechecks share one probe, and Trebell Native has none",async()=>{
  const launches=[];let signedIn=true,hold=null;
  const profile={id:"ssh-recheck-unit",type:"ssh",cwd:"/srv/app"};
  const environments={get:id=>id===profile.id?profile:null,executeArgv:async(_id,{command,args})=>{launches.push(command+" "+args[0]);if(args[0]==="--version")return {exitCode:0,stdout:"grok 1.2.0\n",stderr:""};await hold;return {exitCode:0,stdout:signedIn?"You are logged in\n":"Not logged in\n",stderr:""}}};
  const manager=new AgentRuntimeManager({state:{settings:()=>({activeEnvironmentId:profile.id})},environments,platform:"linux",env:{PATH:"/usr/bin",HOME:"/home/test"}});
  assert.equal((await manager.probe("grok")).available,true);assert.equal(launches.length,2);
  signedIn=false;let release;hold=new Promise(resolve=>{release=resolve});
  // A poll while the recheck runs joins it instead of reading the kept ready answer.
  const first=manager.recheck("grok"),second=manager.recheck("grok"),polled=manager.probe("grok");
  await sleep(20);
  assert.deepEqual(launches.slice(2),["grok --version","grok models"],"the two rechecks share one probe, which the poll joined");
  hold=null;release();
  const answers=await Promise.all([first,second,polled]);
  assert.deepEqual(answers.map(answer=>answer.available),[false,false,false]);
  assert.notEqual(answers[0],answers[1],"each caller gets its own copy");
  assert.equal(await manager.recheck("native"),null);
});
