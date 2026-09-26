import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

test("retired mobile-device control settings are scrubbed from legacy state",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-state-device-retirement-")),env={...process.env,TREBELL_HOME:home};
  try{
    await writeFile(join(home,"ui-state.json"),JSON.stringify({
      version:2,
      projects:[{id:"project-1",path:"C:/repo",settingsOverrides:{agentDeviceAccess:true,autoPull:true}}],
      threadMeta:{},
      settings:{agentDeviceAccess:true,environmentDefaults:{"ssh-a":{agentDeviceAccess:true,defaultPermissionMode:"full"}}},
    }));
    const state=new TrebellStateStore(env);
    assert.equal(Object.prototype.hasOwnProperty.call(state.settings(),"agentDeviceAccess"),false);
    assert.equal(Object.prototype.hasOwnProperty.call(state.environmentDefaults("ssh-a"),"agentDeviceAccess"),false);
    assert.equal(Object.prototype.hasOwnProperty.call(state.projects()[0].settingsOverrides,"agentDeviceAccess"),false);
    const persisted=await readFile(join(home,"ui-state.json"),"utf8");assert.doesNotMatch(persisted,/agentDeviceAccess/);
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

test("automatic context compaction defaults on and persists user preferences",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-state-auto-compact-"));const env={...process.env,TREBELL_HOME:home};
  try{
    const state=new TrebellStateStore(env);
    assert.equal(state.settings().autoCompactContext,true);
    assert.equal(state.settings().autoCompactThresholdPercent,85);
    state.updateSettings({autoCompactContext:false,autoCompactThresholdPercent:90});
    const again=new TrebellStateStore(env);
    assert.equal(again.settings().autoCompactContext,false);
    assert.equal(again.settings().autoCompactThresholdPercent,90);
  }finally{await rm(home,{recursive:true,force:true})}
});

test("MCP server settings are normalized and persist across supported runtimes",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-state-mcp-"));const env={...process.env,TREBELL_HOME:home};
  try{
    const credential=["saved","mcp","credential"].join("-"),httpCredential=["http","mcp","credential"].join("-");
    const state=new TrebellStateStore(env);
    state.updateSettings({mcpServers:[
      {id:"cursor-remote",name:"Remote tools",runtime:"cursor",environmentId:"ssh-a",command:"/opt/remote-mcp",args:["--stdio"],env:[{name:"API_KEY",value:credential},{name:"LOG_LEVEL",value:"debug"}]},
      {id:"claude-local",name:"Claude tools",runtime:"claude",command:"claude-mcp",args:["--stdio"]},
      {id:"native-http",name:"HTTP tools",runtime:"native",type:"http",url:"https://mcp.example.test/mcp",bearerTokenEnv:"MCP_ACCESS_TOKEN",bearerToken:httpCredential},
      {id:"invalid",name:"Ignored",runtime:"codex",command:"codex-mcp"},
    ]});
    const saved=new TrebellStateStore(env).settings().mcpServers;
    assert.equal(saved.length,3);
    assert.deepEqual(saved[0],{id:"cursor-remote",name:"Remote tools",type:"stdio",runtime:"cursor",environmentId:"ssh-a",enabled:true,command:"/opt/remote-mcp",args:["--stdio"],env:[{name:"LOG_LEVEL",value:"debug"}]});
    assert.deepEqual(saved[1],{id:"claude-local",name:"Claude tools",type:"stdio",runtime:"claude",environmentId:null,enabled:true,command:"claude-mcp",args:["--stdio"],env:[]});
    assert.deepEqual(saved[2],{id:"native-http",name:"HTTP tools",type:"http",runtime:"native",environmentId:null,enabled:true,url:"https://mcp.example.test/mcp",bearerTokenEnv:"MCP_ACCESS_TOKEN"});
    const raw=await readFile(join(home,"ui-state.json"),"utf8");assert.doesNotMatch(raw,new RegExp(credential));assert.doesNotMatch(raw,new RegExp(httpCredential));
  }finally{await rm(home,{recursive:true,force:true})}
});

