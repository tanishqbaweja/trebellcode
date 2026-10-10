import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { WebSocketServer } from "ws";
import { HARNESS_TEXT_INSTRUCTIONS, HARNESS_TEXT_TIMEOUT_MS, OPENCODE_GIT_TEXT_CONFIG, acpReadOnlyMode, claudeTextModel, codexGitTextConfig, declineCodexServerRequest, denyAcpRequest, generateTextWithHarness, harnessTextTimeout, OPENCODE_GIT_TEXT_PERMISSION, OPENCODE_GIT_TEXT_REFUSAL } from "../src/harness-text-generation.mjs";

const NAMES={codex:"Codex",claude:"Claude Code",cursor:"Cursor",grok:"Grok Build",opencode:"OpenCode",antigravity:"Antigravity"};
const PROTOCOLS={codex:"codex",claude:"claude",opencode:"sdk"};
const childBaseEnv=()=>Object.fromEntries(Object.entries(process.env).filter(([key])=>/^(?:path|systemroot|temp|tmp|home|userprofile)$/i.test(key)));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function eventually(check,{timeoutMs=8000,message="condition was not met in time"}={}){
  const startedAt=Date.now();
  for(;;){let value=null;try{value=await check()}catch{}if(value)return value;if(Date.now()-startedAt>timeoutMs)throw new Error(message);await delay(50)}
}
// Every local request works in a fresh trebell-git-text-* folder under the OS temp directory, never in the repository.
function assertScratchFolder(path,repo){
  assert.equal(typeof path,"string");assert.notEqual(resolve(path),resolve(repo),"the harness never works in the repository");
  assert.equal(resolve(dirname(path)),resolve(tmpdir()));assert.match(basename(path),/^trebell-git-text-/);
}
const scratchRemoved=path=>eventually(()=>!existsSync(path),{message:"the temp folder "+path+" was not removed"});

function fakeRuntimeManager(kind,overrides={}){
  const calls={probes:[],acpArgs:[],cli:[]};
  return {
    calls,
    definitions:()=>[{id:kind,name:NAMES[kind]||kind,protocol:PROTOCOLS[kind]||"acp"}],
    activeInstance:()=>({id:kind+"-default",kind}),
    probe:async(instance,options)=>{calls.probes.push({id:instance.id,options});return {available:true}},
    executable:()=>"fixture-cli",
    childEnv:()=>({...childBaseEnv(),TREBELL_FIXTURE:"1"}),
    processSpawner:()=>null,
    remoteIo:()=>null,
    runtimeCwd:cwd=>cwd,
    acpArgs:(_instance,mode,cwd)=>{calls.acpArgs.push({mode,cwd});return []},
    runCli:async(instance,args,options)=>{calls.cli.push({id:instance.id,args,options});return {ok:true,code:0,stdout:"",stderr:""}},
    ...(typeof overrides==="function"?overrides(calls):overrides),
  };
}

const EFFECTIVE_CODEX_CONFIG={model:"gpt-fast",mcp_servers:{"fixture-api":{command:"node",enabled:true},"fixture_http":{url:"http://127.0.0.1:9/mcp",enabled:true}},plugins:{"github@fixture-market":{enabled:true},"dotted.plugin@market":{enabled:true}}};
async function fakeCodexAppServer({models=["gpt-fast","gpt-smart"],authenticated=true,completeTurn=true,serverRequest=null,dropAfterTurnStart=false,effectiveConfig=EFFECTIVE_CODEX_CONFIG,configReadError=null}={}){
  const http=createServer(),wss=new WebSocketServer({noServer:true}),seen=[],replies=[];
  http.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws)));
  wss.on("connection",ws=>{
    const send=message=>ws.send(JSON.stringify(message));
    ws.on("message",raw=>{
      const message=JSON.parse(String(raw));
      if(message.method==null){replies.push(message);return}
      seen.push(message);const reply=result=>send({id:message.id,result});
      if(message.method==="initialize")return reply({userAgent:"fixture"});
      if(message.method==="initialized")return;
      if(message.method==="account/read")return reply(authenticated?{account:{type:"chatgpt"},requiresOpenaiAuth:true}:{account:null,requiresOpenaiAuth:true});
      if(message.method==="model/list")return reply({data:models.map(id=>({id,model:id})),nextCursor:null});
      if(message.method==="config/read")return configReadError?send({id:message.id,error:{code:-32603,message:configReadError}}):reply({config:effectiveConfig});
      if(message.method==="thread/start"){send({method:"thread/started",params:{thread:{id:"thread-git-text"}}});return reply({thread:{id:"thread-git-text",ephemeral:message.params.ephemeral},model:message.params.model||"gpt-default"})}
      if(message.method==="turn/start"){
        reply({turn:{id:"turn-git-text",status:"inProgress"}});
        // The app-server goes away mid-turn (a crash, or a profile or environment restart) without any notification.
        if(dropAfterTurnStart){setTimeout(()=>ws.terminate(),50);return}
        if(!completeTurn)return;
        if(serverRequest)send({id:"server-request-1",...serverRequest});
        const params={threadId:"thread-git-text",turnId:"turn-git-text"};
        send({method:"item/agentMessage/delta",params:{...params,itemId:"m1",delta:"Reading the diff"}});
        send({method:"item/completed",params:{...params,item:{type:"agentMessage",id:"m1",text:"Reading the diff",phase:"commentary"}}});
        send({method:"item/completed",params:{threadId:"other-thread",turnId:"other-turn",item:{type:"agentMessage",id:"m9",text:"unrelated thread",phase:"final_answer"}}});
        send({method:"item/agentMessage/delta",params:{...params,itemId:"m2",delta:"feat: add harness text"}});
        send({method:"item/completed",params:{...params,item:{type:"agentMessage",id:"m2",text:"feat: add harness text",phase:"final_answer"}}});
        return send({method:"turn/completed",params:{threadId:"thread-git-text",turn:{id:"turn-git-text",status:"completed",error:null}}});
      }
      if(message.method==="turn/interrupt"||message.method==="thread/unsubscribe")return reply({});
      send({id:message.id,error:{code:-32601,message:"unexpected "+message.method}});
    });
  });
  await new Promise(resolve=>http.listen(0,"127.0.0.1",resolve));
  return {url:"ws://127.0.0.1:"+http.address().port,seen,replies,close:()=>new Promise(resolve=>{for(const client of wss.clients)client.terminate();wss.close(()=>http.close(resolve))})};
}

