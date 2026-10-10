import test from "node:test";
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TrebellStateStore } from "../src/trebell-state.mjs";
import { AgentRuntimeManager, commandOnPath, openCodeCommandHolder, openCodeInstallOwner, openCodeStatusMessage, parseCursorAboutResult, parseGrokModelsAuth, parseOpenCodeAuthList, runtimeCapabilities, runtimeCompatibility, runtimeExecutableCandidates } from "../src/agent-runtime-manager.mjs";
import { runtimeCapabilityKinds, sharedRuntimeCapabilities } from "../src/runtime-capabilities.mjs";
import { AcpAgentSession } from "../src/acp-agent-session.mjs";
import { AgentThreadStore } from "../src/agent-thread-store.mjs";
import { TerminalManager } from "../src/terminal-manager.mjs";

test("agent runtime registry exposes real harnesses and capability-gates configured instances", async () => {
  const home=await mkdtemp(join(tmpdir(),"trebell-agent-runtime-"));
  try{
    const state=new TrebellStateStore({...process.env,TREBELL_HOME:home});
    const manager=new AgentRuntimeManager({state,env:{...process.env,TREBELL_HOME:home}});
    assert.deepEqual(manager.definitions().map(item=>item.id),["native","codex","claude","cursor","grok","opencode","antigravity"]);
    const nativeStatus=await manager.probe("native");assert.equal(nativeStatus.available,true);assert.equal(nativeStatus.protocol,"native");assert.equal(nativeStatus.binary,null);
    assert.throws(()=>manager.upsertInstance({id:"native-extra",kind:"native"}),/does not support additional runtime profiles/i);
    const credential=["runtime","profile","credential"].join("-");
    const fake=manager.upsertInstance({id:"cursor-fixture",kind:"cursor",displayName:"Fixture Cursor",binaryPath:process.execPath,environment:{CURSOR_API_KEY:credential,NODE_ENV:"test"}});
    assert.deepEqual(fake.environment,{NODE_ENV:"test"});
    assert.doesNotMatch(await readFile(join(home,"ui-state.json"),"utf8"),new RegExp(credential));
    const status=await manager.probe(fake);
    assert.equal(status.installed,true);
    assert.equal(status.available,true);
    const selected=await manager.setActive({runtime:"cursor",instanceId:fake.id});
    assert.equal(selected.runtime,"cursor");
    assert.equal(state.settings().agentRuntimeInstanceId,fake.id);
    // A "Cursor" that cannot answer over ACP reports why, instead of a stand-in model.
    const models=await manager.models(fake);
    assert.deepEqual(models.models,[]);assert.match(models.error,/Cursor could not list its models/);
    assert.equal(manager.capabilities("codex").nativeSandbox,true);
    assert.equal(manager.capabilities("native").dynamicTools,true);
    assert.equal(manager.capabilities("native").dynamicToolExpansion,true);
    assert.equal(manager.capabilities("native").nativeSandbox,false);
    assert.equal(manager.capabilities("native").mcpInjection,true);
    assert.equal(manager.capabilities("native").languageIntelligence,true);
    assert.equal(manager.capabilities("native").delegation,true);
    assert.equal(manager.capabilities("opencode").nativeLsp,true);
    assert.equal(manager.capabilities("opencode").detachedTasks,true);
    assert.equal(manager.capabilities("opencode").multiModelFanout,true);
    assert.equal(manager.capabilities("opencode").delegation,true);
    assert.equal(manager.capabilities("opencode").backgroundProcesses,false);
    assert.equal(manager.capabilities("claude").rewind,true);
    assert.equal(manager.capabilities("claude").mcpInjection,true);
    assert.equal(manager.capabilities("claude").detachedTasks,true);
    assert.equal(manager.capabilities("claude").delegation,true);
    assert.equal(manager.capabilities("claude").runtimeProfileSwitching,true);
    assert.equal(manager.capabilities("cursor").fork,"runtime");
    assert.equal(manager.capabilities("cursor").mcpInjection,true);
    assert.equal(manager.capabilities("cursor").clientFilesystem,false,"Cursor runs its own file tools (T3 offers ACP agents no client files)");
    assert.equal(manager.capabilities("antigravity").clientFilesystem,true);
    assert.equal(manager.capabilities("grok").clientTerminal,false);
    assert.equal(manager.capabilities("cursor").nativeSandbox,false);
  }finally{
    await rm(home,{recursive:true,force:true});
  }
});

test("runtime capabilities describe adapter behavior without pretending unsupported features exist",()=>{
  assert.deepEqual(new Set(runtimeCapabilityKinds),new Set(["native","codex","claude","opencode","cursor","grok","antigravity"]));
  for(const runtime of runtimeCapabilityKinds)assert.deepEqual(runtimeCapabilities(runtime),sharedRuntimeCapabilities(runtime));
  const codex=runtimeCapabilities("codex");
  assert.equal(codex.dynamicTools,true);
  assert.equal(codex.projectOwnership,true);
  assert.equal(codex.dynamicToolExpansion,false);
  assert.equal(codex.nativeQueue,true);
  assert.equal(codex.mcpInjection,false);
  assert.equal(codex.managedInference,false);
  assert.equal(codex.backgroundProcesses,false,"Codex does not implement Trebell's thread/backgroundTerminals RPC surface");
  const native=runtimeCapabilities("native");
  assert.equal(native.projectOwnership,false);
  assert.equal(native.dynamicTools,true);assert.equal(native.dynamicToolExpansion,true);assert.equal(native.contextReporting,true);assert.equal(native.nativeQueue,true);assert.equal(native.nativeHistoryPagination,true);assert.equal(native.threadSearch,true);assert.equal(native.languageIntelligence,true);assert.equal(native.nativeLsp,false);assert.equal(native.clientFilesystem,true);assert.equal(native.clientTerminal,true);assert.equal(native.fork,true);assert.equal(native.rewind,true);
  assert.equal(native.mcpInjection,true);assert.equal(native.systemPromptInjection,true);assert.equal(native.compaction,true);assert.equal(native.delegation,true);assert.equal(native.steering,true);assert.equal(native.backgroundProcesses,true);assert.equal(native.managedInference,true);
  const openCode=runtimeCapabilities("opencode");
  assert.equal(openCode.compaction,true);
  assert.equal(openCode.nativeLsp,true);
  assert.equal(openCode.languageIntelligence,true);
  assert.equal(openCode.mcpInjection,false);
  assert.equal(openCode.detachedTasks,true);
  assert.equal(openCode.multiModelFanout,true);
  assert.equal(openCode.delegation,true,"Trebell supplies provider-neutral child-task delegation");
  assert.equal(openCode.managedInference,false);
  assert.equal(openCode.backgroundProcesses,false);
  assert.equal(runtimeCapabilities("claude").runtimeProfileSwitching,true);
  assert.equal(runtimeCapabilities("claude").delegation,true);
  const acp=runtimeCapabilities("grok");
  assert.equal(acp.queue,true,"Trebell supplies the queue for external runtimes");
  assert.equal(acp.fork,"runtime","ACP forking must stay conditional on what the connected runtime advertises");
  assert.equal(acp.rewind,true,"a Grok revert starts a fresh session, as T3's ACP rollbackThread does");
  assert.equal(runtimeCapabilities("antigravity").rewind,true);
  assert.equal(runtimeCapabilities("cursor").rewind,false,"Cursor offers no rollback (T3 canRollbackThread false)");
  assert.equal(acp.delegation,true,"manual Trebell delegation stays available even when the runtime cannot invoke dynamic tools itself");
  assert.equal(acp.videoAttachments,true);
  assert.equal(runtimeCapabilities("antigravity").videoAttachments,false,"Antigravity attachment limits belong in the capability contract, not UI runtime-name checks");
});

test("runtime launch flags preserve Trebell permission-mode boundaries",()=>{
  const manager=new AgentRuntimeManager();
  const cursor={kind:"cursor"},grok={kind:"grok"};
  assert.deepEqual(manager.acpArgs(cursor,"supervised"),["acp"]);
  assert.deepEqual(manager.acpArgs(cursor,"edits"),["acp"],"Cursor edits mode must stay under Trebell ACP approvals instead of enabling broad Auto-review");
  assert.deepEqual(manager.acpArgs(cursor,"auto"),["--auto-review","acp"]);
  assert.deepEqual(manager.acpArgs(cursor,"full"),["--force","acp"]);
  assert.deepEqual(manager.acpArgs(grok,"supervised"),["--permission-mode","default","agent","stdio"]);
  assert.deepEqual(manager.acpArgs(grok,"edits"),["--permission-mode","default","agent","stdio"],"grok agent has no accept-edits mode (it treats acceptEdits as asking); Trebell answers its edit requests itself");
  assert.deepEqual(manager.acpArgs(grok,"auto"),["--permission-mode","auto","agent","stdio"]);
  assert.deepEqual(manager.acpArgs(grok,"full"),["agent","--always-approve","stdio"]);
});

