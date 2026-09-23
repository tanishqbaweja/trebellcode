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

test("pull request auto-settle is opt-in and persists",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-state-auto-settle-"));const env={...process.env,TREBELL_HOME:home};
  try{
    const state=new TrebellStateStore(env);assert.equal(state.settings().autoSettleMergedThreads,false);
    state.updateSettings({autoSettleMergedThreads:true});
    assert.equal(new TrebellStateStore(env).settings().autoSettleMergedThreads,true);
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
    const marks={"gitlab:42":{headSha:"abc",files:{"src/a.js":{revision:"abc",viewedAt:123}},updatedAt:123}};
    assert.deepEqual(state.touchProject(projectPath,{pullRequestViewedFiles:marks}).pullRequestViewedFiles,marks);
  }finally{await rm(home,{recursive:true,force:true});}
});

test("usage records upsert streaming updates instead of double-counting a turn", async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-state-usage-"));
  const env={...process.env,TREBELL_HOME:home};
  try{
    const state=new TrebellStateStore(env);
    state.recordUsage({runtime:"opencode",provider:"opencode-default",model:"opencode/big-pickle",environmentId:"ssh-a",threadId:"thread-1",turnId:"turn-1",usage:{totalTokens:100,inputTokens:70,outputTokens:30},cost:{amount:0.01,currency:"USD"},at:Date.now()});
    state.recordUsage({runtime:"opencode",provider:"opencode-default",model:"opencode/big-pickle",threadId:"thread-1",turnId:"turn-1",usage:{totalTokens:140,inputTokens:90,outputTokens:50},cost:{amount:0.02,currency:"USD"},at:Date.now()});
    state.recordUsage({runtime:"claude",provider:"claude-default",model:"sonnet",threadId:"thread-2",turnId:"turn-2",usage:{totalTokens:60,inputTokens:40,outputTokens:20},at:Date.now()});
    const usage=state.usage({days:1});
    assert.equal(usage.records.length,2);
    assert.equal(usage.total.totalTokens,200);
    assert.equal(usage.total.inputTokens,130);
    assert.equal(usage.total.outputTokens,70);
    assert.equal(usage.total.costUsd,0.02);
    assert.equal(usage.models["opencode/big-pickle"].turns,1);
    assert.equal(usage.environments["ssh-a"].tokens,140);
    assert.equal(usage.environments.local.tokens,60);
    const remoteOnly=state.usage({days:1,environmentIds:["ssh-a"]});
    assert.equal(remoteOnly.records.length,1);
    assert.equal(remoteOnly.total.totalTokens,140);
    assert.equal(remoteOnly.records[0].environmentId,"ssh-a");
    const localOnly=state.usage({days:1,environmentIds:[null]});
    assert.equal(localOnly.records.length,1);
    assert.equal(localOnly.total.totalTokens,60);
    const again=new TrebellStateStore(env).usage({days:1});
    assert.equal(again.records.length,2);
    assert.equal(again.total.totalTokens,200);
    assert.equal(new TrebellStateStore(env).clearUsage(),2);
  }finally{await rm(home,{recursive:true,force:true});}
});

test("projects with the same remote path stay distinct across environments",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-state-project-env-"));
  const env={...process.env,TREBELL_HOME:home};
  try{
    const state=new TrebellStateStore(env);
    const first=state.touchProject("/srv/app",{environmentId:"ssh-a",name:"App A"});
    const second=state.touchProject("/srv/app",{environmentId:"ssh-b",name:"App B"});
    const local=state.touchProject("/srv/app",{environmentId:null,name:"Local-looking path"});
    assert.notEqual(first.id,second.id);
    assert.notEqual(second.id,local.id);
    assert.equal(state.projects().length,3);
    assert.equal(state.project("/srv/app","ssh-a").name,"App A");
    assert.equal(state.project("/srv/app","ssh-b").name,"App B");
    assert.equal(state.project("/srv/app",null).name,"Local-looking path");
    const again=new TrebellStateStore(env);
    assert.equal(again.project("/srv/app","ssh-a").environmentId,"ssh-a");
    assert.equal(again.project("/srv/app",null).environmentId,null);
  }finally{await rm(home,{recursive:true,force:true})}
});

