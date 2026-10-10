import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPENCODE_RETRY_LIMITS, OPENCODE_UNSUPPORTED_SERVER, OpenCodeAgentSession, connectedOpenCodeModels, discoverOpenCodeModelCatalog, openCodeLongRequestFetch, openCodeMessageId, openCodeModelPreferences, openCodePermissionRules, openCodeRetryStop, openCodeStateDirectory, readOpenCodeRecentModels, remapOpenCodeTurns, startOpenCodeServer } from "../src/opencode-agent-session.mjs";
import { NATIVE_PROMPT_PROVENANCE } from "../src/native-request-metrics.mjs";

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function eventually(check,{timeoutMs=5000,message="condition was not met in time"}={}){
  const startedAt=Date.now();
  for(;;){let value=null;try{value=await check()}catch{}if(value)return value;if(Date.now()-startedAt>timeoutMs)throw new Error(message);await delay(20)}
}

// The catalog of the machine where the bug was found: three connected providers, the first of which has no credits left.
const PROVIDERS=Object.freeze({
  connected:["huggingface","nvidia","opencode"],
  default:{anthropic:"claude-x",huggingface:"zai-org/GLM-5.3-Flash",nvidia:"z-ai/glm-5.3-flash",opencode:"big-pickle"},
  all:[
    {id:"anthropic",models:{"claude-x":{id:"claude-x"}}},
    {id:"huggingface",models:{glm:{id:"zai-org/GLM-5.3-Flash",limit:{context:131072}}}},
    {id:"nvidia",models:{glm:{id:"z-ai/glm-5.3-flash"}}},
    {id:"opencode",models:{pickle:{id:"big-pickle"},muse:{id:"muse-spark-1.3-contributor-free"}}},
  ],
});
const PROVIDER_DEFAULT="huggingface/zai-org/GLM-5.3-Flash",RECENT_MODEL="opencode/muse-spark-1.3-contributor-free";
const modelState=recent=>JSON.stringify({recent,favorite:[],variant:{}});

test("OpenCode's default model follows OpenCode's own order: configured, then recently used, then a provider default",()=>{
  assert.equal(connectedOpenCodeModels(PROVIDERS).preferred,PROVIDER_DEFAULT,"without preferences a connected provider's default is used");
  assert.equal(connectedOpenCodeModels(PROVIDERS,{recent:[RECENT_MODEL]}).preferred,RECENT_MODEL);
  assert.equal(connectedOpenCodeModels(PROVIDERS,{configured:"nvidia/z-ai/glm-5.3-flash",recent:[RECENT_MODEL]}).preferred,"nvidia/z-ai/glm-5.3-flash");
  // A configured or recent model whose provider is not connected, or that no longer exists, is skipped as in OpenCode's own picker.
  assert.equal(connectedOpenCodeModels(PROVIDERS,{configured:"anthropic/claude-x",recent:["openai/gpt-gone",RECENT_MODEL]}).preferred,RECENT_MODEL);
  assert.equal(connectedOpenCodeModels(PROVIDERS,{configured:"anthropic/claude-x",recent:["opencode/retired"]}).preferred,PROVIDER_DEFAULT);
});

test("OpenCode's recent models are read from its XDG state folder, whose rules are the same on every platform",async()=>{
  const windowsHome="C:\\Users\\dev",posixHome="/home/dev";
  assert.equal(openCodeStateDirectory({XDG_STATE_HOME:join("X","state"),USERPROFILE:windowsHome,HOME:posixHome},{platform:"win32"}),join("X","state","opencode"));
  assert.equal(openCodeStateDirectory({USERPROFILE:windowsHome,HOME:posixHome},{platform:"win32"}),join(windowsHome,".local","state","opencode"));
  assert.equal(openCodeStateDirectory({USERPROFILE:windowsHome,HOME:posixHome},{platform:"darwin"}),join(posixHome,".local","state","opencode"));
  const read=[];
  const recent=await readOpenCodeRecentModels({env:{XDG_STATE_HOME:"S"},platform:"linux",readText:async path=>{read.push(path);return modelState([
    {providerID:"opencode",modelID:"muse-spark-1.3-contributor-free"},{providerID:"",modelID:"x"},{providerID:"nvidia"},"not an entry",
    {providerID:"opencode",modelID:"muse-spark-1.3-contributor-free"},{providerID:"huggingface",modelID:"zai-org/GLM-5.3-Flash"},
  ])}});
  assert.deepEqual(read,[join("S","opencode","model.json")]);
  assert.deepEqual(recent,[RECENT_MODEL,PROVIDER_DEFAULT]);
  assert.deepEqual(await readOpenCodeRecentModels({env:{XDG_STATE_HOME:"S"},readText:async()=>{throw Object.assign(new Error("missing"),{code:"ENOENT"})}}),[]);
  assert.deepEqual(await readOpenCodeRecentModels({env:{XDG_STATE_HOME:"S"},readText:async()=>"{not json"}),[]);
});

test("OpenCode model preferences use the config API, and the state file only for a server Trebell started",async()=>{
  const directories=[],client={config:{get:async request=>{directories.push(request.query.directory);return {data:{model:" nvidia/z-ai/glm-5.3-flash "}}}}};
  let reads=0;const readText=async()=>{reads++;return modelState([{providerID:"opencode",modelID:"muse-spark-1.3-contributor-free"}])};
  assert.deepEqual(await openCodeModelPreferences({client,directory:"/repo",env:{XDG_STATE_HOME:"S"},readText}),{configured:"nvidia/z-ai/glm-5.3-flash",recent:[RECENT_MODEL]});
  assert.deepEqual(directories,["/repo"],"the configured model is the merged config of the session's directory");
  assert.deepEqual(await openCodeModelPreferences({client,directory:"/repo",env:{XDG_STATE_HOME:"S"},localState:false,readText}),{configured:"nvidia/z-ai/glm-5.3-flash",recent:[]});
  assert.equal(reads,1,"an external server's state is not read from this machine");
  const failing={config:{get:async()=>({error:{data:{message:"config unavailable"}}})}};
  assert.deepEqual(await openCodeModelPreferences({client:failing,directory:"/repo",env:{XDG_STATE_HOME:"S"},readText}),{configured:null,recent:[RECENT_MODEL]});
});

test("an OpenCode retry that is far away, or one of an endless series, ends the turn with the provider's reason",()=>{
  const now=1_000_000;
  assert.equal(openCodeRetryStop({type:"busy"},{now}),null);
  assert.equal(openCodeRetryStop({type:"retry",attempt:2,message:"Rate limited",next:now+8_000},{now}),null,"a retry that comes soon is waited for");
  assert.match(openCodeRetryStop({type:"retry",attempt:1,message:"Usage limit reached.",next:now+3*3_600_000},{now,model:"opencode/big-pickle"}),/^Usage limit reached\. OpenCode would retry opencode\/big-pickle only in about 3 hours, so Trebell stopped the turn\. Try again later or choose another model\.$/);
  assert.match(openCodeRetryStop({type:"retry",attempt:OPENCODE_RETRY_LIMITS.attempts+1,message:"Provider is overloaded",next:now+30_000},{now,model:"nvidia/z-ai/glm-5.3-flash"}),/^Provider is overloaded\. OpenCode kept retrying nvidia\/z-ai\/glm-5\.3-flash \(attempt 6\)/);
});

