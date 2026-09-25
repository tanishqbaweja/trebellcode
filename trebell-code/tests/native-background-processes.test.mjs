import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp,mkdir,rm } from "node:fs/promises";
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
    const started=await execute({namespace:"trebell_terminal",name:"start_background",arguments:{command:process.execPath,args:["-e",script,environment.NATIVE_BACKGROUND_SECRET],cwd:"src",max_output_bytes:4096}});
    assert.equal(started.running,true);assert.ok(started.processId);assert.equal(started.cwd,join(root,"src"));
    assert.doesNotMatch(started.command,/do-not-leak/);assert.match(started.command,/\[redacted\]/);
    const status=await waitFor(()=>{const current=execute({namespace:"trebell_terminal",name:"background_status",arguments:{process_id:started.processId}});return current.then(item=>item.stdout?item:null)});
    assert.deepEqual(JSON.parse(status.stdout),{secret:null});assert.equal(manager.list("thread-a").data.length,1);assert.equal(manager.list("thread-b").data.length,0);
    await assert.rejects(()=>execute({namespace:"trebell_terminal",name:"background_status",arguments:{process_id:"missing"}}),/not found/i);
    const stopped=await execute({namespace:"trebell_terminal",name:"stop_background",arguments:{process_id:started.processId}});assert.equal(stopped.running,false);assert.equal(manager.list("thread-a").data.length,0);
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