test("Windows runtime discovery includes current installer locations even when PATH is stale",()=>{
  const env={USERPROFILE:"C:\\Users\\me",LOCALAPPDATA:"C:\\Users\\me\\AppData\\Local",APPDATA:"C:\\Users\\me\\AppData\\Roaming"};
  assert.ok(runtimeExecutableCandidates("grok",{env,platform:"win32"}).some(path=>path.endsWith("xAI.GrokBuild_Microsoft.Winget.Source_8wekyb3d8bbwe\\grok.exe")));
  const claudeCandidates=runtimeExecutableCandidates("claude",{env,platform:"win32"});
  assert.ok(claudeCandidates.some(path=>path.endsWith(".local\\bin\\claude.exe")));
  const npmClaudeBinary=claudeCandidates.findIndex(path=>path.endsWith("npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"));
  assert.ok(npmClaudeBinary>=0&&npmClaudeBinary<claudeCandidates.findIndex(path=>path.endsWith("npm\\claude.cmd")),"the native binary behind npm's shim is preferred over the .cmd shim");
  const openCodeCandidates=runtimeExecutableCandidates("opencode",{env,platform:"win32"});
  assert.ok(openCodeCandidates[0].endsWith("AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe"));
  assert.ok(openCodeCandidates.some(path=>path.endsWith("AppData\\Roaming\\npm\\opencode.cmd")));
  const cursorCandidates=runtimeExecutableCandidates("cursor",{env,platform:"win32"});
  assert.ok(cursorCandidates[0].endsWith("AppData\\Local\\cursor-agent\\cursor-agent.cmd"),"the official Cursor launcher is preferred over whatever cursor-agent PATH finds first");
  assert.ok(cursorCandidates.some(path=>path.endsWith(".cursor\\bin\\cursor-agent.exe")));
  assert.ok(cursorCandidates.some(path=>path.endsWith("AppData\\Local\\Programs\\cursor\\resources\\app\\bin\\cursor-agent.exe")));
  assert.deepEqual(runtimeExecutableCandidates("grok",{env,platform:"linux"}),[]);
});

const CURSOR_LAUNCHER_FIXTURE=String.raw`
import readline from "node:readline";
const args=process.argv.slice(2);
if(args[0]==="--version")process.stdout.write("2026.09.26-dd393fe\n");
else if(args[0]==="about")process.stdout.write(args.join(" ")==="about --format json"?JSON.stringify({cliVersion:"2026.09.26-dd393fe",userEmail:"dev@example.test"})+"\n":"User Email          dev@example.test\n");
else if(args.at(-1)==="acp"){
  const send=message=>process.stdout.write(JSON.stringify(message)+"\n");
  let picker=false;
  readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on("line",line=>{
    let m;try{m=JSON.parse(line)}catch{return}
    if(m.method==="initialize"){picker=m.params?.clientCapabilities?._meta?.parameterizedModelPicker===true;send({jsonrpc:"2.0",id:m.id,result:{protocolVersion:1,agentInfo:{name:"cursor-launcher-fixture"},agentCapabilities:{sessionCapabilities:{close:{}}}}})}
    // Cursor 2026.09 lists base model ids with per-model options only to a client with the parameterized model picker.
    else if(m.method==="cursor/list_available_models")send(picker
      ?{jsonrpc:"2.0",id:m.id,result:{models:[{value:"default",name:"Auto",configOptions:[]},{value:"gpt-5.6-sol",name:"GPT-5.6 Sol",configOptions:[{id:"reasoning",name:"Reasoning",category:"thought_level",type:"select",currentValue:"medium",options:[{value:"none",name:"None"},{value:"low",name:"Low"},{value:"medium",name:"Medium"},{value:"high",name:"High"},{value:"xhigh",name:"Extra High"}]}]}]}}
      :{jsonrpc:"2.0",id:m.id,error:{code:-32601,message:"Method not found"}});
    else if(m.method==="session/new")send({jsonrpc:"2.0",id:m.id,result:{sessionId:"cursor-launcher-session",models:{currentModelId:"default",availableModels:[{modelId:"default",name:"Auto"}]},configOptions:[{id:"model",name:"Model",category:"model",type:"select",currentValue:"default",options:[{value:"default",name:"Auto"}]}]}});
    else if(m.id!=null)send({jsonrpc:"2.0",id:m.id,result:{}});
  });
}else{process.stderr.write("unexpected arguments: "+args.join(" ")+"\n");process.exitCode=2}
`;

test("the official Cursor .cmd launcher wins over PATH and serves version, about and ACP sessions",{skip:process.platform!=="win32"&&"Windows-only launcher discovery"},async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-cursor-launcher-"));
  const local=join(root,"Local"),launcherDir=join(local,"cursor-agent"),decoyBin=join(root,"npm"),fixture=join(launcherDir,"fixture.mjs"),launcher=join(launcherDir,"cursor-agent.cmd");
  try{
    await Promise.all([mkdir(launcherDir,{recursive:true}),mkdir(decoyBin,{recursive:true}),mkdir(join(root,"user"),{recursive:true})]);
    await writeFile(fixture,CURSOR_LAUNCHER_FIXTURE,"utf8");
    await writeFile(launcher,["@echo off",`"${process.execPath}" "${fixture}" %*`,""].join("\r\n"),"utf8");
    // An unrelated npm package's cursor-agent shim that PATH would find first.
    await writeFile(join(decoyBin,"cursor-agent.cmd"),["@echo off","echo spawn EINVAL 1>&2","exit /b 1",""].join("\r\n"),"utf8");
    const parent=Object.fromEntries(Object.entries(process.env).filter(([key])=>key.toUpperCase()!=="PATH"));
    const env={...parent,PATH:decoyBin+";"+String(process.env.PATH||""),TREBELL_HOME:join(root,"home"),LOCALAPPDATA:local,USERPROFILE:join(root,"user")};
    const manager=new AgentRuntimeManager({state:new TrebellStateStore(env),env,platform:"win32"});
    const instance=manager.instances().find(item=>item.id==="cursor-default");
    assert.equal(manager.executable(instance),launcher,"the official launcher is used as-is because it is not an npm %~dp0 shim");
    const status=await manager.probe(instance);
    assert.equal(status.installed,true);assert.equal(status.available,true);assert.equal(status.binary,launcher);
    assert.equal(status.version,"2026.09.26-dd393fe");assert.equal(status.authenticated,true);assert.equal(status.account?.email,"dev@example.test");
    // The model list is Cursor's own (T3's ACP-era discovery), with names and per-model effort; Auto is the default.
    const listed=await manager.models(instance);
    assert.deepEqual(listed.models,["default","gpt-5.6-sol"]);assert.equal(listed.preferred,"default");assert.equal(listed.source,"live");
    assert.equal(listed.metadata[1].name,"GPT-5.6 Sol");assert.deepEqual(listed.metadata[1].reasoningEfforts,["low","medium","high","xhigh"]);assert.equal(listed.metadata[1].defaultReasoningEffort,"medium");
    const session=new AcpAgentSession({runtime:"cursor",command:manager.executable(instance),args:manager.acpArgs(instance,"supervised"),cwd:root,env:manager.childEnv(instance)});
    try{
      const started=await session.start();
      assert.equal(started.session.sessionId,"cursor-launcher-session");assert.equal(started.initialize.agentInfo.name,"cursor-launcher-fixture");
      assert.equal(session.model,"default","a thread with no model runs on Cursor's Auto, set explicitly because Cursor saves its model globally");
    }finally{await session.close()}
  }finally{await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100})}
});