test("legacy MCP credentials are scrubbed from UI state during load",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-state-mcp-migration-")),env={...process.env,TREBELL_HOME:home},credential=["legacy","mcp","credential"].join("-"),cliCredential=["legacy","cli","credential"].join("-");
  try{
    await writeFile(join(home,"ui-state.json"),JSON.stringify({version:2,projects:[],threadMeta:{},settings:{mcpServers:[{id:"legacy",name:"Legacy tools",runtime:"claude",command:"legacy-mcp",args:["--stdio","--token",cliCredential,"--safe","yes"],env:[{name:"ACCESS_TOKEN",value:credential},{name:"LOG_LEVEL",value:"warn"}]}]}}));
    const state=new TrebellStateStore(env),servers=state.settings().mcpServers;
    assert.deepEqual(servers[0].env,[{name:"LOG_LEVEL",value:"warn"}]);
    assert.deepEqual(servers[0].args,["--stdio","--safe","yes"]);
    const persisted=await readFile(join(home,"ui-state.json"),"utf8");
    assert.doesNotMatch(persisted,new RegExp(credential));assert.doesNotMatch(persisted,new RegExp(cliCredential));assert.doesNotMatch(persisted,/ACCESS_TOKEN|--token/);assert.match(persisted,/LOG_LEVEL/);
  }finally{await rm(home,{recursive:true,force:true})}
});

