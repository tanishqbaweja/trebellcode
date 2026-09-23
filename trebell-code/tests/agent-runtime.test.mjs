import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrebellStateStore } from "../src/trebell-state.mjs";
import { AgentRuntimeManager, parseCursorAboutResult, parseGrokModelsAuth, parseOpenCodeAuthList, runtimeCompatibility } from "../src/agent-runtime-manager.mjs";
import { AcpAgentSession } from "../src/acp-agent-session.mjs";
import { AgentThreadStore } from "../src/agent-thread-store.mjs";
import { TerminalManager } from "../src/terminal-manager.mjs";

test("agent runtime registry exposes real harnesses and capability-gates configured instances", async () => {
  const home=await mkdtemp(join(tmpdir(),"trebell-agent-runtime-"));
  try{
    const state=new TrebellStateStore({...process.env,TREBELL_HOME:home});
    const manager=new AgentRuntimeManager({state,env:{...process.env,TREBELL_HOME:home}});
    assert.deepEqual(manager.definitions().map(item=>item.id),["codex","claude","cursor","grok","opencode","antigravity"]);
    const fake=manager.upsertInstance({id:"cursor-fixture",kind:"cursor",displayName:"Fixture Cursor",binaryPath:process.execPath});
    const status=await manager.probe(fake);
    assert.equal(status.installed,true);
    assert.equal(status.available,true);
    const selected=await manager.setActive({runtime:"cursor",instanceId:fake.id});
    assert.equal(selected.runtime,"cursor");
    assert.equal(state.settings().agentRuntimeInstanceId,fake.id);
    const models=await manager.models(fake);
    assert.deepEqual(models.models,["cursor-default"]);
  }finally{
    await rm(home,{recursive:true,force:true});
  }
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
  await writeFile(input,"INPUT_OK","utf8");
  await writeFile(fixture,String.raw`
import readline from "node:readline";
let next=1000; const pending=new Map(); let sessionId="fixture-session";
function send(x){process.stdout.write(JSON.stringify(x)+"\n")}
function request(method,params){const id="s"+(next++);send({jsonrpc:"2.0",id,method,params});return new Promise((resolve,reject)=>pending.set(id,{resolve,reject}))}
async function handle(m){
  if(m.id!=null&&!m.method&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(m.error.message)):p.resolve(m.result);return}
  if(!m.method||m.id==null)return;
  if(m.method==="initialize")return send({jsonrpc:"2.0",id:m.id,result:{protocolVersion:1,agentInfo:{name:"fixture",version:"1"},agentCapabilities:{loadSession:true,sessionCapabilities:{resume:{},close:{}}}}});
  if(m.method==="session/new"||m.method==="session/resume"||m.method==="session/load")return send({jsonrpc:"2.0",id:m.id,result:{sessionId,models:{currentModelId:"fake-model",availableModels:[{modelId:"fake-model",name:"Fake"}]},configOptions:[],modes:{currentModeId:"build",availableModes:[]}}});
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
  const session=new AcpAgentSession({runtime:"fixture",command:process.execPath,args:[fixture],cwd:root,terminals,permissionMode:"full",onUpdate:update=>updates.push(update)});
  try{
    const started=await session.start({model:"fake-model"});
    assert.equal(started.session.sessionId,"fixture-session");
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