// OpenCode message IDs at a given millisecond (OpenCode orders messages by these IDs).
const messageAt=ms=>openCodeMessageId(BigInt(ms)*0x1000n);
// A stand-in for `opencode serve` (the OpenCode 1.x HTTP API Trebell's SDK session uses). routes["POST /path"] overrides a route.
// Sessions keep their messages and permission rules: a session update appends rules, and a fork copies the messages before its
// messageID under new IDs, as OpenCode 1.x does.
async function fakeOpenCode({providers=PROVIDERS,config={},routes={},messages=[],commands=[],agents=[],skills=[]}={}){
  const calls=[],streams=new Set(),sessions=new Map([["ses_fixture",{permission:null,messages:[...messages]}]]);let forks=0;
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url,"http://127.0.0.1");let text="";for await(const chunk of req)text+=chunk;
    let body=null;try{body=text?JSON.parse(text):null}catch{body=text}
    const key=`${req.method} ${url.pathname}`,json=(status,value)=>{if(res.writableEnded)return;res.writeHead(status,{"content-type":"application/json"});res.end(JSON.stringify(value))};
    calls.push({key,body});
    if(routes[key])return routes[key]({req,res,body,json});
    if(key==="GET /event"){res.writeHead(200,{"content-type":"text/event-stream","cache-control":"no-cache"});res.write(`data: ${JSON.stringify({type:"server.connected",properties:{}})}\n\n`);streams.add(res);res.on("close",()=>streams.delete(res));return}
    if(key==="GET /provider")return json(200,providers);
    if(key==="GET /config")return json(200,config);
    if(key==="GET /command")return json(200,commands);
    if(key==="GET /agent")return json(200,agents);
    if(key==="GET /skill")return json(200,skills);
    if(key==="POST /session"){const permission=Array.isArray(body?.permission)?body.permission:null;sessions.get("ses_fixture").permission=permission;return json(200,{id:"ses_fixture",...(body?.title?{title:body.title}:{}),...(permission?{permission}:{})})}
    const match=/^\/session\/([^/]+)(\/[^/]+)?$/.exec(url.pathname),entry=match&&sessions.get(match[1]);
    if(entry){
      const id=match[1],rest=match[2]||"",info=()=>({id,...(entry.permission?{permission:entry.permission}:{})});
      if(req.method==="GET"&&!rest)return json(200,info());
      if(req.method==="PATCH"&&!rest){entry.permission=[...(entry.permission||[]),...(Array.isArray(body?.permission)?body.permission:[])];return json(200,info())}
      if(req.method==="GET"&&rest==="/message")return json(200,entry.messages.map(message=>({info:message,parts:[]})));
      if(req.method==="POST"&&rest==="/fork"){
        const kept=body?.messageID?entry.messages.filter(message=>message.id<body.messageID):entry.messages,forkId=`ses_fork${++forks}`;
        sessions.set(forkId,{permission:null,messages:kept.map((message,index)=>({...message,id:messageAt(Date.now()+forks*1000+index)}))});
        return json(200,{id:forkId});
      }
      if(req.method==="POST"&&rest==="/abort")return json(200,true);
      // OpenCode stores the user message under the ID the client sent and answers with the assistant message.
      if(req.method==="POST"&&rest==="/message")return json(200,{info:{id:"msg_a1",parentID:body?.messageID||"msg_u1",role:"assistant",tokens:{input:3,output:1}},parts:[{id:"prt_1",type:"text",text:"OK"}]});
      if(req.method==="POST"&&rest==="/command")return json(200,{info:{id:"msg_a1",parentID:body?.messageID||"msg_u1",role:"assistant",tokens:{}},parts:[{id:"prt_1",type:"text",text:"COMMAND_RAN"}]});
    }
    if(/^POST \/(?:permission|question)\//.test(key)||/^POST \/session\/[^/]+\/permissions\//.test(key))return json(200,true);
    json(404,{name:"NotFoundError",data:{message:`No fixture route for ${key}`}});
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const emit=event=>{for(const res of streams)res.write(`data: ${JSON.stringify(event)}\n\n`)};
  return {url:`http://127.0.0.1:${server.address().port}`,calls,streams,emit,sessions,called:key=>calls.filter(call=>call.key===key),close:()=>{for(const res of streams)res.end();server.closeAllConnections?.();return new Promise(resolve=>server.close(resolve))}};
}
async function startedSession(fixture,options={}){
  const updates=[],session=new OpenCodeAgentSession({cwd:"/repo",serverUrl:fixture.url,onUpdate:params=>updates.push(params.update),...options});
  await session.start({model:options.model===undefined?PROVIDER_DEFAULT:options.model});
  await eventually(()=>fixture.streams.size>0,{message:"the session did not subscribe to OpenCode events"});
  return {session,updates};
}
const ABORTED_REPLY={info:{id:"msg_a1",parentID:"msg_u1",role:"assistant",error:{name:"MessageAbortedError",data:{message:"The operation was aborted."}}},parts:[]};

test("OpenCode turns carry a message ID Trebell names, so every turn has its rewind point even when OpenCode never answers",async()=>{
  let fail=false;
  const fixture=await fakeOpenCode({routes:{"POST /session/ses_fixture/message":({body,json})=>fail
    ?json(400,{name:"BadRequest",data:{message:"Session ses_fixture is busy"}})
    :json(200,{info:{id:"msg_a1",parentID:body.messageID,role:"assistant",tokens:{}},parts:[{id:"prt_1",type:"text",text:"OK"}]})}});
  const {session,updates}=await startedSession(fixture);
  try{
    const result=await session.prompt([{type:"text",text:"Reply with exactly OK"}],{messageId:"101b36f4-70d2-447a-b28f-b0dff2796f59"});
    const sent=fixture.called("POST /session/ses_fixture/message")[0].body;
    // T3 Code's makeOpenCodeMessageId: "msg_", 12 hex digits of the time, then random characters.
    assert.match(sent.messageID,/^msg_[0-9a-f]{12}[0-9A-Za-z]{28}$/);
    assert.deepEqual(sent.model,{providerID:"huggingface",modelID:"zai-org/GLM-5.3-Flash"});
    assert.deepEqual({stopReason:result.stopReason,providerMessageId:result.providerMessageId,assistantMessageId:result.assistantMessageId},{stopReason:"end_turn",providerMessageId:sent.messageID,assistantMessageId:"msg_a1"});
    assert.equal(updates.filter(update=>update.sessionUpdate==="agent_message_chunk").map(update=>update.content.text).join(""),"OK");
    // A message OpenCode stored with a later time (another client, or a server clock ahead of this one) moves the next ID past it.
    const ahead=messageAt(Date.now()+3_600_000);
    fixture.emit({type:"message.updated",properties:{sessionID:"ses_fixture",info:{id:ahead,sessionID:"ses_fixture",role:"assistant"}}});
    await delay(150);
    fail=true;
    await assert.rejects(()=>session.prompt([{type:"text",text:"again"}]),error=>{
      const failed=fixture.called("POST /session/ses_fixture/message")[1].body.messageID;
      assert.ok(failed>ahead,"a new message ID sorts after every message the session has");
      assert.equal(error.providerMessageId,failed,"a turn OpenCode refused still knows its rewind point");return true;
    });
  }finally{await session.close();await fixture.close()}
});