test("runtime child environments do not inherit unrelated parent secrets",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-runtime-env-"));
  try{
    const state=new TrebellStateStore({...process.env,TREBELL_HOME:home});
    const manager=new AgentRuntimeManager({
      state,platform:"linux",
      env:{PATH:"/usr/bin",HOME:"/home/test",ANTHROPIC_API_KEY:"claude-secret",OPENAI_API_KEY:"openai-secret",GITHUB_TOKEN:"github-secret",TEAM_PROXY:"http://proxy"},
    });
    const claude=manager.upsertInstance({id:"claude-safe",kind:"claude",displayName:"Claude safe",approvedEnvironmentKeys:["TEAM_PROXY","GITHUB_TOKEN"],environment:{CUSTOM_MODE:"safe",CURSOR_API_KEY:"must-not-persist"}});
    assert.deepEqual(claude.environment,{CUSTOM_MODE:"safe"});
    assert.deepEqual(claude.approvedEnvironmentKeys,["TEAM_PROXY","GITHUB_TOKEN"]);
    const env=manager.childEnv(claude);
    assert.equal(env.PATH,"/usr/bin");assert.equal(env.ANTHROPIC_API_KEY,"claude-secret");assert.equal(env.OPENAI_API_KEY,undefined);
    assert.equal(env.GITHUB_TOKEN,"github-secret","explicit approval should pass the current parent value without storing it");assert.equal(env.TEAM_PROXY,"http://proxy");assert.equal(env.CUSTOM_MODE,"safe");
    const persisted=await readFile(join(home,"ui-state.json"),"utf8");
    assert.doesNotMatch(persisted,/claude-secret|github-secret|http:\/\/proxy/);assert.match(persisted,/GITHUB_TOKEN/);
  }finally{await rm(home,{recursive:true,force:true})}
});

test("remote runtime process spawning cannot escape the active workspace cwd",()=>{
  const calls=[],state={settings:()=>({activeEnvironmentId:"ssh-fixture"})},profile={id:"ssh-fixture",type:"ssh",cwd:"/srv/app"};
  const environments={get:id=>id===profile.id?profile:null,spawnArgv:(id,options)=>{calls.push({id,options});return {pid:123}}};
  const manager=new AgentRuntimeManager({state,environments}),io=manager.remoteIo("/srv/app","ssh-fixture");
  assert.ok(io);
  io.spawn({command:"node",args:["script.js"],cwd:"subdir"});
  assert.equal(calls[0].options.cwd,"/srv/app/subdir");
  assert.throws(()=>io.spawn({command:"node",args:[],cwd:"/tmp/outside"}),/outside the active remote workspace/i);
  assert.throws(()=>io.spawn({command:"node",args:[],cwd:"../outside"}),/outside the active remote workspace/i);
  assert.equal(calls.length,1,"rejected remote cwd values must never reach the environment spawner");
});

test("remote runtime processes receive the same least-privilege environment-name allowlist",()=>{
  const calls=[],profile={id:"ssh-fixture",type:"ssh",cwd:"/srv/app"};
  const state={settings:()=>({activeEnvironmentId:"ssh-fixture"})};
  const environments={get:id=>id===profile.id?profile:null,spawnArgv:(id,options)=>{calls.push({id,options});return {pid:123}}};
  const manager=new AgentRuntimeManager({
    state,environments,platform:"linux",
    env:{PATH:"/usr/bin",HOME:"/home/test",ANTHROPIC_API_KEY:"claude-secret",OPENAI_API_KEY:"other-secret",TEAM_PROXY:"http://proxy"},
  });
  const instance={id:"claude-remote",kind:"claude",approvedEnvironmentKeys:["TEAM_PROXY"],environment:{}};
  const spawnRuntime=manager.processSpawner(instance,"ssh-fixture");assert.ok(spawnRuntime);
  spawnRuntime({args:["--version"],cwd:"/srv/app",stdio:["ignore","pipe","pipe"]});
  const names=calls[0].options.environmentNames;
  assert.ok(names.includes("PATH"));assert.ok(names.includes("HOME"));assert.ok(names.includes("ANTHROPIC_API_KEY"));assert.ok(names.includes("TEAM_PROXY"));
  assert.equal(names.includes("OPENAI_API_KEY"),false);
});

test("remote runtime spawns carry explicit variables, and the runtime CLI runs where the profile runs",async()=>{
  const spawns=[],executes=[],profile={id:"ssh-fixture",type:"ssh",cwd:"/srv/app"};
  const state={settings:()=>({activeEnvironmentId:"ssh-fixture"})};
  const environments={get:id=>id===profile.id?profile:null,spawnArgv:(id,options)=>{spawns.push({id,options});return {pid:123}},executeArgv:async(id,options)=>{executes.push({id,options});return {exitCode:0,stdout:"",stderr:""}}};
  const manager=new AgentRuntimeManager({state,environments,platform:"linux",env:{PATH:"/usr/bin",HOME:"/home/test",OPENAI_API_KEY:"other-secret"}});
  const instance={id:"opencode-remote",kind:"opencode",approvedEnvironmentKeys:[],environment:{}};
  const spawnRuntime=manager.processSpawner(instance,"ssh-fixture"),config=JSON.stringify({permission:{"*":"deny"}});
  spawnRuntime({args:["acp"],cwd:"/srv/app",environment:{OPENCODE_CONFIG_CONTENT:config}});
  spawnRuntime({args:["acp"],cwd:"/srv/app"});
  assert.deepEqual(spawns[0].options.environment,{OPENCODE_CONFIG_CONTENT:config},"an explicit variable reaches the remote process");
  assert.equal(Object.prototype.hasOwnProperty.call(spawns[1].options,"environment"),false,"a plain spawn adds no variables");
  assert.equal(spawns[0].options.command,"opencode");assert.deepEqual(spawns[0].options.args,["acp"]);assert.ok(spawns[0].options.environmentNames.includes("PATH"));
  const result=await manager.runCli(instance,["session","delete","ses_1"],{environmentId:"ssh-fixture",timeoutMs:15_000});
  assert.equal(result.ok,true);assert.equal(executes.length,1);assert.equal(executes[0].id,"ssh-fixture");
  assert.equal(executes[0].options.command,"opencode");assert.deepEqual(executes[0].options.args,["session","delete","ses_1"]);assert.equal(executes[0].options.timeoutMs,15_000);
  assert.deepEqual(executes[0].options.environmentNames,spawns[0].options.environmentNames,"the CLI runs with the profile's variable allowlist");
});

test("Claude runtime profiles validate and persist auto-compact thresholds",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-claude-compact-"));
  try{
    const state=new TrebellStateStore({...process.env,TREBELL_HOME:home});
    const manager=new AgentRuntimeManager({state,env:{...process.env,TREBELL_HOME:home}});
    const saved=manager.upsertInstance({id:"claude-compact",kind:"claude",displayName:"Claude Compact",autoCompactWindow:"300000"});
    assert.equal(saved.autoCompactWindow,300000);
    assert.equal(manager.instances().find(item=>item.id==="claude-compact")?.autoCompactWindow,300000);
    assert.throws(()=>manager.upsertInstance({id:"claude-bad",kind:"claude",autoCompactWindow:"99999"}),/between 100000 and 1000000/);
    const cleared=manager.upsertInstance({...saved,autoCompactWindow:""});
    assert.equal(cleared.autoCompactWindow,null);
  }finally{await rm(home,{recursive:true,force:true})}
});

test("Claude models and plan usage come from Claude Code's own capability probe",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-claude-models-"));
  try{
    const env={...process.env,TREBELL_HOME:home};
    const state=new TrebellStateStore(env);
    const loads=[];let failure=null;
    const probe={
      models:[
        {value:"default",displayName:"Default (recommended)",description:"Opus 5.5",supportedEffortLevels:["low","medium","high","xhigh","max"],supportsFastMode:true},
        {value:"haiku",displayName:"Haiku",supportedEffortLevels:["low","high","ultra"]},
      ],
      commands:[{name:"review",description:"Review"}],agents:[{name:"Plan"}],usage:{rate_limits_available:true,rate_limits:{five_hour:{utilization:12,resets_at:"2026-10-09T22:59:59Z"}}},checkedAt:"2026-10-09T20:00:00.000Z",
    };
    const claudeCapabilitiesCache={load:async(input,options)=>{loads.push({input,options});if(failure)throw failure;return probe}};
    const manager=new AgentRuntimeManager({state,env,claudeCapabilitiesCache});
    manager.probe=async()=>({available:true,installed:true,authenticated:true});
    const models=await manager.models("claude");
    assert.deepEqual(models.models,["default","haiku"]);
    assert.equal(models.preferred,"default","Claude Code's own default model is preselected");
    assert.equal(models.source,"live");
    assert.deepEqual(models.inventory,{commands:[{name:"review",description:"Review"}],agents:[{name:"Plan"}]},"the probe's commands and agents fill a new chat's menus");
    assert.deepEqual(models.metadata[0],{id:"default",name:"Default (recommended)",provider:"claude",agent:"Claude Code",description:"Opus 5.5",supportedReasoningEfforts:["low","medium","high","xhigh","max"],supportsFastMode:true,supportedServiceTiers:["fast"]});
    assert.deepEqual(models.metadata[1].supportedReasoningEfforts,["low","high"]);
    assert.equal(loads[0].input.cwd,null);assert.equal(loads[0].input.spawnProcess,null);assert.equal(loads[0].input.scope,"");assert.equal(loads[0].input.includeUsage,true);
    const usage=await manager.usageLimits("claude");
    assert.deepEqual(usage.windows.map(window=>[window.id,window.label,window.usedPercent]),[["five_hour","Session",12]]);
    failure=new Error("Claude Code did not report its capabilities in time.");
    assert.deepEqual(await manager.models("claude"),{models:[],metadata:[],source:"unavailable",error:"Claude Code could not list its models: Claude Code did not report its capabilities in time."});
    assert.deepEqual((await manager.usageLimits("claude")).unavailable,{reason:"probeFailed",message:"Claude Code could not read usage limits."});
  }finally{await rm(home,{recursive:true,force:true})}
});

