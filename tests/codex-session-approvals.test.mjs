import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { attachCodexRelay } from "../src/codex-relay.mjs";
import { allowsSession, approvalThreadId, createCodexSessionApprovals, sessionApprovalKind, sessionApprovalResult } from "../src/codex-session-approvals.mjs";
import { sleep, startCodexGui, until } from "./fixtures/codex-gui-fake.mjs";

test("the allowance store keeps a thread's allowed kinds for one permission mode, and an answer read in a mode that ended adds nothing",()=>{
  const store=createCodexSessionApprovals();
  const allowed=store.allowance("t1","supervised");allowed.add("command");
  assert.equal(store.allowance("t1","supervised").has("command"),true,"the same thread and mode keep it");
  assert.equal(store.allowance("t2","supervised").has("command"),false,"another thread has its own");
  assert.equal(store.allowance("t1","full").has("command"),false,"a request in another mode does not use it");
  store.turnStarted("t1","supervised");assert.equal(store.allowance("t1","supervised").has("command"),true,"a turn in the same mode keeps it");
  // A request read before a turn in another mode began, answered after it: its allowance is gone, and back in the first mode none returns.
  const late=store.allowance("t1","supervised");
  store.turnStarted("t1","full");late.add("fileChange");
  store.turnStarted("t1","supervised");
  assert.equal(store.allowance("t1","supervised").has("command"),false);assert.equal(store.allowance("t1","supervised").has("fileChange"),false);
  store.allowance("t2","supervised").add("command");store.end("t2");assert.equal(store.allowance("t2","supervised").has("command"),false,"an unloaded thread loses it");
  store.allowance("t3","supervised").add("command");store.clear();assert.equal(store.size(),0);
});

test("only command and file-change approvals can be allowed for a session, each answered in its own protocol's words",()=>{
  assert.equal(sessionApprovalKind("item/commandExecution/requestApproval",{command:"npm test"}),"command");
  assert.equal(sessionApprovalKind("execCommandApproval",{command:["npm","test"]}),"command");
  assert.equal(sessionApprovalKind("item/fileChange/requestApproval",{}),"fileChange");
  assert.equal(sessionApprovalKind("applyPatchApproval",{fileChanges:{}}),"fileChange");
  assert.equal(sessionApprovalKind("item/commandExecution/requestApproval",{networkApprovalContext:{host:"example.com",protocol:"https"}}),null,"network access stays per request");
  assert.equal(sessionApprovalKind("item/permissions/requestApproval",{permissions:{}}),null,"extra permissions stay per request");
  assert.equal(allowsSession("item/commandExecution/requestApproval",{decision:"acceptForSession"}),true);
  assert.equal(allowsSession("item/commandExecution/requestApproval",{decision:"accept"}),false);
  assert.equal(allowsSession("execCommandApproval",{decision:"approved_for_session"}),true);
  assert.equal(allowsSession("execCommandApproval",{decision:"acceptForSession"}),false);
  assert.deepEqual(sessionApprovalResult("item/fileChange/requestApproval"),{decision:"acceptForSession"});
  assert.deepEqual(sessionApprovalResult("applyPatchApproval"),{decision:"approved_for_session"});
  assert.equal(approvalThreadId({conversationId:"legacy-thread"}),"legacy-thread");
});