test("scoped settings resolve environment defaults and project overrides without leaking between environments",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-state-scopes-"));const env={...process.env,TREBELL_HOME:home};
  try{
    const state=new TrebellStateStore(env);
    state.updateSettings({defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",worktreeSubmodules:"recursive",autoPull:false,agentDeviceAccess:false,defaultModel:"model-global",sourceControlMergeMethod:"squash",sourceControlTextStyle:"concise",sourceControlTextModel:null});
    state.updateEnvironmentDefaults("ssh-a",{defaultPermissionMode:"full",defaultWorkspaceMode:"worktree",worktreeSubmodules:"none",agentDeviceAccess:true,defaultModel:"model-remote",sourceControlMergeMethod:"rebase",sourceControlTextStyle:"repository",sourceControlTextModel:"model-writing",sourceControlCustomInstructions:"Follow repository rules.",sourceControlFollowTemplates:true});
    const project=state.touchProject("/srv/app",{environmentId:"ssh-a",name:"Remote App"});
    let scoped=state.projectSettings(project.path,"ssh-a");
    assert.equal(scoped.effective.defaultPermissionMode,"full");
    assert.equal(scoped.effective.defaultWorkspaceMode,"worktree");
    assert.equal(scoped.effective.defaultModel,"model-remote");
    assert.equal(scoped.effective.sourceControlMergeMethod,"rebase");
    assert.equal(scoped.effective.sourceControlTextStyle,"repository");
    assert.equal(scoped.effective.sourceControlTextModel,"model-writing");
    assert.equal(scoped.effective.sourceControlCustomInstructions,"Follow repository rules.");
    assert.equal(scoped.effective.sourceControlFollowTemplates,true);
    assert.equal(state.environmentDefaults("ssh-b").defaultPermissionMode,"supervised");

    state.updateProjectSettings(project.path,"ssh-a",{defaultPermissionMode:"edits",autoPull:true,sourceControlMergeMethod:"merge",sourceControlTextStyle:"custom",sourceControlTextModel:"model-project-writing",sourceControlCustomInstructions:"Prefix the ticket ID.",sourceControlFollowTemplates:false},[]);
    scoped=state.projectSettings(project.path,"ssh-a");
    assert.equal(scoped.overrides.defaultPermissionMode,"edits");
    assert.equal(scoped.effective.defaultPermissionMode,"edits");
    assert.equal(scoped.effective.autoPull,true);
    assert.equal(scoped.effective.sourceControlMergeMethod,"merge");
    assert.equal(scoped.effective.sourceControlTextStyle,"custom");
    assert.equal(scoped.effective.sourceControlTextModel,"model-project-writing");
    assert.equal(scoped.effective.sourceControlCustomInstructions,"Prefix the ticket ID.");
    assert.equal(scoped.effective.sourceControlFollowTemplates,false);
    assert.equal(state.project(project.path,"ssh-a").permissionMode,"edits");

    state.updateProjectSettings(project.path,"ssh-a",{},["defaultPermissionMode","autoPull","sourceControlMergeMethod","sourceControlTextStyle","sourceControlTextModel","sourceControlCustomInstructions","sourceControlFollowTemplates"]);
    scoped=state.projectSettings(project.path,"ssh-a");
    assert.equal(scoped.overrides.defaultPermissionMode,undefined);
    assert.equal(scoped.effective.defaultPermissionMode,"full");
    assert.equal(scoped.effective.autoPull,false);
    assert.equal(scoped.effective.sourceControlMergeMethod,"rebase");
    assert.equal(scoped.effective.sourceControlTextStyle,"repository");
    assert.equal(scoped.effective.sourceControlTextModel,"model-writing");
    assert.equal(scoped.effective.sourceControlCustomInstructions,"Follow repository rules.");
    assert.equal(scoped.effective.sourceControlFollowTemplates,true);
    assert.equal(state.project(project.path,"ssh-a").permissionMode,null);

    state.touchProject(project.path,{environmentId:"ssh-a",workspaceMode:"current"});
    scoped=state.projectSettings(project.path,"ssh-a");
    assert.equal(scoped.overrides.defaultWorkspaceMode,"current");
    assert.equal(scoped.effective.defaultWorkspaceMode,"current");
  }finally{await rm(home,{recursive:true,force:true})}
});