test("Edit from here rewinds an OpenCode thread into a fork before the turn and leaves the files alone",async()=>{
  const now=Date.now(),[u1,a1,u2,a2]=[0,1,2,3].map(index=>messageAt(now-60_000+index*1000));
  const fixture=await fakeOpenCode({messages:[{id:u1,role:"user"},{id:a1,role:"assistant"},{id:u2,role:"user"},{id:a2,role:"assistant"}]});
  const {session}=await startedSession(fixture,{permissionMode:"edits"});
  try{
    // A message ID OpenCode never handed out is refused before anything changes.
    await assert.rejects(()=>session.rewind("101b36f4-70d2-447a-b28f-b0dff2796f59"),{code:"OPENCODE_REWIND_TARGET_MISSING"});
    // The turn after the last stored message (OpenCode never stored its message) has nothing to drop: the session stays.
    assert.deepEqual(await session.rewind(messageAt(now)),{sessionId:"ses_fixture",messageIds:[],tailId:null});
    assert.equal(fixture.called("POST /session/ses_fixture/fork").length,0);
    const rewound=await session.rewind(u2);
    // OpenCode's revert would also undo the files the agent changed since that message (T3 Code's rollbackThread never calls it).
    assert.equal(fixture.calls.some(call=>call.key.endsWith("/revert")),false);
    assert.deepEqual(fixture.called("POST /session/ses_fixture/fork").map(call=>call.body),[{messageID:u2}]);
    assert.equal(rewound.sessionId,"ses_fork1");assert.equal(session.sessionId,"ses_fork1");
    const copies=fixture.sessions.get("ses_fork1").messages.map(message=>message.id);
    assert.deepEqual(rewound.messageIds,[[u1,copies[0]],[a1,copies[1]]]);
    assert.ok(rewound.tailId>copies[1],"a turn OpenCode never stored moves past every copy");
    // A fork has no rules of its own: it gets the thread's mode before the thread continues in it.
    assert.deepEqual(fixture.called("PATCH /session/ses_fork1").map(call=>call.body.permission),[openCodePermissionRules("edits")]);
    await session.prompt([{type:"text",text:"Try another way"}]);
    assert.equal(fixture.called("POST /session/ses_fork1/message").length,1);assert.equal(fixture.called("POST /session/ses_fixture/message").length,0);
  }finally{await session.close();await fixture.close()}
});

test("a forked OpenCode thread's turns move to the fork's copies of their messages",async()=>{
  const now=Date.now(),[u1,a1,u2,a2]=[0,1,2,3].map(index=>messageAt(now-60_000+index*1000));
  const fixture=await fakeOpenCode({messages:[{id:u1,role:"user"},{id:a1,role:"assistant"},{id:u2,role:"user"},{id:a2,role:"assistant"}]});
  const {session}=await startedSession(fixture);
  let pending=null;
  try{
    const forked=await session.fork();
    assert.deepEqual(fixture.called("POST /session/ses_fixture/fork").map(call=>call.body),[{}]);
    assert.equal(forked.sessionId,"ses_fork1");assert.equal(session.sessionId,"ses_fixture","the source thread stays in its own session");
    const copies=fixture.sessions.get("ses_fork1").messages.map(message=>message.id);
    assert.deepEqual(forked.messageIds,[[u1,copies[0]],[a1,copies[1]],[u2,copies[2]],[a2,copies[3]]]);
    // A failed turn whose message OpenCode never stored rewinds to the next stored message's copy, or past every copy.
    const between=messageAt(now-60_000+1500),after=messageAt(now);
    const turns=remapOpenCodeTurns([
      {id:"t1",providerMessageId:u1,items:[{type:"agentMessage",providerMessageId:u1},{type:"note"}]},
      {id:"t-failed",providerMessageId:between},{id:"t2",providerMessageId:u2},{id:"t-last",providerMessageId:after},{id:"t-live"},
    ],forked);
    assert.deepEqual(turns.map(turn=>turn.providerMessageId),[copies[0],copies[2],copies[2],forked.tailId,undefined]);
    assert.deepEqual(turns[0].items,[{type:"agentMessage",providerMessageId:copies[0]},{type:"note"}]);
    // Forking or rewinding waits for the running turn.
    const routes=await fakeOpenCode({routes:{"POST /session/ses_fixture/message":({json})=>{pending=json}}});
    const busy=await startedSession(routes);
    try{
      const running=busy.session.prompt([{type:"text",text:"long"}]);
      await eventually(()=>pending);
      await assert.rejects(()=>busy.session.fork(),/Stop the running OpenCode turn before forking/);
      await assert.rejects(()=>busy.session.rewind(u1),/Stop the running OpenCode turn before rewinding/);
      pending(200,{info:{id:"msg_a1",parentID:"msg_u1",role:"assistant",tokens:{}},parts:[]});await running;
    }finally{await busy.session.close();await routes.close()}
  }finally{await session.close();await fixture.close()}
});

test("a new OpenCode session carries the mode's permission rules and no fixed title, and a mode change applies before the next turn",async()=>{
  const agents=[
    {name:"build",mode:"primary",permission:[{permission:"*",pattern:"*",action:"allow"},{permission:"external_directory",pattern:"/tmp/opencode/*",action:"allow"}]},
    {name:"plan",mode:"primary",permission:[]},{name:"explore",mode:"subagent",permission:[]},{name:"title",mode:"primary",hidden:true,permission:[]},
  ];
  const fixture=await fakeOpenCode({agents,routes:{"GET /session/ses_child":({json})=>json(200,{id:"ses_child",parentID:"ses_fixture",permission:[{permission:"todowrite",pattern:"*",action:"deny"}]})}});
  const {session,updates}=await startedSession(fixture,{permissionMode:"supervised",repositoryMcp:null});
  try{
    const created=fixture.called("POST /session")[0].body,rules=openCodePermissionRules("supervised",{trustedDirectories:["/tmp/opencode/*"]});
    assert.deepEqual(created,{permission:rules},"OpenCode names the session from its first prompt (T3 Code sets no title)");
    // The composer's agent picker lists the primary agents only.
    assert.deepEqual(updates.find(update=>update.sessionUpdate==="session_info_update"&&update.agents).agents.map(agent=>agent.name),["build","plan"]);
    // The same mode again sends nothing; another mode is appended after the session's rules, where it decides.
    await session.setPermissionMode("supervised");
    assert.equal(fixture.called("PATCH /session/ses_fixture").length,0);
    await session.setPermissionMode("full");
    assert.deepEqual(fixture.called("PATCH /session/ses_fixture").map(call=>call.body.permission),[openCodePermissionRules("full")]);
    assert.deepEqual(fixture.sessions.get("ses_fixture").permission,[...rules,...openCodePermissionRules("full")]);
    // A subagent's session started with only the parent's denies and folder rules; it gets the whole policy, OpenCode's own rules last.
    fixture.emit({type:"message.updated",properties:{sessionID:"ses_fixture",info:{id:"msg_a9",sessionID:"ses_fixture",role:"assistant"}}});
    fixture.emit({type:"message.part.updated",properties:{sessionID:"ses_fixture",part:{id:"prt_task",messageID:"msg_a9",sessionID:"ses_fixture",type:"tool",tool:"task",callID:"call_task",state:{status:"running",input:{},metadata:{sessionId:"ses_child"}}}}});
    await eventually(()=>fixture.called("PATCH /session/ses_child").length,{message:"the subagent session did not get the thread's rules"});
    assert.deepEqual(fixture.called("PATCH /session/ses_child")[0].body.permission,[...openCodePermissionRules("full"),{permission:"todowrite",pattern:"*",action:"deny"}]);
  }finally{await session.close();await fixture.close()}
});

test("a session another OpenCode server reopens keeps its rules when OpenCode lists the same trusted folders in another order",async()=>{
  const folders=["/tmp/opencode/*","/home/dev/.claude/skills/a/*","/home/dev/.claude/skills/b/*"];
  const agentsWith=order=>[{name:"build",mode:"primary",permission:order.map(pattern=>({permission:"external_directory",pattern,action:"allow"}))}];
  const first=await fakeOpenCode({agents:agentsWith(folders)});
  const {session}=await startedSession(first,{permissionMode:"supervised"});
  const stored=first.sessions.get("ses_fixture").permission;
  await session.close();await first.close();
  const second=await fakeOpenCode({agents:agentsWith([...folders].reverse())});second.sessions.get("ses_fixture").permission=stored;
  const reopened=new OpenCodeAgentSession({cwd:"/repo",serverUrl:second.url,permissionMode:"supervised",onUpdate:()=>{}});
  try{
    await reopened.start({providerSessionId:"ses_fixture",model:PROVIDER_DEFAULT});
    assert.equal(reopened.sessionId,"ses_fixture");assert.equal(second.called("POST /session").length,0);
    assert.equal(second.called("PATCH /session/ses_fixture").length,0,"the same rules are not appended again");
  }finally{await reopened.close();await second.close()}
});

