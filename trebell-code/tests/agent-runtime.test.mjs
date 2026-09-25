import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrebellStateStore } from "../src/trebell-state.mjs";
import { AgentRuntimeManager, parseCursorAboutResult, parseGrokModelsAuth, parseOpenCodeAuthList, runtimeCapabilities, runtimeCompatibility } from "../src/agent-runtime-manager.mjs";
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
    const models=await manager.models(fake);
    assert.deepEqual(models.models,["cursor-default"]);
    assert.equal(manager.capabilities("codex").nativeSandbox,true);
    assert.equal(manager.capabilities("native").dynamicTools,true);
    assert.equal(manager.capabilities("native").nativeSandbox,false);
    assert.equal(manager.capabilities("native").mcpInjection,false);
    assert.equal(manager.capabilities("native").delegation,false);
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
    assert.equal(manager.capabilities("cursor").clientFilesystem,true);
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
  assert.equal(codex.nativeQueue,true);
  assert.equal(codex.mcpInjection,false);
  const native=runtimeCapabilities("native");
  assert.equal(native.dynamicTools,true);assert.equal(native.contextReporting,true);assert.equal(native.nativeHistoryPagination,true);
  assert.equal(native.mcpInjection,false);assert.equal(native.compaction,false);assert.equal(native.delegation,false);assert.equal(native.steering,false);
  const openCode=runtimeCapabilities("opencode");
  assert.equal(openCode.compaction,true);
  assert.equal(openCode.nativeLsp,true);
  assert.equal(openCode.mcpInjection,false);
  assert.equal(openCode.detachedTasks,true);
  assert.equal(openCode.multiModelFanout,true);
  assert.equal(openCode.delegation,true,"Trebell supplies provider-neutral child-task delegation");
  assert.equal(openCode.backgroundProcesses,false);
  assert.equal(runtimeCapabilities("claude").runtimeProfileSwitching,true);
  assert.equal(runtimeCapabilities("claude").delegation,true);
  const acp=runtimeCapabilities("grok");
  assert.equal(acp.queue,true,"Trebell supplies the queue for external runtimes");
  assert.equal(acp.fork,"runtime","ACP forking must stay conditional on what the connected runtime advertises");
  assert.equal(acp.rewind,false);
  assert.equal(acp.delegation,true,"manual Trebell delegation stays available even when the runtime cannot invoke dynamic tools itself");
});

