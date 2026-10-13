import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp,mkdir,readFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeBuiltins } from "../src/native-builtins.mjs";
import { NativeBackgroundProcessManager } from "../src/native-background-processes.mjs";

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
  }finally{await manager.closeAll();await rm(root,{recursive:true,force:true})}
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
  }finally{await manager.closeAll();await rm(root,{recursive:true,force:true})}
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
  }finally{await manager.closeAll();await rm(root,{recursive:true,force:true})}
});
