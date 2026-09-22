import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

test("legacy implicit System appearance migrates to Dark once",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-state-theme-migration-"));
  const env={...process.env,TREBELL_HOME:home};
  try{
    await writeFile(join(home,"ui-state.json"),JSON.stringify({version:1,projects:[],threadMeta:{},settings:{appearance:"dark",appearanceMode:"system"}}));
    const migrated=new TrebellStateStore(env);assert.equal(migrated.settings().appearance,"dark");assert.equal(migrated.settings().appearanceMode,"dark");
    migrated.updateSettings({appearanceMode:"system"});
    const explicit=new TrebellStateStore(env);assert.equal(explicit.settings().appearanceMode,"system");
  }finally{await rm(home,{recursive:true,force:true})}
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
      worktreeSubmodules:"top-level",
      icon:{kind:"monogram",value:"tb",color:"#123456"},
      scripts:[{
        id:"dev",
        name:"Dev server",
        command:"npm run dev",
        previewUrl:"http://localhost:5173",
        autoOpenPreview:true,
        runOnWorktreeCreate:true,
        waitForSetup:true,
      }],
      preferredScriptId:"dev",
    });
    assert.equal(saved.scripts.length,1);
    assert.equal(saved.scripts[0].command,"npm run dev");
    assert.equal(saved.scripts[0].runOnWorktreeCreate,true);
    assert.equal(saved.scripts[0].waitForSetup,true);
    assert.equal(saved.preferredScriptId,"dev");
    assert.equal(saved.worktreeSubmodules,"top-level");
    assert.deepEqual(saved.icon,{kind:"monogram",value:"TB",color:"#123456"});

    const cleared=state.touchProject(projectPath,{defaultModel:null,permissionMode:null,workspaceMode:null,worktreeSubmodules:null,icon:null});
    assert.equal(cleared.defaultModel,null);
    assert.equal(cleared.permissionMode,null);
    assert.equal(cleared.workspaceMode,null);
    assert.equal(cleared.worktreeSubmodules,null);
    assert.equal(cleared.icon,null);

    const again=new TrebellStateStore(env).projects()[0];
    assert.equal(again.scripts[0].previewUrl,"http://localhost:5173");
    assert.equal(again.preferredScriptId,"dev");

    const cleanup=state.touchProject(projectPath,{worktreeCleanup:{mode:"custom",rules:{worktreeAfterDays:5000,worktreeOnMerge:true,worktreeOnDelete:true,worktreeUnchanged:false}}});
    assert.deepEqual(cleanup.worktreeCleanup,{mode:"custom",rules:{worktreeAfterDays:3650,worktreeOnMerge:true,worktreeOnDelete:true,worktreeUnchanged:false}});
    assert.equal(state.touchProject(projectPath,{worktreeCleanup:null}).worktreeCleanup,null);
    assert.deepEqual(state.updateSettings({worktreeCleanup:{mode:"custom",rules:{worktreeAfterDays:14,worktreeUnchanged:true}}}).worktreeCleanup,{mode:"custom",rules:{worktreeAfterDays:14,worktreeOnMerge:false,worktreeOnDelete:false,worktreeUnchanged:true}});
    assert.equal(state.updateSettings({panelAnimationMs:999}).panelAnimationMs,400);
    assert.equal(state.updateSettings({panelAnimationMs:-50}).panelAnimationMs,0);
  }finally{await rm(home,{recursive:true,force:true});}
});

test("usage records upsert streaming updates instead of double-counting a turn", async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-state-usage-"));
  const env={...process.env,TREBELL_HOME:home};
  try{
    const state=new TrebellStateStore(env);
    state.recordUsage({runtime:"opencode",provider:"opencode-default",model:"opencode/big-pickle",threadId:"thread-1",turnId:"turn-1",usage:{totalTokens:100,inputTokens:70,outputTokens:30},cost:{amount:0.01,currency:"USD"},at:Date.now()});
    state.recordUsage({runtime:"opencode",provider:"opencode-default",model:"opencode/big-pickle",threadId:"thread-1",turnId:"turn-1",usage:{totalTokens:140,inputTokens:90,outputTokens:50},cost:{amount:0.02,currency:"USD"},at:Date.now()});
    state.recordUsage({runtime:"claude",provider:"claude-default",model:"sonnet",threadId:"thread-2",turnId:"turn-2",usage:{totalTokens:60,inputTokens:40,outputTokens:20},at:Date.now()});
    const usage=state.usage({days:1});
    assert.equal(usage.records.length,2);
    assert.equal(usage.total.totalTokens,200);
    assert.equal(usage.total.inputTokens,130);
    assert.equal(usage.total.outputTokens,70);
    assert.equal(usage.total.costUsd,0.02);
    assert.equal(usage.models["opencode/big-pickle"].turns,1);
    const again=new TrebellStateStore(env).usage({days:1});
    assert.equal(again.records.length,2);
    assert.equal(again.total.totalTokens,200);
    assert.equal(new TrebellStateStore(env).clearUsage(),2);
  }finally{await rm(home,{recursive:true,force:true});}
});