test("a message naming one of OpenCode's commands runs that command, with only the user's own text as its arguments",async()=>{
  const fixture=await fakeOpenCode({commands:[{name:"parityprobe",template:"Reply with exactly TEMPLATE_RAN_$ARGUMENTS"},{name:"init"}]});
  const {session,updates}=await startedSession(fixture);
  try{
    session.setReasoningEffort("high");
    const context=Object.defineProperty({type:"text",text:"<trebell_context>\nworking context\n</trebell_context>"},NATIVE_PROMPT_PROVENANCE,{value:{kind:"working_context"}});
    const image={type:"image",mimeType:"image/png",data:"aGk="};
    const result=await session.prompt([context,{type:"text",text:"/parityprobe zebra stripes"},image],{agent:"plan"});
    const sent=fixture.called("POST /session/ses_fixture/command")[0].body;
    assert.deepEqual({command:sent.command,arguments:sent.arguments,model:sent.model,agent:sent.agent,variant:sent.variant,parts:sent.parts},{command:"parityprobe",arguments:"zebra stripes",model:"huggingface/zai-org/GLM-5.3-Flash",agent:"plan",variant:undefined,parts:[{type:"file",mime:"image/png",url:"data:image/png;base64,aGk="}]});
    assert.match(sent.messageID,/^msg_/);assert.equal(result.providerMessageId,sent.messageID);
    assert.equal(fixture.called("POST /session/ses_fixture/message").length,0);
    assert.equal(updates.filter(update=>update.sessionUpdate==="agent_message_chunk").map(update=>update.content.text).join(""),"COMMAND_RAN");
    // A name OpenCode does not list, or a path, stays an ordinary message.
    await session.prompt([{type:"text",text:"/unknown thing"}]);await session.prompt([{type:"text",text:"/src/app.js is broken"}]);
    assert.deepEqual(fixture.called("POST /session/ses_fixture/message").map(call=>call.body.parts.map(part=>part.text)),[["/unknown thing"],["/src/app.js is broken"]]);
    assert.equal(fixture.called("POST /session/ses_fixture/command").length,1);
  }finally{await session.close();await fixture.close()}
});

test("a reasoning level is sent as the model's OpenCode variant, only for a model that has it",async()=>{
  const providers={connected:["opencode"],default:{opencode:"muse"},all:[{id:"opencode",name:"OpenCode Zen",models:{
    muse:{id:"muse",name:"Muse Spark 1.3 Free",variants:{minimal:{},low:{},medium:{},high:{},off:{disabled:true}}},plain:{id:"plain",name:"Plain"},
  }}]};
  const fixture=await fakeOpenCode({providers});const {session}=await startedSession(fixture,{model:"opencode/muse"});
  try{
    assert.deepEqual(session.sessionSetup.models.availableModels,[{modelId:"opencode/muse",name:"Muse Spark 1.3 Free"},{modelId:"opencode/plain",name:"Plain"}]);
    session.setReasoningEffort("low");await session.prompt([{type:"text",text:"hi"}]);
    session.setReasoningEffort("off");await session.prompt([{type:"text",text:"hi"}]);
    await session.setModel("opencode/plain");session.setReasoningEffort("low");await session.prompt([{type:"text",text:"hi"}]);
    session.setReasoningEffort(null);await session.setModel("opencode/muse");await session.prompt([{type:"text",text:"hi"}]);
    assert.deepEqual(fixture.called("POST /session/ses_fixture/message").map(call=>call.body.variant),["low",undefined,undefined,undefined]);
  }finally{await session.close();await fixture.close()}
});

test("a model OpenCode cannot use fails with OpenCode's own reason, not its generic server error",async()=>{
  let fixture;
  const generic={name:"UnknownError",data:{message:"Unexpected server error. Check server logs for details.",ref:"err_e535bfcf"}};
  const reason="Model not found: opencode/no-such-model. Did you mean: gpt-5-nano?";
  fixture=await fakeOpenCode({routes:{"POST /session/ses_fixture/message":({json})=>{
    // OpenCode answers the prompt with a generic error and publishes the reason as session.error just after.
    json(500,generic);
    setTimeout(()=>{
      fixture.emit({type:"session.error",properties:{sessionID:"ses_fixture",error:{name:"UnknownError",data:{message:reason}}}});
      // The same reason again, with OpenCode's exception name in front and its stack trace after.
      fixture.emit({type:"session.error",properties:{sessionID:"ses_fixture",error:{name:"UnknownError",data:{message:`ProviderModelNotFoundError: ${reason}\n    at resolve (src/provider.ts:12:3)\n    at async prompt (src/session.ts:40:1)`}}}});
    },150);
  }}});
  const {session,updates}=await startedSession(fixture);
  try{
    await assert.rejects(()=>session.prompt([{type:"text",text:"hello"}]),{message:`OpenCode could not get a reply from huggingface/zai-org/GLM-5.3-Flash: ${reason}`});
    await delay(300);
    assert.deepEqual(updates.filter(update=>update.sessionUpdate==="runtime_error").map(update=>update.message),[],"the same reason is not shown a second time");
    // A generic error with no reason after it still ends the turn, once the short wait is over.
    const quiet=await fakeOpenCode({routes:{"POST /session/ses_fixture/message":({json})=>json(500,generic)}});
    const second=await startedSession(quiet);
    try{await assert.rejects(()=>second.session.prompt([{type:"text",text:"hello"}]),{message:"OpenCode could not get a reply from huggingface/zai-org/GLM-5.3-Flash: Unexpected server error. Check server logs for details."})}
    finally{await second.session.close();await quiet.close()}
  }finally{await session.close();await fixture.close()}
});

test("OpenCode's reasoning text streams as the model's thinking, apart from its reply",async()=>{
  let pending=null;
  const fixture=await fakeOpenCode({routes:{"POST /session/ses_fixture/message":({json})=>{pending=json}}});
  const {session,updates}=await startedSession(fixture);
  const of=kind=>updates.filter(update=>update.sessionUpdate===kind).map(update=>update.content.text).join("");
  try{
    const running=session.prompt([{type:"text",text:"Think first"}]);
    await eventually(()=>pending);
    fixture.emit({type:"message.updated",properties:{sessionID:"ses_fixture",info:{id:"msg_a1",sessionID:"ses_fixture",role:"assistant"}}});
    fixture.emit({type:"message.part.updated",properties:{sessionID:"ses_fixture",part:{id:"prt_r",messageID:"msg_a1",sessionID:"ses_fixture",type:"reasoning",text:""}}});
    fixture.emit({type:"message.part.delta",properties:{sessionID:"ses_fixture",messageID:"msg_a1",partID:"prt_r",field:"text",delta:"Weighing "}});
    fixture.emit({type:"message.part.delta",properties:{sessionID:"ses_fixture",messageID:"msg_a1",partID:"prt_r",field:"text",delta:"options"}});
    fixture.emit({type:"message.part.updated",properties:{sessionID:"ses_fixture",part:{id:"prt_r",messageID:"msg_a1",sessionID:"ses_fixture",type:"reasoning",text:"Weighing options."}}});
    await eventually(()=>of("agent_thought_chunk")==="Weighing options.",{message:"the reasoning text did not stream"});
    pending(200,{info:{id:"msg_a1",parentID:"msg_u1",role:"assistant",tokens:{}},parts:[{id:"prt_1",type:"text",text:"Answer"}]});
    await running;
    assert.equal(of("agent_message_chunk"),"Answer");
  }finally{await session.close();await fixture.close()}
});