test("harness text limits, model choice and refusal helpers stay within the read-only contract",()=>{
  assert.equal(HARNESS_TEXT_TIMEOUT_MS,90_000);
  assert.equal(harnessTextTimeout(),90_000);assert.equal(harnessTextTimeout(600_000),90_000,"the timeout never exceeds 90 seconds");assert.equal(harnessTextTimeout(500),500);
  assert.equal(claudeTextModel(["gpt-5.6-sol","sonnet"]),"sonnet");assert.equal(claudeTextModel(["claude-opus-4-8"]),"claude-opus-4-8");assert.equal(claudeTextModel(["openai/gpt-y","test/coding-fast"]),null);
  assert.equal(claudeTextModel(["fable"]),"fable");assert.equal(claudeTextModel(["default"]),"default");assert.equal(claudeTextModel(["opus[1m]"]),"opus[1m]");
  assert.deepEqual(declineCodexServerRequest({id:1,method:"item/commandExecution/requestApproval",params:{command:"git diff"}}),{decision:"decline"});
  assert.deepEqual(declineCodexServerRequest({id:2,method:"item/fileChange/requestApproval",params:{}}),{decision:"decline"});
  assert.deepEqual(declineCodexServerRequest({id:3,method:"execCommandApproval",params:{command:["git","diff"]}}),{decision:{denied:{rejection:"rejected by Trebell policy"}}});
  assert.deepEqual(declineCodexServerRequest({id:4,method:"item/permissions/requestApproval",params:{permissions:{network:true}}}),{permissions:{},scope:"turn"});
  assert.deepEqual(declineCodexServerRequest({id:5,method:"mcpServer/elicitation/request",params:{}}),{action:"decline",content:null,_meta:null});
  assert.throws(()=>declineCodexServerRequest({id:6,method:"item/tool/call",params:{}}),/does not service item\/tool\/call/);
  assert.deepEqual(denyAcpRequest("session/request_permission",{options:[{optionId:"ok",kind:"allow_always"},{optionId:"no",kind:"reject_always"}]}),{outcome:{outcome:"cancelled"}},"a reject-always answer would be saved beyond this request, so it is cancelled instead");
  assert.deepEqual(denyAcpRequest("session/request_permission",{options:[{optionId:"ok",kind:"allow_once"},{optionId:"no",kind:"reject_once"}]}),{outcome:{outcome:"selected",optionId:"no"}});
  assert.deepEqual(denyAcpRequest("session/request_permission",{options:[{optionId:"ok",kind:"allow_once"}]}),{outcome:{outcome:"cancelled"}});
  assert.throws(()=>denyAcpRequest("fs/write_text_file",{path:"x"}),error=>error.code===-32000&&/read-only/.test(error.message));
  const modes=ids=>({modes:{currentModeId:ids[0],availableModes:ids.map(id=>({id,name:id}))}});
  assert.equal(acpReadOnlyMode("cursor",modes(["agent","ask","plan"])),"ask");
  assert.equal(acpReadOnlyMode("cursor",modes(["agent","plan"])),null,"Cursor only counts its ask mode as read-only");
  assert.equal(acpReadOnlyMode("grok",modes(["default","Plan"])),"Plan");assert.equal(acpReadOnlyMode("antigravity",modes(["agent","read-only","plan"])),"read-only");
  assert.equal(acpReadOnlyMode("grok",{}),null);
});

test("Codex Git text config switches off every configured MCP server, plugins, apps, hooks, notify and web search",()=>{
  const config=codexGitTextConfig(EFFECTIVE_CODEX_CONFIG);
  assert.deepEqual(config,{
    notify:[],web_search:"disabled","features.hooks":false,"features.codex_hooks":false,"features.apps":false,"features.plugins":false,"features.multi_agent":false,"features.tool_suggest":false,"features.image_generation":false,"features.browser_use":false,"features.computer_use":false,"features.goals":false,"features.shell_tool":false,"features.unified_exec":false,"features.view_image":false,
    "mcp_servers.fixture-api.enabled":false,"mcp_servers.fixture_http.enabled":false,"plugins.github@fixture-market.enabled":false,
  },"a dotted plugin id cannot be named in a dotted override and relies on features.plugins");
  assert.deepEqual(Object.keys(codexGitTextConfig({})).filter(key=>/^(?:mcp_servers|plugins)\./.test(key)),[]);
  assert.throws(()=>codexGitTextConfig({mcp_servers:{"odd.name":{command:"x"}}}),/MCP server 'odd\.name' cannot be switched off/,"a server that cannot be switched off stops the request");
});

test("harness text generation refuses Trebell Native and reports an unavailable harness before starting it",async()=>{
  await assert.rejects(()=>generateTextWithHarness({runtimeManager:fakeRuntimeManager("native"),prompt:"PROMPT"}),/Trebell Native writes Git text with its model provider/);
  let queried=false;
  const manager=fakeRuntimeManager("claude",{probe:async()=>({available:false,message:"Claude Code is installed but not authenticated"})});
  await assert.rejects(()=>generateTextWithHarness({runtimeManager:manager,prompt:"PROMPT",deps:{claudeQuery:()=>{queried=true;throw new Error("must not run")}}}),error=>error.code==="HARNESS_UNAVAILABLE"&&error.message==="Claude Code is installed but not authenticated");
  assert.equal(queried,false);
});

