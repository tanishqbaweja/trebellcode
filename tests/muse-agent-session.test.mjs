import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { acpToolFrame } from "../src/acp-tool-state.mjs";
import { HarnessSessionLostError } from "../src/harness-session-lost.mjs";
import { MuseAgentSession, MUSE_INTERRUPT_TIMEOUT_MS, MUSE_REQUEST_TIMEOUT_MS, museApprovalChoices, museDisplayText, museInputParts, museToolUpdate } from "../src/muse-agent-session.mjs";
import { MuseHost, MUSE_SHUTDOWN_TIMEOUT_MS, MUSE_STARTUP_TIMEOUT_MS, loadMuseSdk, museEnvironment, museExitMessage, museServeArgs, museVerbatimPath, museWorkspaceRoot, stopMuseProcessTree } from "../src/muse-host.mjs";
import { withWorkingContext } from "../src/working-context-envelope.mjs";

// Muse Code is driven through Meta's SDK (@muse-code/sdk, a real Connection) over a fake `muse serve`: a child whose stdio carries
// MSP frames. Replays use the recorded transcripts in tests/fixtures/muse/*.ndjson (MIT, see THIRD_PARTY_NOTICES.md; recorded with Muse
// 1.4.3, their frames match the stable schema of Muse 1.4.13); the initialize answer of the other tests is Muse 1.4.13's own.
const FIXTURES=new URL("./fixtures/muse/",import.meta.url);
const INIT=JSON.parse(readFileSync(new URL("initialize-1.4.13.json",FIXTURES),"utf8")).result;
const settle=()=>new Promise(resolve=>setImmediate(resolve));
// Polls with the real timers, also while a test has Node's mock timers on.
const realSetTimeout=globalThis.setTimeout;
async function until(check,label="condition",ms=5000){
  const deadline=Date.now()+ms;
  while(!check()){if(Date.now()>deadline)throw new Error(`timed out waiting for ${label}`);await new Promise(resolve=>realSetTimeout(resolve,5))}
}

// A fake host never reaches the real tree stop (taskkill, or a group signal): every fake gets this one instead. Its pid, 4242, is
// no Windows process's either (those are multiples of 4).
const fakeStop=async target=>{target.exit?.(1)};
function fakeChild({pid=4242}={}){
  const child=new EventEmitter();
  child.pid=pid;child.exitCode=null;child.signals=[];
  child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
  child.kill=signal=>{child.signals.push(signal);return true};
  child.exit=(code=0,signal=null)=>{if(child.exitCode!==null)return;child.exitCode=code;child.stdout.end();child.stderr.end();child.emit("exit",code,signal);child.emit("close",code,signal)};
  // The process ends while a tool it started (agent-browser and its Chrome, a background terminal) still holds its stdout and
  // stderr: Node then emits 'exit' and no 'close', and the output never ends.
  child.exitHeld=(code=0,signal=null)=>{if(child.exitCode!==null||child.signalCode)return;child.exitCode=code;child.signalCode=signal;child.emit("exit",code,signal)};
  return child;
}
// The process group a fake host leads on Linux and macOS, as process.kill reaches it by the host's negated pid: signal 0 finds it
// while the host or another process of it lives (ESRCH once none does); SIGTERM ends the host and each process that takes it, and
// SIGKILL every one. The processes left in it hold the host's output, so the host ends with 'exit' and no 'close'.
function fakeProcessGroup(t,child,{yielding=0,stubborn=0}={}){
  const realKill=process.kill,members=[...Array(yielding).fill(true),...Array(stubborn).fill(false)],sent=[];
  const hostAlive=()=>child.exitCode===null&&!child.signalCode;
  const kill=t.mock.method(process,"kill",(pid,signal="SIGTERM")=>{
    if(pid!==-child.pid)return realKill.call(process,pid,signal);
    if(!hostAlive()&&!members.length)throw Object.assign(new Error("kill ESRCH"),{code:"ESRCH",errno:-3,syscall:"kill"});
    if(signal===0)return true;
    sent.push(signal);
    for(let index=members.length-1;index>=0;index--)if(signal==="SIGKILL"||members[index])members.splice(index,1);
    if(hostAlive())setImmediate(()=>child.exitHeld(null,signal));
    return true;
  });
  return {sent,members,restore:()=>kill.mock.restore()};
}
// Fails, instead of hanging, when a promise does not settle in time (real timers, also while a test has Node's mock timers on).
const realClearTimeout=globalThis.clearTimeout;
async function settlesWithin(promise,ms,label){
  let timer;
  try{return await Promise.race([promise,new Promise((_resolve,reject)=>{timer=realSetTimeout(()=>reject(new Error(`${label} did not settle within ${ms} ms`)),ms)})])}
  finally{realClearTimeout(timer)}
}

const DEFAULT_HANDLERS={
  initialize:()=>INIT,
  "session/start":params=>({session:{sessionId:params.sessionId,status:"idle",activeTurnId:null,workspaceRoot:params.workspaceRoot,providerId:params.providerId,modelId:params.modelId??null,kind:"root"},viewCursor:`v4:${params.sessionId}:1`}),
  "session/resume":params=>({session:{sessionId:params.sessionId,status:"idle",modelId:"muse-spark-1.3"},history:{mode:"none",items:null},pendingRequests:[],viewCursor:`v4:${params.sessionId}:9`}),
  "session/setApprovalMode":params=>({commandId:params.commandId,applyOutcome:"noop"}),
  "turn/start":params=>({commandId:params.commandId,status:"accepted",turnId:params.commandId,startedNewTurn:true,disposition:"started"}),
  "turn/steer":params=>({commandId:params.commandId,status:"accepted",turnId:params.expectedTurnId}),
  "turn/interrupt":params=>({commandId:params.commandId,status:"accepted",turnId:params.turnId}),
  "approval/decide":params=>({commandId:params.commandId,status:"accepted",approvalId:params.approvalId,terminal:true}),
  "userInput/cancel":params=>({commandId:params.commandId,status:"accepted",userInputId:params.userInputId}),
};