test("the Codex relay tells the server each answer to a request the window was asked, with that request's method and params",async()=>{
  const upstreamHttp=createServer(),upstreamWss=new WebSocketServer({noServer:true}),received=[],sockets=new Set();
  upstreamHttp.on("upgrade",(req,socket,head)=>upstreamWss.handleUpgrade(req,socket,head,ws=>upstreamWss.emit("connection",ws,req)));
  upstreamWss.on("connection",ws=>{sockets.add(ws);ws.on("message",raw=>{const message=JSON.parse(String(raw));received.push(message);if(message.method)ws.send(JSON.stringify({id:message.id,result:{}}))})});
  await new Promise(resolve=>upstreamHttp.listen(0,"127.0.0.1",resolve));
  const relayHttp=createServer((_req,res)=>{res.statusCode=404;res.end()}),seen=[],asked=[];
  const relay=attachCodexRelay(relayHttp,{targetUrl:`ws://127.0.0.1:${upstreamHttp.address().port}`,
    handleServerRequest:message=>{asked.push(message);return null},
    onServerRequestAnswered:(message,context)=>seen.push({message,context})});
  await new Promise(resolve=>relayHttp.listen(0,"127.0.0.1",resolve));
  const client=new WebSocket(`ws://127.0.0.1:${relayHttp.address().port}/api/codex/ws`),messages=[];
  try{
    await new Promise((resolve,reject)=>{client.once("open",resolve);client.once("error",reject)});client.on("message",raw=>messages.push(JSON.parse(String(raw))));
    client.send(JSON.stringify({id:1,method:"initialize",params:{}}));await until(()=>messages.some(item=>item.id===1));
    [...sockets][0].send(JSON.stringify({id:77,method:"item/commandExecution/requestApproval",params:{threadId:"t1",itemId:"c1",command:"npm test"}}));
    await until(()=>messages.some(item=>item.method==="item/commandExecution/requestApproval"));
    const request=messages.find(item=>item.method==="item/commandExecution/requestApproval");
    client.send(JSON.stringify({id:request.id,result:{decision:"acceptForSession"}}));
    await until(()=>received.some(item=>item.id===77&&item.result));
    assert.deepEqual(received.find(item=>item.id===77).result,{decision:"acceptForSession"});
    assert.equal(seen.length,1);assert.equal(seen[0].message.id,77,"the answer as it goes back to Codex");
    assert.equal(seen[0].context.method,"item/commandExecution/requestApproval");
    assert.equal(seen[0].context.params,asked[0].params,"the params handleServerRequest got, not the window's copy");
  }finally{client.terminate();relay.close();for(const ws of sockets)ws.terminate();upstreamWss.close();await new Promise(resolve=>relayHttp.close(resolve));await new Promise(resolve=>upstreamHttp.close(resolve))}
});

const SUPERVISED={approvalPolicy:"on-request",sandboxPolicy:{type:"workspaceWrite",writableRoots:[],networkAccess:true}};
const FULL={approvalPolicy:"never",sandboxPolicy:{type:"dangerFullAccess"}};
const command=(threadId,itemId,extra={})=>["item/commandExecution/requestApproval",{threadId,turnId:"turn-1",itemId,command:"npm run "+itemId,startedAtMs:Date.now(),...extra}];

test("after Allow session, Trebell answers the thread's later command approvals itself, and they never reach the window",async()=>{
  const fixture=await startCodexGui("trebell-session-approvals-"),{upstream}=fixture,threadId="session-thread",otherId="other-thread";
  try{
    await fixture.thread(threadId);await fixture.thread(otherId);
    const window=await fixture.window();await window.request("initialize",{clientInfo:{name:"session-approvals"}});
    await window.request("turn/start",{threadId,input:[],...SUPERVISED});
    const asks=()=>window.requests("item/commandExecution/requestApproval");
    // The first asks; the person allows it for the session.
    const first=upstream.ask(...command(threadId,"cmd-1"));
    assert.ok(await until(()=>asks().length===1),"the first command approval reaches the window");
    window.answer(asks()[0],{decision:"acceptForSession"});
    assert.ok(await until(()=>first.answers().length===1));assert.deepEqual(first.answers()[0].result,{decision:"acceptForSession"});
    // The next command in the thread is answered by Trebell, as Codex's own acceptForSession would not: it never reaches the window,
    // nor does Codex's serverRequest/resolved for it.
    const second=upstream.ask(...command(threadId,"cmd-2"));
    assert.ok(await until(()=>second.answers().length===1),"Trebell answers the second command approval");
    assert.deepEqual(second.answers()[0].result,{decision:"acceptForSession"});
    upstream.notify("serverRequest/resolved",{threadId,requestId:second.id});
    await sleep(150);
    assert.equal(asks().length,1,"only the first card was shown");
    assert.equal(window.notifications("serverRequest/resolved").length,0,"no resolved notice for a request the window never had");
    const resolved=(await fixture.traces(threadId)).filter(item=>item.name==="permission.resolved"&&item.data?.sessionAllowed);
    assert.equal(resolved.length,1);assert.equal(resolved[0].status,"accept");
    // A file change was not allowed, network access and other threads stay per request.
    upstream.ask("item/fileChange/requestApproval",{threadId,turnId:"turn-1",itemId:"patch-1",startedAtMs:Date.now()});
    upstream.ask(...command(threadId,"net-1",{networkApprovalContext:{host:"registry.npmjs.org",protocol:"https"}}));
    upstream.ask(...command(otherId,"cmd-other"));
    assert.ok(await until(()=>window.requests("item/fileChange/requestApproval").length===1&&asks().length===3),"each of those asks");
    // Back in the same mode the allowance holds; a turn in another mode ends it, and back in the first mode it is not there.
    await window.request("turn/start",{threadId,input:[],...SUPERVISED});
    const third=upstream.ask(...command(threadId,"cmd-3"));assert.ok(await until(()=>third.answers().length===1));
    assert.deepEqual(third.answers()[0].result,{decision:"acceptForSession"});
    await window.request("turn/start",{threadId,input:[],...FULL});
    await window.request("turn/start",{threadId,input:[],...SUPERVISED});
    upstream.ask(...command(threadId,"cmd-4"));
    assert.ok(await until(()=>asks().length===4),"after another mode the command asks again");
    assert.equal(asks().at(-1).params.itemId,"cmd-4");
  }finally{await fixture.close()}
});