test("runtime launch flags preserve Trebell permission-mode boundaries",()=>{
  const manager=new AgentRuntimeManager();
  const cursor={kind:"cursor"},grok={kind:"grok"};
  assert.deepEqual(manager.acpArgs(cursor,"supervised"),["acp"]);
  assert.deepEqual(manager.acpArgs(cursor,"edits"),["acp"],"Cursor edits mode must stay under Trebell ACP approvals instead of enabling broad Auto-review");
  assert.deepEqual(manager.acpArgs(cursor,"auto"),["--auto-review","acp"]);
  assert.deepEqual(manager.acpArgs(cursor,"full"),["--force","acp"]);
  assert.deepEqual(manager.acpArgs(grok,"supervised"),["--permission-mode","default","agent","stdio"]);
  assert.deepEqual(manager.acpArgs(grok,"edits"),["--permission-mode","acceptEdits","agent","stdio"]);
  assert.deepEqual(manager.acpArgs(grok,"auto"),["--permission-mode","auto","agent","stdio"]);
  assert.deepEqual(manager.acpArgs(grok,"full"),["agent","--always-approve","stdio"]);
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

test("runtime profile compatibility follows continuation identity instead of display names",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-runtime-compat-"));
  try{
    const env={...process.env,TREBELL_HOME:home,CLAUDE_CONFIG_DIR:join(home,"claude-default")};
    const state=new TrebellStateStore(env);
    const manager=new AgentRuntimeManager({state,env,platform:"win32"});
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
    assert.equal(calls.some(call=>call.command==="npm"&&call.args.join(" ")==="install -g @anthropic-ai/claude-code"),true);
    await assert.rejects(()=>manager.install("cursor"),/not installable/i);
    const snapshot=await manager.snapshot();
    assert.equal(snapshot.definitions.find(item=>item.id==="claude").installable,true);
    assert.equal(snapshot.definitions.find(item=>item.id==="opencode").packageName,"@opencode/cli");
    assert.equal(snapshot.definitions.find(item=>item.id==="cursor").installable,false);
  }finally{await rm(home,{recursive:true,force:true})}
});

test("OpenCode compatibility blocks known-broken managed updates and pins verified versions",async()=>{
  assert.equal(runtimeCompatibility("opencode","opencode 1.14.18").status,"broken");
  assert.equal(runtimeCompatibility("opencode","v1.14.19").status,"supported");
  assert.equal(runtimeCompatibility("opencode","dev-build").status,"unknown");
  const home=await mkdtemp(join(tmpdir(),"trebell-opencode-compat-"));const env={...process.env,TREBELL_HOME:home};
  try{
    const state=new TrebellStateStore(env);const calls=[];let candidate="1.14.18";
    const environments={
      get:id=>id==="ssh-fixture"?{id,name:"Fixture SSH",type:"ssh",cwd:"/srv/app"}:null,
      executeArgv:async(id,{command,args})=>{
        calls.push({id,command,args:[...args]});
        if(command==="npm"&&args[0]==="--version")return {exitCode:0,stdout:"11.0.0\n",stderr:""};
        if(command==="npm"&&args[0]==="view")return {exitCode:0,stdout:JSON.stringify(candidate)+"\n",stderr:""};
        if(command==="npm"&&args[0]==="install")return {exitCode:0,stdout:"installed\n",stderr:""};
        if(command==="opencode"&&args[0]==="--version")return {exitCode:0,stdout:"opencode "+candidate+"\n",stderr:""};
        if(command==="opencode"&&args[0]==="models")return {exitCode:0,stdout:"fixture/model\n",stderr:""};
        return {exitCode:1,stdout:"",stderr:"unexpected command"};
      },
    };
    state.updateSettings({activeEnvironmentId:"ssh-fixture"});
    const manager=new AgentRuntimeManager({state,env,environments});
    await assert.rejects(()=>manager.install("opencode"),/known to be incompatible/i);
    assert.equal(calls.some(call=>call.command==="npm"&&call.args[0]==="install"),false);
    candidate="1.14.19";
    const installed=await manager.install("opencode");
    assert.equal(installed.targetVersion,"1.14.19");
    assert.equal(installed.compatibility.status,"supported");
    assert.equal(calls.some(call=>call.command==="npm"&&call.args.join(" ")==="install -g @opencode\/cli@1.14.19"),true);
    const status=await manager.probe("opencode");
    assert.equal(status.compatibility.status,"supported");
  }finally{await rm(home,{recursive:true,force:true})}
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
    const state=new TrebellStateStore(env);const manager=new AgentRuntimeManager({state,env});
    assert.deepEqual(manager.authCommand("claude"),{runtime:"claude",instanceId:"claude-default",name:"Claude Code",command:"claude",args:["auth","login"]});
    assert.deepEqual(manager.authCommand("cursor"),{runtime:"cursor",instanceId:"cursor-default",name:"Cursor",command:"cursor-agent",args:["login"]});
    assert.deepEqual(manager.authCommand("grok"),{runtime:"grok",instanceId:"grok-default",name:"Grok Build",command:"grok",args:["login"]});
    assert.deepEqual(manager.authCommand("opencode"),{runtime:"opencode",instanceId:"opencode-default",name:"OpenCode",command:"opencode",args:["auth","login"]});
    const external=manager.upsertInstance({id:"opencode-external",kind:"opencode",serverUrl:"https://opencode.example.test"});
    assert.throws(()=>manager.authCommand(external),/external server/i);
    assert.throws(()=>manager.authCommand("codex"),/does not expose/i);
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

test("ACP agent session serves bounded filesystem and terminal capabilities end to end", async () => {
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
    const created=await request("terminal/create",{sessionId,command:process.execPath,args:["-e","process.stdout.write('TERM_OK')"],cwd:${JSON.stringify(root)},env:[]});
    await request("terminal/wait_for_exit",{sessionId,terminalId:created.terminalId});
    const terminal=await request("terminal/output",{sessionId,terminalId:created.terminalId});
    send({jsonrpc:"2.0",method:"session/update",params:{sessionId,update:{sessionUpdate:"tool_call",toolCallId:"tool-1",title:"Fixture command",kind:"execute",status:"completed",rawOutput:terminal.output}}});
    send({jsonrpc:"2.0",method:"session/update",params:{sessionId,update:{sessionUpdate:"usage_update",used:12,size:128}}});
    send({jsonrpc:"2.0",method:"session/update",params:{sessionId,update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"FAKE_OK"}}}});
    return send({jsonrpc:"2.0",id:m.id,result:{stopReason:"end_turn"}});
  }
}
readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on("line",line=>{try{handle(JSON.parse(line)).catch(e=>send({jsonrpc:"2.0",id:null,error:{code:-32603,message:e.message}}))}catch{}});
`,"utf8");
  const terminals=new TerminalManager({persist:false});
  const updates=[];
  const session=new AcpAgentSession({runtime:"fixture",command:process.execPath,args:[fixture],cwd:root,terminals,permissionMode:"full",onUpdate:update=>updates.push(update),mcpServers:[{name:"Fixture tools",command:"/opt/fixture-mcp",args:["--stdio"],env:[{name:"TOKEN",value:"secret"}]}]});
  try{
    const started=await session.start({model:"fake-model"});
    assert.equal(started.session.sessionId,"fixture-session");
    assert.deepEqual(JSON.parse(await readFile(mcpPayload,"utf8")),[{name:"Fixture tools",command:"/opt/fixture-mcp",args:["--stdio"],env:[{name:"TOKEN",value:"secret"}]}]);
    const result=await session.prompt([{type:"text",text:"run"}]);
    assert.equal(result.stopReason,"end_turn");
    assert.equal(await readFile(output,"utf8"),"READ:INPUT_OK");
    assert.ok(updates.some(item=>item.update?.sessionUpdate==="agent_message_chunk"&&item.update.content?.text==="FAKE_OK"));
    assert.ok(updates.some(item=>item.update?.sessionUpdate==="tool_call"&&String(item.update.rawOutput||"").includes("TERM_OK")));
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

test("external active turns settle as interrupted errors when restart recovery is disabled", async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-agent-no-recovery-"));
  const env={...process.env,TREBELL_HOME:home};
  try{
    const first=new AgentThreadStore(env);const thread=first.create({runtime:"claude",cwd:home,providerSessionId:"claude-session"});first.addTurn(thread.id,{inputText:"Do work"});
    const restarted=new AgentThreadStore(env);assert.deepEqual(restarted.reconcileRestart({continueAfterRestart:false}),[]);
    const settled=restarted.get(thread.id);assert.equal(settled.turns[0].status,"failed");assert.match(settled.turns[0].error?.message||"",/interrupted by a Trebell restart/i);assert.equal(settled.status.type,"systemError");assert.equal(settled.recovery,undefined);
  }finally{await rm(home,{recursive:true,force:true})}
});