test("runtime profile credentials are scrubbed from new and legacy UI state",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-state-runtime-secret-")),env={...process.env,TREBELL_HOME:home};
  const newCredential=["new","runtime","credential"].join("-"),legacyCredential=["legacy","runtime","credential"].join("-");
  try{
    const state=new TrebellStateStore(env);
    state.updateSettings({agentRuntimeInstances:[{id:"cursor-custom",kind:"cursor",displayName:"Cursor Custom",environment:{CURSOR_AUTH_TOKEN:newCredential,NODE_ENV:"production"}}]});
    assert.deepEqual(state.settings().agentRuntimeInstances[0].environment,{NODE_ENV:"production"});
    assert.doesNotMatch(await readFile(join(home,"ui-state.json"),"utf8"),new RegExp(newCredential));
    await writeFile(join(home,"ui-state.json"),JSON.stringify({version:2,projects:[],threadMeta:{},settings:{agentRuntimeInstances:[{id:"grok-custom",kind:"grok",displayName:"Grok Custom",environment:{XAI_API_KEY:legacyCredential,LOG_LEVEL:"debug"}}]}}));
    const migrated=new TrebellStateStore(env);assert.deepEqual(migrated.settings().agentRuntimeInstances[0].environment,{LOG_LEVEL:"debug"});
    const disk=await readFile(join(home,"ui-state.json"),"utf8");assert.doesNotMatch(disk,new RegExp(legacyCredential));assert.doesNotMatch(disk,/XAI_API_KEY/);assert.match(disk,/LOG_LEVEL/);
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
    state.recordUsage({runtime:"opencode",provider:"opencode-default",model:"opencode/big-pickle",environmentId:"ssh-a",threadId:"thread-1",turnId:"turn-1",usage:{totalTokens:100,inputTokens:70,outputTokens:30,reasoningOutputTokens:20},cost:{amount:0.01,currency:"USD"},at:Date.now()});
    state.recordUsage({runtime:"opencode",provider:"opencode-default",model:"opencode/big-pickle",threadId:"thread-1",turnId:"turn-1",usage:{totalTokens:140,inputTokens:90,outputTokens:50,reasoningOutputTokens:25},cost:{amount:0.02,currency:"USD"},at:Date.now()});
    state.recordUsage({runtime:"claude",provider:"claude-default",model:"sonnet",threadId:"thread-2",turnId:"turn-2",usage:{totalTokens:60,inputTokens:40,outputTokens:20,reasoningOutputTokens:3},at:Date.now()});
    const usage=state.usage({days:1});
    assert.equal(usage.records.length,2);
    assert.equal(usage.total.totalTokens,200);
    assert.equal(usage.total.inputTokens,130);
    assert.equal(usage.total.outputTokens,70);
    assert.equal(usage.total.reasoningOutputTokens,28);
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

test("thread usage reconstructs goal token totals from persisted turn usage",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-state-thread-usage-")),env={...process.env,TREBELL_HOME:home};
  try{
    const state=new TrebellStateStore(env);
    state.recordUsage({runtime:"claude",threadId:"thread-a",turnId:"turn-1",at:1000,usage:{totalTokens:120,inputTokens:80,outputTokens:40}});
    state.recordUsage({runtime:"claude",threadId:"thread-a",turnId:"turn-2",at:2000,usage:{totalTokens:230,inputTokens:180,outputTokens:50,reasoningOutputTokens:7},cost:{amount:0.25,currency:"USD"}});
    state.recordUsage({runtime:"claude",threadId:"thread-b",turnId:"turn-3",at:3000,usage:{totalTokens:999}});
    assert.deepEqual(state.threadUsage("thread-a",{since:1500}),{totalTokens:230,inputTokens:180,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:50,reasoningOutputTokens:7,costUsd:0.25,costKnown:1,turns:1,records:1});
  }finally{await rm(home,{recursive:true,force:true})}
});

test("verification records persist, upsert by turn, and stay filterable",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-state-verification-")),env={...process.env,TREBELL_HOME:home};
  try{
    const state=new TrebellStateStore(env),plan={risk:"high",steps:[{id:"tests",kind:"tests",required:true}]};
    const first=state.recordVerification({environmentId:"ssh-a",projectPath:"/srv/app",threadId:"thread-1",turnId:"turn-1",plan,evidence:[{stepId:"tests",exitCode:1}],assessment:{status:"failed",risk:"high",verified:false}});
    assert.equal(first.id,"verification:ssh-a:thread-1:turn-1");assert.equal(first.status,"failed");assert.equal(first.risk,"high");
    const updated=state.recordVerification({environmentId:"ssh-a",projectPath:"/srv/app",threadId:"thread-1",turnId:"turn-1",plan,evidence:[{stepId:"tests",exitCode:0}],assessment:{status:"verified",risk:"high",verified:true}});
    assert.equal(updated.id,first.id);assert.equal(updated.createdAt,first.createdAt);assert.equal(updated.status,"verified");
    state.recordVerification({environmentId:null,projectPath:"/local/app",threadId:"thread-2",turnId:"turn-2",plan:{risk:"low",steps:[]},evidence:[],assessment:{status:"verified",risk:"low",verified:true}});
    const again=new TrebellStateStore(env);
    assert.equal(again.verificationRecords().length,2);
    assert.equal(again.verificationRecords({threadId:"thread-1"})[0].status,"verified");
    assert.equal(again.verificationRecords({projectPath:"/srv/app",environmentId:"ssh-a"}).length,1);
    assert.equal(again.verificationRecords({environmentId:null}).length,1);
  }finally{await rm(home,{recursive:true,force:true})}
});

