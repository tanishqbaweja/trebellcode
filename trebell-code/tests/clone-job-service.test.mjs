import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CloneJobService, parseCloneProgress } from "../src/clone-job-service.mjs";
import { TrebellStateStore } from "../src/trebell-state.mjs";
import { git } from "../src/git-service.mjs";

test("clone progress parser keeps the furthest Git phase percentage",()=>{
  let state=parseCloneProgress("remote: Counting objects: 42% (42/100)\r",{progress:0,phase:"Starting"});
  assert.equal(state.progress,42);assert.equal(state.phase,"Counting objects");
  state=parseCloneProgress("Receiving objects: 18% (18/100)\r",state);
  assert.equal(state.progress,42);assert.equal(state.phase,"Receiving objects");
  state=parseCloneProgress("Resolving deltas: 87% (87/100)\r",state);
  assert.equal(state.progress,87);assert.equal(state.phase,"Resolving deltas");
});

test("background clone materializes atomically and persists project completion",{timeout:20000},async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-clone-home-"));
  const source=await mkdtemp(join(tmpdir(),"trebell-clone-source-"));
  const parent=await mkdtemp(join(tmpdir(),"trebell-clone-dest-"));
  const destination=join(parent,"widget");
  try{
    await git(source,["init"]);await git(source,["config","user.email","trebell@example.test"]);await git(source,["config","user.name","Trebell Test"]);
    await writeFile(join(source,"README.md"),"hello\n");await git(source,["add","README.md"]);await git(source,["commit","-m","first"]);
    const state=new TrebellStateStore({...process.env,TREBELL_HOME:home});const service=new CloneJobService({state});
    const started=await service.start({url:source,destination});assert.equal(started.status,"running");
    const finished=await service.wait(started.id,{timeoutMs:15000});assert.equal(finished.status,"completed");assert.equal(finished.progress,100);
    assert.equal((await stat(join(destination,"README.md"))).isFile(),true);
    const project=state.project(destination,null);assert.equal(project.cloneJob.status,"completed");assert.equal(project.cloneJob.progress,100);
    await assert.rejects(stat(project.cloneJob.tempPath));
  }finally{await Promise.all([rm(home,{recursive:true,force:true}),rm(source,{recursive:true,force:true}),rm(parent,{recursive:true,force:true})])}
});

test("cancelling a clone job transitions to cancelled and clears its temp path",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-clone-cancel-home-"));
  const parent=await mkdtemp(join(tmpdir(),"trebell-clone-cancel-dest-"));
  try{
    let child=null;
    const spawnProcess=()=>{
      child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{queueMicrotask(()=>child.emit("close",null,"SIGTERM"));return true};return child;
    };
    const state=new TrebellStateStore({...process.env,TREBELL_HOME:home});const service=new CloneJobService({state,spawnProcess});
    const started=await service.start({url:"https://example.test/acme/widget.git",destination:join(parent,"widget")});
    child.stderr.write("Receiving objects: 12% (12/100)\r");
    await service.cancel(started.id);const finished=await service.wait(started.id,{timeoutMs:2000});
    assert.equal(finished.status,"cancelled");assert.equal(state.project(join(parent,"widget"),null).cloneJob.status,"cancelled");
  }finally{await Promise.all([rm(home,{recursive:true,force:true}),rm(parent,{recursive:true,force:true})])}
});

test("remote clone jobs run Git and finalization inside the selected environment",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-clone-remote-home-"));
  try{
    const calls=[];let child=null;
    const environments={
      get:id=>id==="ssh-a"?{id:"ssh-a",name:"Remote",type:"ssh",cwd:"/srv"}:null,
      executeArgv:async(id,options)=>{
        calls.push({kind:"exec",id,...options});
        if(options.command==="test")return {exitCode:1,stdout:"",stderr:""};
        return {exitCode:0,stdout:"",stderr:""};
      },
      spawnArgv:(id,options)=>{
        calls.push({kind:"spawn",id,...options});child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>true;
        queueMicrotask(()=>{child.stderr.write("Receiving objects: 64% (64/100)\r");child.emit("close",0,null)});
        return child;
      },
    };
    const state=new TrebellStateStore({...process.env,TREBELL_HOME:home});const service=new CloneJobService({state,environments});
    const started=await service.start({url:"git@example.test:acme/widget.git",destination:"/srv/projects/widget",environmentId:"ssh-a"});
    const finished=await service.wait(started.id,{timeoutMs:2000});
    assert.equal(finished.status,"completed");
    const spawned=calls.find(call=>call.kind==="spawn");assert.equal(spawned.id,"ssh-a");assert.equal(spawned.command,"git");assert.equal(spawned.cwd,"/srv/projects");assert.equal(spawned.args[0],"clone");
    assert.equal(calls.some(call=>call.kind==="exec"&&call.command==="mv"&&call.args.at(-1)==="/srv/projects/widget"),true);
    assert.equal(state.project("/srv/projects/widget","ssh-a").cloneJob.status,"completed");
  }finally{await rm(home,{recursive:true,force:true})}
});
