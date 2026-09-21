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
    state.addStash({text:"hello",attachments:["context.txt"],contextChips:[{id:"ctx-1",path:"context.txt",kind:"review",label:"Review: context.txt"}],projectPath:project.path});
    const again=new TrebellStateStore(env);
    assert.equal(again.projects()[0].name,"Project A");
    assert.equal(again.threadMeta("thread-1").pinned,true);
    assert.equal(again.listStashes()[0].text,"hello");
    assert.deepEqual(again.listStashes()[0].contextChips,[{id:"ctx-1",path:"context.txt",kind:"review",label:"Review: context.txt"}]);
  }finally{await rm(home,{recursive:true,force:true});}
});


test("project actions persist, sanitize, inherit preference, and allow clearing overrides", async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-state-actions-"));
  const env={...process.env,TREBELL_HOME:home};
  try{
    const state=new TrebellStateStore(env);
    const projectPath=join(home,"project");
    const saved=state.touchProject(projectPath,{
      defaultModel:"freebuff/test/coding-fast",
      permissionMode:"full",
      workspaceMode:"worktree",
      scripts:[{
        id:"dev",
        name:"Dev server",
        command:"npm run dev",
        previewUrl:"http://localhost:5173",
        autoOpenPreview:true,
        runOnWorktreeCreate:true,
      }],
      preferredScriptId:"dev",
    });
    assert.equal(saved.scripts.length,1);
    assert.equal(saved.scripts[0].command,"npm run dev");
    assert.equal(saved.scripts[0].runOnWorktreeCreate,true);
    assert.equal(saved.preferredScriptId,"dev");

    const cleared=state.touchProject(projectPath,{defaultModel:null,permissionMode:null,workspaceMode:null});
    assert.equal(cleared.defaultModel,null);
    assert.equal(cleared.permissionMode,null);
    assert.equal(cleared.workspaceMode,null);

    const again=new TrebellStateStore(env).projects()[0];
    assert.equal(again.scripts[0].previewUrl,"http://localhost:5173");
    assert.equal(again.preferredScriptId,"dev");
  }finally{await rm(home,{recursive:true,force:true});}
});