test("Codex adapter uses an isolated ephemeral read-only never-approve thread in an empty folder and declines server requests",async()=>{
  const server=await fakeCodexAppServer({serverRequest:{method:"item/commandExecution/requestApproval",params:{threadId:"thread-git-text",command:"git diff"}}});
  let released=0;
  try{
    const manager=fakeRuntimeManager("codex");
    const result=await generateTextWithHarness({runtimeManager:manager,prompt:"Write one Git commit subject.\n\nDiff:\n+change",cwd:"H:\\repo",models:["sonnet","gpt-smart"],version:"9.9.9",codexAppServer:async()=>({url:server.url,release:async()=>{released++}})});
    assert.deepEqual(result,{text:"feat: add harness text",model:"gpt-smart",runtime:"codex",name:"Codex"});
    const configRead=server.seen.find(item=>item.method==="config/read").params;
    const started=server.seen.find(item=>item.method==="thread/start").params;
    assertScratchFolder(started.cwd,"H:\\repo");assert.equal(configRead.cwd,started.cwd,"the MCP servers are read for the folder the thread runs in");
    assert.deepEqual(started,{cwd:started.cwd,approvalPolicy:"never",sandbox:"read-only",ephemeral:true,environments:[],config:codexGitTextConfig(EFFECTIVE_CODEX_CONFIG),threadSource:"trebell-git-text",developerInstructions:HARNESS_TEXT_INSTRUCTIONS,model:"gpt-smart"});
    assert.equal(started.config["mcp_servers.fixture-api.enabled"],false);assert.equal(started.config["features.plugins"],false);assert.deepEqual(started.config.notify,[]);
    const order=server.seen.map(item=>item.method);assert.ok(order.indexOf("config/read")<order.indexOf("thread/start"));
    const turn=server.seen.find(item=>item.method==="turn/start").params;
    assert.equal(turn.threadId,"thread-git-text");assert.equal(turn.approvalPolicy,"never");assert.deepEqual(turn.sandboxPolicy,{type:"readOnly",networkAccess:false});assert.deepEqual(turn.environments,[],"the turn has no shell or file environment");
    assert.equal(turn.input[0].text,"Write one Git commit subject.\n\nDiff:\n+change");assert.equal(turn.model,"gpt-smart");
    assert.deepEqual(server.replies.find(item=>item.id==="server-request-1")?.result,{decision:"decline"},"approval requests are declined, never prompted");
    assert.ok(server.seen.some(item=>item.method==="thread/unsubscribe"&&item.params.threadId==="thread-git-text"));
    assert.equal(server.seen.some(item=>item.method==="turn/interrupt"),false,"a completed turn is not interrupted");
    assert.equal(released,1,"the dedicated app-server is released");assert.equal(manager.calls.probes.length,0);
    await scratchRemoved(started.cwd);
    const fallback=await generateTextWithHarness({runtimeManager:manager,prompt:"PROMPT",models:["claude-opus-4-8"],codexAppServer:async()=>({url:server.url,release:async()=>{released++}})});
    assert.equal(fallback.model,"gpt-default","a model outside Codex's catalog falls back to the Codex default");
    assert.equal(Object.prototype.hasOwnProperty.call(server.seen.filter(item=>item.method==="thread/start").at(-1).params,"model"),false);
  }finally{await server.close()}
  const remote=await fakeCodexAppServer();
  try{
    // A remote environment's Codex runs there, so it keeps the repository path instead of a local temp folder.
    await generateTextWithHarness({runtimeManager:fakeRuntimeManager("codex",{remoteIo:()=>({root:"/srv/app"})}),prompt:"PROMPT",cwd:"/srv/app",environmentId:"ssh-fixture",codexAppServer:async()=>({url:remote.url,release:async()=>{}})});
    const started=remote.seen.find(item=>item.method==="thread/start").params;
    assert.equal(started.cwd,"/srv/app");assert.deepEqual(started.environments,[]);assert.equal(started.config["features.hooks"],false);
  }finally{await remote.close()}
});

test("Codex adapter stops with clear errors when signed out, when its MCP servers cannot be listed or when the turn exceeds the limit",async()=>{
  const signedOut=await fakeCodexAppServer({authenticated:false});
  let released=0;
  try{
    await assert.rejects(()=>generateTextWithHarness({runtimeManager:fakeRuntimeManager("codex"),prompt:"PROMPT",codexAppServer:async()=>({url:signedOut.url,release:async()=>{released++}})}),error=>error.code==="HARNESS_UNAVAILABLE"&&/Codex is not authenticated/.test(error.message));
    assert.equal(signedOut.seen.some(item=>item.method==="thread/start"),false);assert.equal(released,1);
  }finally{await signedOut.close()}
  const unlisted=await fakeCodexAppServer({configReadError:"config/read is unavailable"});
  try{
    await assert.rejects(()=>generateTextWithHarness({runtimeManager:fakeRuntimeManager("codex"),prompt:"PROMPT",codexAppServer:async()=>({url:unlisted.url,release:async()=>{released++}})}),error=>error.code==="HARNESS_TEXT_FAILED"&&/could not list its MCP servers/.test(error.message));
    assert.equal(unlisted.seen.some(item=>item.method==="thread/start"),false,"without the server list no thread starts");assert.equal(released,2);
  }finally{await unlisted.close()}
  const stalled=await fakeCodexAppServer({completeTurn:false});
  try{
    const startedAt=Date.now();
    await assert.rejects(()=>generateTextWithHarness({runtimeManager:fakeRuntimeManager("codex"),prompt:"PROMPT",timeoutMs:1500,codexAppServer:async()=>({url:stalled.url,release:async()=>{released++}})}),error=>error.code==="HARNESS_TEXT_TIMEOUT"&&/Codex did not return the Git text within 2 seconds\. Try again/.test(error.message));
    assert.ok(Date.now()-startedAt<10_000);
    assert.ok(stalled.seen.some(item=>item.method==="turn/interrupt"&&item.params.turnId==="turn-git-text"),"a timed-out turn is interrupted");
    assert.ok(stalled.seen.some(item=>item.method==="thread/unsubscribe"));assert.equal(released,3);
  }finally{await stalled.close()}
});

test("Codex adapter reports a stopped app-server at once instead of waiting out the time limit",async()=>{
  const dropped=await fakeCodexAppServer({dropAfterTurnStart:true});
  let released=0;
  try{
    const startedAt=Date.now();
    await assert.rejects(()=>generateTextWithHarness({runtimeManager:fakeRuntimeManager("codex"),prompt:"PROMPT",timeoutMs:60_000,codexAppServer:async()=>({url:dropped.url,release:async()=>{released++}})}),error=>error.code==="HARNESS_TEXT_FAILED"&&/Codex app-server stopped before it returned the Git text\. Try again\./.test(error.message));
    assert.ok(Date.now()-startedAt<10_000,"the closed socket fails the request long before the 60 second limit");
    assert.equal(dropped.seen.some(item=>item.method==="turn/interrupt"),false,"a stopped app-server is not asked to interrupt");
    assert.equal(released,1);
  }finally{await dropped.close()}
});