test("OpenCode's catalog carries model and provider names, reasoning levels, and the agents and commands a new chat offers",async()=>{
  const providers={connected:["opencode","openai"],default:{opencode:"muse",openai:"gpt"},all:[
    {id:"opencode",name:"OpenCode Zen",models:{muse:{id:"muse",name:"Muse Spark 1.3 Free",limit:{context:200000},variants:{minimal:{},low:{},medium:{},high:{},xhigh:{}}}}},
    {id:"openai",name:"OpenAI",models:{gpt:{id:"gpt",name:"GPT",variants:{low:{},high:{}}},mini:{id:"mini",name:"Mini"}}},
  ]};
  const agents=[{name:"build",mode:"primary",permission:[]},{name:"plan",mode:"all",permission:[]},{name:"general",mode:"subagent",permission:[]},{name:"summary",mode:"primary",hidden:true,permission:[]}];
  const fixture=await fakeOpenCode({providers,agents,commands:[{name:"init",description:"create AGENTS.md"}],skills:[{name:"pdf",description:"PDF tools"}]});
  try{
    const catalog=await discoverOpenCodeModelCatalog({cwd:"/repo",serverUrl:fixture.url});
    assert.deepEqual(catalog.metadata,[
      {id:"opencode/muse",name:"Muse Spark 1.3 Free",provider:"opencode",agent:"OpenCode",upstreamProvider:"OpenCode Zen",contextWindow:200000,reasoningEfforts:["minimal","low","medium","high","xhigh"],defaultReasoningEffort:"medium"},
      {id:"openai/gpt",name:"GPT",provider:"opencode",agent:"OpenCode",upstreamProvider:"OpenAI",reasoningEfforts:["low","high"],defaultReasoningEffort:"high"},
      {id:"openai/mini",name:"Mini",provider:"opencode",agent:"OpenCode",upstreamProvider:"OpenAI"},
    ]);
    assert.deepEqual(catalog.connectedProviders,["opencode","openai"]);
    assert.deepEqual({commands:catalog.inventory.commands.map(item=>item.name),skills:catalog.inventory.skills.map(item=>item.name),agents:catalog.inventory.agents.map(item=>item.name)},{commands:["init"],skills:["pdf"],agents:["build","plan"]});
  }finally{await fixture.close()}
});

test("a failed OpenCode reply ends the turn with one clear error that names the model",async()=>{
  const error={name:"APIError",data:{message:"Payment Required: You have no remaining credits.",statusCode:402,isRetryable:false}};
  let fixture;
  fixture=await fakeOpenCode({routes:{"POST /session/ses_fixture/message":async({json})=>{
    // OpenCode publishes session.error and then answers the prompt with the failed assistant message.
    fixture.emit({type:"session.error",properties:{sessionID:"ses_fixture",error}});await delay(100);
    json(200,{info:{id:"msg_a1",parentID:"msg_u1",role:"assistant",error},parts:[]});
    await delay(50);fixture.emit({type:"session.error",properties:{sessionID:"ses_fixture",error}});
  }}});
  const {session,updates}=await startedSession(fixture);
  try{
    await assert.rejects(()=>session.prompt([{type:"text",text:"hello"}],{messageId:"turn-1"}),{message:"OpenCode could not get a reply from huggingface/zai-org/GLM-5.3-Flash: Payment Required: You have no remaining credits.",providerMessageId:"msg_u1",assistantMessageId:"msg_a1"});
    // A later, different session error still reaches the conversation; the failed turn's own error is not shown a second time.
    await delay(150);
    fixture.emit({type:"session.error",properties:{sessionID:"ses_fixture",error:{name:"UnknownError",data:{message:"Snapshot failed"}}}});
    await eventually(()=>updates.some(update=>update.sessionUpdate==="runtime_error"));
    assert.deepEqual(updates.filter(update=>update.sessionUpdate==="runtime_error").map(update=>update.message),["Snapshot failed"]);
  }finally{await session.close();await fixture.close()}
});

test("a session error during an OpenCode turn that still finishes is shown once, after the turn",async()=>{
  const error={name:"UnknownError",data:{message:"Snapshot failed"}};
  let fixture;
  fixture=await fakeOpenCode({routes:{"POST /session/ses_fixture/message":async({json})=>{
    fixture.emit({type:"session.error",properties:{sessionID:"ses_fixture",error}});await delay(100);
    json(200,{info:{id:"msg_a1",parentID:"msg_u1",role:"assistant",tokens:{}},parts:[{id:"prt_1",type:"text",text:"Done"}]});
  }}});
  const {session,updates}=await startedSession(fixture);
  try{
    assert.equal((await session.prompt([{type:"text",text:"hello"}])).stopReason,"end_turn");
    assert.deepEqual(updates.filter(update=>update.sessionUpdate==="runtime_error").map(update=>update.message),["Snapshot failed"]);
    fixture.emit({type:"session.error",properties:{sessionID:"ses_fixture",error}});await delay(150);
    assert.equal(updates.filter(update=>update.sessionUpdate==="runtime_error").length,1,"the same error is not repeated");
  }finally{await session.close();await fixture.close()}
});

test("OpenCode 1.x text deltas stream into the conversation, and the part's last update does not repeat them",async()=>{
  let pending=null;
  const fixture=await fakeOpenCode({routes:{"POST /session/ses_fixture/message":({json})=>{pending=json}}});
  const {session,updates}=await startedSession(fixture);
  const chunks=()=>updates.filter(update=>update.sessionUpdate==="agent_message_chunk").map(update=>update.content.text);
  const part=(id,type,text)=>({type:"message.part.updated",properties:{sessionID:"ses_fixture",part:{id,messageID:"msg_a1",sessionID:"ses_fixture",type,text}}});
  const delta=(partID,text,sessionID="ses_fixture")=>({type:"message.part.delta",properties:{sessionID,messageID:"msg_a1",partID,field:"text",delta:text}});
  try{
    const running=session.prompt([{type:"text",text:"Count to three"}]);
    await eventually(()=>pending);
    // OpenCode 1.18: the text part starts empty, grows through deltas and ends with one update that carries the full text.
    fixture.emit({type:"message.updated",properties:{sessionID:"ses_fixture",info:{id:"msg_a1",sessionID:"ses_fixture",role:"assistant"}}});
    fixture.emit(part("prt_1","text",""));
    for(const text of ["1\n","2\n","3"])fixture.emit(delta("prt_1",text));
    // Reasoning deltas and another session's deltas are not reply text.
    fixture.emit(part("prt_r","reasoning",""));fixture.emit(delta("prt_r","thinking"));fixture.emit(delta("prt_1","other session","ses_other"));
    await eventually(()=>chunks().join("")==="1\n2\n3",{message:"the reply was not streamed"});
    fixture.emit(part("prt_1","text","1\n2\n3"));await delay(100);
    pending(200,{info:{id:"msg_a1",parentID:"msg_u1",role:"assistant",tokens:{}},parts:[{id:"prt_1",type:"text",text:"1\n2\n3"}]});
    assert.equal((await running).stopReason,"end_turn");
    assert.deepEqual(chunks(),["1\n","2\n","3"],"each piece of text reaches the conversation once");
  }finally{await session.close();await fixture.close()}
});

test("an OpenCode prompt the server rejects ends the turn with that reason",async()=>{
  const fixture=await fakeOpenCode({routes:{"POST /session/ses_fixture/message":({json})=>json(400,{name:"BadRequest",data:{message:"Session ses_fixture is busy"}})}});
  const {session}=await startedSession(fixture);
  try{await assert.rejects(()=>session.prompt([{type:"text",text:"hello"}]),{message:"OpenCode could not get a reply from huggingface/zai-org/GLM-5.3-Flash: Session ses_fixture is busy"})}
  finally{await session.close();await fixture.close()}
});