test("runtime profile compatibility follows continuation identity instead of display names",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-runtime-compat-"));
  try{
    const nativeCodexHome=join(home,"codex-env"),env={...process.env,TREBELL_HOME:home,CODEX_HOME:nativeCodexHome,CLAUDE_CONFIG_DIR:join(home,"claude-default")};
    const state=new TrebellStateStore(env);
    const manager=new AgentRuntimeManager({state,env,platform:"win32"});
    assert.equal(manager.childEnv(manager.instances().find(item=>item.id==="codex-default")).CODEX_HOME,nativeCodexHome);
    assert.match(manager.continuationKey("codex-default").toLowerCase(),new RegExp(resolve(nativeCodexHome).replace(/[.*+?^${}()|[\]\\]/g,"\\$&").toLowerCase()));
    const sharedCodex=join(home,"shared-codex");
    manager.upsertInstance({id:"codex-work",kind:"codex",displayName:"Work",homePath:sharedCodex,shadowHomePath:join(home,"codex-work-auth")});
    manager.upsertInstance({id:"codex-personal",kind:"codex",displayName:"Personal",homePath:sharedCodex,shadowHomePath:join(home,"codex-personal-auth")});
    manager.upsertInstance({id:"codex-isolated",kind:"codex",displayName:"Isolated",homePath:join(home,"isolated-codex")});
    assert.deepEqual(new Set(manager.compatibleInstanceIds("codex-work")),new Set(["codex-work","codex-personal"]));
    assert.equal(manager.continuationKey("codex-work"),manager.continuationKey("codex-personal"));
    assert.notEqual(manager.continuationKey("codex-work"),manager.continuationKey("codex-isolated"));

    const sharedClaude=join(home,"claude-shared");
    manager.upsertInstance({id:"claude-work",kind:"claude",displayName:"Claude Work",homePath:sharedClaude});
    manager.upsertInstance({id:"claude-personal",kind:"claude",displayName:"Claude Personal",homePath:sharedClaude});
    manager.upsertInstance({id:"claude-isolated",kind:"claude",displayName:"Claude Isolated",homePath:join(home,"claude-isolated")});
    assert.deepEqual(new Set(manager.compatibleInstanceIds("claude-work")),new Set(["claude-work","claude-personal"]));
    assert.notEqual(manager.continuationKey("claude-work"),manager.continuationKey("claude-isolated"));
  }finally{await rm(home,{recursive:true,force:true})}
});

test("runtime installer uses only official allowlisted packages in the selected environment", async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-agent-install-"));
  const env={...process.env,TREBELL_HOME:home};const calls=[];
  try{
    const state=new TrebellStateStore(env);state.updateSettings({activeEnvironmentId:"ssh-fixture"});
    const environments={
      get:id=>id==="ssh-fixture"?{id,name:"Fixture SSH",type:"ssh",cwd:"/srv/app"}:null,
      executeArgv:async(id,{command,args})=>{
        calls.push({id,command,args:[...args]});
        if(command==="npm"&&args[0]==="--version")return {exitCode:0,stdout:"11.0.0\n",stderr:""};
        if(command==="npm"&&args[0]==="install")return {exitCode:0,stdout:"installed\n",stderr:""};
        if(command==="claude"&&args[0]==="--version")return {exitCode:0,stdout:"claude 2.0.0\n",stderr:""};
        if(command==="claude"&&args[0]==="auth")return {exitCode:0,stdout:JSON.stringify({loggedIn:false}),stderr:""};
        return {exitCode:1,stdout:"",stderr:"unexpected command"};
      },
    };
    const manager=new AgentRuntimeManager({state,env,environments});
    const installed=await manager.install("claude");
    assert.equal(installed.packageName,"@anthropic-ai/claude-code");
    assert.equal(installed.status.installed,true);assert.equal(installed.status.authenticated,false);
    assert.equal(installed.status.message,"Claude Code is not authenticated. Run `claude auth login` and try again.");
    assert.equal(calls.some(call=>call.command==="npm"&&call.args.join(" ")==="install -g @anthropic-ai/claude-code"),true);
    await assert.rejects(()=>manager.install("cursor"),/not installable/i);
    const snapshot=await manager.snapshot();
    assert.equal(snapshot.definitions.find(item=>item.id==="claude").installable,true);
    // OpenCode 1.x is the opencode-ai package; @opencode/cli is OpenCode 2.x, which Trebell Code does not run.
    assert.equal(snapshot.definitions.find(item=>item.id==="opencode").packageName,"opencode-ai");
    assert.match(snapshot.definitions.find(item=>item.id==="opencode").installCommand,/^npm install -g opencode-ai .*opencode upgrade/);
    assert.equal(snapshot.definitions.find(item=>item.id==="claude").installCommand,"npm install -g @anthropic-ai/claude-code");
    assert.equal(snapshot.definitions.find(item=>item.id==="cursor").installable,false);
  }finally{await rm(home,{recursive:true,force:true})}
});