test("Claude adapter runs one tool-less turn without hooks, MCP servers or a saved session",async()=>{
  const seen=[];
  const claudeQuery=({prompt,options})=>{seen.push({prompt,options});return (async function*(){
    yield {type:"system",subtype:"init",model:"claude-opus-4-8",session_id:"session-1"};
    yield {type:"assistant",message:{content:[{type:"text",text:"fix: tighten harness text"}]}};
    yield {type:"result",subtype:"success",is_error:false,result:"fix: tighten harness text"};
  })()};
  const manager=fakeRuntimeManager("claude");
  const result=await generateTextWithHarness({runtimeManager:manager,prompt:"PROMPT",cwd:"H:\\repo",environmentId:null,models:["gpt-5.6-sol","opus"],version:"9.9.9",deps:{claudeQuery}});
  assert.deepEqual(result,{text:"fix: tighten harness text",model:"claude-opus-4-8",runtime:"claude",name:"Claude Code"});
  const {prompt,options}=seen[0];
  assert.equal(prompt,"PROMPT");assert.equal(options.cwd,"H:\\repo");assert.equal(options.model,"opus");
  assert.deepEqual(options.tools,[]);assert.equal(options.maxTurns,1);assert.equal(options.persistSession,false);assert.equal(options.permissionMode,"dontAsk");
  assert.deepEqual(options.mcpServers,{});assert.equal(options.strictMcpConfig,true);assert.deepEqual(options.settings,{disableAllHooks:true});assert.deepEqual(options.settingSources,["user"]);
  assert.equal(options.systemPrompt.append,HARNESS_TEXT_INSTRUCTIONS);assert.equal(options.env.CLAUDE_AGENT_SDK_CLIENT_APP,"trebell-code/9.9.9");assert.equal(options.env.TREBELL_FIXTURE,"1");
  assert.equal(options.spawnClaudeCodeProcess,undefined);assert.equal(options.enableFileCheckpointing,undefined);
  assert.equal((await options.canUseTool("Bash",{command:"git diff"},{toolUseID:"tool-1"})).behavior,"deny");
  assert.deepEqual(manager.calls.probes,[{id:"claude-default",options:{environmentId:null}}]);
  await generateTextWithHarness({runtimeManager:manager,prompt:"PROMPT",models:["gpt-5.6-sol"],deps:{claudeQuery}});
  assert.equal(Object.prototype.hasOwnProperty.call(seen[1].options,"model"),false,"another runtime's model falls back to Claude's default");
  const failing=()=>(async function*(){yield {type:"result",subtype:"success",is_error:true,result:"Invalid API key · Please run /login"}})();
  await assert.rejects(()=>generateTextWithHarness({runtimeManager:manager,prompt:"PROMPT",deps:{claudeQuery:failing}}),/^Error: Claude Code could not write the Git text: Invalid API key/);
  // Claude's API-error frame is never the Git text; an error Claude does not retry is explained in its own words.
  const modelError="There's an issue with the selected model (claude-nonexistent-9). It may not exist or you may not have access to it.";
  const unknownModel=()=>(async function*(){
    yield {type:"assistant",error:"model_not_found",message:{content:[{type:"text",text:modelError}]}};
    yield {type:"result",subtype:"success",is_error:true,terminal_reason:"api_error",api_error_status:404,result:modelError};
  })();
  await assert.rejects(()=>generateTextWithHarness({runtimeManager:manager,prompt:"PROMPT",deps:{claudeQuery:unknownModel}}),error=>error.message==="Claude Code could not write the Git text: "+modelError);
  const signedOut=()=>(async function*(){
    yield {type:"assistant",error:"authentication_failed",message:{content:[{type:"text",text:"Invalid API key"}]}};
    yield {type:"result",subtype:"success",is_error:true,terminal_reason:"api_error",api_error_status:401,result:"Invalid API key"};
  })();
  await assert.rejects(()=>generateTextWithHarness({runtimeManager:manager,prompt:"PROMPT",deps:{claudeQuery:signedOut}}),/Run `claude auth login`/);
  const diagnostic=()=>(async function*(){yield {type:"result",subtype:"error_during_execution",is_error:true,errors:["[ede_diagnostic] result_type=user","Claude Code process exited"]}})();
  await assert.rejects(()=>generateTextWithHarness({runtimeManager:manager,prompt:"PROMPT",deps:{claudeQuery:diagnostic}}),error=>error.message==="Claude Code could not write the Git text: Claude Code process exited");
});

test("Claude adapter aborts its query when the caller cancels",async()=>{
  let abortSignal=null;
  const claudeQuery=({options})=>{abortSignal=options.abortController.signal;return (async function*(){await new Promise((_,reject)=>abortSignal.addEventListener("abort",()=>reject(new Error("aborted")),{once:true}))})()};
  const controller=new AbortController();setTimeout(()=>controller.abort(),50);
  await assert.rejects(()=>generateTextWithHarness({runtimeManager:fakeRuntimeManager("claude"),prompt:"PROMPT",signal:controller.signal,deps:{claudeQuery}}),error=>error.code==="HARNESS_TEXT_CANCELLED");
  assert.equal(abortSignal?.aborted,true);
});

// configured: the model in OpenCode's config; recent: the recently used models in OpenCode's state file (model.json), newest first.
// promptErrors: the model error of each prompt in turn (none: it answers). asks: permission requests and questions a prompt without a
// `tools` map (a regular OpenCode turn) raises on the event stream; it answers once every request of its own session has been answered.
function openCodeFixture(calls,{configured=null,recent=null,providers=null,promptErrors=[],asks=[]}={}){
  const streams=new Set(),answered=[];let sessions=0,prompts=0;
  const emit=event=>{for(const push of streams)push(event)};
  const subscribe=async({signal})=>{
    calls.push(["event.subscribe"]);
    const queue=[{type:"server.connected",properties:{}}];let wake=()=>{};
    const push=event=>{queue.push(event);wake()};streams.add(push);
    const stream=(async function*(){
      try{
        while(!signal.aborted){
          if(queue.length){yield queue.shift();continue}
          await new Promise(resolve=>{wake=resolve;signal.addEventListener("abort",resolve,{once:true})});
        }
      }finally{streams.delete(push)}
    })();
    return {stream};
  };
  const openCodeServer=async options=>{calls.push(["server",options]);return {url:"http://127.0.0.1:4096",close(){calls.push(["server.close",existsSync(options.cwd)])}}};
  const openCodeClient=config=>{calls.push(["client",config]);return {
    provider:{list:async request=>{calls.push(["provider.list",request]);return {data:providers??{all:[{id:"anthropic",models:{"claude-x":{id:"claude-x"}}},{id:"openai",models:{"gpt-y":{id:"gpt-y"}}},{id:"offline",models:{local:{id:"local"}}}],connected:["anthropic","openai"],default:{anthropic:"claude-x"}}}}},
    config:{get:async request=>{calls.push(["config.get",request]);return {data:configured?{model:configured}:{}}}},
    event:{subscribe},
    postSessionIdPermissionsPermissionId:async request=>{calls.push(["permission.legacy",request]);answered.push(request.path.permissionID);return {data:true}},
    session:{
      create:async request=>{calls.push(["session.create",request]);sessions++;return {data:{id:sessions===1?"ses_git_text":`ses_git_text_${sessions}`}}},
      prompt:async request=>{
        calls.push(["session.prompt",request]);const error=promptErrors[prompts++];
        if(error)return {data:{info:{id:"msg_2",error},parts:[]}};
        if(!request.body.tools&&asks.length){
          const own=asks.filter(ask=>!ask.sessionID).length;
          for(const ask of asks)emit({type:ask.type,properties:{id:ask.id,sessionID:ask.sessionID||request.path.id}});
          for(let waited=0;answered.length<own&&waited<100;waited++)await new Promise(resolve=>setTimeout(resolve,20));
        }
        return {data:{info:{id:"msg_2",providerID:request.body.model?.providerID,modelID:request.body.model?.modelID},parts:[{type:"reasoning",text:"thinking"},{type:"text",text:"{\"title\":\"Harness PR\",\"body\":\"Body\"}"}]}};
      },
      abort:async request=>{calls.push(["session.abort",request]);return {data:true}},
      delete:async request=>{calls.push(["session.delete",request]);return {data:true}},
    },
  }};
  const openCodeV2Client=config=>{calls.push(["v2client",config]);return {
    permission:{reply:async request=>{calls.push(["permission.reply",request]);answered.push(request.requestID);return {data:true}}},
    question:{reject:async request=>{calls.push(["question.reject",request]);answered.push(request.requestID);return {data:true}}},
  }};
  // Never this machine's own OpenCode state: the tests choose the recently used models.
  const openCodeStateReader=async path=>{
    calls.push(["state.read",path]);if(!recent)throw Object.assign(new Error("no OpenCode state file"),{code:"ENOENT"});
    return JSON.stringify({recent:recent.map(id=>({providerID:id.slice(0,id.indexOf("/")),modelID:id.slice(id.indexOf("/")+1)})),favorite:[]});
  };
  return {openCodeServer,openCodeClient,openCodeV2Client,openCodeStateReader};
}