test("cancelling an OpenCode turn ends it as cancelled instead of failed",async()=>{
  let pending=null;
  const fixture=await fakeOpenCode({routes:{
    "POST /session/ses_fixture/message":({json})=>{pending=json},
    "POST /session/ses_fixture/abort":({json})=>{pending?.(200,ABORTED_REPLY);json(200,true)},
  }});
  const {session,updates}=await startedSession(fixture);
  try{
    const running=session.prompt([{type:"text",text:"long task"}]);
    await eventually(()=>pending);
    await session.cancel();
    assert.equal((await running).stopReason,"cancelled");
    fixture.emit({type:"session.error",properties:{sessionID:"ses_fixture",error:ABORTED_REPLY.info.error}});
    await delay(150);
    assert.equal(updates.some(update=>update.sessionUpdate==="runtime_error"),false,"Trebell's own stop is not reported as an error");
  }finally{await session.close();await fixture.close()}
});

test("closing the session ends a waiting OpenCode turn at once",async()=>{
  const fixture=await fakeOpenCode({routes:{"POST /session/ses_fixture/message":()=>{}}});
  const {session}=await startedSession(fixture);
  try{
    const running=session.prompt([{type:"text",text:"long task"}]);
    await eventually(()=>fixture.called("POST /session/ses_fixture/message").length);
    await session.close();
    assert.equal((await running).stopReason,"cancelled");
  }finally{await session.close();await fixture.close()}
});

test("a retry OpenCode would only make hours later stops the turn with the provider's reason instead of hanging",async()=>{
  let pending=null;
  const fixture=await fakeOpenCode({routes:{
    "POST /session/ses_fixture/message":({json})=>{pending=json},
    "POST /session/ses_fixture/abort":({json})=>{pending?.(200,ABORTED_REPLY);json(200,true)},
  }});
  const {session}=await startedSession(fixture);
  try{
    const running=session.prompt([{type:"text",text:"hello"}]);running.catch(()=>{});
    await eventually(()=>pending);
    fixture.emit({type:"session.status",properties:{sessionID:"ses_fixture",status:{type:"retry",attempt:1,message:"Rate limit reached for this account",next:Date.now()+2*3_600_000}}});
    await assert.rejects(running,/^Error: Rate limit reached for this account\. OpenCode would retry huggingface\/zai-org\/GLM-5\.3-Flash only in about 2 hours, so Trebell stopped the turn/);
    assert.equal(fixture.called("POST /session/ses_fixture/abort").length,1,"the waiting OpenCode turn is aborted");
  }finally{await session.close();await fixture.close()}
});

// Node's fetch gives up on response headers after 300 seconds; the test lowers that limit so the behaviour shows in seconds. undici checks
// that deadline on a coarse (about half a second) clock, so the late reply comes well after any point at which it can fire.
const LATE_HEADERS_MS=3000;
async function withShortFetchHeaderTimeout(warmUrl,timeoutMs,run){
  const key=Symbol.for("undici.globalDispatcher.1");
  await fetch(warmUrl).then(response=>response.arrayBuffer());
  const previous=globalThis[key],Agent=previous?.constructor;
  if(typeof Agent!=="function")return false;
  const agent=new Agent({headersTimeout:timeoutMs});globalThis[key]=agent;
  try{await run();return true}finally{globalThis[key]=previous;await agent.close().catch(()=>{})}
}

test("an OpenCode turn that outlasts Node's fetch header timeout still returns its reply",async t=>{
  // OpenCode 1.x sends the prompt's response headers only when the whole turn is done.
  const slowly=({json})=>{setTimeout(()=>json(200,{info:{id:"msg_a1",parentID:"msg_u1",role:"assistant",tokens:{}},parts:[{id:"prt_1",type:"text",text:"DONE"}]}),LATE_HEADERS_MS)};
  const fixture=await fakeOpenCode({routes:{"POST /session/ses_fixture/message":slowly,"POST /slow":slowly}});
  const {session}=await startedSession(fixture);
  try{
    const ran=await withShortFetchHeaderTimeout(fixture.url+"/config",100,async()=>{
      await assert.rejects(fetch(fixture.url+"/slow",{method:"POST",body:"{}"}),error=>error?.cause?.code==="UND_ERR_HEADERS_TIMEOUT","Node's fetch drops a reply whose headers come late");
      const result=await session.prompt([{type:"text",text:"a long refactor"}]);
      assert.equal(result.stopReason,"end_turn");assert.equal(result.providerMessageId,"msg_u1");
    });
    if(!ran)t.skip("this runtime does not expose Node's fetch dispatcher");
  }finally{await session.close();await fixture.close()}
});

test("the long-request transport keeps headers, status, empty bodies and cancellation",async()=>{
  const fixture=await fakeOpenCode({routes:{
    "POST /echo":({req,body,res})=>{res.writeHead(201,{"content-type":"application/json","x-seen":String(req.headers["x-opencode-directory"])});res.end(JSON.stringify({body,encoding:req.headers["accept-encoding"]}))},
    "POST /empty":({res})=>{res.writeHead(204);res.end()},
    "POST /reset":({res})=>{res.writeHead(205);res.end()},
    "POST /never":()=>{},
  }});
  try{
    const echo=await openCodeLongRequestFetch(new Request(fixture.url+"/echo",{method:"POST",headers:{"content-type":"application/json","x-opencode-directory":"%2Frepo"},body:JSON.stringify({a:1})}));
    assert.equal(echo.status,201);assert.equal(echo.headers.get("x-seen"),"%2Frepo");
    assert.deepEqual(await echo.json(),{body:{a:1},encoding:"identity"});
    const empty=await openCodeLongRequestFetch(fixture.url+"/empty",{method:"POST"});
    assert.equal(empty.status,204);assert.equal(empty.body,null);
    // Every status that has no body (a 205 included) becomes an empty response rather than an error thrown inside Node's HTTP client.
    const reset=await openCodeLongRequestFetch(fixture.url+"/reset",{method:"POST",body:"{}"});
    assert.equal(reset.status,205);assert.equal(reset.body,null);
    const controller=new AbortController();
    const waiting=openCodeLongRequestFetch(fixture.url+"/never",{method:"POST",body:"{}",signal:controller.signal});
    setTimeout(()=>controller.abort(),50);
    await assert.rejects(waiting,{name:"AbortError"});
  }finally{await fixture.close()}
});

test("OpenCode permission requests (permission.asked) are answered, so a turn never waits forever",async()=>{
  const fixture=await fakeOpenCode();const asked=[];
  const {session}=await startedSession(fixture,{permissionMode:"supervised",onPermission:async request=>{asked.push(request.params);return "accept"}});
  try{
    fixture.emit({type:"permission.asked",properties:{id:"per_1",sessionID:"ses_fixture",permission:"edit",patterns:["src/app.js"],metadata:{filepath:"src/app.js"},always:["*"],tool:{messageID:"msg_a1",callID:"call_1"}}});
    await eventually(()=>fixture.called("POST /permission/per_1/reply").length);
    assert.deepEqual(fixture.called("POST /permission/per_1/reply")[0].body,{reply:"once"});
    assert.equal(asked.length,1);
    assert.deepEqual({title:asked[0].toolCall.title,toolCallId:asked[0].toolCall.toolCallId,kind:asked[0].toolCall.kind,permissionType:asked[0].permissionType},{title:"Edit files: src/app.js",toolCallId:"call_1",kind:"edit",permissionType:"edit"});
    // Requests for another session are not answered by this one.
    fixture.emit({type:"permission.asked",properties:{id:"per_other",sessionID:"ses_other",permission:"edit",patterns:[],metadata:{},always:[]}});
    fixture.emit({type:"permission.asked",properties:{id:"per_2",sessionID:"ses_fixture",permission:"bash",patterns:["rm -rf build"],metadata:{},always:[]}});
    await eventually(()=>fixture.called("POST /permission/per_2/reply").length);
    assert.equal(fixture.called("POST /permission/per_other/reply").length,0);
  }finally{await session.close();await fixture.close()}
  // Full access allows without asking, and an OpenCode without the newer reply route gets the session-scoped one. The automatic
  // answer is "once": OpenCode's "always" would stay in its server's approvals.
  const legacy=await fakeOpenCode({routes:{"POST /permission/per_3/reply":({json})=>json(404,{name:"NotFoundError",data:{message:"no route"}})}});
  const full=await startedSession(legacy,{permissionMode:"full",onPermission:async()=>{throw new Error("full access does not ask")}});
  try{
    legacy.emit({type:"permission.asked",properties:{id:"per_3",sessionID:"ses_fixture",permission:"bash",patterns:["npm test"],metadata:{},always:["npm *"]}});
    await eventually(()=>legacy.called("POST /session/ses_fixture/permissions/per_3").length);
    assert.deepEqual(legacy.called("POST /session/ses_fixture/permissions/per_3")[0].body,{response:"once"});
  }finally{await full.session.close();await legacy.close()}
});

