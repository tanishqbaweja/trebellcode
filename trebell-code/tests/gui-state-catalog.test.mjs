import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createGuiServer } from "../src/gui-server.mjs";
import { TrebellStateStore } from "../src/trebell-state.mjs";

async function freePort(){
  const server=createServer();
  await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const port=server.address().port;
  await new Promise(resolve=>server.close(resolve));
  return port;
}

test("/api/state returns compact thread catalog while per-thread metadata stays complete",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-gui-state-catalog-")),env={...process.env,TREBELL_HOME:home};
  const [port,appPort]=await Promise.all([freePort(),freePort()]);
  let gui;
  try{
    const state=new TrebellStateStore(env);
    state.updateSettings({onboardingComplete:true});
    state.updateThreadMeta("thread-heavy",{
      runtime:"codex",runtimeInstanceId:"codex-default",provider:"freebuff",projectless:true,updatedAt:100,
      threadSnapshot:{id:"thread-heavy",name:"Heavy thread",preview:"Bootstrap should stay compact",cwd:"C:/repo",model:"model-a",updatedAt:100,createdAt:90,status:{type:"idle"},runtime:"codex",provider:"freebuff"},
      goal:{objective:"G".repeat(10000)},trebellQueue:[{id:"queued-1",input:[{type:"text",text:"Q".repeat(10000)}]}],
      trebellContext:{task:"T".repeat(10000),selectedFiles:[{path:"src/heavy.js",reason:"R".repeat(5000)}]},
      continuityNotes:{completedWork:["C".repeat(10000)]},reviewedFiles:Array.from({length:500},(_,index)=>"src/file-"+index+".js"),
    });
    gui=await createGuiServer({port,appPort,mock:true,env});

    const publicState=await fetch(gui.url+"/api/state").then(response=>response.json());
    const catalog=publicState.threadMeta["thread-heavy"];
    assert.equal(catalog.__catalogOnly,true);assert.equal(catalog.threadSnapshot.name,"Heavy thread");assert.equal(catalog.runtime,"codex");assert.equal(catalog.projectless,true);
    for(const heavy of ["goal","trebellQueue","trebellContext","continuityNotes","reviewedFiles"])assert.equal(Object.prototype.hasOwnProperty.call(catalog,heavy),false);

    const full=await fetch(gui.url+"/api/thread-meta?threadId=thread-heavy").then(response=>response.json());
    assert.equal(full.goal.objective.length,10000);assert.equal(full.trebellQueue[0].id,"queued-1");assert.equal(full.trebellContext.task.length,10000);assert.equal(full.reviewedFiles.length,500);
    assert.ok(JSON.stringify(publicState).length<JSON.stringify(full).length/2,"bootstrap state should remain materially smaller than one deliberately heavy full metadata record");
  }finally{if(gui)await gui.close();await rm(home,{recursive:true,force:true})}
});