test("OpenCode adapter asks in a regular OpenCode turn whose tools all need permission, in an empty folder, and deletes the session",async()=>{
  const calls=[],deps=openCodeFixture(calls);
  const manager=fakeRuntimeManager("opencode");
  const result=await generateTextWithHarness({runtimeManager:manager,prompt:"PROMPT",cwd:"H:\\repo",models:["sonnet","openai/gpt-y"],deps});
  assert.deepEqual(result,{text:"{\"title\":\"Harness PR\",\"body\":\"Body\"}",model:"openai/gpt-y",runtime:"opencode",name:"OpenCode"});
  const serverOptions=calls[0][1],scratch=serverOptions.cwd;
  // The Trebell-started server and every SDK call use the empty folder, so the repository's .opencode plugins and config never load.
  assertScratchFolder(scratch,"H:\\repo");assert.equal(serverOptions.env.TREBELL_FIXTURE,"1");assert.equal(serverOptions.serverUrl,null);
  assert.equal(calls.find(([name])=>name==="client")[1].directory,scratch);
  for(const [name,request] of calls.filter(([name])=>/^(?:provider|config|session)\./.test(name)))assert.equal(request.query.directory,scratch,name+" uses the empty folder");
  const created=calls.find(([name])=>name==="session.create")[1];
  assert.deepEqual(created.body.permission,OPENCODE_GIT_TEXT_PERMISSION);
  // Everything is denied except OpenCode's built-in tools, which must ask (and are refused); nothing is allowed outright.
  assert.deepEqual(OPENCODE_GIT_TEXT_PERMISSION[0],{permission:"*",pattern:"*",action:"deny"});
  assert.ok(OPENCODE_GIT_TEXT_PERMISSION.slice(1).every(rule=>rule.action==="ask"&&rule.pattern==="*"));
  assert.ok(["bash","edit","read","task","webfetch","external_directory"].every(permission=>OPENCODE_GIT_TEXT_PERMISSION.some(rule=>rule.permission===permission)));
  const prompted=calls.find(([name])=>name==="session.prompt")[1];
  assert.deepEqual(prompted.path,{id:"ses_git_text"});assert.deepEqual(prompted.body.model,{providerID:"openai",modelID:"gpt-y"});
  // No tools map: a tool-less request is refused by OpenCode Zen's free models, and the map would replace the permission rules.
  assert.equal("tools" in prompted.body,false);
  assert.equal(prompted.body.system,HARNESS_TEXT_INSTRUCTIONS);assert.deepEqual(prompted.body.parts,[{type:"text",text:"PROMPT"}]);
  const order=calls.map(([name])=>name);
  assert.ok(order.indexOf("event.subscribe")>=0&&order.indexOf("event.subscribe")<order.indexOf("session.prompt"),"Trebell listens for permission requests before it prompts");
  assert.ok(order.indexOf("session.delete")>order.indexOf("session.prompt"),"the session is deleted after the reply");
  assert.equal(order.at(-1),"server.close","the Trebell-owned server stops last");
  assert.equal(calls.at(-1)[1],true,"the folder outlives the server process and is removed after it");
  await scratchRemoved(scratch);
  const fallback=await generateTextWithHarness({runtimeManager:manager,prompt:"PROMPT",models:["test/coding-fast"],deps});
  assert.equal(fallback.model,"anthropic/claude-x","an unknown model falls back to OpenCode's preferred connected model");
});

test("an OpenCode profile with its own server URL keeps the repository as its directory",async()=>{
  const calls=[],deps=openCodeFixture(calls);
  const instance={id:"opencode-server",kind:"opencode",serverUrl:"http://127.0.0.1:4096"};
  await generateTextWithHarness({runtimeManager:fakeRuntimeManager("opencode"),instance,prompt:"PROMPT",cwd:"H:\\repo",deps});
  assert.equal(calls[0][1].cwd,"H:\\repo");assert.equal(calls[0][1].serverUrl,"http://127.0.0.1:4096");
  assert.equal(calls.find(([name])=>name==="client")[1].directory,"H:\\repo");
  assert.equal(calls.find(([name])=>name==="session.prompt")[1].query.directory,"H:\\repo");
});

test("OpenCode Git text without the thread's model uses the model OpenCode itself would pick: configured, then recent, then a default",async()=>{
  // test/coding-fast is a model this OpenCode does not offer; the provider default is anthropic/claude-x.
  const run=async(options,instance=null)=>{
    const calls=[],deps=openCodeFixture(calls,options);
    const result=await generateTextWithHarness({runtimeManager:fakeRuntimeManager("opencode"),...(instance?{instance}:{}),prompt:"PROMPT",cwd:"H:\\repo",models:["test/coding-fast"],deps});
    return {calls,model:result.model,prompted:calls.find(([name])=>name==="session.prompt")[1],folder:calls[0][1].cwd};
  };
  const recent=await run({recent:["offline/local","openai/gpt-y"]});
  assert.equal(recent.model,"openai/gpt-y","the newest recent model of a connected provider beats the provider default");
  assert.deepEqual(recent.prompted.body.model,{providerID:"openai",modelID:"gpt-y"});
  const read=recent.calls.filter(([name])=>name==="state.read").map(([,path])=>path);
  assert.equal(read.length,1);assert.match(read[0],/[\\/]opencode[\\/]model\.json$/);
  const configured=await run({configured:"openai/gpt-y",recent:["anthropic/claude-x"]});
  assert.equal(configured.model,"openai/gpt-y","OpenCode's configured model comes before its recent ones");
  assert.equal(configured.calls.find(([name])=>name==="config.get")[1].query.directory,configured.folder);
  assert.equal((await run({})).model,"anthropic/claude-x","with neither, a connected provider's default");
  // A profile's own server may run on another machine: its configured model counts, this machine's recent list does not.
  const external=await run({recent:["openai/gpt-y"]},{id:"opencode-server",kind:"opencode",serverUrl:"http://127.0.0.1:4096"});
  assert.equal(external.model,"anthropic/claude-x");assert.equal(external.calls.some(([name])=>name==="state.read"),false);
});