test("an Allow session answered after a turn in another mode began allows nothing, and an unloaded thread asks again",async()=>{
  const fixture=await startCodexGui("trebell-session-late-"),{upstream}=fixture,threadId="late-thread",legacyId="legacy-thread";
  try{
    await fixture.thread(threadId);await fixture.thread(legacyId,{permissionProfile:"supervised"});
    const window=await fixture.window();await window.request("initialize",{clientInfo:{name:"session-late"}});
    await window.request("turn/start",{threadId,input:[],...SUPERVISED});
    const asks=()=>window.requests("item/commandExecution/requestApproval");
    // Each answer below has reached Codex (answers()), so the server has taken it, before Codex asks its next request: those travel
    // on two sockets, and a fixed wait between them could let the next request arrive first on a busy machine.
    const late=upstream.ask(...command(threadId,"cmd-late"));assert.ok(await until(()=>asks().length===1));
    // The mode changes and comes back before the person answers; the late Allow session allows nothing.
    await window.request("turn/start",{threadId,input:[],...FULL});
    await window.request("turn/start",{threadId,input:[],...SUPERVISED});
    window.answer(asks()[0],{decision:"acceptForSession"});assert.ok(await until(()=>late.answers().length===1));
    const after=upstream.ask(...command(threadId,"cmd-after"));
    assert.ok(await until(()=>asks().length===2),"the late answer did not allow the session");
    // Allowed now, then the window lets the thread go: the allowance goes with it.
    window.answer(asks()[1],{decision:"acceptForSession"});assert.ok(await until(()=>after.answers().length===1));
    const answered=upstream.ask(...command(threadId,"cmd-allowed"));assert.ok(await until(()=>answered.answers().length===1));
    assert.deepEqual(answered.answers()[0].result,{decision:"acceptForSession"});
    await window.request("thread/unsubscribe",{threadId});
    upstream.ask(...command(threadId,"cmd-unloaded"));
    assert.ok(await until(()=>asks().length===3),"an unloaded thread asks again");
    // Codex's legacy approvals name the thread conversationId and are answered approved_for_session.
    const legacy=()=>window.requests("execCommandApproval");
    const call=upstream.ask("execCommandApproval",{conversationId:legacyId,callId:"call-1",command:["npm","test"],cwd:fixture.home});
    assert.ok(await until(()=>legacy().length===1));window.answer(legacy()[0],{decision:"approved_for_session"});
    assert.ok(await until(()=>call.answers().length===1));
    const again=upstream.ask("execCommandApproval",{conversationId:legacyId,callId:"call-2",command:["npm","run","lint"],cwd:fixture.home});
    assert.ok(await until(()=>again.answers().length===1));assert.deepEqual(again.answers()[0].result,{decision:"approved_for_session"});
    assert.equal(legacy().length,1);
    // Codex closing the thread ends it too: the window hears of it once the server has.
    upstream.notify("thread/closed",{threadId:legacyId});assert.ok(await until(()=>window.notifications("thread/closed").length===1));
    upstream.ask("execCommandApproval",{conversationId:legacyId,callId:"call-3",command:["npm","run","build"],cwd:fixture.home});
    assert.ok(await until(()=>legacy().length===2),"a closed thread asks again");
  }finally{await fixture.close()}
});