test("OpenCode compatibility blocks known-broken managed updates and pins verified versions",async()=>{
  assert.equal(runtimeCompatibility("opencode","opencode 1.14.18").status,"broken");
  assert.equal(runtimeCompatibility("opencode","v1.14.19").status,"supported");
  assert.equal(runtimeCompatibility("opencode","1.18.32").status,"supported");
  assert.equal(runtimeCompatibility("opencode","dev-build").status,"unknown");
  // OpenCode 2.x prints "opencode v2.0.18" and serves another API (T3 Code's versionProbe tells the two apart the same way).
  const v2=runtimeCompatibility("opencode","opencode v2.0.18");
  assert.equal(v2.status,"unsupported");assert.match(v2.message,/^OpenCode 2\.x is not supported yet: .*opencode-ai/);
  const home=await mkdtemp(join(tmpdir(),"trebell-opencode-compat-"));const env={...process.env,TREBELL_HOME:home};
  try{
    const state=new TrebellStateStore(env);const calls=[];let candidate="1.14.18",installedVersion="1.14.10",installTakes=true;
    const environments={
      get:id=>id==="ssh-fixture"?{id,name:"Fixture SSH",type:"ssh",cwd:"/srv/app"}:null,
      executeArgv:async(id,{command,args})=>{
        calls.push({id,command,args:[...args]});
        if(command==="npm"&&args[0]==="--version")return {exitCode:0,stdout:"11.0.0\n",stderr:""};
        if(command==="npm"&&args[0]==="view")return {exitCode:0,stdout:JSON.stringify(candidate)+"\n",stderr:""};
        if(command==="npm"&&args[0]==="install"){if(installTakes)installedVersion=args.at(-1).split("@").at(-1);return {exitCode:0,stdout:"installed\n",stderr:""}}
        if(command==="opencode"&&args[0]==="--version")return {exitCode:0,stdout:"opencode "+installedVersion+"\n",stderr:""};
        if(command==="opencode"&&args[0]==="auth")return {exitCode:0,stdout:"— 1 credentials\n",stderr:""};
        return {exitCode:1,stdout:"",stderr:"unexpected command"};
      },
    };
    state.updateSettings({activeEnvironmentId:"ssh-fixture"});
    const manager=new AgentRuntimeManager({state,env,environments});
    const installs=()=>calls.filter(call=>call.command==="npm"&&call.args[0]==="install").map(call=>call.args.join(" "));
    await assert.rejects(()=>manager.install("opencode"),/known to be incompatible/i);
    assert.deepEqual(installs(),[]);
    candidate="1.14.19";
    const installed=await manager.install("opencode");
    assert.equal(installed.targetVersion,"1.14.19");assert.equal(installed.packageName,"opencode-ai");assert.equal(installed.method,"npm");
    assert.equal(installed.compatibility.status,"supported");
    // OpenCode 1.x's own package, with its install script allowed (npm 12 skips it otherwise, T3 Code); never 2.x's @opencode/cli.
    assert.deepEqual(installs(),["install -g --allow-scripts=opencode-ai opencode-ai@1.14.19"]);
    assert.equal(installed.status.version,"opencode 1.14.19");assert.equal(installed.status.compatibility.status,"supported");
    // Already the newest release: nothing is installed again.
    assert.match((await manager.install("opencode")).output,/already the newest/i);assert.equal(installs().length,1);
    // An install that leaves the OpenCode this profile runs on its old version is reported, not shown as ready.
    candidate="1.14.20";installTakes=false;
    await assert.rejects(()=>manager.install("opencode"),/OpenCode 1\.14\.20 was installed, but the OpenCode this profile runs .* still reports 1\.14\.19/);
    // OpenCode 2.x is neither updated nor joined by a 1.x install: 2.x converts OpenCode's shared database.
    installedVersion="v2.0.24";const before=calls.length;
    await assert.rejects(()=>manager.install("opencode"),/OpenCode 2\.x converts OpenCode's shared database in place/);
    assert.deepEqual(calls.slice(before).map(call=>call.command+" "+call.args.join(" ")),["opencode --version"]);
    // A remote 2.x is reported as unsupported (Trebell has not been verified with it); its ACP status check still runs.
    const remote2x=await manager.probe("opencode");
    assert.equal(remote2x.compatibility.status,"unsupported");assert.equal(remote2x.authenticated,true);
  }finally{await rm(home,{recursive:true,force:true})}
});

// The Windows command shim npm writes for a package's bin.
const npmShim=target=>["@ECHO off","GOTO start",":find_dp0","SET dp0=%~dp0","EXIT /b",":start","SETLOCAL","CALL :find_dp0",`"%dp0%\\${target}"   %*`,""].join("\r\n");

test("Trebell updates an OpenCode only the way it was installed, judged from where its binary really is",()=>{
  const exists=paths=>path=>paths.includes(path);
  assert.deepEqual(openCodeInstallOwner("/home/dev/.opencode/bin/opencode",{platform:"linux"}),{method:"native"});
  assert.deepEqual(openCodeInstallOwner("C:\\Users\\dev\\.opencode\\bin\\opencode.exe",{platform:"win32"}),{method:"native"});
  assert.deepEqual(openCodeInstallOwner("/usr/local/lib/node_modules/opencode-ai/bin/opencode",{platform:"linux"}),{method:"npm",prefix:"/usr/local"});
  const roaming="C:\\Users\\dev\\AppData\\Roaming\\npm";
  assert.deepEqual(openCodeInstallOwner(roaming+"\\node_modules\\opencode-ai\\bin\\opencode.exe",{platform:"win32",exists:exists([roaming+"\\opencode.cmd"])}),{method:"npm",prefix:roaming});
  // Without npm's shim beside node_modules the folder is not a global prefix (a project's node_modules, for one).
  assert.equal(openCodeInstallOwner("C:\\work\\app\\node_modules\\opencode-ai\\bin\\opencode.exe",{platform:"win32",exists:exists([])}),null);
  assert.equal(openCodeInstallOwner("/work/app/node_modules/.pnpm/node_modules/opencode-ai/bin/opencode",{platform:"linux"}),null);
  assert.equal(openCodeInstallOwner("/usr/local/lib/node_modules/tool/node_modules/opencode-ai/bin/opencode",{platform:"linux"}),null);
  // OpenCode 2.x's package, Homebrew and other installs are not Trebell's to update.
  assert.equal(openCodeInstallOwner(roaming+"\\node_modules\\@opencode\\cli\\bin\\opencode.exe",{platform:"win32",exists:exists([roaming+"\\opencode.cmd"])}),null);
  assert.equal(openCodeInstallOwner("/opt/homebrew/Cellar/opencode/1.18.32/bin/opencode",{platform:"darwin"}),null);
  // npm does not replace a command another package installed, so an npm update needs the prefix's opencode command to be opencode-ai's.
  const missing=()=>{throw Object.assign(new Error("missing"),{code:"ENOENT"})};
  assert.equal(openCodeCommandHolder(roaming,{platform:"win32",read:()=>npmShim("node_modules\\@opencode\\cli\\bin\\opencode.exe")}),"@opencode/cli");
  assert.equal(openCodeCommandHolder(roaming,{platform:"win32",read:()=>npmShim("node_modules\\opencode-ai\\bin\\opencode.exe")}),null);
  assert.equal(openCodeCommandHolder(roaming,{platform:"win32",read:missing}),null,"npm creates a command that is not there yet");
  assert.equal(openCodeCommandHolder("/usr/local",{platform:"linux",readLink:()=>"../lib/node_modules/@opencode/cli/bin/opencode"}),"@opencode/cli");
  assert.equal(openCodeCommandHolder("/usr/local",{platform:"linux",readLink:()=>"../lib/node_modules/opencode-ai/bin/opencode"}),null);
  assert.equal(openCodeCommandHolder("/usr/local",{platform:"linux",readLink:missing}),null);
  assert.equal(openCodeCommandHolder("/usr/local",{platform:"linux",readLink:()=>{throw Object.assign(new Error("not a link"),{code:"EINVAL"})}}),"/usr/local/bin/opencode");
  // A bare command is found as cross-spawn finds it: on PATH, with PATHEXT on Windows.
  const bin="C:\\tools\\bin";
  assert.equal(commandOnPath("opencode",{platform:"win32",env:{PATH:"C:\\empty;"+bin,PATHEXT:".EXE;.CMD"},exists:exists([bin+"\\opencode.CMD"])}),bin+"\\opencode.CMD");
  assert.equal(commandOnPath("opencode",{platform:"linux",env:{PATH:"/usr/bin:/home/dev/.opencode/bin"},exists:exists(["/home/dev/.opencode/bin/opencode"])}),"/home/dev/.opencode/bin/opencode");
  assert.equal(commandOnPath("/opt/opencode",{platform:"linux",env:{},exists:exists([])}),null);
  assert.equal(commandOnPath("C:\\oc\\opencode.exe",{platform:"win32",env:{},exists:exists(["C:\\oc\\opencode.exe"])}),"C:\\oc\\opencode.exe");
  // T3 Code's status wording, from the providers OpenCode's server reports connected.
  assert.equal(openCodeStatusMessage(4),"4 upstream providers connected through OpenCode.");
  assert.equal(openCodeStatusMessage(1,{external:true}),"1 upstream provider connected through the configured OpenCode server.");
  assert.equal(openCodeStatusMessage(0),"OpenCode is available, but it did not report any connected upstream providers.");
});

// A stand-in OpenCode CLI (`--version`, `upgrade`, `serve`) and npm, run through Windows command launchers. They keep their state in
// one JSON file: the installed version, the provider list the server reports, and every call.
const FAKE_OPENCODE_CLI=String.raw`
import { readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
const file=process.env.FAKE_OPENCODE_STATE,state=JSON.parse(readFileSync(file,"utf8")),save=()=>writeFileSync(file,JSON.stringify(state));
const args=process.argv.slice(2);state.calls.push(["opencode",...args]);save();
if(args[0]==="--version"){process.stdout.write(state.version+"\n");process.exit(0)}
if(args[0]==="upgrade"){state.version=args[1];save();process.stdout.write("upgraded\n");process.exit(0)}
if(args[0]!=="serve")process.exit(1);
if(state.serveFails){process.stderr.write("config is broken\n");process.exit(2)}
const port=Number((args.find(arg=>arg.startsWith("--port="))||"").slice(7)),json=(res,value)=>{res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify(value))};
http.createServer((req,res)=>{
  const path=new URL(req.url,"http://127.0.0.1").pathname;
  if(path==="/provider")return json(res,state.providers);
  if(path==="/config"||path==="/skill")return json(res,path==="/config"?{}:[]);
  if(path==="/command")return json(res,[{name:"init"}]);
  if(path==="/agent")return json(res,[{name:"build",mode:"primary"},{name:"general",mode:"subagent"}]);
  if(path==="/instance/dispose")return json(res,true);
  res.writeHead(404);res.end();
}).listen(port,"127.0.0.1",()=>process.stdout.write("opencode server listening on http://127.0.0.1:"+port+"\n"));
`;
const FAKE_NPM=String.raw`
import { readFileSync, writeFileSync } from "node:fs";
const file=process.env.FAKE_OPENCODE_STATE,state=JSON.parse(readFileSync(file,"utf8")),args=process.argv.slice(2);
state.calls.push(["npm",...args]);
if(args[0]==="--version")process.stdout.write("11.0.0\n");
else if(args[0]==="view")process.stdout.write(JSON.stringify(state.latest)+"\n");
else if(args[0]==="install")state.version=args.at(-1).split("@").at(-1);
writeFileSync(file,JSON.stringify(state));
`;
const FIXTURE_PROVIDERS={connected:["opencode","openai"],default:{opencode:"muse"},all:[{id:"opencode",name:"OpenCode Zen",models:{muse:{id:"muse",name:"Muse"}}},{id:"openai",name:"OpenAI",models:{gpt:{id:"gpt",name:"GPT"}}}]};
async function openCodeCliFixture(root,{version="1.18.30",latest="1.18.35"}={}){
  const scripts=join(root,"scripts");await mkdir(scripts,{recursive:true});
  await writeFile(join(scripts,"opencode.mjs"),FAKE_OPENCODE_CLI,"utf8");await writeFile(join(scripts,"npm.mjs"),FAKE_NPM,"utf8");
  const statePath=join(root,"state.json"),write=value=>writeFile(statePath,JSON.stringify(value),"utf8");
  await write({version,latest,providers:FIXTURE_PROVIDERS,calls:[]});
  const launcher=async(path,script)=>{await mkdir(join(path,".."),{recursive:true});await writeFile(path,["@echo off",`"${process.execPath}" "${join(scripts,script)}" %*`,""].join("\r\n"),"utf8")};
  const bin=join(root,"bin");await launcher(join(bin,"npm.cmd"),"npm.mjs");
  const env={...process.env};for(const key of Object.keys(env))if(key.toUpperCase()==="PATH")delete env[key];
  env.PATH=bin+";"+(process.env.PATH||"");env.TREBELL_HOME=join(root,"home");env.FAKE_OPENCODE_STATE=statePath;env.XDG_STATE_HOME=join(root,"xdg-state");
  return {env,launcher,read:async()=>JSON.parse(await readFile(statePath,"utf8")),update:async patch=>write({...JSON.parse(await readFile(statePath,"utf8")),...patch})};
}
const WINDOWS_ONLY={skip:process.platform!=="win32"&&"runs Windows command launchers"};

test("a local OpenCode's status counts the providers its own server connects, once per binary and version",WINDOWS_ONLY,async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-opencode-status-"));
  try{
    const fixture=await openCodeCliFixture(root),binary=join(root,"oc","opencode.cmd");await fixture.launcher(binary,"opencode.mjs");
    const manager=new AgentRuntimeManager({state:new TrebellStateStore(fixture.env),env:fixture.env,platform:"win32"});
    manager.upsertInstance({id:"opencode-default",kind:"opencode",binaryPath:binary,approvedEnvironmentKeys:["FAKE_OPENCODE_STATE","XDG_STATE_HOME"]});
    const serves=async()=>(await fixture.read()).calls.filter(call=>call[1]==="serve").length;
    const status=await manager.probe("opencode");
    assert.deepEqual({available:status.available,authenticated:status.authenticated,account:status.account,message:status.message},{available:true,authenticated:true,account:{connectedProviders:2},message:"2 upstream providers connected through OpenCode."});
    // Thread starts check the status again; they reuse that read, and a model list right after it does too.
    await manager.probe("opencode");
    const listed=await manager.models("opencode");
    assert.equal(await serves(),1);
    assert.deepEqual(listed.models,["opencode/muse","openai/gpt"]);assert.deepEqual(listed.metadata.map(item=>item.name),["Muse","GPT"]);
    assert.deepEqual({commands:listed.inventory.commands.map(item=>item.name),agents:listed.inventory.agents.map(item=>item.name)},{commands:["init"],agents:["build"]});
    assert.equal((await fixture.read()).calls.some(call=>call[1]==="auth"),false,"the provider count comes from OpenCode's server, not its credential list");
    // OpenCode 2.x runs nothing beyond its version check.
    await fixture.update({version:"opencode v2.0.24",calls:[]});
    const v2=await manager.probe("opencode");
    assert.equal(v2.available,false);assert.equal(v2.compatibility.status,"unsupported");assert.match(v2.message,/^OpenCode 2\.x is not supported yet/);
    assert.deepEqual((await fixture.read()).calls,[["opencode","--version"]]);
    // A server that cannot start makes OpenCode unavailable, with its reason.
    await fixture.update({version:"1.18.31",serveFails:true});
    const broken=await manager.probe("opencode");
    assert.equal(broken.available,false);assert.match(broken.message,/^OpenCode could not list its providers: OpenCode server exited with code 2\. config is broken/);
  }finally{await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:200})}
});

