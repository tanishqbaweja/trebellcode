import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp,mkdir,readFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile,spawn } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { createNativeBuiltins } from "../src/native-builtins.mjs";
import { NativeBackgroundProcessManager } from "../src/native-background-processes.mjs";
import { EnvironmentManager } from "../src/environment-manager.mjs";

async function waitFor(check,{timeout=3000}={}){
  const started=Date.now();for(;;){const value=await check();if(value)return value;if(Date.now()-started>timeout)throw new Error("Timed out waiting for Native background process");await new Promise(resolve=>setTimeout(resolve,20))}
}

test("Native background processes outlive the tool call, keep bounded output, and do not inherit unrelated secrets",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-bg-"));await mkdir(join(root,"src"),{recursive:true});
  const environment={...process.env,NATIVE_BACKGROUND_SECRET:"do-not-leak"},manager=new NativeBackgroundProcessManager({environment}),events=[];manager.onEvent=event=>events.push(event);
  try{
    const execute=createNativeBuiltins({root,environment,backgroundProcesses:manager,threadId:"thread-a"});
    const script="process.stdout.write(JSON.stringify({secret:process.env.NATIVE_BACKGROUND_SECRET||null}));setInterval(()=>{},1000)";
    const started=await execute({namespace:"trebell_process",name:"start",arguments:{command:process.execPath,args:["-e",script,environment.NATIVE_BACKGROUND_SECRET],cwd:"src",max_output_bytes:4096}});
    assert.equal(started.running,true);assert.ok(started.processId);assert.equal(started.cwd,join(root,"src"));
    assert.doesNotMatch(started.command,/do-not-leak/);assert.match(started.command,/\[redacted\]/);
    const status=await waitFor(()=>{const current=execute({namespace:"trebell_process",name:"status",arguments:{process_id:started.processId}});return current.then(item=>item.stdout?item:null)});
    assert.deepEqual(JSON.parse(status.stdout),{secret:null});assert.equal(manager.list("thread-a").data.length,1);assert.equal(manager.list("thread-b").data.length,0);
    await assert.rejects(()=>execute({namespace:"trebell_process",name:"status",arguments:{process_id:"missing"}}),/not found/i);
    const stopped=await execute({namespace:"trebell_process",name:"stop",arguments:{process_id:started.processId}});assert.equal(stopped.running,false);assert.equal(manager.list("thread-a").data.length,0);
    assert.ok(events.some(event=>event.name==="native.background.started"));assert.ok(events.some(event=>event.name==="native.background.terminated"));
  }finally{await manager.closeAll();await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("Native background processes preserve remote argv isolation metadata instead of exposing the parent environment",async()=>{
  const stdout=new PassThrough(),stderr=new PassThrough(),child=new EventEmitter();Object.assign(child,{stdout,stderr,pid:4321,kill(){queueMicrotask(()=>child.emit("close",0,"SIGTERM"));return true}});
  let launch=null;const environments={get:id=>id==="ssh-1"?{id:"ssh-1",name:"Build",type:"ssh",cwd:"/srv/app"}:null,spawnArgv:(id,options)=>{launch={id,options};return child}};
  const manager=new NativeBackgroundProcessManager({environments,environment:{TOP_SECRET:"hidden"}});
  try{
    const started=manager.start({threadId:"thread-r",command:"node",args:["server.js"],cwd:"/srv/app",environmentId:"ssh-1",environmentNames:["PATH","HOME"]});
    assert.equal(started.environmentType,"ssh");assert.equal(Object.prototype.hasOwnProperty.call(started,"osPid"),false);assert.equal(launch.id,"ssh-1");assert.deepEqual(launch.options.environmentNames,["PATH","HOME"]);assert.equal(launch.options.environment,null);
    await manager.terminate("thread-r",started.processId);
  }finally{await manager.closeAll()}
});

// What a Node child needs from this machine to start, and nothing else of its environment: no one's real secrets reach these tests.
function hostBaseline(){
  const wanted=new Set(["PATH","SYSTEMROOT","WINDIR","COMSPEC","TEMP","TMP","TMPDIR","HOME","USERPROFILE"]);
  return Object.fromEntries(Object.keys(process.env).filter(name=>wanted.has(name.toUpperCase())).map(name=>[name,process.env[name]]));
}

test("Native background processes keep the project's toolchain variables, and a remote one forwards their names through the guarded list",async()=>{
  const toolchain={GEM_HOME:"/fixture/bundle",BUNDLE_PATH:"/fixture/bundle",CARGO_HOME:"/fixture/cargo",RUSTUP_HOME:"/fixture/rustup",JAVA_HOME:"/fixture/jdk",GOPATH:"/fixture/go",VIRTUAL_ENV:"/fixture/venv"};
  const secrets={OPENAI_API_KEY:"sk-fixture-openai",ANTHROPIC_API_KEY:"sk-ant-fixture",GITHUB_TOKEN:"ghp_fixture",AWS_SECRET_ACCESS_KEY:"fixture-aws-secret",NATIVE_FIXTURE_TOKEN:"fixture-token",BUNDLE_GEMS__EXAMPLE__COM:"fixture-user:fixture-pass"};
  const root=await mkdtemp(join(tmpdir(),"trebell-native-bg-toolchain-")),manager=new NativeBackgroundProcessManager({environment:{...hostBaseline(),...toolchain,...secrets}});
  try{
    const names=[...Object.keys(toolchain),...Object.keys(secrets)];
    const script=`process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(names)}.map(name=>[name,process.env[name]??null]))))`;
    const started=manager.start({threadId:"thread-t",command:process.execPath,args:["-e",script],cwd:root});
    await manager.waitForExit("thread-t",started.processId,{waitMs:15_000});
    const status=manager.status("thread-t",started.processId);assert.equal(status.exitCode,0,status.stderr);
    assert.deepEqual(JSON.parse(status.stdout),{...toolchain,...Object.fromEntries(Object.keys(secrets).map(name=>[name,null]))});
  }finally{await manager.closeAll();await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
  const child=new EventEmitter();Object.assign(child,{stdout:new PassThrough(),stderr:new PassThrough(),pid:4321,kill(){queueMicrotask(()=>child.emit("close",0,"SIGTERM"));return true}});
  let launch=null;const environments={get:id=>id==="ssh-1"?{id:"ssh-1",name:"Build",type:"ssh",cwd:"/srv/app"}:null,spawnArgv:(id,options)=>{launch={id,options};return child}};
  const remote=new NativeBackgroundProcessManager({environments,environment:{...toolchain,...secrets}});
  try{
    const started=remote.start({threadId:"thread-r",command:"cargo",args:["test"],cwd:"/srv/app",environmentId:"ssh-1",environmentNames:["PATH","HOME"]});
    assert.deepEqual(launch.options.environmentNames,["PATH","HOME"]);assert.equal(launch.options.environment,null);
    const guarded=launch.options.guardedEnvironmentNames||[];
    for(const name of Object.keys(toolchain))assert.ok(guarded.includes(name),name);
    for(const name of Object.keys(secrets))assert.equal(guarded.includes(name),false,name);
    await remote.terminate("thread-r",started.processId);
  }finally{await remote.closeAll()}
});

// JAVA_TOOL_OPTIONS (which every JVM prints as it starts), JAVA_OPTS, MAVEN_OPTS, MAVEN_ARGS, GRADLE_OPTS and SBT_OPTS can hold a
// credential in a form its vendor documents that no check of names and shapes tells from a plain option (Honeycomb's
// -Dotel.exporter.otlp.headers=x-honeycomb-team=<key>, an Azure SAS's sig=, a user:password@host with no scheme), so a background
// process never gets them, holding one or not, here or from a remote host's own environment; the other toolchain variables it does.
const JVM_OPTION_FIXTURES=Object.freeze({
  credentials:Object.freeze({
    JAVA_TOOL_OPTIONS:"-Dotel.exporter.otlp.headers=x-honeycomb-team=hcaik_fixture",JAVA_OPTS:"-Dapp.blob.url=https://acct.blob.core.windows.net/c?sv=2022-11-02&sp=r&sig=fixture",
    MAVEN_OPTS:"-Ddsn=app:fixture-pass@tcp(db:3306)/app",MAVEN_ARGS:"-Dproxy=bob:fixture-pass@proxy.example:8080",
    GRADLE_OPTS:"-Dspring.cloud.azure.storage.blob.connection-string=BlobEndpoint=https://acct.blob.core.windows.net/;SharedAccessSignature=sv=2022-11-02&sig=fixture",
    SBT_OPTS:"-Daws.secretKey=fixture-secret",
  }),
  harmless:Object.freeze({JAVA_TOOL_OPTIONS:"-Dfile.encoding=UTF-8",JAVA_OPTS:"-Xmx2g",MAVEN_OPTS:"-XX:MaxRAMPercentage=75",MAVEN_ARGS:"-o",GRADLE_OPTS:"-Dorg.gradle.daemon=false",SBT_OPTS:"-Xss4m"}),
});
const JVM_TOOLCHAIN_FIXTURE=Object.freeze({GEM_HOME:"/fixture/bundle",JAVA_HOME:"/fixture/jdk",GRADLE_USER_HOME:"/fixture/gradle",RUSTUP_HOME:"/fixture/rustup"});
// A POSIX shell, as a WSL or SSH host has, where this machine has one (Git for Windows' sh, or the system's).
const posixShell=await new Promise(resolve=>execFile("sh",["-c","printf ok"],{windowsHide:true,timeout:20_000},(error,stdout)=>resolve(!error&&String(stdout)==="ok")));

test("Native background processes never get the JVM's or the build tools' option strings, holding a credential or not, and get the other toolchain variables",async()=>{
  for(const [kind,options] of Object.entries(JVM_OPTION_FIXTURES)){
    const root=await mkdtemp(join(tmpdir(),"trebell-native-bg-jvm-")),manager=new NativeBackgroundProcessManager({environment:{...hostBaseline(),...JVM_TOOLCHAIN_FIXTURE,...options}});
    try{
      const names=[...Object.keys(JVM_TOOLCHAIN_FIXTURE),...Object.keys(options)];
      const script=`process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(names)}.map(name=>[name,process.env[name]??null]))))`;
      const started=manager.start({threadId:"thread-j",command:process.execPath,args:["-e",script],cwd:root});
      await manager.waitForExit("thread-j",started.processId,{waitMs:15_000});
      const status=manager.status("thread-j",started.processId);assert.equal(status.exitCode,0,status.stderr);
      assert.deepEqual(JSON.parse(status.stdout),{...JVM_TOOLCHAIN_FIXTURE,...Object.fromEntries(Object.keys(options).map(name=>[name,null]))},kind);
    }finally{await manager.closeAll();await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
  }
});

// On a remote host the values are the host's own: environment-manager builds the command the process starts with there (the
// guarded names checked by the host's sh, env -i clearing the rest), and this machine's sh runs it as the host would, with those values.
test("Native background processes on a remote host never get its JVM or build tools' option strings, and get its other toolchain variables",{skip:!posixShell&&"no POSIX shell on this machine"},async()=>{
  const profile={id:"ssh-1",name:"Build",type:"ssh",cwd:"/srv/app",host:"build.example",port:22,enabled:true};
  for(const [kind,options] of Object.entries(JVM_OPTION_FIXTURES)){
    const environments=new EnvironmentManager({state:{environments:()=>[profile]},platform:"linux"}),host={...hostBaseline(),...JVM_TOOLCHAIN_FIXTURE,...options};
    environments.spawnSession=(_id,{command,stdio})=>spawn("sh",["-c",command],{env:host,stdio,windowsHide:true});
    const manager=new NativeBackgroundProcessManager({environments,environment:{}});
    try{
      const started=manager.start({threadId:"thread-jr",command:"env",args:[],cwd:"/srv/app",environmentId:profile.id});
      await manager.waitForExit("thread-jr",started.processId,{waitMs:15_000});
      const status=manager.status("thread-jr",started.processId);assert.equal(status.exitCode,0,status.stderr);
      const printed=Object.fromEntries(String(status.stdout||"").split(/\r?\n/).filter(line=>line.includes("=")).map(line=>[line.slice(0,line.indexOf("=")),line.slice(line.indexOf("=")+1)]));
      for(const name of Object.keys(options))assert.equal(printed[name],undefined,kind+": "+name+"="+options[name]);
      for(const [name,value] of Object.entries(JVM_TOOLCHAIN_FIXTURE))assert.equal(printed[name],value,kind+": "+name);
    }finally{await manager.closeAll()}
  }
});

test("Native background process stop terminates local descendants",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-bg-tree-")),pidPath=join(root,"descendant.pid"),manager=new NativeBackgroundProcessManager();
  try{
    const childScript="setInterval(()=>{},1000)";
    const parentScript=[
      "const {spawn}=require('node:child_process');",
      "const fs=require('node:fs');",
      `const child=spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'inherit'});`,
      `fs.writeFileSync(${JSON.stringify(pidPath)},String(child.pid));`,
      "setInterval(()=>{},1000);",
    ].join("");
    const started=manager.start({threadId:"thread-tree",command:process.execPath,args:["-e",parentScript],cwd:root});
    const descendantPid=await waitFor(async()=>{try{return Number(await readFile(pidPath,"utf8"))||null}catch{return null}});
    await manager.terminate("thread-tree",started.processId);
    let descendantAlive=true;
    for(let attempt=0;attempt<20&&descendantAlive;attempt++){
      try{process.kill(descendantPid,0);await new Promise(resolve=>setTimeout(resolve,50))}
      catch(error){if(error?.code==="ESRCH")descendantAlive=false;else throw error}
    }
    assert.equal(descendantAlive,false,"stopping a Native background process must not leave descendants running");
  }finally{await manager.closeAll();await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

function fakeRemoteEnvironment(){
  const children=[];
  const environments={get:id=>id==="ssh-1"?{id:"ssh-1",name:"Build",type:"ssh",cwd:"/srv/app"}:null,spawnArgv:()=>{
    const child=new EventEmitter();Object.assign(child,{stdout:new PassThrough(),stderr:new PassThrough(),pid:7000+children.length,kill(){queueMicrotask(()=>child.emit("close",0,"SIGTERM"));return true}});children.push(child);return child;
  }};
  return {environments,children};
}

test("Native background processes get short per-thread handles that resolve alongside their full ids",async()=>{
  const {environments}=fakeRemoteEnvironment(),manager=new NativeBackgroundProcessManager({environments,environment:{}});
  try{
    const start=(threadId,command)=>manager.start({threadId,command,args:["--serve"],cwd:"/srv/app",environmentId:"ssh-1",environmentNames:["PATH"]});
    const first=start("thread-a","node"),second=start("thread-a","python3"),other=start("thread-b","ruby");
    assert.equal(first.handle,"p1");assert.equal(second.handle,"p2");assert.equal(other.handle,"p1","handles count per thread");
    assert.match(first.processId,/^[0-9a-f-]{36}$/,"the real id is kept for the app and for old calls");
    assert.equal(manager.status("thread-a","p2").processId,second.processId);
    assert.equal(manager.status("thread-a"," P2 ").processId,second.processId,"a handle is matched without case or surrounding space");
    assert.equal(manager.status("thread-a",first.processId).handle,"p1","a full id is still accepted");
    assert.equal(manager.status("thread-b","p1").processId,other.processId);
    assert.throws(()=>manager.status("thread-b","p2"),/not found/i,"another thread's handle does not resolve");
    assert.throws(()=>manager.status("thread-b",first.processId),/not found/i,"another thread's id does not resolve");
    assert.deepEqual(manager.list("thread-a").data.map(item=>item.handle).sort(),["p1","p2"]);
    const stopped=await manager.terminate("thread-a","p1");assert.equal(stopped.handle,"p1");assert.equal(stopped.running,false);
    assert.equal(start("thread-a","deno").handle,"p3","a handle is never reused for a later process");
  }finally{await manager.closeAll()}
});

test("a thread's history sets where a new manager starts its handles, so a handle from before a restart never names a new process",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-bg-restart-")),first=new NativeBackgroundProcessManager(),second=new NativeBackgroundProcessManager();
  const idle=["-e","setInterval(()=>{},1000)"],{highestProcessHandle}=await import("../src/native-background-processes.mjs");
  try{
    const dev=first.start({threadId:"thread-1",command:process.execPath,args:idle,cwd:root});assert.equal(dev.handle,"p1");
    await first.closeAll();
    const thread={id:"thread-1",turns:[
      {items:[{type:"userMessage",content:[{type:"text",text:"Start p9 for me"}]},{type:"dynamicToolCall",namespace:"trebell_process",tool:"start",arguments:{command:"npm",args:["run","dev"]},rawOutput:dev}]},
      {items:[{type:"dynamicToolCall",namespace:"trebell_terminal",tool:"background_status",arguments:'{"process_id":"p1"}',rawOutput:'{"process_id":"p1","running":false}'},{type:"dynamicToolCall",namespace:"trebell_workspace",tool:"read_file",rawOutput:{handle:"p40"}}]},
    ]};
    assert.equal(highestProcessHandle(thread),1,"only process tools' calls and results are read");
    assert.equal(highestProcessHandle({turns:[{items:[{type:"dynamicToolCall",namespace:"trebell_process",tool:"list",rawOutput:{data:[{handle:"p3"},{handle:"p12"}]}}]}]}),12);
    assert.equal(highestProcessHandle({}),0);
    second.reserveHandles("thread-1",highestProcessHandle(thread));second.reserveHandles("thread-1",0);
    const watcher=second.start({threadId:"thread-1",command:process.execPath,args:idle,cwd:root});
    assert.equal(watcher.handle,"p2");
    assert.throws(()=>second.status("thread-1","p1"),/not found/,"the dev server's old handle does not reach the watcher");
    assert.equal(second.status("thread-1","p2").processId,watcher.processId);
    assert.equal(second.start({threadId:"thread-2",command:process.execPath,args:idle,cwd:root}).handle,"p1","other threads keep their own count");
  }finally{await first.closeAll();await second.closeAll();await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("Native process tools accept a short handle for status and stop",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-bg-handle-")),manager=new NativeBackgroundProcessManager();
  try{
    const execute=createNativeBuiltins({root,backgroundProcesses:manager,threadId:"thread-h"});
    const started=await execute({namespace:"trebell_process",name:"start",arguments:{command:process.execPath,args:["-e","process.stdout.write('ready');setInterval(()=>{},1000)"]}});
    assert.equal(started.handle,"p1");
    const status=await waitFor(async()=>{const current=await execute({namespace:"trebell_process",name:"status",arguments:{process_id:"p1"}});return current.stdout?current:null});
    assert.equal(status.processId,started.processId);assert.equal(status.stdout,"ready");
    const legacy=await execute({namespace:"trebell_terminal",name:"background_status",arguments:{process_id:"p1"}});assert.equal(legacy.processId,started.processId);
    const stopped=await execute({namespace:"trebell_process",name:"stop",arguments:{process_id:"p1"}});assert.equal(stopped.running,false);
  }finally{await manager.closeAll();await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("a process record gives each stream's retained text its absolute byte offsets, also after the tail is trimmed",async()=>{
  const {environments,children}=fakeRemoteEnvironment(),manager=new NativeBackgroundProcessManager({environments,environment:{}});
  try{
    const started=manager.start({threadId:"thread-o",command:"python3",args:["train.py"],cwd:"/srv/app",environmentId:"ssh-1",environmentNames:["PATH"],maxOutputBytes:1024});
    assert.deepEqual(started.outputOffsets,{stdout:{start:0,end:0},stderr:{start:0,end:0}});
    assert.deepEqual(Object.keys(started).slice(-4),["outputOffsets","stdout","stderr","truncated"],"the offsets come before the text, so a capped audit record keeps them");
    const child=children[0];child.stdout.write("x".repeat(700));child.stderr.write("warn\n");
    await new Promise(resolve=>setImmediate(resolve));
    let status=manager.status("thread-o","p1");
    assert.deepEqual(status.outputOffsets,{stdout:{start:0,end:700},stderr:{start:0,end:5}});assert.equal(status.truncated,false);
    child.stdout.write("y".repeat(900));await new Promise(resolve=>setImmediate(resolve));
    status=manager.status("thread-o","p1");
    assert.equal(status.truncated,true);assert.equal(status.outputOffsets.stdout.end,1600,"the end counts every byte written");
    assert.equal(status.outputOffsets.stdout.start,1600-Buffer.byteLength(status.stdout),"the start is where the retained text begins");
    assert.equal(status.outputOffsets.stdout.start,576);
    // A trim that would cut a character drops the rest of it too, so the text starts on a whole character, holds no replacement
    // character, and its start is the exact position of that character in everything written.
    child.stdout.write("a"+"é".repeat(600)+"b");await new Promise(resolve=>setImmediate(resolve));
    status=manager.status("thread-o","p1");const {start,end}=status.outputOffsets.stdout;
    // 1,024 retained + 1,202 written = 2,226 bytes; keeping the last 1,024 would start inside the 89th "é" (byte 1,202), so the
    // cut moves on to byte 1,203: 1,023 bytes are kept, from absolute byte 1,600+179.
    assert.equal(end,1600+1202);assert.equal(start,1600+179);assert.equal(end-start,Buffer.byteLength(status.stdout));
    assert.equal(Buffer.byteLength(status.stdout),1023);assert.ok(status.stdout.startsWith("é"));assert.equal(status.stdout.includes("�"),false);assert.ok(status.stdout.endsWith("éb"));
    assert.equal(Object.hasOwn(status.outputOffsets.stdout,"redacted"),false,"text redaction left alone has no redacted flag");
  }finally{await manager.closeAll()}
});

test("a process stream whose text redaction changed is flagged, since its offsets count what the process wrote",async()=>{
  const {environments,children}=fakeRemoteEnvironment(),manager=new NativeBackgroundProcessManager({environments,environment:{}});
  try{
    manager.start({threadId:"thread-r",command:"python3",args:["serve.py"],cwd:"/srv/app",environmentId:"ssh-1",environmentNames:["PATH"]});
    const child=children[0];child.stdout.write("password=abcdefghijklmnopq\n");child.stderr.write("listening\n");
    await new Promise(resolve=>setImmediate(resolve));
    const status=manager.status("thread-r","p1");
    assert.equal(status.stdout,"password=[redacted]\n");
    assert.deepEqual(status.outputOffsets,{stdout:{start:0,end:27,redacted:true},stderr:{start:0,end:10}});
  }finally{await manager.closeAll()}
});

test("waitForExit returns when the process exits, not when it writes output",async()=>{
  const {environments,children}=fakeRemoteEnvironment(),manager=new NativeBackgroundProcessManager({environments,environment:{}});
  try{
    manager.start({threadId:"thread-w",command:"python3",args:["run.py"],cwd:"/srv/app",environmentId:"ssh-1",environmentNames:["PATH"]});
    const child=children[0],started=Date.now();let settled=false;
    const waiting=manager.waitForExit("thread-w","p1",{waitMs:5000}).then(()=>{settled=true});
    child.stdout.write("progress 1\n");await new Promise(resolve=>setTimeout(resolve,60));
    assert.equal(settled,false,"output does not end the wait");
    child.emit("close",0,null);await waiting;
    assert.ok(Date.now()-started<2000,"the exit ends the wait at once");
    const status=manager.status("thread-w","p1");assert.equal(status.running,false);assert.equal(status.exitCode,0);
    const again=Date.now();await manager.waitForExit("thread-w","p1",{waitMs:5000});assert.ok(Date.now()-again<100,"an ended process is not waited for");
  }finally{await manager.closeAll()}
});

test("waitForExit gives up at its wait_ms, which is capped at 60 seconds",async t=>{
  const {environments}=fakeRemoteEnvironment(),manager=new NativeBackgroundProcessManager({environments,environment:{}});
  t.mock.timers.enable({apis:["setTimeout"]});
  try{
    manager.start({threadId:"thread-c",command:"python3",args:["run.py"],cwd:"/srv/app",environmentId:"ssh-1",environmentNames:["PATH"]});
    let short=false;const shortWait=manager.waitForExit("thread-c","p1",{waitMs:250}).then(()=>{short=true});
    t.mock.timers.tick(249);await Promise.resolve();assert.equal(short,false);
    t.mock.timers.tick(1);await shortWait;assert.equal(short,true);
    let long=false;const longWait=manager.waitForExit("thread-c","p1",{waitMs:10*60_000}).then(()=>{long=true});
    t.mock.timers.tick(59_999);await Promise.resolve();assert.equal(long,false);
    t.mock.timers.tick(1);await longWait;assert.equal(long,true,"a longer wait_ms stops at 60 seconds");
    assert.equal(manager.status("thread-c","p1").running,true);
    await assert.rejects(()=>manager.waitForExit("thread-c","p9",{waitMs:100}),/not found/i);
  }finally{t.mock.timers.reset();await manager.closeAll()}
});

test("waitForExit ends with an AbortError when the turn is cancelled",async()=>{
  const {environments}=fakeRemoteEnvironment(),manager=new NativeBackgroundProcessManager({environments,environment:{}});
  try{
    manager.start({threadId:"thread-a",command:"python3",args:["run.py"],cwd:"/srv/app",environmentId:"ssh-1",environmentNames:["PATH"]});
    const controller=new AbortController(),started=Date.now();
    setTimeout(()=>controller.abort(),50);
    await assert.rejects(()=>manager.waitForExit("thread-a","p1",{waitMs:30_000,signal:controller.signal}),error=>error?.name==="AbortError");
    assert.ok(Date.now()-started<2000,"the abort ends the wait at once");
    await assert.rejects(()=>manager.waitForExit("thread-a","p1",{waitMs:30_000,signal:controller.signal}),error=>error?.name==="AbortError","an already aborted turn does not wait");
    assert.equal(manager.status("thread-a","p1").running,true,"cancelling the wait leaves the process running");
  }finally{await manager.closeAll()}
});

test("waitForExit ends without an error when its wake signal fires, as when the person steers the turn",async()=>{
  const {environments}=fakeRemoteEnvironment(),manager=new NativeBackgroundProcessManager({environments,environment:{}});
  try{
    manager.start({threadId:"thread-k",command:"python3",args:["run.py"],cwd:"/srv/app",environmentId:"ssh-1",environmentNames:["PATH"]});
    const turn=new AbortController(),wake=new AbortController(),started=Date.now();
    setTimeout(()=>wake.abort("native-steering"),50);
    await manager.waitForExit("thread-k","p1",{waitMs:30_000,signal:turn.signal,wake:wake.signal});
    assert.ok(Date.now()-started<2000,"the wake ends the wait at once");
    const again=Date.now();await manager.waitForExit("thread-k","p1",{waitMs:30_000,signal:turn.signal,wake:wake.signal});
    assert.ok(Date.now()-again<100,"an already woken call does not wait");
    assert.equal(manager.status("thread-k","p1").running,true);
  }finally{await manager.closeAll()}
});

test("status with wait_ms waits for the exit through the built-in tools, on both tool names",async()=>{
  const {environments,children}=fakeRemoteEnvironment(),manager=new NativeBackgroundProcessManager({environments,environment:{}});
  const root=await mkdtemp(join(tmpdir(),"trebell-native-bg-wait-"));
  try{
    manager.start({threadId:"thread-b",command:"python3",args:["run.py"],cwd:"/srv/app",environmentId:"ssh-1",environmentNames:["PATH"]});
    const execute=createNativeBuiltins({root,backgroundProcesses:manager,threadId:"thread-b"});
    setTimeout(()=>{children[0].stdout.write("done 42\n");children[0].emit("close",0,null)},40);
    const status=await execute({namespace:"trebell_process",name:"status",arguments:{process_id:"p1",wait_ms:5000}});
    assert.equal(status.running,false);assert.equal(status.stdout,"done 42\n");
    const legacy=await execute({namespace:"trebell_terminal",name:"background_status",arguments:{process_id:"p1",wait_ms:5000}});assert.equal(legacy.running,false);
    manager.start({threadId:"thread-b",command:"python3",args:["serve.py"],cwd:"/srv/app",environmentId:"ssh-1",environmentNames:["PATH"]});
    const controller=new AbortController();setTimeout(()=>controller.abort(),40);
    await assert.rejects(()=>execute({namespace:"trebell_process",name:"status",arguments:{process_id:"p2",wait_ms:60_000},signal:controller.signal}),error=>error?.name==="AbortError");
  }finally{await manager.closeAll();await rm(root,{recursive:true,force:true})}
});

const execFileAsync=promisify(execFile);

// The headless runner's end: the process that started a server exits, and the server stays up and can still write.
test("releaseAll leaves a local process running after the process that started it exits, and its later writes still work",{skip:process.platform==="win32"&&"on Windows releaseAll stops every process"},async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-bg-release-")),beat=join(root,"beat.txt");
  // The service writes to both pipes and counts in a file every 20 ms. Without a reader on its pipes, its first write after the
  // starting process exits fails with EPIPE, which ends a Node process.
  const service=`let n=0;setInterval(()=>{n++;process.stdout.write('out '+n+'\\n');process.stderr.write('err '+n+'\\n');require('node:fs').writeFileSync(${JSON.stringify(beat)},String(n))},20)`;
  const host=[
    `import { NativeBackgroundProcessManager } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname,"..","src","native-background-processes.mjs")).href)};`,
    "const manager=new NativeBackgroundProcessManager(),events=[];manager.onEvent=event=>events.push(event.name);",
    `const started=manager.start({threadId:"run",command:process.execPath,args:["-e",${JSON.stringify(service)}],cwd:${JSON.stringify(root)}});`,
    "for(let i=0;i<300&&!manager.status('run',started.processId).stdout;i++)await new Promise(resolve=>setTimeout(resolve,10));",
    "const released=await manager.releaseAll();",
    "console.log(JSON.stringify({released,events,left:manager.list('run').data.length}));",
  ].join("\n");
  let pid=null;
  try{
    // The host must exit on its own: a released process holds nothing that keeps it alive.
    const {stdout}=await execFileAsync(process.execPath,["--input-type=module","-e",host],{timeout:15_000});
    const {released,events,left}=JSON.parse(stdout.trim().split("\n").pop());
    assert.equal(released.length,1);assert.equal(released[0].running,true);assert.equal(left,0);
    pid=released[0].osPid;assert.ok(Number.isInteger(pid)&&pid>0);
    assert.ok(events.includes("native.background.released"));assert.ok(!events.includes("native.background.terminated"));
    const before=Number(await readFile(beat,"utf8"));await new Promise(resolve=>setTimeout(resolve,500));const after=Number(await readFile(beat,"utf8"));
    assert.ok(after>before+5,`the released process kept running and writing (${before} -> ${after})`);
    process.kill(pid,0);
  }finally{
    if(pid){try{process.kill(-pid,"SIGKILL")}catch{}}
    await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250});
  }
});

test("releaseAll stops remote processes, and on Windows every process, as closeAll does",async()=>{
  const {environments,children}=fakeRemoteEnvironment(),remote=new NativeBackgroundProcessManager({environments,environment:{}});
  remote.start({threadId:"thread-r",command:"node",args:["server.js"],cwd:"/srv/app",environmentId:"ssh-1",environmentNames:["PATH"]});
  let kills=0;children[0].kill=()=>{kills++;queueMicrotask(()=>children[0].emit("close",0,"SIGTERM"));return true};
  assert.deepEqual(await remote.releaseAll(),[]);assert.equal(kills,1);assert.equal(remote.list("thread-r").data.length,0);
  const root=await mkdtemp(join(tmpdir(),"trebell-native-bg-release-win-")),windows=new NativeBackgroundProcessManager({platform:"win32"});
  try{
    const started=windows.start({threadId:"thread-w",command:process.execPath,args:["-e","setInterval(()=>{},1000)"],cwd:root});
    assert.deepEqual(await windows.releaseAll(),[]);
    let alive=true;
    for(let attempt=0;attempt<40&&alive;attempt++){try{process.kill(started.osPid,0);await new Promise(resolve=>setTimeout(resolve,50))}catch(error){if(error?.code==="ESRCH")alive=false;else throw error}}
    assert.equal(alive,false,"on Windows releaseAll stops the process");
  }finally{await windows.closeAll();await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});