test("OpenCode Git text refuses every permission request and question of its session, so nothing runs",async()=>{
  // Three permission requests and a question from this session, plus a request from another session that is none of Trebell's business.
  const asks=[{type:"permission.asked",id:"per_1"},{type:"permission.asked",id:"per_2"},{type:"question.asked",id:"que_1"},{type:"permission.asked",id:"per_3"},{type:"permission.asked",id:"per_other",sessionID:"ses_other"}];
  const calls=[],deps=openCodeFixture(calls,{asks});
  const result=await generateTextWithHarness({runtimeManager:fakeRuntimeManager("opencode"),prompt:"PROMPT",cwd:"H:\\repo",models:["openai/gpt-y"],deps});
  assert.deepEqual(result,{text:"{\"title\":\"Harness PR\",\"body\":\"Body\"}",model:"openai/gpt-y",runtime:"opencode",name:"OpenCode"});
  assert.equal(calls.filter(([name])=>name==="session.prompt").length,1,"one request");
  // Refused with a reason the first two times, then plainly, which ends the turn; the question is dismissed.
  const replies=calls.filter(([name])=>name==="permission.reply").map(([,request])=>request);
  assert.deepEqual(replies.map(request=>request.requestID),["per_1","per_2","per_3"],"only this session's requests are answered");
  assert.ok(replies.every(request=>request.reply==="reject"&&request.directory===calls[0][1].cwd));
  assert.deepEqual(replies.map(request=>request.message??null),[OPENCODE_GIT_TEXT_REFUSAL,OPENCODE_GIT_TEXT_REFUSAL,null]);
  assert.deepEqual(calls.filter(([name])=>name==="question.reject").map(([,request])=>request.requestID),["que_1"]);
  assert.equal(calls.some(([name])=>name==="permission.legacy"),false);
  const order=calls.map(([name])=>name);
  assert.deepEqual(calls.filter(([name])=>name==="session.delete").map(([,request])=>request.path.id),["ses_git_text"]);
  assert.equal(order.at(-1),"server.close","the Trebell-owned server stops last");
});

test("OpenCode model errors are reported in OpenCode's own words after one request",async()=>{
  for(const [error,pattern] of [
    [{name:"ProviderAuthError",data:{providerID:"openai",message:"Missing API key"}},/^OpenCode could not write the Git text: Missing API key$/],
    [{name:"APIError",data:{message:"Rate limited",statusCode:429}},/^OpenCode could not write the Git text: Rate limited$/],
    [{name:"MessageAbortedError"},/^OpenCode could not write the Git text: MessageAbortedError$/],
  ]){
    const calls=[],deps=openCodeFixture(calls,{promptErrors:[error]});
    await assert.rejects(()=>generateTextWithHarness({runtimeManager:fakeRuntimeManager("opencode"),prompt:"PROMPT",cwd:"H:\\repo",models:["openai/gpt-y"],deps}),failure=>failure.code==="HARNESS_TEXT_FAILED"&&pattern.test(failure.message));
    assert.equal(calls.filter(([name])=>name==="session.prompt").length,1);
    assert.equal(calls.filter(([name])=>name==="session.delete").length,1,"the session is deleted");
    assert.equal(calls.at(-1)[0],"server.close");
  }
});

test("an OpenCode server without the 1.x API gets a clear Git text error and no prompt",async()=>{
  const calls=[],deps=openCodeFixture(calls,{providers:"<!doctype html><html><body>OpenCode</body></html>"});
  await assert.rejects(()=>generateTextWithHarness({runtimeManager:fakeRuntimeManager("opencode"),prompt:"PROMPT",cwd:"H:\\repo",deps}),error=>{
    assert.equal(error.code,"HARNESS_TEXT_FAILED");
    assert.match(error.message,/^OpenCode could not write the Git text: This OpenCode server does not offer the OpenCode 1\.x API/);
    return true;
  });
  assert.equal(calls.some(([name])=>name==="session.create"),false,"nothing is sent to it");
  assert.equal(calls.at(-1)[0],"server.close","the server Trebell started for it is stopped");
});