test("updating npm's global opencode-ai installs into the prefix that holds the binary Trebell runs",WINDOWS_ONLY,async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-opencode-npm-"));
  try{
    const fixture=await openCodeCliFixture(root),prefix=join(root,"npm"),binary=join(prefix,"node_modules","opencode-ai","bin","opencode.cmd");
    await fixture.launcher(binary,"opencode.mjs");await writeFile(join(prefix,"opencode.cmd"),npmShim("node_modules\\opencode-ai\\bin\\opencode.exe"),"utf8");
    const manager=new AgentRuntimeManager({state:new TrebellStateStore(fixture.env),env:fixture.env,platform:"win32"});
    manager.upsertInstance({id:"opencode-default",kind:"opencode",binaryPath:binary,approvedEnvironmentKeys:["FAKE_OPENCODE_STATE","XDG_STATE_HOME"]});
    const plan=await manager.openCodeInstallPlan();
    assert.deepEqual({method:plan.method,installedVersion:plan.installedVersion,targetVersion:plan.targetVersion,command:plan.command,args:plan.args},{method:"npm",installedVersion:"1.18.30",targetVersion:"1.18.35",command:"npm",args:["install","-g","--prefix",realpathSync(prefix),"--allow-scripts=opencode-ai","opencode-ai@1.18.35"]});
    const installed=await manager.install("opencode");
    assert.equal(installed.status.version,"1.18.35");assert.equal(installed.status.message,"2 upstream providers connected through OpenCode.");
    // An OpenCode Trebell cannot tell who installed is left alone.
    const custom=join(root,"custom","opencode.cmd");await fixture.launcher(custom,"opencode.mjs");
    manager.upsertInstance({id:"opencode-default",kind:"opencode",binaryPath:custom,approvedEnvironmentKeys:["FAKE_OPENCODE_STATE","XDG_STATE_HOME"]});
    await fixture.update({calls:[]});
    await assert.rejects(()=>manager.install("opencode"),/could not tell how .*custom.*opencode\.cmd was installed/);
    assert.deepEqual((await fixture.read()).calls,[["opencode","--version"]]);
    // Once OpenCode 2.x (@opencode/cli) holds the prefix's opencode command, npm would refuse to replace it: Trebell runs no npm.
    manager.upsertInstance({id:"opencode-default",kind:"opencode",binaryPath:binary,approvedEnvironmentKeys:["FAKE_OPENCODE_STATE","XDG_STATE_HOME"]});
    await writeFile(join(prefix,"opencode.cmd"),npmShim("node_modules\\@opencode\\cli\\bin\\opencode.exe"),"utf8");await fixture.update({version:"1.18.30",calls:[]});
    await assert.rejects(()=>manager.install("opencode"),/^Error: npm cannot update opencode-ai in .*npm: the opencode command there runs @opencode\/cli, and npm does not replace another package's command\. Trebell Code changes neither install\./);
    assert.deepEqual((await fixture.read()).calls,[["opencode","--version"]]);
  }finally{await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:200})}
});