test("OpenCode requests Auto allows are answered once, so nothing is remembered after a switch to Supervised; the user's own Always allow is kept",async()=>{
  // OpenCode keeps an "always" answer in its server's approvals, which outrank the session's rules: an automatic "always" in Auto would
  // let the same edits and commands run unasked once the thread is back in Supervised.
  const fixture=await fakeOpenCode();const asked=[];
  const {session}=await startedSession(fixture,{permissionMode:"auto",onPermission:async request=>{asked.push(request.params.permissionType);return "acceptForSession"}});
  try{
    fixture.emit({type:"permission.asked",properties:{id:"per_edit",sessionID:"ses_fixture",permission:"edit",patterns:["src/app.js"],metadata:{filepath:"src/app.js"},always:["*"]}});
    fixture.emit({type:"permission.asked",properties:{id:"per_bash",sessionID:"ses_fixture",permission:"bash",patterns:["npm test"],metadata:{},always:["npm *"]}});
    await eventually(()=>fixture.called("POST /permission/per_edit/reply").length&&fixture.called("POST /permission/per_bash/reply").length);
    assert.deepEqual(fixture.called("POST /permission/per_edit/reply").map(call=>call.body),[{reply:"once"}]);
    assert.deepEqual(fixture.called("POST /permission/per_bash/reply").map(call=>call.body),[{reply:"once"}]);
    assert.deepEqual(asked,[],"Auto answers these itself");
    // Back in Supervised the user is asked, and the user's own "Always allow" is OpenCode's "always".
    await session.setPermissionMode("supervised");
    fixture.emit({type:"permission.asked",properties:{id:"per_edit_2",sessionID:"ses_fixture",permission:"edit",patterns:["src/app.js"],metadata:{filepath:"src/app.js"},always:["*"]}});
    await eventually(()=>fixture.called("POST /permission/per_edit_2/reply").length);
    assert.deepEqual(asked,["edit"]);
    assert.deepEqual(fixture.called("POST /permission/per_edit_2/reply").map(call=>call.body),[{reply:"always"}]);
  }finally{await session.close();await fixture.close()}
});

test("an OpenCode permission request the app never answered is refused, and the session still handles later requests",async()=>{
  const fixture=await fakeOpenCode();let asked=0;
  // The first approval fails as the relay's does when nobody answers in time or the app disconnects.
  const {session}=await startedSession(fixture,{permissionMode:"supervised",onPermission:async()=>{if(++asked===1)throw new Error("item/tool/requestApproval user response timed out");return "accept"}});
  try{
    fixture.emit({type:"permission.asked",properties:{id:"per_1",sessionID:"ses_fixture",permission:"external_directory",patterns:["/outside/*"],metadata:{},always:[]}});
    await eventually(()=>fixture.called("POST /permission/per_1/reply").length,{message:"OpenCode was left waiting for an answer"});
    assert.deepEqual(fixture.called("POST /permission/per_1/reply")[0].body,{reply:"reject"});
    fixture.emit({type:"permission.asked",properties:{id:"per_2",sessionID:"ses_fixture",permission:"bash",patterns:["npm test"],metadata:{},always:[]}});
    await eventually(()=>fixture.called("POST /permission/per_2/reply").length,{message:"the session stopped reading OpenCode's events"});
    assert.deepEqual(fixture.called("POST /permission/per_2/reply")[0].body,{reply:"once"});
  }finally{await session.close();await fixture.close()}
});