// An ACP agent fixture. Environment switches: TREBELL_ACP_MODES (comma list, first is current), TREBELL_ACP_SET_MODE=fail,
// TREBELL_ACP_DELETE=1 (advertise session/delete), TREBELL_ACP_CLOSE=unsupported (answer like Cursor), TREBELL_ACP_HANG=1 (never
// answer the prompt). An OPENCODE_CONFIG_CONTENT agent becomes an extra mode, as OpenCode lists its primary agents.
const ACP_FIXTURE=String.raw`
import readline from "node:readline";
import { writeFileSync } from "node:fs";
const env=process.env;
const record={args:process.argv.slice(2),cwd:process.cwd(),initialize:null,sessionCwd:null,setMode:null,setModel:null,permission:null,fsRead:null,terminal:null,prompt:null,cancelled:false,deleted:null,closed:false,order:[]};
const save=()=>writeFileSync(env.TREBELL_ACP_RECORD,JSON.stringify(record));
let configAgents=[];try{configAgents=Object.keys(JSON.parse(env.OPENCODE_CONFIG_CONTENT||"{}").agent||{})}catch{}
const modes=[...String(env.TREBELL_ACP_MODES??"agent,ask,plan").split(",").filter(Boolean),...configAgents];
let next=1;const pending=new Map();
const send=message=>process.stdout.write(JSON.stringify(message)+"\n");
const request=(method,params)=>{const id="agent-"+(next++);send({jsonrpc:"2.0",id,method,params});return new Promise(resolve=>pending.set(id,resolve))};
readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on("line",async line=>{
  let m;try{m=JSON.parse(line)}catch{return}
  if(m.id!=null&&!m.method){const resolve=pending.get(m.id);pending.delete(m.id);resolve?.(m);return}
  if(m.method){record.order.push(m.method);save()}
  if(m.method==="initialize"){record.initialize=m.params;save();return send({jsonrpc:"2.0",id:m.id,result:{protocolVersion:1,agentInfo:{name:"git-text-fixture"},agentCapabilities:{sessionCapabilities:env.TREBELL_ACP_DELETE==="1"?{close:{},delete:{}}:{close:{}}}}})}
  if(m.method==="session/new"){record.sessionCwd=m.params.cwd;save();return send({jsonrpc:"2.0",id:m.id,result:{sessionId:"acp-git-text",models:{currentModelId:"fast",availableModels:[{modelId:"fast",name:"Fast"},{modelId:"smart",name:"Smart"}]},modes:{currentModeId:modes[0]||null,availableModes:modes.map(id=>({id,name:id}))}}})}
  if(m.method==="session/set_mode"||m.method==="session/set_config_option"){
    if(env.TREBELL_ACP_SET_MODE==="fail")return send({jsonrpc:"2.0",id:m.id,error:{code:-32603,message:"mode switch failed"}});
    record.setMode=m.params.modeId??m.params.value;save();return send({jsonrpc:"2.0",id:m.id,result:{}});
  }
  if(m.method==="session/set_model"){record.setModel=m.params.modelId;save();return send({jsonrpc:"2.0",id:m.id,result:{}})}
  if(m.method==="session/prompt"){
    record.prompt=m.params.prompt?.[0]?.text||"";save();
    if(env.TREBELL_ACP_HANG==="1")return;
    record.permission=(await request("session/request_permission",{sessionId:"acp-git-text",toolCall:{toolCallId:"t1",title:"Run git diff",kind:"execute"},options:[{optionId:"yes",name:"Allow",kind:"allow_once"},{optionId:"no",name:"Reject",kind:"reject_once"}]})).result||null;
    record.fsRead=(await request("fs/read_text_file",{sessionId:"acp-git-text",path:"README.md"})).error||null;
    record.terminal=(await request("terminal/create",{sessionId:"acp-git-text",command:"git",args:["diff"]})).error||null;
    save();
    send({jsonrpc:"2.0",method:"session/update",params:{sessionId:"acp-git-text",update:{sessionUpdate:"agent_thought_chunk",content:{type:"text",text:"thinking"}}}});
    send({jsonrpc:"2.0",method:"session/update",params:{sessionId:"other-session",update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"unrelated"}}}});
    send({jsonrpc:"2.0",method:"session/update",params:{sessionId:"acp-git-text",update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"docs: describe "}}}});
    send({jsonrpc:"2.0",method:"session/update",params:{sessionId:"acp-git-text",update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"harness text"}}}});
    return send({jsonrpc:"2.0",id:m.id,result:{stopReason:"end_turn"}});
  }
  if(m.method==="session/cancel"){record.cancelled=true;save();return}
  if(m.method==="session/delete"){record.deleted=m.params.sessionId;save();return send({jsonrpc:"2.0",id:m.id,result:{}})}
  if(m.method==="session/close"){record.closed=true;save();return env.TREBELL_ACP_CLOSE==="unsupported"?send({jsonrpc:"2.0",id:m.id,error:{code:-32601,message:"Method not found: session/close"}}):send({jsonrpc:"2.0",id:m.id,result:{}})}
  if(m.id!=null)send({jsonrpc:"2.0",id:m.id,error:{code:-32601,message:"unsupported "+m.method}});
});
`;
async function acpFixture(prefix){
  const root=await mkdtemp(join(tmpdir(),prefix));const fixture=join(root,"fixture.mjs"),recordPath=join(root,"record.json");
  await writeFile(fixture,ACP_FIXTURE,"utf8");
  return {root,fixture,recordPath,record:async()=>JSON.parse(await readFile(recordPath,"utf8")),cleanup:()=>rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100})};
}
const localAcpManager=(kind,{fixture,recordPath},env={})=>fakeRuntimeManager(kind,calls=>({executable:()=>process.execPath,childEnv:()=>({...childBaseEnv(),TREBELL_ACP_RECORD:recordPath,...env}),acpArgs:(_instance,mode,cwd)=>{calls.acpArgs.push({mode,cwd});return [fixture]}}));

test("ACP adapter works in an empty folder in Cursor's read-only ask mode, offers no filesystem or terminal and rejects permissions",async()=>{
  const acp=await acpFixture("trebell-acp-git-text-");
  try{
    // Cursor answers session/close with "method not found"; the request still succeeds and the process tree is stopped.
    const manager=localAcpManager("cursor",acp,{TREBELL_ACP_CLOSE:"unsupported"});
    const result=await generateTextWithHarness({runtimeManager:manager,prompt:"PROMPT",cwd:acp.root,models:["missing","smart"],version:"9.9.9"});
    assert.deepEqual(result,{text:"docs: describe harness text",model:"smart",runtime:"cursor",name:"Cursor"});
    const record=await acp.record();
    assertScratchFolder(record.sessionCwd,acp.root);assert.equal(resolve(record.cwd),resolve(record.sessionCwd),"the process also starts in the empty folder");
    assert.deepEqual(manager.calls.acpArgs,[{mode:"read-only",cwd:record.sessionCwd}]);
    // Cursor lists its base model ids (the ids in Trebell's model list) only to a client with the parameterized model picker.
    assert.deepEqual(record.initialize.clientCapabilities,{fs:{readTextFile:false,writeTextFile:false},terminal:false,_meta:{parameterizedModelPicker:true}});
    assert.equal(record.setMode,"ask","Cursor runs in its read-only ask mode, never its default agent mode");
    assert.ok(record.order.indexOf("session/set_mode")<record.order.indexOf("session/prompt"),"the mode is set before the prompt");
    assert.deepEqual(record.permission,{outcome:{outcome:"selected",optionId:"no"}},"permission requests are rejected without prompting");
    assert.match(record.fsRead?.message||"",/read-only/);assert.match(record.terminal?.message||"",/read-only/);
    assert.equal(record.setModel,"smart");assert.ok(record.prompt.startsWith(HARNESS_TEXT_INSTRUCTIONS));assert.ok(record.prompt.endsWith("PROMPT"));
    assert.equal(record.closed,true,"the session close is attempted");assert.equal(record.cancelled,false,"a finished prompt is not cancelled");
    assert.equal(manager.calls.probes.length,1);assert.deepEqual(manager.calls.cli,[],"ACP harnesses have no session delete");
    await scratchRemoved(record.sessionCwd);
  }finally{await acp.cleanup()}
});

test("Cursor Git text is never prompted outside its ask mode",async()=>{
  for(const env of [{TREBELL_ACP_MODES:"agent,plan"},{TREBELL_ACP_SET_MODE:"fail"}]){
    const acp=await acpFixture("trebell-acp-git-text-mode-");
    try{
      await assert.rejects(()=>generateTextWithHarness({runtimeManager:localAcpManager("cursor",acp,env),prompt:"PROMPT",cwd:acp.root}),error=>error.code==="HARNESS_TEXT_FAILED"&&/Cursor (?:did not offer its read-only ask mode|could not switch to its read-only ask mode), so the Git text prompt was not sent/.test(error.message));
      const record=await acp.record();
      assert.equal(record.prompt,null,"no prompt is sent without the read-only mode: "+JSON.stringify(env));assert.equal(record.closed,true);
    }finally{await acp.cleanup()}
  }
  // Other ACP harnesses use a read-only mode when they offer one.
  const acp=await acpFixture("trebell-acp-git-text-grok-");
  try{
    await generateTextWithHarness({runtimeManager:localAcpManager("grok",acp,{TREBELL_ACP_MODES:"default,plan"}),prompt:"PROMPT",cwd:acp.root});
    assert.equal((await acp.record()).setMode,"plan");
  }finally{await acp.cleanup()}
});

