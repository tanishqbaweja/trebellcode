import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrebellStateStore } from "../src/trebell-state.mjs";

test("explicit project hooks normalize and persist across state reloads",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-project-hooks-state-")),env={...process.env,TREBELL_HOME:home};
  try{
    const first=new TrebellStateStore(env),project=first.touchProject("/repo",{hooks:[
      {name:"Lint gate",event:"verification.required",command:"npm run lint",timeoutMs:45000},
      {id:"notify",name:"Notify",event:"source-control.after",command:"echo done",failureMode:"block",actions:["push","push"]},
      {name:"Invalid",event:"tool.before",command:"echo nope"},
    ]});
    assert.equal(project.hooks.length,2);assert.ok(project.hooks[0].id);assert.equal(project.hooks[0].failureMode,"block");assert.equal(project.hooks[0].timeoutMs,45000);assert.deepEqual(project.hooks[1].actions,["push"]);assert.equal(project.hooks[1].failureMode,"warn");
    const again=new TrebellStateStore(env),persisted=again.project("/repo",null);assert.deepEqual(persisted.hooks,project.hooks);
    const updated=again.touchProject("/repo",{hooks:[{...persisted.hooks[0],enabled:false}]});assert.equal(updated.hooks.length,1);assert.equal(updated.hooks[0].enabled,false);assert.equal(updated.hooks[0].id,project.hooks[0].id);
  }finally{await rm(home,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
});