test("legacy high-growth state migrates to SQLite while ui-state JSON stays lean",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-state-sqlite-migration-")),env={...process.env,TREBELL_HOME:home},now=Date.now();
  try{
    await writeFile(join(home,"ui-state.json"),JSON.stringify({version:2,projects:[],threadMeta:{},settings:{},checkpoints:[{id:"cp-legacy",threadId:"thread-legacy",createdAt:now-4,root:"/repo",commit:"abc"}],usageRecords:[{id:"native:thread-legacy:turn-1",runtime:"native",provider:"agentrouter",model:"model-a",environmentId:null,threadId:"thread-legacy",turnId:"turn-1",at:now-3,usage:{totalTokens:12,inputTokens:8,outputTokens:4},cost:null}],verificationRecords:[{id:"verification:local:thread-legacy:turn-1",environmentId:null,projectPath:"/repo",threadId:"thread-legacy",turnId:"turn-1",plan:{risk:"low",steps:[]},evidence:[],assessment:{status:"verified",risk:"low",verified:true},status:"verified",risk:"low",createdAt:now-2,updatedAt:now-2}],repositoryKnowledge:[{id:"knowledge-legacy",projectPath:"/repo",environmentId:null,category:"architecture",fact:"Legacy fact",scope:"repository",source:"explicit",confidence:1,status:"verified",evidence:[],createdAt:now-1,updatedAt:now-1}]}));
    const state=new TrebellStateStore(env);assert.equal(state.checkpoints("thread-legacy")[0].id,"cp-legacy");assert.equal(state.usage({days:1}).records[0].usage.totalTokens,12);assert.equal(state.verificationRecords({threadId:"thread-legacy"})[0].status,"verified");assert.equal(state.repositoryKnowledge({projectPath:"/repo"})[0].fact,"Legacy fact");
    state.updateCheckpoint("cp-legacy",{turnId:"turn-linked"});state.updateSettings({notifications:false});
    const disk=JSON.parse(await readFile(join(home,"ui-state.json"),"utf8"));for(const key of ["checkpoints","usageRecords","verificationRecords","repositoryKnowledge"])assert.equal(Object.prototype.hasOwnProperty.call(disk,key),false,key+" should live in SQLite, not ui-state.json");
    const restarted=new TrebellStateStore(env),snapshot=restarted.snapshot();assert.equal(restarted.checkpoints("thread-legacy")[0].turnId,"turn-linked");assert.equal(snapshot.usageRecords.length,1);assert.equal(snapshot.verificationRecords.length,1);assert.equal(snapshot.repositoryKnowledge.length,1);assert.equal(restarted.settings().notifications,false);
    assert.match(await readFile(join(home,"trebell.sqlite"),"latin1"),/state_usage/);
  }finally{await rm(home,{recursive:true,force:true})}
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

test("environment enabled state persists without deleting the saved profile",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-env-enabled-"));
  const env={...process.env,TREBELL_HOME:home};
  try{
    const state=new TrebellStateStore(env);
    const profile=state.upsertEnvironment({id:"ssh-a",name:"Remote",type:"ssh",host:"example.test"});
    assert.equal(profile.enabled,true);
    assert.equal(state.setEnvironmentEnabled("ssh-a",false).enabled,false);
    assert.equal(state.environments()[0].enabled,false);
    const restarted=new TrebellStateStore(env);
    assert.equal(restarted.environments()[0].enabled,false);
    assert.equal(restarted.setEnvironmentEnabled("ssh-a",true).enabled,true);
    assert.equal(restarted.environments()[0].name,"Remote");
  }finally{await rm(home,{recursive:true,force:true})}
});

test("scoped settings resolve environment defaults and project overrides without leaking between environments",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-state-scopes-"));const env={...process.env,TREBELL_HOME:home};
  try{
    const state=new TrebellStateStore(env);
    state.updateSettings({defaultPermissionMode:"supervised",defaultWorkspaceMode:"current",worktreeSubmodules:"recursive",autoPull:false,defaultModel:"model-global",sourceControlMergeMethod:"squash",sourceControlTextStyle:"concise",sourceControlTextModel:null});
    state.updateEnvironmentDefaults("ssh-a",{defaultPermissionMode:"full",defaultWorkspaceMode:"worktree",worktreeSubmodules:"none",defaultModel:"model-remote",sourceControlMergeMethod:"rebase",sourceControlTextStyle:"repository",sourceControlTextModel:"model-writing",sourceControlCustomInstructions:"Follow repository rules.",sourceControlFollowTemplates:true});
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
