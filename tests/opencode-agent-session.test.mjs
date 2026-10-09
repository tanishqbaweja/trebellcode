import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPENCODE_RETRY_LIMITS, OPENCODE_UNSUPPORTED_SERVER, OpenCodeAgentSession, connectedOpenCodeModels, discoverOpenCodeModelCatalog, openCodeLongRequestFetch, openCodeModelPreferences, openCodeRetryStop, openCodeStateDirectory, readOpenCodeRecentModels, startOpenCodeServer } from "../src/opencode-agent-session.mjs";

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

// A stand-in for `opencode serve` (the OpenCode 1.x HTTP API Trebell's SDK session uses). routes["POST /path"] overrides a route.
async function fakeOpenCode({providers=PROVIDERS,config={},routes={},messages=["msg_u0","msg_u1"]}={}){
  const calls=[],streams=new Set();
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url,"http://127.0.0.1");let text="";for await(const chunk of req)text+=chunk;
    let body=null;try{body=text?JSON.parse(text):null}catch{body=text}
    const key=`${req.method} ${url.pathname}`,json=(status,value)=>{if(res.writableEnded)return;res.writeHead(status,{"content-type":"application/json"});res.end(JSON.stringify(value))};
    calls.push({key,body});
    if(routes[key])return routes[key]({req,res,body,json});
    if(key==="GET /event"){res.writeHead(200,{"content-type":"text/event-stream","cache-control":"no-cache"});res.write(`data: ${JSON.stringify({type:"server.connected",properties:{}})}\n\n`);streams.add(res);res.on("close",()=>streams.delete(res));return}
    if(key==="GET /provider")return json(200,providers);
    if(key==="GET /config")return json(200,config);
    if(key==="POST /session")return json(200,{id:"ses_fixture",title:"Trebell task"});
    if(["GET /command","GET /agent","GET /skill"].includes(key))return json(200,[]);
    if(key==="POST /session/ses_fixture/abort")return json(200,true);
    if(key==="POST /session/ses_fixture/message")return json(200,{info:{id:"msg_a1",parentID:"msg_u1",role:"assistant",tokens:{input:3,output:1}},parts:[{id:"prt_1",type:"text",text:"OK"}]});
    // Like OpenCode, a rewind answers with the session; it has a revert point only for a message the session has.
    if(key==="POST /session/ses_fixture/revert")return json(200,{id:"ses_fixture",...(messages.includes(body?.messageID)?{revert:{messageID:body.messageID}}:{})});
    if(/^POST \/(?:permission|question)\//.test(key)||/^POST \/session\/[^/]+\/permissions\//.test(key))return json(200,true);
    json(404,{name:"NotFoundError",data:{message:`No fixture route for ${key}`}});
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const emit=event=>{for(const res of streams)res.write(`data: ${JSON.stringify(event)}\n\n`)};
  return {url:`http://127.0.0.1:${server.address().port}`,calls,streams,emit,called:key=>calls.filter(call=>call.key===key),close:()=>{for(const res of streams)res.end();server.closeAllConnections?.();return new Promise(resolve=>server.close(resolve))}};
}
async function startedSession(fixture,options={}){
  const updates=[],session=new OpenCodeAgentSession({cwd:"/repo",serverUrl:fixture.url,onUpdate:params=>updates.push(params.update),...options});
  await session.start({model:options.model===undefined?PROVIDER_DEFAULT:options.model});
  await eventually(()=>fixture.streams.size>0,{message:"the session did not subscribe to OpenCode events"});
  return {session,updates};
}
const ABORTED_REPLY={info:{id:"msg_a1",parentID:"msg_u1",role:"assistant",error:{name:"MessageAbortedError",data:{message:"The operation was aborted."}}},parts:[]};

test("OpenCode turns send no Trebell message ID: OpenCode names the message and revert maps Trebell's ID to it",async()=>{
  const fixture=await fakeOpenCode();const {session,updates}=await startedSession(fixture);
  try{
    const result=await session.prompt([{type:"text",text:"Reply with exactly OK"}],{messageId:"101b36f4-70d2-447a-b28f-b0dff2796f59"});
    const sent=fixture.called("POST /session/ses_fixture/message")[0].body;
    assert.equal(Object.hasOwn(sent,"messageID"),false,"OpenCode rejects any message ID it did not generate itself");
    assert.deepEqual(sent.model,{providerID:"huggingface",modelID:"zai-org/GLM-5.3-Flash"});
    assert.deepEqual({stopReason:result.stopReason,providerMessageId:result.providerMessageId,assistantMessageId:result.assistantMessageId},{stopReason:"end_turn",providerMessageId:"msg_u1",assistantMessageId:"msg_a1"});
    assert.equal(updates.filter(update=>update.sessionUpdate==="agent_message_chunk").map(update=>update.content.text).join(""),"OK");
    await session.revert("101b36f4-70d2-447a-b28f-b0dff2796f59");
    await session.revert("msg_u0");
    assert.deepEqual(fixture.called("POST /session/ses_fixture/revert").map(call=>call.body),[{messageID:"msg_u1"},{messageID:"msg_u0"}]);
  }finally{await session.close();await fixture.close()}
});

test("an OpenCode rewind to a message the session does not have fails instead of pretending it rewound",async()=>{
  // A forked thread keeps the source thread's message IDs, but OpenCode's fork gives every copied message a new ID, and OpenCode answers
  // a rewind to an unknown message with the unchanged session.
  const fixture=await fakeOpenCode({messages:["msg_fork_u1"]});const {session}=await startedSession(fixture);
  try{
    await assert.rejects(()=>session.revert("msg_source_u1"),{code:"OPENCODE_REWIND_TARGET_MISSING",message:/^OpenCode could not rewind to this turn: its session has no message msg_source_u1/});
    assert.equal((await session.revert("msg_fork_u1")).revert.messageID,"msg_fork_u1");
  }finally{await session.close();await fixture.close()}
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
  // Full access allows without asking, and an OpenCode without the newer reply route gets the session-scoped one.
  const legacy=await fakeOpenCode({routes:{"POST /permission/per_3/reply":({json})=>json(404,{name:"NotFoundError",data:{message:"no route"}})}});
  const full=await startedSession(legacy,{permissionMode:"full",onPermission:async()=>{throw new Error("full access does not ask")}});
  try{
    legacy.emit({type:"permission.asked",properties:{id:"per_3",sessionID:"ses_fixture",permission:"bash",patterns:["npm test"],metadata:{},always:["npm *"]}});
    await eventually(()=>legacy.called("POST /session/ses_fixture/permissions/per_3").length);
    assert.deepEqual(legacy.called("POST /session/ses_fixture/permissions/per_3")[0].body,{response:"always"});
  }finally{await full.session.close();await legacy.close()}
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