test("a subagent's permission requests, questions and far-off retries (OpenCode runs it in a child session) never hold the turn",async()=>{
  let pending=null;
  const sessions={ses_child:{id:"ses_child",parentID:"ses_fixture"},ses_grandchild:{id:"ses_grandchild",parentID:"ses_child"},ses_other:{id:"ses_other"}};
  const fixture=await fakeOpenCode({routes:{
    ...Object.fromEntries(Object.entries(sessions).map(([id,info])=>[`GET /session/${id}`,({json})=>json(200,info)])),
    "POST /permission/per_legacy/reply":({json})=>json(404,{name:"NotFoundError",data:{message:"no route"}}),
    "POST /session/ses_fixture/message":({json})=>{pending=json},
    "POST /session/ses_fixture/abort":({json})=>{pending?.(200,ABORTED_REPLY);json(200,true)},
  }});
  const titles=[];
  const {session}=await startedSession(fixture,{onPermission:async request=>{titles.push(request.params.toolCall.title);return "accept"},onQuestion:async()=>({q1:"Yes"})});
  try{
    fixture.emit({type:"permission.asked",properties:{id:"per_child",sessionID:"ses_child",permission:"external_directory",patterns:["/outside/*"],metadata:{},always:[]}});
    fixture.emit({type:"question.asked",properties:{id:"que_grandchild",sessionID:"ses_grandchild",questions:[{question:"Proceed?",header:"Proceed",options:[{label:"Yes",description:""}]}]}});
    fixture.emit({type:"permission.asked",properties:{id:"per_other",sessionID:"ses_other",permission:"edit",patterns:["notes.md"],metadata:{},always:[]}});
    // An OpenCode without the newer reply route gets the subagent session's own route.
    fixture.emit({type:"permission.asked",properties:{id:"per_legacy",sessionID:"ses_child",permission:"bash",patterns:["ls"],metadata:{},always:[]}});
    await eventually(()=>fixture.called("POST /session/ses_child/permissions/per_legacy").length,{message:"the subagent's request was left waiting"});
    assert.deepEqual(fixture.called("POST /permission/per_child/reply").map(call=>call.body),[{reply:"once"}]);
    assert.deepEqual(fixture.called("POST /question/que_grandchild/reply").map(call=>call.body),[{answers:[["Yes"]]}]);
    assert.deepEqual(fixture.called("POST /session/ses_child/permissions/per_legacy").map(call=>call.body),[{response:"once"}]);
    assert.equal(fixture.called("POST /permission/per_other/reply").length+fixture.called("POST /session/ses_other/permissions/per_other").length,0,"a session outside this one's family is not answered");
    assert.deepEqual(titles,["Use a folder outside the workspace: /outside/*","Run command: ls"]);
    assert.equal(fixture.called("GET /session/ses_child").length,1,"a session's family is looked up once");
    // A subagent waiting hours for its retry holds the turn too: the turn stops and both sessions are aborted.
    const running=session.prompt([{type:"text",text:"Delegate the search to a subagent"}]);running.catch(()=>{});
    await eventually(()=>pending);
    fixture.emit({type:"session.status",properties:{sessionID:"ses_child",status:{type:"retry",attempt:1,message:"Usage limit reached",next:Date.now()+3*3_600_000}}});
    await assert.rejects(running,/^Error: A subagent's model request failed: Usage limit reached\. OpenCode would retry only in about 3 hours, so Trebell stopped the turn/);
    assert.equal(fixture.called("POST /session/ses_child/abort").length,1);assert.equal(fixture.called("POST /session/ses_fixture/abort").length,1);
  }finally{await session.close();await fixture.close()}
});

test("OpenCode questions go to Trebell's question prompt and are dismissed rather than left waiting",async()=>{
  const fixture=await fakeOpenCode();const seen=[];
  const {session}=await startedSession(fixture,{onQuestion:async request=>{seen.push(request.input);return {q1:["Postgres"],q2:"Yes"}}});
  const question={id:"que_1",sessionID:"ses_fixture",questions:[
    {question:"Which database?",header:"Database",options:[{label:"Postgres",description:"Relational"},{label:"SQLite",description:"File"}],multiple:false},
    {question:"Add tests?",header:"Tests",options:[{label:"Yes",description:""},{label:"No",description:""}]},
  ]};
  try{
    fixture.emit({type:"question.asked",properties:question});
    await eventually(()=>fixture.called("POST /question/que_1/reply").length);
    assert.deepEqual(fixture.called("POST /question/que_1/reply")[0].body,{answers:[["Postgres"],["Yes"]]});
    assert.deepEqual(seen[0].questions.map(item=>({id:item.id,header:item.header,question:item.question,options:item.options.map(option=>option.label)})),[
      {id:"q1",header:"Database",question:"Which database?",options:["Postgres","SQLite"]},
      {id:"q2",header:"Tests",question:"Add tests?",options:["Yes","No"]},
    ]);
  }finally{await session.close();await fixture.close()}
  const quiet=await fakeOpenCode();const unanswered=await startedSession(quiet,{onQuestion:undefined});
  try{
    quiet.emit({type:"question.asked",properties:{...question,id:"que_2"}});
    await eventually(()=>quiet.called("POST /question/que_2/reject").length);
  }finally{await unanswered.session.close();await quiet.close()}
});

test("an OpenCode 2.x server is reported as incompatible instead of offering no models",async()=>{
  const fixture=await fakeOpenCode({routes:{"GET /provider":({res})=>{res.writeHead(200,{"content-type":"text/html"});res.end("<!doctype html><html><body>OpenCode</body></html>")}}});
  const session=new OpenCodeAgentSession({cwd:"/repo",serverUrl:fixture.url});
  try{
    await assert.rejects(()=>session.start({}),{message:OPENCODE_UNSUPPORTED_SERVER});
    await assert.rejects(()=>discoverOpenCodeModelCatalog({cwd:"/repo",serverUrl:fixture.url}),{message:OPENCODE_UNSUPPORTED_SERVER});
  }finally{await session.close();await fixture.close()}
});

// A stand-in `opencode serve` process: `node serve --hostname=... --port=N` runs this file from the working folder.
const FAKE_SERVE=String.raw`
const http=require("node:http");
const port=Number((process.argv.find(arg=>arg.startsWith("--port="))||"").slice(7)),mode=process.env.FAKE_OPENCODE_MODE||"v1";
if(mode==="crash"){process.stdout.write("starting\nserver password hunter2-secret\n");process.exit(3)}
const providers=JSON.parse(process.env.FAKE_OPENCODE_PROVIDERS||"{}"),config=JSON.parse(process.env.FAKE_OPENCODE_CONFIG||"{}");
http.createServer((req,res)=>{
  const url=new URL(req.url,"http://127.0.0.1"),json=value=>{res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify(value))};
  if(mode==="v2"){res.writeHead(200,{"content-type":"text/html"});res.end("<!doctype html><html></html>");return}
  if(req.method==="GET"&&url.pathname==="/provider")return json(providers);
  if(req.method==="GET"&&url.pathname==="/config")return json(config);
  if(req.method==="POST"&&url.pathname==="/session")return json({id:"ses_spawned"});
  if(req.method==="GET"&&url.pathname==="/event"){res.writeHead(200,{"content-type":"text/event-stream"});res.write("data: "+JSON.stringify({type:"server.connected",properties:{}})+"\n\n");return}
  if(req.method==="GET"&&["/command","/agent","/skill"].includes(url.pathname))return json([]);
  res.writeHead(404,{"content-type":"application/json"});res.end(JSON.stringify({name:"NotFoundError",data:{message:"not found"}}));
}).listen(port,"127.0.0.1",()=>process.stdout.write((mode==="v2"?"":"opencode ")+"server listening on http://127.0.0.1:"+port+"\n"+(mode==="v2"?"server password hunter2-secret\n":"")));
`;
async function fakeServeFolder(t){
  const root=await mkdtemp(join(tmpdir(),"trebell-opencode-serve-"));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  await writeFile(join(root,"serve"),FAKE_SERVE);
  const state=join(root,"state");await mkdir(join(state,"opencode"),{recursive:true});
  return {root,state,env:(extra={})=>({...process.env,XDG_STATE_HOME:state,FAKE_OPENCODE_PROVIDERS:JSON.stringify(PROVIDERS),FAKE_OPENCODE_CONFIG:"{}",...extra})};
}

test("a Trebell-started OpenCode defaults to the user's recently used model unless a model is configured",async t=>{
  const folder=await fakeServeFolder(t);
  await writeFile(join(folder.state,"opencode","model.json"),modelState([{providerID:"opencode",modelID:"muse-spark-1.3-contributor-free"}]));
  const catalog=await discoverOpenCodeModelCatalog({command:process.execPath,cwd:folder.root,env:folder.env()});
  assert.equal(catalog.preferred,RECENT_MODEL);assert.equal(catalog.models[0],RECENT_MODEL,"the picker lists the default first");
  const session=new OpenCodeAgentSession({command:process.execPath,cwd:folder.root,env:folder.env()});
  try{
    const started=await session.start({});
    assert.equal(started.session.models.currentModelId,RECENT_MODEL);
  }finally{await session.close()}
  const configured=await discoverOpenCodeModelCatalog({command:process.execPath,cwd:folder.root,env:folder.env({FAKE_OPENCODE_CONFIG:JSON.stringify({model:"nvidia/z-ai/glm-5.3-flash"})})});
  assert.equal(configured.preferred,"nvidia/z-ai/glm-5.3-flash");
  // A thread's own model still wins over every default.
  const explicit=new OpenCodeAgentSession({command:process.execPath,cwd:folder.root,env:folder.env()});
  try{assert.equal((await explicit.start({model:PROVIDER_DEFAULT})).session.models.currentModelId,PROVIDER_DEFAULT)}finally{await explicit.close()}
});

test("an OpenCode server that fails to start is not left running and its password never reaches the error",async t=>{
  const folder=await fakeServeFolder(t);
  await assert.rejects(()=>startOpenCodeServer({command:process.execPath,cwd:folder.root,env:folder.env({FAKE_OPENCODE_MODE:"crash"})}),error=>{
    assert.match(error.message,/OpenCode server exited with code 3/);assert.match(error.message,/server password \[redacted\]/);
    assert.equal(error.message.includes("hunter2-secret"),false);return true;
  });
  // A 2.x server starts (its listening line has no "opencode" prefix), is found incompatible and is stopped by the session.
  const session=new OpenCodeAgentSession({command:process.execPath,cwd:folder.root,env:folder.env({FAKE_OPENCODE_MODE:"v2"})});
  await assert.rejects(()=>session.start({}),{message:OPENCODE_UNSUPPORTED_SERVER});
  const child=session.server.child;await session.close();
  await eventually(()=>child.exitCode!==null||child.signalCode!==null,{message:"the incompatible OpenCode server kept running"});
});