// A scripted `muse serve`: answers each request with its handler (undefined: no answer), and records every frame Trebell sends.
class FakeMuse{
  constructor(child,{handlers={},exitOnEof=true}={}){
    this.child=child;this.frames=[];this.taken=new Map();this.waiters=new Set();this.handlers={...DEFAULT_HANDLERS,...handlers};this.stdinEnded=false;
    readline.createInterface({input:child.stdin}).on("line",line=>{if(line.trim())this.#receive(JSON.parse(line))});
    child.stdin.on("end",()=>{this.stdinEnded=true;if(exitOnEof)setImmediate(()=>child.exit(0))});
  }
  #receive(frame){
    this.frames.push(frame);for(const waiter of [...this.waiters])waiter();
    const handler=frame.method&&frame.id!==undefined?this.handlers[frame.method]:null;
    if(handler)Promise.resolve().then(()=>handler(frame.params||{},this)).then(
      result=>{if(result!==undefined)this.write({jsonrpc:"2.0",id:frame.id,result})},
      error=>this.write({jsonrpc:"2.0",id:frame.id,error:{code:error.code??-32000,message:error.message,data:{kind:error.kind||"internal",retryable:false}}}),
    );
  }
  sent(method){return this.frames.filter(frame=>frame.method===method)}
  // The next frame of this method Trebell sends (each call takes the next one).
  next(method){
    return new Promise(resolve=>{
      const look=()=>{const index=this.taken.get(method)||0,list=this.sent(method);if(list.length<=index)return;this.taken.set(method,index+1);this.waiters.delete(look);resolve(list[index])};
      this.waiters.add(look);look();
    });
  }
  write(frame){this.child.stdout.write(JSON.stringify(frame)+"\n")}
  notify(method,params){this.write({jsonrpc:"2.0",method,params})}
}

// Replays one recorded transcript: each group of frames Trebell sends (in any order within the group) is followed by
// the frames Muse sent then, with the recorded session, turn and command ids replaced by the ones Trebell minted.
class ReplayMuse{
  constructor(child,name,{exitOnEof=true}={}){
    this.child=child;this.frames=[];this.unexpected=[];this.tokens=new Map();this.turns=0;this.commands=0;this.lastId=null;
    this.steps=readFileSync(new URL(`${name}.ndjson`,FIXTURES),"utf8").split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line)).filter(step=>step.send||step.emit);
    this.position=0;this.pending=this.#group();
    readline.createInterface({input:child.stdin}).on("line",line=>{if(line.trim())this.#receive(JSON.parse(line))});
    child.stdin.on("end",()=>{if(exitOnEof)setImmediate(()=>child.exit(0))});
  }
  #group(){const sends=[];while(this.position<this.steps.length&&this.steps[this.position].send)sends.push(this.steps[this.position++].send);return sends}
  #receive(frame){
    this.frames.push(frame);
    const params=frame.params||{},method=frame.method||("result" in frame||"error" in frame?"reply":"?");
    if(frame.method==="session/start"){this.tokens.set("$SESSION_COMMAND",params.commandId);this.tokens.set("$SESSION",params.sessionId)}
    else if(frame.method==="turn/start")this.tokens.set("$TURN"+(++this.turns),params.commandId);
    else if(params.commandId)this.tokens.set("$COMMAND"+(++this.commands),params.commandId);
    if(frame.method&&frame.id!==undefined)this.lastId=frame.id;
    const index=this.pending.indexOf(method);
    if(index<0){this.unexpected.push(method);return}
    this.pending.splice(index,1);
    if(this.pending.length)return;
    while(this.position<this.steps.length&&this.steps[this.position].emit)this.child.stdout.write(JSON.stringify(this.#fill(this.steps[this.position++].emit))+"\n");
    this.pending=this.#group();
  }
  #fill(value){
    if(value==="$ID")return this.lastId;
    if(typeof value==="string"){let out=value;for(const [token,id] of [...this.tokens].sort((a,b)=>b[0].length-a[0].length))out=out.split(token).join(id);return out}
    if(Array.isArray(value))return value.map(item=>this.#fill(item));
    if(value&&typeof value==="object")return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,this.#fill(item)]));
    return value;
  }
  get finished(){return this.position>=this.steps.length&&!this.pending.length}
}

async function startSession({muse=(child)=>new FakeMuse(child),platform=undefined,cwd=process.cwd(),model=null,providerSessionId=null,permissionMode="supervised",options={}}={}){
  const child=fakeChild(),fake=muse(child),spawned=[],updates=[];
  const session=new MuseAgentSession({command:"muse",cwd,env:{PATH:process.env.PATH||""},version:"1.6.0",permissionMode,...(platform?{platform}:{}),
    spawnFn:(command,args,spawnOptions)=>{spawned.push({command,args,options:spawnOptions});return child},
    onUpdate:params=>updates.push(params.update),stopTree:fakeStop,...options});
  const started=await session.start({model,providerSessionId});
  return {session,child,muse:fake,spawned,updates,started};
}
const chunks=(updates,type="agent_message_chunk")=>updates.filter(update=>update.sessionUpdate===type).map(update=>update.content.text).join("");
const event=(method,sessionId,params)=>({jsonrpc:"2.0",method,params:{sessionId,viewCursor:`v4:${sessionId}:7`,...params}});
const itemFrame=(method,sessionId,item)=>event(method,sessionId,{item});

test("Muse Code's host starts `muse serve --trust-workspace` hidden in the plain thread folder, with MUSE_NO_AUTO_UPDATE=1, and Read only without the shell, writes or workspace trust",async()=>{
  const folder=await mkdtemp(join(tmpdir(),"trebell-muse-launch-"));
  try{
    const {session,spawned}=await startSession({cwd:folder,platform:"win32"});
    assert.equal(spawned.length,1);
    assert.equal(spawned[0].command,"muse");
    assert.deepEqual(spawned[0].args,["serve","--trust-workspace"]);
    assert.equal(spawned[0].options.windowsHide,true);
    assert.deepEqual(spawned[0].options.stdio,["pipe","pipe","pipe"]);
    assert.equal(spawned[0].options.cwd,folder);
    assert.equal(spawned[0].options.detached,false,"Windows stops the tree with taskkill; POSIX hosts lead their own process group");
    assert.equal(spawned[0].options.env.MUSE_NO_AUTO_UPDATE,"1");
    assert.equal(spawned[0].options.env.PATH,process.env.PATH||"");
    assert.equal(session.needsRelaunch("edits"),false);
    assert.equal(session.needsRelaunch("read-only"),true,"Read only is fixed when the host launches");
    await session.close();
    assert.deepEqual(museServeArgs("read-only"),["serve","--disable-shell","--disable-write"]);
    assert.deepEqual(museServeArgs("read-only",{sessionLog:false}),["serve","--disable-shell","--disable-write","--no-session-log"]);
    for(const mode of ["supervised","edits","auto"])assert.deepEqual(museServeArgs(mode),["serve","--trust-workspace"],mode);
    assert.deepEqual(museServeArgs("full"),["serve","--trust-workspace","--disable-sandbox"],"Full access runs Muse's shell without its sandbox");
    const readOnly=await startSession({cwd:folder,permissionMode:"read-only",platform:"linux"});
    assert.deepEqual(readOnly.spawned[0].args,["serve","--disable-shell","--disable-write"]);
    assert.equal(readOnly.spawned[0].options.detached,true);
    await readOnly.session.close();
  }finally{await rm(folder,{recursive:true,force:true})}
});

test("Muse Code never gets a META_API_KEY unless its profile is set to its API key, matched in any case and its value never read, and a host started without an environment gets a Muse profile's",async()=>{
  for(const key of ["META_API_KEY","meta_api_key","Meta_Api_Key"]){
    const source={PATH:"/bin",MUSE_CHANNEL:"muse-stable"};let reads=0;
    Object.defineProperty(source,key,{enumerable:true,get:()=>{reads++;return "meta-key-of-trebells-environment"}});
    assert.deepEqual(museEnvironment(source),{PATH:"/bin",MUSE_CHANNEL:"muse-stable",MUSE_NO_AUTO_UPDATE:"1"},key);
    assert.equal(reads,0,"the key's value is never read");
    assert.ok(Object.keys(source).includes(key),"the environment given is left as it was");
    assert.equal(museEnvironment(source,{approved:["meta_api_key"]})[key],undefined,"an approval is no way in");
    assert.equal(museEnvironment(source,{authMethod:"api-key"})[key],"meta-key-of-trebells-environment","a profile set to its API key keeps it");
  }
  // A session hands its profile's method to its host: the key reaches Muse only on its API key.
  const plain=await startSession({options:{env:{PATH:"/bin",META_API_KEY:"meta-key-of-trebells-environment"}}});
  assert.equal("META_API_KEY" in plain.spawned[0].options.env,false);
  await plain.session.close();
  const approved=await startSession({options:{env:{PATH:"/bin",META_API_KEY:"meta-key-of-trebells-environment"},authMethod:"api-key"}});
  assert.equal(approved.spawned[0].options.env.META_API_KEY,"meta-key-of-trebells-environment");
  await approved.session.close();
  // Without an environment, a host gets what a Muse Code profile gets of Trebell's own: no other harness's key, and no META_API_KEY.
  const saved={META_API_KEY:process.env.META_API_KEY,TREBELL_FIXTURE_OTHER_API_KEY:process.env.TREBELL_FIXTURE_OTHER_API_KEY};
  process.env.META_API_KEY="meta-key-of-trebells-environment";process.env.TREBELL_FIXTURE_OTHER_API_KEY="another-harness-key";
  try{
    const host=new MuseHost({command:"muse"});
    assert.equal(Object.keys(host.env).some(name=>/^(?:META_API_KEY|TREBELL_FIXTURE_OTHER_API_KEY)$/i.test(name)),false);
    assert.equal(host.env.MUSE_NO_AUTO_UPDATE,"1");
    assert.ok(Object.keys(host.env).some(name=>name.toUpperCase()==="PATH"),"what Muse needs to run is there");
    const session=new MuseAgentSession({command:"muse",cwd:process.cwd(),onUpdate:()=>{}});
    assert.equal(session.env,undefined,"a session without an environment leaves it to its host");
  }finally{for(const [name,value] of Object.entries(saved))if(value===undefined)delete process.env[name];else process.env[name]=value}
});

test("initialize names Trebell Code and asks for session MCP servers; a schema fingerprint other than the SDK's is logged, not refused",async()=>{
  const {session,muse,updates}=await startSession({muse:child=>new ReplayMuse(child,"simple")});
  const initialize=muse.frames.find(frame=>frame.method==="initialize");
  assert.deepEqual(initialize.params,{clientInfo:{name:"trebell_code",title:"Trebell Code",version:"1.6.0"},capabilities:{requestedCapabilities:["sessionMcp"]}});
  assert.ok(muse.frames.some(frame=>frame.method==="initialized"&&frame.id===undefined),"initialized follows the answer");
  // The recorded host (Muse 1.4.3) serves an older stable-schema fingerprint than SDK 1.4.13 pins.
  const warning=updates.find(update=>update.sessionUpdate==="protocol_warning");
  assert.match(warning.message,/sha256:4cb67108.*differs from the fingerprint this SDK pins/);
  assert.equal(session.initializeResult.serverInfo.version,"1.4.3");
  assert.deepEqual(muse.unexpected,[]);
  await session.close();
});

test("an initialize answer with schema envelope version 2 is refused and the host is stopped",async()=>{
  const child=fakeChild(),muse=new FakeMuse(child,{handlers:{initialize:()=>({...INIT,schema:{...INIT.schema,version:2}})}});
  const session=new MuseAgentSession({command:"muse",cwd:process.cwd(),spawnFn:()=>child,stopTree:fakeStop,onUpdate:()=>{}});
  await assert.rejects(session.start({}),/session protocol version 2, and Trebell speaks version 1/);
  assert.equal(muse.stdinEnded,true,"the refused host's input is closed");
  assert.equal(child.exitCode,0);
  assert.equal(muse.sent("session/start").length,0);
});

test("a host that does not answer initialize within 20 s is stopped",async()=>{
  assert.equal(MUSE_STARTUP_TIMEOUT_MS,20_000);
  const child=fakeChild(),muse=new FakeMuse(child,{handlers:{initialize:()=>undefined}});
  const host=new MuseHost({command:"muse",spawnFn:()=>child,stopTree:fakeStop,startupTimeoutMs:60});
  await assert.rejects(host.start({}),/did not answer within 0 seconds|did not answer within/);
  assert.equal(muse.stdinEnded,true);
});

test("close() ends Muse's input at once and stops the whole process tree only after 10 s",async()=>{
  assert.equal(MUSE_SHUTDOWN_TIMEOUT_MS,10_000);
  const stops=[];
  // A host that keeps running after its input ends (exitOnEof false): only the tree stop ends it.
  const {session,child,muse}=await startSession({muse:child=>new FakeMuse(child,{exitOnEof:false}),platform:"win32",options:{stopTree:async(target,{platform})=>{stops.push({pid:target.pid,platform});target.exit(1)}}});
  mock.timers.enable({apis:["setTimeout"]});
  try{
    const closing=session.close();
    await until(()=>muse.stdinEnded,"stdin to end");
    assert.deepEqual(stops,[],"no stop while Muse winds down");
    mock.timers.tick(9_999);await settle();await settle();
    assert.deepEqual(stops,[],"still none at 9.999 s");
    mock.timers.tick(1);await until(()=>stops.length===1,"the tree stop");
    assert.deepEqual(stops,[{pid:4242,platform:"win32"}]);
    await closing;
    assert.equal(child.exitCode,1);
  }finally{mock.timers.reset()}
});

test("a host that exits with code 2, 3, 4 or 5 says what Muse's exit means, with the last line it wrote",async()=>{
  const env={HOME:"/home/ada",USERPROFILE:"/home/ada"};
  assert.equal(museExitMessage({code:2},"",{environment:env}),"Muse Code refused the way Trebell started it (exit code 2).");
  assert.equal(museExitMessage({code:3},"loading\nmalformed settings file at /home/ada/.config/muse/settings.json\n",{environment:env}),"Muse Code could not load its settings; check ~/.config/muse/settings.json (exit code 3): malformed settings file at ~/.config/muse/settings.json");
  assert.equal(museExitMessage({code:4},"",{environment:env}),"Another Muse Code process holds this session; close it and try again (exit code 4).");
  assert.equal(museExitMessage({code:5},"",{environment:env}),"This Muse Code build cannot host sessions for Trebell; update Muse Code (exit code 5).");
  assert.equal(museExitMessage({code:1},"muse: installed binary is missing; rerun the installer\n",{environment:env}),"Muse Code exited unexpectedly (code 1): muse: installed binary is missing; rerun the installer");
  assert.equal(museExitMessage({code:null,signal:"SIGKILL"},"",{environment:env}),"Muse Code exited unexpectedly (signal SIGKILL).");
  assert.equal(museExitMessage({error:Object.assign(new Error("spawn muse ENOENT"),{code:"ENOENT"})},"",{command:"muse"}),"Could not start Muse Code 'muse': spawn muse ENOENT");
  // A host that exits while it starts fails the start with that message.
  for(const code of [2,3,4,5]){
    const child=fakeChild();
    const session=new MuseAgentSession({command:"muse",cwd:process.cwd(),spawnFn:()=>{setImmediate(()=>{child.stderr.write(`muse: exit ${code}\n`);setImmediate(()=>child.exit(code))});return child},stopTree:fakeStop,onUpdate:()=>{}});
    await assert.rejects(session.start({}),error=>{assert.equal(error.message,museExitMessage({code},`muse: exit ${code}\n`));assert.equal(error.code,code);return true});
  }
});

test("session/start names a minted session, the canonical folder, Meta, Ask me and promptUnmatched; another session in the answer is refused",async()=>{
  const folder=await mkdtemp(join(tmpdir(),"trebell-muse-start-"));
  try{
    const {session,muse,started}=await startSession({cwd:folder,model:"muse-spark-1.3",platform:"win32"});
    const [frame]=muse.sent("session/start");
    assert.match(frame.params.sessionId,/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,"a UUIDv7 from the connection's minter");
    assert.notEqual(frame.params.commandId,frame.params.sessionId);
    assert.deepEqual({...frame.params,sessionId:"S",commandId:"C"},{sessionId:"S",workspaceRoot:await museWorkspaceRoot(folder,{verbatim:false}),providerId:"meta",modelId:"muse-spark-1.3",approvalMode:"promptUnmatched",permissionProfile:":ask-me",commandId:"C"});
    assert.equal(session.sessionId,frame.params.sessionId);
    assert.equal(started.session.sessionId,frame.params.sessionId);
    assert.equal(started.session.models.currentModelId,"muse-spark-1.3");
    assert.equal(started.initialize.serverInfo.version,"1.4.13");
    assert.equal(session.resumable,true);
    await session.close();
    // "default" is never sent as a model.
    const plain=await startSession({cwd:folder,model:"default"});
    assert.equal("modelId" in plain.muse.sent("session/start")[0].params,false);
    await plain.session.close();
    const child=fakeChild();new FakeMuse(child,{handlers:{"session/start":()=>({session:{sessionId:"01a00000-0000-7000-8000-000000000000"},viewCursor:"v4:x:1"})}});
    const other=new MuseAgentSession({command:"muse",cwd:folder,spawnFn:()=>child,stopTree:fakeStop,onUpdate:()=>{}});
    await assert.rejects(other.start({}),/another session than the one Trebell asked for/);
    assert.equal(child.exitCode,0,"the host is closed");
  }finally{await rm(folder,{recursive:true,force:true})}
});

test("a saved conversation is resumed with session/resume (no items, Ask me) and then session/setApprovalMode; one Muse no longer has is a lost session",async()=>{
  const saved="01a17000-1111-7000-8000-000000000001";
  const {session,muse,started}=await startSession({providerSessionId:saved});
  assert.equal(muse.sent("session/start").length,0);
  const [resume]=muse.sent("session/resume"),[mode]=muse.sent("session/setApprovalMode");
  assert.deepEqual({...resume.params,commandId:"C"},{sessionId:saved,excludeItems:true,permissionProfile:":ask-me",commandId:"C"});
  assert.deepEqual({...mode.params,commandId:"C"},{sessionId:saved,mode:"promptUnmatched",commandId:"C"});
  assert.ok(muse.frames.indexOf(resume)<muse.frames.indexOf(mode));
  assert.equal(started.session.sessionId,saved);
  assert.equal(started.session.models.currentModelId,"muse-spark-1.3");
  await session.close();
  const child=fakeChild();new FakeMuse(child,{handlers:{"session/resume":params=>{throw Object.assign(new Error(`session ${params.sessionId} not found`),{code:-32020,kind:"sessionNotFound"})}}});
  const lost=new MuseAgentSession({command:"muse",cwd:process.cwd(),spawnFn:()=>child,stopTree:fakeStop,onUpdate:()=>{}});
  await assert.rejects(lost.start({providerSessionId:saved}),error=>{
    assert.ok(error instanceof HarnessSessionLostError);
    assert.equal(error.harness,"muse");assert.equal(error.sessionId,saved);
    assert.match(error.message,/Muse Code could not resume this conversation: session .* not found/);
    return true;
  });
});

test("turn/start sends Trebell's runtime notes first, then the parts, with the person's words as display text, the turn's own id and the folder in Muse's form",async()=>{
  const folder=await mkdtemp(join(tmpdir(),"trebell-muse-turn-"));
  try{
    for(const platform of ["win32","linux"]){
      const {session,muse,spawned}=await startSession({cwd:folder,platform,model:"muse-spark-1.3"});
      session.setReasoningEffort("xhigh");
      const parts=withWorkingContext([{type:"text",text:"Fix the parser"},{type:"image",mimeType:"image/png",data:"aGk="}],[["trebell.goal",{kind:"application",value:"Ship it"}]]);
      const running=session.prompt(parts);
      const frame=await muse.next("turn/start");
      const {input,displayText,workspaceRoots,ifBusy,reasoningEffort,commandId,sessionId}=frame.params;
      assert.match(input[0].text,/^<trebell_runtime>\nYou are running inside Trebell Code through the Muse Code harness using model muse-spark-1\.3\./);
      assert.match(input[1].text,/Ship it/,"Trebell's working context");
      assert.deepEqual(input.slice(2),[{type:"text",text:"Fix the parser"},{type:"image",base64Data:"aGk=",mediaType:"image/png"}]);
      assert.equal(displayText,"Fix the parser");
      assert.equal(ifBusy,"queue");assert.equal(reasoningEffort,"xhigh");assert.equal(sessionId,session.sessionId);
      assert.equal(session.activePrompt.turnId,commandId,"the turn's id is the command id Trebell minted");
      if(platform==="win32"){
        assert.match(workspaceRoots[0],/^\\\\\?\\/,"the verbatim form on Windows");
        assert.equal(workspaceRoots[0],museVerbatimPath(await museWorkspaceRoot(folder,{verbatim:false})));
      }else assert.deepEqual(workspaceRoots,[await museWorkspaceRoot(folder,{platform:"linux"})]);
      assert.doesNotMatch(spawned[0].options.cwd,/^\\\\\?\\/,"the process starts in the plain folder");
      muse.notify("turn/completed",{sessionId:session.sessionId,viewCursor:"v",terminal:"completed",turnId:commandId});
      assert.equal((await running).stopReason,"end_turn");
      await session.close();
    }
  }finally{await rm(folder,{recursive:true,force:true})}
});

test("Muse's verbatim roots: drives, shares and a root already verbatim; Windows spells a root as the disk does",async()=>{
  assert.equal(museVerbatimPath("C:\\Users\\Person\\repo"),"\\\\?\\C:\\Users\\Person\\repo");
  assert.equal(museVerbatimPath("\\\\server\\share\\repo"),"\\\\?\\UNC\\server\\share\\repo");
  assert.equal(museVerbatimPath("\\\\?\\C:\\repo"),"\\\\?\\C:\\repo");
  assert.equal(await museWorkspaceRoot("C:/work/repo",{platform:"win32",resolveReal:async()=>{throw new Error("missing")}}),"\\\\?\\C:\\work\\repo");
  assert.equal(await museWorkspaceRoot("/work/repo",{platform:"linux",resolveReal:async path=>path+"-real"}),"/work/repo-real");
  if(process.platform!=="win32")return;
  const folder=await mkdtemp(join(tmpdir(),"MuseRoot-"));
  try{
    const root=await museWorkspaceRoot(folder.toLowerCase());
    assert.ok(root.startsWith("\\\\?\\"));
    assert.ok(root.endsWith("\\"+folder.split("\\").at(-1)),"the folder's own case, read from the disk");
  }finally{await rm(folder,{recursive:true,force:true})}
});

test("prompt parts: text as is, images as base64 with their type, other attachments named by their saved path; nothing to send is refused",()=>{
  const file=process.platform==="win32"?"C:\\Users\\ada\\notes.pdf":"/home/ada/notes.pdf";
  assert.deepEqual(museInputParts([{type:"text",text:"Read this"},{type:"image",mimeType:"image/jpeg",data:"AAAA"},{type:"resource_link",uri:pathToFileURL(file).href,name:"notes.pdf"},{type:"text",text:"[Attached audio \"a.wav\" is saved at: /tmp/a.wav]"}]),[
    {type:"text",text:"Read this"},{type:"image",base64Data:"AAAA",mediaType:"image/jpeg"},{type:"text",text:`Attached file: ${file}`},{type:"text",text:"[Attached audio \"a.wav\" is saved at: /tmp/a.wav]"},
  ]);
  assert.throws(()=>museInputParts([]),/Muse Code needs text or an image/);
  assert.throws(()=>museInputParts([{type:"text",text:"  "}]),/Muse Code needs text or an image/);
  assert.equal(museDisplayText([{type:"image",mimeType:"image/png",data:"AAAA"}]),"Attached image");
  assert.equal(museDisplayText([{type:"text",text:"one"},{type:"text",text:"two"}]),"one\ntwo");
});

test("a recorded Muse turn streams its reply and ends the turn; Muse's own message and reminder children are not rows",async()=>{
  const {session,muse,updates}=await startSession({muse:child=>new ReplayMuse(child,"simple")});
  let delivered=0;
  const result=await session.prompt([{type:"text",text:"Respond with the following text: fixture simple ok"}],{onDelivered:()=>delivered++});
  assert.equal(result.stopReason,"end_turn");
  assert.equal(result.raw.terminal,"completed");
  assert.equal(delivered,1);
  assert.equal(chunks(updates),"fixture simple ok");
  assert.deepEqual(updates.filter(update=>update.sessionUpdate==="tool_call"||update.sessionUpdate==="tool_call_update"),[],"userMessage and reminderChild items are skipped");
  assert.equal(session.busy,false);
  assert.deepEqual(muse.unexpected,[]);
  await session.close();
});

test("a recorded two-turn conversation keeps each turn's reply to its own turn",async()=>{
  const {session,muse,updates}=await startSession({muse:child=>new ReplayMuse(child,"multi_turn")});
  assert.equal((await session.prompt([{type:"text",text:"first"}])).stopReason,"end_turn");
  assert.equal(chunks(updates),"first fixture turn complete");
  updates.length=0;
  assert.equal((await session.prompt([{type:"text",text:"second"}])).stopReason,"end_turn");
  assert.equal(chunks(updates),"second fixture turn complete");
  const turns=muse.frames.filter(frame=>frame.method==="turn/start").map(frame=>frame.params.commandId);
  assert.equal(new Set(turns).size,2);
  assert.ok(muse.finished||muse.pending.length===0);
  assert.deepEqual(muse.unexpected,[]);
  await session.close();
});

test("an item keeps its highest revision: an older item/updated arriving late is ignored",async()=>{
  const {session,muse,updates}=await startSession();
  const running=session.prompt([{type:"text",text:"go"}]);
  const {params:{commandId:turnId}}=await muse.next("turn/start");
  const sid=session.sessionId,item=fields=>({itemId:"tool-1",kind:"toolCall",tool:"read_file",turnId,...fields});
  muse.write(itemFrame("item/started",sid,item({revision:1,status:"inProgress",args:"{\"path\":\"a.txt\"}"})));
  muse.write(itemFrame("item/updated",sid,item({revision:3,status:"inProgress",args:"{\"path\":\"b.txt\"}"})));
  muse.write(itemFrame("item/updated",sid,item({revision:2,status:"inProgress",args:"{\"path\":\"stale.txt\"}"})));
  muse.write(itemFrame("item/completed",sid,item({revision:4,status:"completed",args:"{\"path\":\"b.txt\"}",visibleOutput:"B"})));
  // An item of another turn is not this turn's.
  muse.write(itemFrame("item/started",sid,{...item({revision:1,status:"inProgress"}),itemId:"other",turnId:"01a00000-0000-7000-8000-00000000beef"}));
  muse.notify("turn/completed",{sessionId:sid,viewCursor:"v",terminal:"completed",turnId});
  await running;
  const rows=updates.filter(update=>update.toolCallId==="tool-1");
  assert.deepEqual(rows.map(row=>[row.sessionUpdate,row.status,row.rawInput.path]),[["tool_call","in_progress","a.txt"],["tool_call_update","in_progress","b.txt"],["tool_call_update","completed","b.txt"]]);
  assert.equal(updates.some(update=>update.toolCallId==="other"),false);
  await session.close();
});

test("deltas: text streams the reply, summary.N the reasoning's parts and output a command's output; the final text adds only what did not stream",async()=>{
  const {session,muse,updates}=await startSession();
  const running=session.prompt([{type:"text",text:"go"}]);
  const {params:{commandId:turnId}}=await muse.next("turn/start");
  const sid=session.sessionId,send=frame=>muse.write(frame),delta=(itemId,field,value)=>send(event("item/delta",sid,{itemId,...(field?{field}:{}),delta:value}));
  send(itemFrame("item/started",sid,{itemId:"think",kind:"reasoning",turnId,revision:1,status:"inProgress",summary:[""]}));
  delta("think","summary.0","Reading the parser.");delta("think","summary.1","Planning the fix.");
  send(itemFrame("item/completed",sid,{itemId:"think",kind:"reasoning",turnId,revision:2,status:"completed",summary:["Reading the parser.","Planning the fix."]}));
  send(itemFrame("item/started",sid,{itemId:"sh",kind:"toolCall",tool:"bash",turnId,revision:1,status:"inProgress",args:"{\"command\":\"npm test\"}"}));
  delta("sh","output","ok 1\n");delta("sh","output","ok 2\n");
  send(itemFrame("item/completed",sid,{itemId:"sh",kind:"toolCall",tool:"bash",turnId,revision:2,status:"completed",args:"{\"command\":\"npm test\"}",visibleOutput:JSON.stringify({command:"npm test",exit_code:0,output:"ok 1\nok 2\n",terminal_status:"completed"})}));
  send(itemFrame("item/started",sid,{itemId:"say",kind:"agentMessage",turnId,revision:1,status:"inProgress",text:""}));
  delta("say",null,"Fixed the ");delta("say","text","parser");
  send(itemFrame("item/completed",sid,{itemId:"say",kind:"agentMessage",turnId,revision:2,status:"completed",text:"Fixed the parser and its tests."}));
  // A late delta for a closed item changes nothing.
  delta("say","text"," twice");
  send(itemFrame("item/completed",sid,{itemId:"end",kind:"agentMessage",turnId,revision:1,status:"completed",text:"Done."}));
  muse.notify("turn/completed",{sessionId:sid,viewCursor:"v",terminal:"completed",turnId});
  await running;
  const thoughts=updates.filter(update=>update.sessionUpdate==="agent_thought_chunk");
  assert.deepEqual(thoughts.map(update=>update.content.text),["Reading the parser.","\n\nPlanning the fix."]);
  assert.ok(thoughts.every(update=>update.messageId==="think"),"one reasoning block per item");
  assert.deepEqual(updates.filter(update=>update.sessionUpdate==="agent_message_chunk").map(update=>update.content.text),["Fixed the ","parser"," and its tests.","\n\nDone."]);
  const shell=updates.filter(update=>update.toolCallId==="sh");
  assert.deepEqual(shell.map(update=>[update.kind,update.title,update.status]),[["execute","npm test","in_progress"],["execute","npm test","in_progress"],["execute","npm test","in_progress"],["execute","npm test","completed"]]);
  assert.equal(shell[2].rawOutput,"ok 1\nok 2\n","output streams into the command");
  assert.equal(shell.at(-1).aggregatedOutput,"ok 1\nok 2\n");
  assert.equal(shell.at(-1).exitCode,0,"Muse's run record carries the exit code");
  await session.close();
});

test("tools map to rows: an edit keeps its exact old and new text, a write its content, a patch its diff, a search its hits",()=>{
  const item=fields=>({itemId:"native-item",kind:"toolCall",status:"completed",revision:1,...fields});
  const edit=acpToolFrame(museToolUpdate(item({tool:"edit_file",args:JSON.stringify({file_path:"src/index.ts",old_string:"old\n",new_string:""})})));
  assert.equal(edit.kind,"edit");assert.equal(edit.status,"completed");
  assert.deepEqual(edit.content,[{type:"diff",path:"src/index.ts",oldText:"old\n",newText:""}]);
  assert.deepEqual(edit.changes,[{path:"src/index.ts",kind:"update",oldText:"old\n",newText:""}]);
  const write=acpToolFrame(museToolUpdate(item({tool:"write_file",args:JSON.stringify({path:"README.md",content:"Hello\n"})})));
  assert.deepEqual(write.changes,[{path:"README.md",kind:"add",newText:"Hello\n"}]);
  const patch=acpToolFrame(museToolUpdate(item({tool:"apply_patch",args:JSON.stringify({path:"README.md",patch:"@@ -1 +1 @@\n-old\n+new"})})));
  assert.deepEqual(patch.changes,[{path:"README.md",kind:"update",diff:"@@ -1 +1 @@\n-old\n+new"}]);
  for(const status of ["rejected","timedOut","handedOff"]){
    const failed=museToolUpdate(item({tool:"search_files",status,fallbackText:"Native explanation"}));
    assert.equal(failed.status,"failed",status);
    assert.equal(failed.rawOutput,`Muse Code reported ${status}.\nNative explanation`);
    assert.equal(failed.title,`search_files: Muse Code reported ${status}.`);
  }
  const search=museToolUpdate(item({tool:"web_search",args:JSON.stringify({query:"node lts"}),visibleOutput:JSON.stringify({query:"node lts",results:[{url:"https://nodejs.org/",title:"Node.js",snippet:"Node 24 is LTS",extra:1},{url:"",title:"",snippet:"No link"}]})}));
  assert.equal(search.kind,"fetch");assert.equal(search.title,"web_search: node lts");
  assert.deepEqual(search.rawOutput,{query:"node lts",results:[{url:"https://nodejs.org/",title:"Node.js",snippet:"Node 24 is LTS"},{snippet:"No link"}]});
  assert.equal(search.content[0].content.text,"Node.js (https://nodejs.org/)\nNode 24 is LTS\n\nNo link");
  const page=museToolUpdate(item({tool:"web_fetch",args:JSON.stringify({url:"https://nodejs.org/en/about"}),visibleOutput:"About Node.js"}));
  assert.deepEqual(page.rawOutput.results,[{url:"https://nodejs.org/en/about",snippet:"About Node.js"}]);
  const shell=museToolUpdate({itemId:"u1",kind:"userShell",status:"completed",revision:2,commandText:"git status",visibleOutput:"clean",exitCode:0,turnId:null});
  assert.deepEqual([shell.kind,shell.title,shell.rawOutput,shell.exitCode],["execute","git status","clean",0]);
  const other=museToolUpdate(item({tool:"read_file",args:"{\"path\":\"a.txt\"",status:"inProgress"}));
  assert.deepEqual([other.kind,other.title,other.status,other.rawInput],["other","read_file","in_progress",{args:"{\"path\":\"a.txt\""}],"arguments still streaming stay as text");
  assert.equal(museToolUpdate(item({kind:"subagent",tool:undefined,objective:"Review the diff"})).title,"Subagent · Review the diff");
});

test("Stop interrupts the running turn and waits for Muse's turn/completed: a recorded interrupted turn ends as a stop the person asked for",async()=>{
  assert.equal(MUSE_INTERRUPT_TIMEOUT_MS,30_000);
  const {session,muse}=await startSession({muse:child=>new ReplayMuse(child,"turn_interrupt")});
  const result=await session.prompt([{type:"text",text:"Do not answer immediately."}],{onDelivered:()=>void session.cancel()});
  assert.equal(result.stopReason,"cancelled");
  assert.equal(result.interrupted,true);
  assert.equal(result.raw.reason,"cancelled during model step");
  const [interrupt]=muse.frames.filter(frame=>frame.method==="turn/interrupt");
  assert.equal(interrupt.params.turnId,muse.frames.find(frame=>frame.method==="turn/start").params.commandId);
  assert.deepEqual(muse.unexpected,[]);
  assert.equal(session.dead,false,"the host stays for the next turn");
  await session.close();
});

test("a Stop Muse does not confirm within the wait drops the host, and the turn ends stopped",async()=>{
  const stops=[];
  const {session,muse}=await startSession({options:{interruptTimeoutMs:40,stopTree:async target=>{stops.push(target.pid);target.exit(1)}}});
  const running=session.prompt([{type:"text",text:"go"}]);
  await muse.next("turn/start");
  const cancelling=session.cancel();
  await muse.next("turn/interrupt");
  await cancelling;
  assert.deepEqual(await running,{stopReason:"cancelled",interrupted:true,providerMessageId:null});
  assert.equal(session.dead,true,"the next message starts a new host");
  await until(()=>muse.stdinEnded,"the host's input to end");
  await session.close();
});

test("a message steers only the running turn, naming the turn it is meant for",async()=>{
  const {session,muse}=await startSession();
  await assert.rejects(session.steer([{type:"text",text:"Focus on the parser"}]),/no running turn to steer/);
  assert.equal(muse.sent("turn/steer").length,0);
  const running=session.prompt([{type:"text",text:"go"}]);
  const {params:{commandId:turnId}}=await muse.next("turn/start");
  assert.deepEqual(await session.steer([{type:"text",text:"Focus on the parser"}]),{accepted:true,pending:0,providerMessageId:null});
  const [steer]=muse.sent("turn/steer");
  assert.equal(steer.params.expectedTurnId,turnId);
  assert.deepEqual(steer.params.input,[{type:"text",text:"Focus on the parser"}]);
  muse.handlers["turn/steer"]=params=>({commandId:params.commandId,status:"accepted",turnId:"01a00000-0000-7000-8000-0000000000aa"});
  await assert.rejects(session.steer([{type:"text",text:"more"}]),/another turn than the running one/);
  muse.notify("turn/completed",{sessionId:session.sessionId,viewCursor:"v",terminal:"completed",turnId});
  await running;
  await assert.rejects(session.steer([{type:"text",text:"late"}]),/no running turn to steer/);
  await session.close();
});

test("a recorded approval asks the person once with Muse's own choices, its request gets the presentation receipt, and their Reject sends Muse's abort for the stage asked",async()=>{
  const asked=[];
  const {session,muse,updates}=await startSession({muse:child=>new ReplayMuse(child,"permission"),options:{onPermission:request=>{asked.push(request);return "decline"}}});
  const result=await session.prompt([{type:"text",text:"Run the shell command `touch muse-declined.txt` with your shell tool once."}]);
  assert.equal(result.stopReason,"end_turn");
  assert.equal(chunks(updates),"REJECTED");
  assert.equal(asked.length,1,"the request and its notification are asked once");
  assert.deepEqual(asked[0].approvalOptions,[{decision:"accept",label:"Allow once"},{decision:"acceptAlways",label:"Always allow in this workspace: touch ..."},{decision:"decline",label:"Reject"}]);
  assert.deepEqual(asked[0].params.toolCall,{toolCallId:"call_01a11a6d8ddc760a8b514b4cfbb683c7",title:"touch muse-declined.txt",kind:"execute",rawInput:{command:"touch muse-declined.txt"}});
  const decide=muse.frames.find(frame=>frame.method==="approval/decide");
  assert.equal(decide.params.choiceId,"abort","Muse's Reject; the 'Always allow' rule is never chosen for the person");
  assert.deepEqual(decide.params.requirementId,{approvalId:decide.params.approvalId,sourceIndex:0});
  assert.equal("feedback" in decide.params,false);
  const receipt=muse.frames.find(frame=>frame.method===undefined&&frame.result!==undefined);
  assert.deepEqual(receipt.result,{},"the server request gets the presentation receipt");
  assert.equal(muse.frames.filter(frame=>frame.method==="approval/decide").length,1,"the request and its notification are decided once");
  assert.equal(updates.some(update=>String(update.toolCallId||"").startsWith("muse-approval:")),false,"no row of Trebell's own: the person was asked");
  assert.deepEqual(muse.unexpected,[]);
  await session.close();
});

test("Muse's questions are asked in the question dialog and answered with userInput/answer, and a file approval is declined with Muse's denied choice",async()=>{
  const choices=museApprovalChoices([{choiceId:"allow_once",decision:"approved",scope:"once"},{choiceId:"keep_out",decision:"deniedPolicyAmendment",scope:"localPersistent"},{choiceId:"abort",decision:"abort",scope:"once"},{choiceId:"deny_session",decision:"denied",scope:"session"},{choiceId:"deny",decision:"denied",scope:"once"}]);
  assert.deepEqual([choices.get("decline").choiceId,choices.get("cancel").choiceId,choices.get("accept").choiceId],["deny","abort","allow_once"],"the narrowest Reject, never one that saves a rule");
  assert.equal(museApprovalChoices([{choiceId:"abort",decision:"abort",scope:"once"}]).get("decline").choiceId,"abort","a shell approval's Reject is its abort");
  const questions=[],approvals=[];
  const {session,muse,updates}=await startSession({options:{onQuestion:request=>{questions.push(request);return {lang:["TS"]}},onPermission:request=>{approvals.push(request);return "decline"}}});
  const running=session.prompt([{type:"text",text:"go"}]);
  const {params:{commandId:turnId}}=await muse.next("turn/start");
  const sid=session.sessionId;
  const question={sessionId:sid,userInputId:"q-1",turnId,itemId:"t-1",toolCallId:"call_1",toolName:"request_user_input",viewCursor:"v",questions:[{id:"lang",header:"Language",question:"Which language should the parser use?",options:[{label:"TS"},{label:"JS"}],selection:{mode:"single"}}]};
  muse.write({jsonrpc:"2.0",id:7,method:"userInput/request",params:question});
  muse.notify("userInput/requested",question);
  const answer=await muse.next("userInput/answer");
  assert.deepEqual({...answer.params,commandId:"C"},{sessionId:sid,userInputId:"q-1",answers:[{questionId:"lang",selectedLabel:"TS"}],commandId:"C"});
  assert.equal(questions.length,1,"the request and its notification are asked once");
  assert.deepEqual(questions[0].input.questions,[{id:"lang",header:"Language",question:"Which language should the parser use?",multiSelect:false,allowCustomAnswer:true,options:[{label:"TS",description:""},{label:"JS",description:""}]}]);
  // A file approval offering a denied choice is declined with it.
  const approval={sessionId:sid,approvalId:"ap-1",turnId,itemId:"ap-1",taskId:"ap-1",toolCallId:"call_2",toolName:"write_file",rawArgs:"{}",judgeEscalated:false,protectedWrite:false,viewCursor:"v",sourceRange:{},subject:{kind:"fileAccess",access:"write",path:"../outside.txt"},currentRequirementId:{approvalId:"ap-1",sourceIndex:0},availableChoices:[{choiceId:"yes",decision:"approved",scope:"once",label:"Allow once"},{choiceId:"no",decision:"denied",scope:"once",label:"Reject"}]};
  muse.notify("approval/requested",approval);
  const decide=await muse.next("approval/decide");
  assert.equal(decide.params.choiceId,"no");
  assert.equal("feedback" in decide.params,false);
  assert.deepEqual(approvals[0].params.toolCall,{toolCallId:"call_2",title:"../outside.txt",kind:"edit",rawInput:{path:"../outside.txt",access:"write"}});
  muse.notify("turn/completed",{sessionId:sid,viewCursor:"v",terminal:"completed",turnId});
  await running;
  await until(()=>muse.frames.some(frame=>frame.id===7&&frame.result),"the question's receipt");
  assert.equal(muse.sent("userInput/cancel").length,0);
  assert.deepEqual(updates.filter(update=>update.sessionUpdate==="tool_call").map(update=>update.title),[],"no row of Trebell's own: the person was asked");
  await session.close();
});

test("a failed turn rejects with Muse's own error, and a host that exits during a turn ends it once with its reason; one that exits while idle leaves the session dead, saying so as no turn's, with what the next message does",async()=>{
  const failed=await startSession();
  const turn=failed.session.prompt([{type:"text",text:"go"}]);
  const {params:{commandId:turnId}}=await failed.muse.next("turn/start");
  failed.muse.notify("turn/completed",{sessionId:failed.session.sessionId,viewCursor:"v",terminal:"failed",turnId,reason:"model step failed: upstream answered 500",error:{kind:"modelError",message:"model step failed: upstream answered 500",retryable:false}});
  await assert.rejects(turn,error=>{assert.equal(error.message,"model step failed: upstream answered 500");assert.equal(error.code,"modelError");return true});
  assert.equal(failed.session.dead,false);
  await failed.session.close();

  const dying=await startSession();
  const running=dying.session.prompt([{type:"text",text:"go"}]);
  await dying.muse.next("turn/start");
  dying.child.stderr.write("panic: lost the model stream\n");
  setImmediate(()=>dying.child.exit(1));
  await assert.rejects(running,/^Error: Muse Code exited unexpectedly \(code 1\): panic: lost the model stream$/);
  assert.equal(dying.session.dead,true);
  assert.equal(dying.updates.filter(update=>update.sessionUpdate==="runtime_error").length,0,"the turn carries the reason, once");
  await assert.rejects(dying.session.prompt([{type:"text",text:"again"}]),/exited unexpectedly/);
  await dying.session.close();

  const idle=await startSession();
  idle.child.exit(4);
  await until(()=>idle.session.dead,"the idle host to be seen gone");
  assert.deepEqual(idle.updates.filter(update=>update.sessionUpdate==="runtime_error").map(update=>[update.message,update.turnless]),[["Another Muse Code process holds this session; close it and try again (exit code 4). The next message starts Muse Code again.",true]]);
  await idle.session.close();
});

test("a host that exits during a turn while a tool it started holds its output ends the turn with its exit at once, lets go of its pipes, and on Windows closes without a tree stop",async()=>{
  const stops=[];
  const {session,child,muse,updates}=await startSession({platform:"win32",options:{stopTree:async target=>{stops.push(target.pid)}}});
  const running=session.prompt([{type:"text",text:"go"}]);
  await muse.next("turn/start");
  child.stderr.write("panic: lost the model stream\n");
  setImmediate(()=>child.exitHeld(1));
  await settlesWithin(assert.rejects(running,/^Error: Muse Code exited unexpectedly \(code 1\): panic: lost the model stream$/),5000,"the turn");
  assert.equal(session.dead,true);
  assert.equal(updates.filter(update=>update.sessionUpdate==="runtime_error").length,0,"the turn carries the reason, once");
  assert.deepEqual([child.stdin.destroyed,child.stdout.destroyed,child.stderr.destroyed],[true,true,true],"Trebell let go of its ends of the pipes the tool still holds");
  await settlesWithin(session.close(),1000,"close()");
  assert.deepEqual(stops,[],"a launcher that has exited is not stopped: its pid may be another process's by now");
});

test("the frames Muse wrote just before it exited still reach the turn, and an idle host whose tool holds its output is reported gone once",async()=>{
  const {session,child,muse,updates}=await startSession();
  const running=session.prompt([{type:"text",text:"go"}]);
  const {params:{commandId:turnId}}=await muse.next("turn/start");
  // Muse exits as it ends the turn; its last frame is read a moment after the exit.
  child.exitHeld(0);
  realSetTimeout(()=>muse.notify("turn/completed",{sessionId:session.sessionId,viewCursor:"v",terminal:"completed",turnId}),100);
  assert.equal((await settlesWithin(running,5000,"the turn")).stopReason,"end_turn");
  await until(()=>session.dead,"the idle host to be seen gone",5000);
  assert.deepEqual(updates.filter(update=>update.sessionUpdate==="runtime_error").map(update=>update.message),["Muse Code exited unexpectedly (code 0). The next message starts Muse Code again."]);
  await session.close();
});

test("close() of a host that exits as its input ends, while a tool it started holds its output, returns once it has exited, on Windows without a tree stop",async()=>{
  const stops=[];
  const {session,child,muse}=await startSession({platform:"win32",muse:child=>new FakeMuse(child,{exitOnEof:false}),options:{stopTree:async target=>{stops.push(target.pid);target.exit(1)}}});
  child.stdin.on("end",()=>setImmediate(()=>child.exitHeld(0)));
  const started=Date.now();
  await settlesWithin(session.close(),5000,"close()");
  assert.ok(Date.now()-started<5000,"no wait for the 10 s shutdown budget");
  assert.equal(muse.stdinEnded,true);
  assert.deepEqual(stops,[]);
  assert.deepEqual(session.host.exit,{code:0,signal:null},"the exit Muse ended with");
});

test("on Windows the process-tree stop leaves a launcher that has exited alone, and stops a running one's tree",async()=>{
  const spawned=[],spawnFn=(command,args)=>{spawned.push([command,...args]);const killer=new EventEmitter();setImmediate(()=>killer.emit("exit",0));return killer};
  const exited=Object.assign(fakeChild(),{exitCode:1}),signalled=Object.assign(fakeChild(),{exitCode:null,signalCode:"SIGKILL"});
  await stopMuseProcessTree(exited,{platform:"win32",spawnFn});
  await stopMuseProcessTree(signalled,{platform:"win32",spawnFn});
  assert.deepEqual(spawned,[],"no taskkill for a pid Windows may have given another process");
  await stopMuseProcessTree(fakeChild(),{platform:"win32",spawnFn});
  assert.deepEqual(spawned,[["taskkill","/PID","4242","/T","/F"]]);
});

test("on Linux and macOS the process-tree stop still reaches the process group of a launcher that has exited: SIGTERM, then SIGKILL once the grace has passed only while any of it is left",async t=>{
  const exited=Object.assign(fakeChild(),{exitCode:1});
  // A process the launcher started, still in its group and holding its output, that ends on SIGTERM.
  const yielding=fakeProcessGroup(t,exited,{yielding:1});
  await stopMuseProcessTree(exited,{platform:"linux",graceMs:5000});
  assert.deepEqual([yielding.sent,yielding.members.length],[["SIGTERM"],0],"no SIGKILL once nothing of the group is left");
  yielding.restore();
  // One that outlives SIGTERM gets SIGKILL when the grace has passed.
  const stubborn=fakeProcessGroup(t,exited,{stubborn:1}),started=Date.now();
  await stopMuseProcessTree(exited,{platform:"linux",graceMs:200});
  assert.deepEqual([stubborn.sent,stubborn.members.length],[["SIGTERM","SIGKILL"],0]);
  assert.ok(Date.now()-started>=200,"SIGKILL only once the grace has passed");
  assert.deepEqual(exited.signals,[],"the signals went to the group, not to the launcher alone");
});

test("on Linux and macOS a host that exits while a process it started still holds its output is reported gone, and that process is stopped with the host's process group",async t=>{
  const {session,child,updates}=await startSession({platform:"linux",options:{stopTree:stopMuseProcessTree}});
  const group=fakeProcessGroup(t,child,{yielding:1});
  child.exitHeld(1);
  await until(()=>session.dead,"the host to be seen gone");
  await until(()=>!group.members.length,"the process left in the host's group to be stopped");
  assert.deepEqual(group.sent,["SIGTERM"]);
  assert.deepEqual(updates.filter(update=>update.sessionUpdate==="runtime_error").map(update=>update.message),["Muse Code exited unexpectedly (code 1). The next message starts Muse Code again."]);
  await settlesWithin(session.close(),1000,"close()");
});

test("on Linux and macOS close() of a host that exits as its input ends, while a process it started holds its output, stops that process with the host's process group and does not wait for the shutdown budget",async t=>{
  const {session,child,muse}=await startSession({platform:"linux",muse:child=>new FakeMuse(child,{exitOnEof:false}),options:{stopTree:stopMuseProcessTree}});
  const group=fakeProcessGroup(t,child,{yielding:1});
  child.stdin.on("end",()=>setImmediate(()=>child.exitHeld(0)));
  const started=Date.now();
  await settlesWithin(session.close(),5000,"close()");
  assert.ok(Date.now()-started<5000,"no wait for the 10 s shutdown budget");
  assert.equal(muse.stdinEnded,true);
  assert.deepEqual([group.sent,group.members.length],[["SIGTERM"],0]);
  assert.deepEqual(session.host.exit,{code:0,signal:null},"the exit Muse ended with");
});

test("on Linux and macOS a host still running at the shutdown deadline gets SIGTERM for its process group, and SIGKILL once the grace has passed while a process of it is left, though the host itself ended on SIGTERM",async t=>{
  const {session,child}=await startSession({platform:"linux",muse:child=>new FakeMuse(child,{exitOnEof:false}),options:{shutdownTimeoutMs:50,stopTree:stopMuseProcessTree}});
  const group=fakeProcessGroup(t,child,{stubborn:1}),started=Date.now();
  await settlesWithin(session.close(),8000,"close()");
  assert.equal(child.signalCode,"SIGTERM","the host ended on the group's SIGTERM, while the process left in its group held its output");
  assert.deepEqual([group.sent,group.members.length],[["SIGTERM","SIGKILL"],0]);
  assert.ok(Date.now()-started>=2000,"SIGKILL once the 2 s grace has passed");
});

test("a command Muse does not answer within 30 s stops the host",async()=>{
  assert.equal(MUSE_REQUEST_TIMEOUT_MS,30_000);
  // Only the turn's own command races the short bound: the session starts on the default one, and is answered here more slowly than
  // that bound, as a loaded machine may answer it.
  const slowStart=params=>new Promise(resolve=>realSetTimeout(()=>resolve(DEFAULT_HANDLERS["session/start"](params)),100));
  const {session,muse}=await startSession({muse:child=>new FakeMuse(child,{handlers:{"session/start":slowStart}})});
  session.requestTimeoutMs=40;
  muse.handlers["turn/start"]=()=>undefined;
  await assert.rejects(session.prompt([{type:"text",text:"go"}]),/did not answer within 0 seconds when asked to start the turn, so Trebell stopped it/);
  assert.equal(session.dead,true);
  await until(()=>muse.stdinEnded,"the host to be closed");
  await session.close();
});

test("Meta's SDK loads with the first Muse session, never when the session module loads",async()=>{
  const run=await mkdtemp(join(tmpdir(),"trebell-muse-sdk-")),log=join(run,"modules.log");
  try{
    const recorder=new URL("./fixtures/module-load-recorder.mjs",import.meta.url).href,session=new URL("../src/muse-agent-session.mjs",import.meta.url).href,host=new URL("../src/muse-host.mjs",import.meta.url).href;
    // The child waits after the import until the parent has read what it loaded, then starts what a first host starts.
    const script=`await import(${JSON.stringify(session)});process.stdout.write("imported\\n");await new Promise(resolve=>process.stdin.once("data",resolve));const {loadMuseSdk}=await import(${JSON.stringify(host)});await loadMuseSdk();process.stdout.write("loaded\\n");process.exit(0);`;
    const child=spawn(process.execPath,["--import",recorder,"--input-type=module","-e",script],{env:{...process.env,TREBELL_MODULE_LOAD_LOG:log},windowsHide:true,stdio:["pipe","pipe","pipe"]});
    let output="",checked=false,sdkAtImport=null;
    child.stdout.on("data",async chunk=>{
      output+=chunk;
      if(checked||!output.includes("imported"))return;
      checked=true;sdkAtImport=(await readFile(log,"utf8").catch(()=>"")).includes("/node_modules/@muse-code/sdk/");child.stdin.write("go\n");
    });
    const code=await new Promise(resolve=>child.once("exit",resolve));
    assert.equal(code,0,output);
    await until(()=>sdkAtImport!==null,"the import check");
    assert.equal(sdkAtImport,false,"importing the session module loads no SDK");
    assert.match(await readFile(log,"utf8"),/\/node_modules\/@muse-code\/sdk\/dist\/src\/index\.js/,"the first host loads it");
  }finally{await rm(run,{recursive:true,force:true})}
  const sdk=await loadMuseSdk();
  assert.equal(typeof sdk.Connection,"function");
  let loads=0;
  const {session}=await startSession({options:{loadSdk:()=>{loads++;return loadMuseSdk()}}});
  assert.equal(loads,1);
  await session.close();
});

// A stand-in `muse serve` behind a launcher like Meta's (muse.cmd runs PowerShell, which runs muse-bin; here the launcher runs
// node): it answers initialize with what it was started with, and ignores its closed input when MUSE_FAKE_HANG is set.
async function realLauncher(folder){
  const server=join(folder,"fake-muse-serve.cjs");
  await writeFile(server,[
    "const lines=require('node:readline').createInterface({input:process.stdin});",
    `const init=${JSON.stringify(INIT)};`,
    // MUSE_FAKE_ORPHAN: the server starts a process that inherits its stdio and outlives it, as a browser a tool started does: on
    // Linux and macOS in the host's process group, as a tool Muse starts is; on Windows detached, as Windows otherwise ends it with
    // the server.
    "const orphan=()=>{if(!process.env.MUSE_FAKE_ORPHAN)return {};const left=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit',detached:process.platform==='win32',windowsHide:true});left.unref();return {orphanPid:left.pid}};",
    "lines.on('line',line=>{const frame=JSON.parse(line);if(frame.method==='initialize')process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:frame.id,result:{...init,serverInfo:{name:'muse',version:String(process.env.MUSE_NO_AUTO_UPDATE)},userAgent:process.argv.slice(2).join(' ')+' | '+process.cwd(),museHome:String(process.pid),...orphan()}})+'\\n')});",
    "lines.on('close',()=>{if(process.env.MUSE_FAKE_HANG)setInterval(()=>{},1000);else process.exit(0)});",
  ].join("\n"));
  if(process.platform==="win32"){
    const launcher=join(folder,"muse.cmd");
    await writeFile(launcher,`@echo off\r\nsetlocal\r\n"${process.execPath}" "%~dp0fake-muse-serve.cjs" %*\r\nexit /b %ERRORLEVEL%\r\n`);
    return launcher;
  }
  const launcher=join(folder,"muse");
  await writeFile(launcher,`#!/bin/sh\n"${process.execPath}" "$(dirname "$0")/fake-muse-serve.cjs" "$@"\n`);await chmod(launcher,0o755);
  return launcher;
}
test("a real launcher in a folder with spaces and cmd metacharacters starts Muse's host with its arguments and MUSE_NO_AUTO_UPDATE, and a host that ignores its closed input has its whole tree stopped",{timeout:60000},async()=>{
  const folder=await mkdtemp(join(tmpdir(),"trebell muse (a&b) "));
  try{
    const launcher=await realLauncher(folder);
    const host=new MuseHost({command:launcher,args:museServeArgs(),cwd:folder,env:{...process.env}});
    await host.start({version:"1.6.0"});
    assert.equal(host.initializeResult.serverInfo.version,"1","MUSE_NO_AUTO_UPDATE=1 reached Muse");
    assert.equal(host.initializeResult.userAgent,`serve --trust-workspace | ${folder}`);
    const closing=Date.now();await host.close();
    assert.equal(host.exit.code,0,"Muse ended when its input closed");
    assert.ok(Date.now()-closing<5000);
    const hanging=new MuseHost({command:launcher,args:museServeArgs(),cwd:folder,env:{...process.env,MUSE_FAKE_HANG:"1"},shutdownTimeoutMs:300});
    await hanging.start({version:"1.6.0"});
    // The launcher, and the server it started (which names its pid in museHome).
    const pid=hanging.pid,server=Number(hanging.initializeResult.museHome),stopping=Date.now();
    assert.ok(server>0&&server!==pid);
    await hanging.close();
    assert.ok(Date.now()-stopping>=300,"the tree stop waits for the shutdown budget");
    assert.ok(hanging.exit,"the stopped host's exit is observed");
    const alive=target=>{try{process.kill(target,0);return true}catch(error){return error.code==="EPERM"}};
    await until(()=>!alive(pid)&&!alive(server),"the launcher and its server to end",10000);
  }finally{await rm(folder,{recursive:true,force:true})}
});

test("a real host whose server exits while a process it started still holds its output is seen gone at once, and its close does not wait for the shutdown budget: on Linux and macOS it ends that process, still in the host's process group, and on Windows it runs no tree stop",{timeout:60000},async()=>{
  const folder=await mkdtemp(join(tmpdir(),"trebell-muse-orphan-"));let orphan=0;
  const windows=process.platform==="win32",alive=pid=>{try{process.kill(pid,0);return true}catch(error){return error.code==="EPERM"}};
  try{
    const launcher=await realLauncher(folder),stops=[];
    // On Windows the tree stop is recorded, not run: run against a launcher that has exited, taskkill could reach a process given its
    // pid. Elsewhere the real one runs.
    const host=new MuseHost({command:launcher,args:museServeArgs(),cwd:folder,env:{...process.env,MUSE_FAKE_ORPHAN:"1"},...(windows?{stopTree:async target=>{stops.push(target.pid)}}:{})});
    await host.start({version:"1.6.0"});
    orphan=Number(host.initializeResult.orphanPid);assert.ok(orphan>0,"the server started the process that holds its output");
    const closing=Date.now();
    await settlesWithin(host.close(),5000,"close()");
    assert.ok(Date.now()-closing<5000,"no wait for the 10 s shutdown budget");
    assert.deepEqual(host.exit,{code:0,signal:null},"the launcher's own exit, once its server ended with its input");
    if(windows)assert.deepEqual(stops,[],"no tree stop for a launcher that has exited");
    else await until(()=>!alive(orphan),"the process left in the host's process group to end",2000);
  }finally{
    if(orphan)try{process.kill(orphan)}catch{}
    await rm(folder,{recursive:true,force:true,maxRetries:20,retryDelay:100});
  }
});

test("the process-tree stop ends a launcher and the process it started (real processes)",async()=>{
  const script="const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});process.stdout.write(c.pid+'\\n');setInterval(()=>{},1000);";
  const launcher=spawn(process.execPath,["-e",script],{stdio:["pipe","pipe","pipe"],windowsHide:true,detached:process.platform!=="win32"});
  const exited=new Promise(resolve=>launcher.once("close",(code,signal)=>resolve({code,signal})));
  const grandchild=await new Promise(resolve=>{let out="";launcher.stdout.on("data",chunk=>{out+=chunk;if(out.includes("\n"))resolve(Number(out.trim()))})});
  const alive=pid=>{try{process.kill(pid,0);return true}catch(error){return error.code==="EPERM"}};
  assert.ok(alive(launcher.pid)&&alive(grandchild));
  await stopMuseProcessTree(launcher);
  await exited;
  await until(()=>!alive(grandchild),"the launcher's child to end",10000);
  assert.equal(alive(launcher.pid),false);
});