test("ACP adapter cancels a prompt that is still running when the request times out",async()=>{
  const acp=await acpFixture("trebell-acp-git-text-timeout-");
  try{
    await assert.rejects(()=>generateTextWithHarness({runtimeManager:localAcpManager("cursor",acp,{TREBELL_ACP_HANG:"1"}),prompt:"PROMPT",cwd:acp.root,timeoutMs:1500}),error=>error.code==="HARNESS_TEXT_TIMEOUT");
    const record=await eventually(async()=>{const value=await acp.record();return value.cancelled&&value.closed?value:null},{message:"the running prompt was not cancelled and closed"});
    assert.ok(record.order.indexOf("session/cancel")<record.order.indexOf("session/close"),"the prompt is cancelled before the session closes");
    await scratchRemoved(record.sessionCwd);
  }finally{await acp.cleanup()}
});

function remoteOpenCodeManager(acp,{env={},spawned=[]}={}){
  return fakeRuntimeManager("opencode",{
    executable:()=>"opencode",remoteIo:()=>({root:"/srv/app"}),runtimeCwd:()=>"/srv/app",
    // Like the SSH spawner: an explicit environment reaches the remote process (as env -i NAME=value), the local env does not.
    processSpawner:()=>options=>{spawned.push({command:options.command,args:options.args,cwd:options.cwd,environment:options.environment});return spawn(process.execPath,[acp.fixture,...options.args],{env:{...childBaseEnv(),TREBELL_ACP_RECORD:acp.recordPath,TREBELL_ACP_MODES:"build,plan",...env,...(options.environment||{})},stdio:options.stdio||["pipe","pipe","pipe"],windowsHide:true})},
  });
}

test("remote OpenCode writes Git text with its Git text agent through its ACP server, refuses its permission requests and deletes the session",async()=>{
  // The same rules as a local Git text session: everything is denied except OpenCode's built-in tools, which must ask (and are refused).
  const config=JSON.parse(OPENCODE_GIT_TEXT_CONFIG);
  assert.deepEqual(config.permission,{"*":"deny"});
  assert.deepEqual(config.agent["trebell-git-text"],{mode:"primary",description:"Trebell Git text",permission:Object.fromEntries(OPENCODE_GIT_TEXT_PERMISSION.map(rule=>[rule.permission,rule.action]))});
  assert.equal(Object.keys(config.agent["trebell-git-text"].permission)[0],"*","the catch-all deny comes first, so the built-in tools' ask rules win");
  assert.ok(Object.values(config.agent["trebell-git-text"].permission).every(action=>action==="deny"||action==="ask"));
  // OpenCode 2.x advertises session/delete: the session is deleted over ACP before it closes.
  let acp=await acpFixture("trebell-acp-remote-git-text-");
  try{
    const spawned=[],manager=remoteOpenCodeManager(acp,{env:{TREBELL_ACP_DELETE:"1"},spawned});
    const result=await generateTextWithHarness({runtimeManager:manager,prompt:"PROMPT",cwd:"/srv/app",environmentId:"ssh-fixture",deps:{openCodeServer:async()=>{throw new Error("a remote OpenCode must not start a local server")}}});
    assert.equal(result.text,"docs: describe harness text");assert.equal(result.model,"fast");
    assert.deepEqual(spawned,[{command:"opencode",args:["acp"],cwd:"/srv/app",environment:{OPENCODE_CONFIG_CONTENT:OPENCODE_GIT_TEXT_CONFIG}}]);
    const record=await acp.record();
    assert.deepEqual(record.args,["acp"]);assert.equal(record.sessionCwd,"/srv/app");
    assert.equal(record.setMode,"trebell-git-text","the session switches to the Git text agent");
    assert.ok(record.order.indexOf("session/set_mode")<record.order.indexOf("session/prompt"),"the Git text agent is set before the prompt");
    assert.deepEqual(record.permission,{outcome:{outcome:"selected",optionId:"no"}},"OpenCode's permission request is refused");
    assert.equal(record.deleted,"acp-git-text");assert.ok(record.order.indexOf("session/delete")<record.order.indexOf("session/close"));
    assert.deepEqual(manager.calls.cli,[],"an ACP delete needs no CLI call");
    assert.deepEqual(manager.calls.probes,[{id:"opencode-default",options:{environmentId:"ssh-fixture"}}]);
  }finally{await acp.cleanup()}
  // OpenCode 1.x has no ACP delete: the CLI deletes the session in the same environment once the ACP process has stopped.
  acp=await acpFixture("trebell-acp-remote-git-text-cli-");
  try{
    const manager=remoteOpenCodeManager(acp);
    await generateTextWithHarness({runtimeManager:manager,prompt:"PROMPT",cwd:"/srv/app",environmentId:"ssh-fixture"});
    const record=await acp.record();
    assert.equal(record.deleted,null);assert.equal(record.setMode,"trebell-git-text");
    assert.deepEqual(manager.calls.cli,[{id:"opencode-default",args:["session","delete","acp-git-text"],options:{environmentId:"ssh-fixture",timeoutMs:15_000}}]);
  }finally{await acp.cleanup()}
});

test("remote OpenCode sends nothing when its Git text agent is missing or cannot be selected",async()=>{
  // Without the config the agent does not exist (an OpenCode that ignores OPENCODE_CONFIG_CONTENT); a failed switch is refused the same way.
  const cases=[{spawner:manager=>({...manager,processSpawner:()=>options=>manager.processSpawner()({...options,environment:undefined})}),pattern:/did not offer its restricted trebell-git-text agent/},{env:{TREBELL_ACP_SET_MODE:"fail"},pattern:/could not switch to its read-only trebell-git-text mode/}];
  for(const {spawner,env={},pattern} of cases){
    const acp=await acpFixture("trebell-acp-remote-git-text-refused-");
    try{
      let manager=remoteOpenCodeManager(acp,{env});if(spawner)manager=spawner(manager);
      await assert.rejects(()=>generateTextWithHarness({runtimeManager:manager,prompt:"PROMPT",cwd:"/srv/app",environmentId:"ssh-fixture"}),error=>error.code==="HARNESS_TEXT_FAILED"&&pattern.test(error.message));
      const record=await acp.record();
      assert.equal(record.prompt,null,"the build agent is never prompted");
      assert.deepEqual(manager.calls.cli.map(call=>call.args),[["session","delete","acp-git-text"]],"the unused session is still deleted");
    }finally{await acp.cleanup()}
  }
});