test("an OpenCode from its own installer updates with opencode upgrade to the newest 1.x release",WINDOWS_ONLY,async()=>{
  // OpenCode's installer puts its binary in ~/.opencode/bin on macOS and Linux; the launcher stands in for that binary.
  const root=await mkdtemp(join(tmpdir(),"trebell-opencode-native-"));
  try{
    const fixture=await openCodeCliFixture(root),binary=join(root,"home-dir",".opencode","bin","opencode");
    await fixture.launcher(binary+".cmd","opencode.mjs");await writeFile(binary,"","utf8");
    const fetched=[];
    const fetchImpl=async url=>{fetched.push(String(url));return new Response(JSON.stringify({name:"opencode-ai",version:"1.18.40"}),{status:200,headers:{"content-type":"application/json"}})};
    const manager=new AgentRuntimeManager({state:new TrebellStateStore(fixture.env),env:fixture.env,platform:"linux",fetchImpl});
    manager.upsertInstance({id:"opencode-default",kind:"opencode",binaryPath:binary,approvedEnvironmentKeys:["FAKE_OPENCODE_STATE","XDG_STATE_HOME"]});
    const installed=await manager.install("opencode");
    assert.equal(installed.method,"native");assert.equal(installed.targetVersion,"1.18.40");assert.equal(installed.status.version,"1.18.40");
    assert.deepEqual(fetched,["https://registry.npmjs.org/opencode-ai/latest"]);
    const calls=(await fixture.read()).calls;
    assert.deepEqual(calls.find(call=>call[1]==="upgrade"),["opencode","upgrade","1.18.40"]);
    assert.equal(calls.some(call=>call[0]==="npm"),false,"OpenCode's own installer needs no npm");
  }finally{await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:200})}
});

test("remote runtime usage reads the remote login but returns only normalized limits",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-remote-usage-"));const env={...process.env,TREBELL_HOME:home};
  try{
    const state=new TrebellStateStore(env);state.updateSettings({activeEnvironmentId:"ssh-usage",agentRuntime:"cursor",agentRuntimeInstanceId:"cursor-default"});
    const calls=[];
    const encoded=value=>Buffer.from(value,"utf8").toString("base64");
    const environments={
      get:id=>id==="ssh-usage"?{id,name:"Remote usage",type:"ssh",cwd:"/srv/app"}:null,
      executeArgv:async(id,{command,args})=>{
        calls.push({id,command,args:[...args]});
        if(command==="uname")return {exitCode:0,stdout:"Linux\n",stderr:""};
        if(command==="sh")return {exitCode:0,stdout:"HOME="+encoded("/home/dev")+"\nCURSOR_AUTH_TOKEN="+encoded("remote-private-token")+"\n",stderr:""};
        return {exitCode:1,stdout:"",stderr:"not found"};
      },
    };
    let authorization="";
    const manager=new AgentRuntimeManager({state,env,environments,fetchImpl:async(_url,options)=>{authorization=options.headers.authorization;return new Response(JSON.stringify({planUsage:{totalPercentUsed:61}}),{status:200,headers:{"content-type":"application/json"}})}});
    const limits=await manager.usageLimits("cursor");
    assert.equal(authorization,"Bearer remote-private-token");
    assert.equal(limits.windows[0].usedPercent,61);
    assert.doesNotMatch(JSON.stringify(limits),/remote-private-token/);
    assert.equal(calls.some(call=>call.command==="sh"),true);
  }finally{await rm(home,{recursive:true,force:true})}
});

test("provider auth probes distinguish authenticated, unauthenticated and unknown CLI states",()=>{
  assert.deepEqual(parseCursorAboutResult({stdout:JSON.stringify({cliVersion:"2026.03",userEmail:"dev@example.test"}),stderr:"",code:0}),{authenticated:true,email:"dev@example.test"});
  assert.deepEqual(parseCursorAboutResult({stdout:JSON.stringify({cliVersion:"2026.03",userEmail:null}),stderr:"",code:0}),{authenticated:false,email:null});
  assert.deepEqual(parseCursorAboutResult({stdout:"CLI Version 2026.03\nUser Email          Not logged in\n",stderr:"",code:0}),{authenticated:false,email:null});
  assert.equal(parseGrokModelsAuth("You are logged in\n- grok-4.6 (default)"),true);
  assert.equal(parseGrokModelsAuth("Not authenticated. Run grok login."),false);
  assert.equal(parseGrokModelsAuth("- grok-4.6"),null);
  assert.deepEqual(parseOpenCodeAuthList("— 0 credentials\n— 2 environment variables\n"),{connected:2,authenticated:true});
  assert.deepEqual(parseOpenCodeAuthList("— 0 credentials\n— 0 environment variables\n"),{connected:0,authenticated:null});
});

test("runtime auth commands use the provider's real interactive CLI flow",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-runtime-auth-command-"));const env={...process.env,TREBELL_HOME:home};
  try{
    const state=new TrebellStateStore(env);const manager=new AgentRuntimeManager({state,env,platform:"linux"});
    assert.deepEqual(manager.authCommand("claude"),{runtime:"claude",instanceId:"claude-default",name:"Claude Code",command:"claude",args:["auth","login"]});
    assert.deepEqual(manager.authCommand("cursor"),{runtime:"cursor",instanceId:"cursor-default",name:"Cursor",command:"cursor-agent",args:["login"]});
    assert.deepEqual(manager.authCommand("grok"),{runtime:"grok",instanceId:"grok-default",name:"Grok Build",command:"grok",args:["login"]});
    assert.deepEqual(manager.authCommand("opencode"),{runtime:"opencode",instanceId:"opencode-default",name:"OpenCode",command:"opencode",args:["auth","login"]});
    const codexAuth=manager.authCommand("codex");
    assert.equal(codexAuth.runtime,"codex");assert.equal(codexAuth.instanceId,"codex-default");assert.equal(codexAuth.name,"Codex");assert.deepEqual(codexAuth.args,["login"]);assert.ok(codexAuth.command);
    const external=manager.upsertInstance({id:"opencode-external",kind:"opencode",serverUrl:"https://opencode.example.test"});
    assert.throws(()=>manager.authCommand(external),/external server/i);
  }finally{await rm(home,{recursive:true,force:true})}
});

test("remote runtime probes use provider-native auth status without treating unknown as signed out",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-runtime-auth-"));const env={...process.env,TREBELL_HOME:home};
  try{
    const state=new TrebellStateStore(env);state.updateSettings({activeEnvironmentId:"ssh-auth"});
    let cursorLoggedIn=false,grokLoggedIn=false;
    const environments={
      get:id=>id==="ssh-auth"?{id,name:"Auth SSH",type:"ssh",cwd:"/srv/app"}:null,
      executeArgv:async(_id,{command,args})=>{
        if(args[0]==="--version")return {exitCode:0,stdout:"1.20.0\n",stderr:""};
        if(command==="cursor-agent"&&args[0]==="about")return {exitCode:0,stdout:JSON.stringify({userEmail:cursorLoggedIn?"dev@example.test":null}),stderr:""};
        if(command==="grok"&&args[0]==="models")return {exitCode:0,stdout:grokLoggedIn?"You are logged in\n- grok-4.6\n":"Not logged in\n",stderr:""};
        if(command==="opencode"&&args[0]==="auth")return {exitCode:0,stdout:"— 0 credentials\n— 0 environment variables\n",stderr:""};
        return {exitCode:1,stdout:"",stderr:"unexpected command"};
      },
    };
    const manager=new AgentRuntimeManager({state,env,environments});
    const cursorSignedOut=await manager.probe("cursor");assert.equal(cursorSignedOut.authenticated,false);assert.equal(cursorSignedOut.available,false);
    cursorLoggedIn=true;const cursorReady=await manager.probe("cursor");assert.equal(cursorReady.authenticated,true);assert.equal(cursorReady.available,true);assert.equal(cursorReady.account.email,"dev@example.test");
    const grokSignedOut=await manager.probe("grok");assert.equal(grokSignedOut.authenticated,false);assert.equal(grokSignedOut.available,false);
    grokLoggedIn=true;assert.equal((await manager.probe("grok")).authenticated,true);
    const openCode=await manager.probe("opencode");assert.equal(openCode.authenticated,null);assert.equal(openCode.available,true);assert.equal(openCode.account.connectedProviders,0);
  }finally{await rm(home,{recursive:true,force:true})}
});

