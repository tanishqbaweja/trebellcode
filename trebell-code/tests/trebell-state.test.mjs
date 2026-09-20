import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrebellStateStore } from "../src/trebell-state.mjs";

test("Trebell UI state persists project, thread metadata and stashes", async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-state-"));
  const env={...process.env,TREBELL_HOME:home};
  try{
    const state=new TrebellStateStore(env);
    const project=state.touchProject(join(home,"project"),{name:"Project A"});
    state.updateThreadMeta("thread-1",{pinned:true,snoozedUntil:123});
    state.addStash({text:"hello",projectPath:project.path});
    const again=new TrebellStateStore(env);
    assert.equal(again.projects()[0].name,"Project A");
    assert.equal(again.threadMeta("thread-1").pinned,true);
    assert.equal(again.listStashes()[0].text,"hello");
  }finally{await rm(home,{recursive:true,force:true});}
});