// Antigravity is the one harness offered the client's files (T3 AntigravityAcpSupport); no harness is offered its terminal.
test("ACP agent session serves Antigravity bounded client files end to end and refuses the terminal it does not offer", async () => {
  const root=await mkdtemp(join(tmpdir(),"trebell-acp-session-"));
  const fixture=join(root,"fake-acp.mjs");
  const input=join(root,"input.txt");
  const output=join(root,"output.txt");
  const mcpPayload=join(root,"mcp.json");
  await writeFile(input,"INPUT_OK","utf8");
  await writeFile(fixture,String.raw`
import readline from "node:readline";
import { writeFile } from "node:fs/promises";
let next=1000; const pending=new Map(); let sessionId="fixture-session";
function send(x){process.stdout.write(JSON.stringify(x)+"\n")}
function request(method,params){const id="s"+(next++);send({jsonrpc:"2.0",id,method,params});return new Promise((resolve,reject)=>pending.set(id,{resolve,reject}))}
async function handle(m){
  if(m.id!=null&&!m.method&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);return}
  if(!m.method||m.id==null)return;
  if(m.method==="initialize")return send({jsonrpc:"2.0",id:m.id,result:{protocolVersion:1,agentInfo:{name:"fixture",version:"1"},agentCapabilities:{loadSession:true,sessionCapabilities:{resume:{},close:{}}}}});
  if(m.method==="session/new"||m.method==="session/resume"||m.method==="session/load"){await writeFile(${JSON.stringify(mcpPayload)},JSON.stringify(m.params.mcpServers||[]));return send({jsonrpc:"2.0",id:m.id,result:{sessionId,models:{currentModelId:"fake-model",availableModels:[{modelId:"fake-model",name:"Fake"}]},configOptions:[],modes:{currentModeId:"build",availableModes:[]}}})}
  if(m.method==="session/set_model")return send({jsonrpc:"2.0",id:m.id,result:{}});
  if(m.method==="session/close")return send({jsonrpc:"2.0",id:m.id,result:{}});
  if(m.method==="session/prompt"){
    const read=await request("fs/read_text_file",{sessionId,path:${JSON.stringify(input)}});
    await request("fs/write_text_file",{sessionId,path:${JSON.stringify(output)},content:"READ:"+read.content});
    let terminal="TERM_RAN";try{await request("terminal/create",{sessionId,command:process.execPath,args:["-e","process.stdout.write('TERM_OK')"],cwd:${JSON.stringify(root)},env:[]})}catch(error){terminal="TERM_REFUSED:"+error.message}
    send({jsonrpc:"2.0",method:"session/update",params:{sessionId,update:{sessionUpdate:"tool_call",toolCallId:"tool-1",title:"Fixture command",kind:"execute",status:"completed",rawOutput:terminal}}});
    send({jsonrpc:"2.0",method:"session/update",params:{sessionId,update:{sessionUpdate:"usage_update",used:12,size:128}}});
    send({jsonrpc:"2.0",method:"session/update",params:{sessionId,update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"FAKE_OK"}}}});
    return send({jsonrpc:"2.0",id:m.id,result:{stopReason:"end_turn"}});
  }
}
readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on("line",line=>{try{handle(JSON.parse(line)).catch(e=>send({jsonrpc:"2.0",id:null,error:{code:-32603,message:e.message}}))}catch{}});
`,"utf8");
  const terminals=new TerminalManager({persist:false});
  const updates=[];
  const session=new AcpAgentSession({runtime:"antigravity",command:process.execPath,args:[fixture],cwd:root,terminals,permissionMode:"full",onUpdate:update=>updates.push(update),mcpServers:[{name:"Fixture tools",command:"/opt/fixture-mcp",args:["--stdio"],env:[{name:"TOKEN",value:"secret"}]}]});
  try{
    const started=await session.start({model:"fake-model"});
    assert.equal(started.session.sessionId,"fixture-session");
    assert.deepEqual(JSON.parse(await readFile(mcpPayload,"utf8")),[{name:"Fixture tools",command:"/opt/fixture-mcp",args:["--stdio"],env:[{name:"TOKEN",value:"secret"}]}]);
    const result=await session.prompt([{type:"text",text:"run"}]);
    assert.equal(result.stopReason,"end_turn");
    assert.equal(await readFile(output,"utf8"),"READ:INPUT_OK");
    assert.ok(updates.some(item=>item.update?.sessionUpdate==="agent_message_chunk"&&item.update.content?.text==="FAKE_OK"));
    assert.ok(updates.some(item=>item.update?.sessionUpdate==="tool_call"&&String(item.update.rawOutput||"").startsWith("TERM_REFUSED:")),"terminal/create is refused");
    assert.deepEqual(terminals.list(),[],"no terminal was started for the harness");
    assert.ok(updates.some(item=>item.update?.sessionUpdate==="usage_update"&&item.update.used===12));
    await assert.rejects(()=>session.client.request("fs/read_text_file",{sessionId:"fixture-session",path:join(root,"..","escape.txt")},1000));
  }finally{
    await session.close().catch(()=>{});
    await terminals.shutdown().catch(()=>{});
    await rm(root,{recursive:true,force:true});
  }
});

test("external active turns become queued restart recoveries only when enabled", async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-agent-recovery-"));
  const env={...process.env,TREBELL_HOME:home};
  try{
    const first=new AgentThreadStore(env);const thread=first.create({runtime:"opencode",cwd:home,providerSessionId:"ses_saved",model:"fixture/model"});const turn=first.addTurn(thread.id,{inputText:"Keep working"});
    const restarted=new AgentThreadStore(env);const recovered=restarted.reconcileRestart({continueAfterRestart:true});
    assert.deepEqual(recovered.map(item=>item.threadId),[thread.id]);
    const pending=restarted.get(thread.id);assert.equal(pending.recovery?.pending,true);assert.equal(pending.recovery?.turnId,turn.id);assert.equal(pending.turns[0].status,"interrupted");assert.equal(pending.status.type,"idle");
    const resumed=restarted.restartTurn(thread.id,turn.id);assert.equal(resumed.status,"inProgress");assert.equal(restarted.get(thread.id).status.type,"active");
  }finally{await rm(home,{recursive:true,force:true})}
});

test("restart recovery refuses to auto-repeat an unresolved tool action", async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-agent-uncertain-recovery-"));
  const env={...process.env,TREBELL_HOME:home};
  try{
    const first=new AgentThreadStore(env);const thread=first.create({runtime:"native",cwd:home,providerSessionId:"native-saved",model:"fixture/model"});const turn=first.addTurn(thread.id,{inputText:"Deploy the change"});
    first.addItem(thread.id,turn.id,{type:"dynamicToolCall",id:"tool-1",namespace:"trebell_browser",tool:"click",arguments:{ref:"submit"},status:"inProgress"});
    const restarted=new AgentThreadStore(env);assert.deepEqual(restarted.reconcileRestart({continueAfterRestart:true}),[]);
    const blocked=restarted.get(thread.id);assert.equal(blocked.status.type,"systemError");assert.equal(blocked.turns[0].status,"interrupted");assert.equal(blocked.recovery?.pending,false);assert.equal(blocked.recovery?.blocked,true);assert.equal(blocked.recovery?.reason,"uncertain_tool_action");assert.equal(blocked.recovery?.uncertainTools?.[0]?.id,"tool-1");assert.equal(blocked.recovery?.uncertainTools?.[0]?.tool,"click");assert.match(blocked.turns[0].error?.message||"",/Inspect its real-world state before repeating/i);
  }finally{await rm(home,{recursive:true,force:true})}
});

test("restart recovery still auto-resumes when all recorded tool actions are settled", async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-agent-settled-recovery-"));
  const env={...process.env,TREBELL_HOME:home};
  try{
    const first=new AgentThreadStore(env);const thread=first.create({runtime:"opencode",cwd:home,providerSessionId:"ses-settled",model:"fixture/model"});const turn=first.addTurn(thread.id,{inputText:"Continue"});
    first.addItem(thread.id,turn.id,{type:"dynamicToolCall",id:"tool-done",namespace:"trebell_repo",tool:"search_symbols",arguments:{query:"Session"},status:"completed",success:true});
    const restarted=new AgentThreadStore(env);const recovered=restarted.reconcileRestart({continueAfterRestart:true});assert.deepEqual(recovered.map(item=>item.threadId),[thread.id]);assert.equal(restarted.get(thread.id).recovery?.pending,true);
  }finally{await rm(home,{recursive:true,force:true})}
});

test("external active turns settle as interrupted errors when restart recovery is disabled", async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-agent-no-recovery-"));
  const env={...process.env,TREBELL_HOME:home};
  try{
    const first=new AgentThreadStore(env);const thread=first.create({runtime:"claude",cwd:home,providerSessionId:"claude-session"});first.addTurn(thread.id,{inputText:"Do work"});
    const restarted=new AgentThreadStore(env);assert.deepEqual(restarted.reconcileRestart({continueAfterRestart:false}),[]);
    const settled=restarted.get(thread.id);assert.equal(settled.turns[0].status,"failed");assert.match(settled.turns[0].error?.message||"",/interrupted by a Trebell restart/i);assert.equal(settled.status.type,"systemError");assert.equal(settled.recovery,undefined);
  }finally{await rm(home,{recursive:true,force:true})}
});
