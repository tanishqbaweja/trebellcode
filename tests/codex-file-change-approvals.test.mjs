import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { attachCodexRelay } from "../src/codex-relay.mjs";
import * as adapter from "../src/codex-policy-adapter.mjs";
import { sleep, startCodexGui, until } from "./fixtures/codex-gui-fake.mjs";

test("the Codex relay lets the server add to a request the window is to answer, and the answer goes back under Codex's id",async()=>{
  const upstreamHttp=createServer(),upstreamWss=new WebSocketServer({noServer:true}),received=[],sockets=new Set();
  upstreamHttp.on("upgrade",(req,socket,head)=>upstreamWss.handleUpgrade(req,socket,head,ws=>upstreamWss.emit("connection",ws,req)));
  upstreamWss.on("connection",ws=>{sockets.add(ws);ws.on("message",raw=>{const message=JSON.parse(String(raw));received.push(message);if(message.method)ws.send(JSON.stringify({id:message.id,result:{}}))})});
  await new Promise(resolve=>upstreamHttp.listen(0,"127.0.0.1",resolve));
  const relayHttp=createServer((_req,res)=>{res.statusCode=404;res.end()}),asked=[];
  const relay=attachCodexRelay(relayHttp,{targetUrl:`ws://127.0.0.1:${upstreamHttp.address().port}`,
    handleServerRequest:message=>{asked.push(message);return null},
    transformServerRequest:message=>message.method==="item/fileChange/requestApproval"?{...message,params:{...message.params,trebellFileChanges:[{path:"src/app.js",kind:"update",movePath:null}]}}:message});
  await new Promise(resolve=>relayHttp.listen(0,"127.0.0.1",resolve));
  const client=new WebSocket(`ws://127.0.0.1:${relayHttp.address().port}/api/codex/ws`),messages=[];
  try{
    await new Promise((resolve,reject)=>{client.once("open",resolve);client.once("error",reject)});client.on("message",raw=>messages.push(JSON.parse(String(raw))));
    client.send(JSON.stringify({id:1,method:"initialize",params:{}}));await until(()=>messages.some(item=>item.id===1));
    [...sockets][0].send(JSON.stringify({id:88,method:"item/fileChange/requestApproval",params:{threadId:"t1",turnId:"u1",itemId:"p1"}}));
    await until(()=>messages.some(item=>item.method==="item/fileChange/requestApproval"));
    const request=messages.find(item=>item.method==="item/fileChange/requestApproval");
    assert.deepEqual(request.params.trebellFileChanges,[{path:"src/app.js",kind:"update",movePath:null}],"the window gets the request as the server rewrote it");
    assert.equal(Object.prototype.hasOwnProperty.call(asked[0].params,"trebellFileChanges"),false,"Codex's own request is left as it came");
    client.send(JSON.stringify({id:request.id,result:{decision:"accept"}}));
    await until(()=>received.some(item=>item.id===88&&item.result));
    assert.deepEqual(received.find(item=>item.id===88).result,{decision:"accept"});
  }finally{client.terminate();relay.close();for(const ws of sockets)ws.terminate();upstreamWss.close();await new Promise(resolve=>relayHttp.close(resolve));await new Promise(resolve=>upstreamHttp.close(resolve))}
});

test("a Codex file change's files come from its item's changes or a legacy request's fileChanges, a move with its new path",()=>{
  assert.deepEqual(adapter.codexFileChanges([
    {path:"/repo/src/app.js",kind:{type:"update",move_path:null},diff:"@@"},
    {path:"/repo/src/new.js",kind:{type:"add"},diff:"+x"},
    {path:"/repo/src/old.js",kind:{type:"update",move_path:"/repo/src/renamed.js"},diff:""},
    {path:"/repo/gone.txt",kind:{type:"delete"},diff:""},
    {kind:{type:"add"}},
  ]),[
    {path:"/repo/src/app.js",kind:"update",movePath:null},
    {path:"/repo/src/new.js",kind:"add",movePath:null},
    {path:"/repo/src/old.js",kind:"update",movePath:"/repo/src/renamed.js"},
    {path:"/repo/gone.txt",kind:"delete",movePath:null},
  ]);
  assert.deepEqual(adapter.codexFileChanges({"/repo/a.md":{type:"add",content:"# A"},"/repo/b.md":{type:"update",unified_diff:"@@",move_path:"/repo/c.md"}}),[
    {path:"/repo/a.md",kind:"add",movePath:null},{path:"/repo/b.md",kind:"update",movePath:"/repo/c.md"},
  ]);
  assert.deepEqual(adapter.codexFileChanges(null),[]);
  // The card names a file from the workspace when it is inside it.
  assert.equal(adapter.workspaceFilePath("/repo","/repo/src/app.js"),"src/app.js");
  assert.equal(adapter.workspaceFilePath("/repo","/elsewhere/a.js"),"/elsewhere/a.js");
  assert.equal(adapter.workspaceFilePath("C:\\work\\repo","C:\\work\\repo\\src\\app.js"),"src\\app.js");
  assert.equal(adapter.workspaceFilePath(null,"/repo/a.js"),"/repo/a.js");
});

test("a file change approval is decided for each of its files: a path rule applies to them, and one file outside the workspace rejects it",()=>{
  const request={id:1,method:"item/fileChange/requestApproval",params:{threadId:"t",turnId:"u",itemId:"patch-1",startedAtMs:1}};
  const rules=[{runtime:"codex",kind:"edit",pathPrefix:"/repo/src/generated",effect:"deny",reason:"Generated files are rebuilt, not edited."}];
  // Codex's request names no file, so without its files no path rule could apply.
  assert.equal(adapter.codexApprovalPolicyDecision(request,{profile:"supervised",workspace:"/repo",rules}).decision,"CONFIRM");
  const denied=adapter.codexApprovalPolicyDecision(request,{profile:"supervised",workspace:"/repo",rules,files:[{path:"/repo/src/app.js",kind:"update"},{path:"/repo/src/generated/api.js",kind:"update"}]});
  assert.equal(denied.decision,"REJECT");assert.equal(denied.reason,"Generated files are rebuilt, not edited.");assert.equal(denied.action.requestedPath,"/repo/src/generated/api.js");
  const moved=adapter.resolveCodexApprovalByPolicy(request,{profile:"workspace-write",workspace:"/repo",files:[{path:"/repo/src/a.js",kind:"update",movePath:"/elsewhere/a.js"}]});
  assert.equal(moved.handled,true);assert.equal(moved.policy.decision,"REJECT","a move out of the workspace is outside it");assert.deepEqual(moved.result,{decision:"decline"});
  const inside=adapter.resolveCodexApprovalByPolicy(request,{profile:"workspace-write",workspace:"/repo",files:[{path:"/repo/src/a.js",kind:"update"},{path:"/repo/src/b.js",kind:"add"}]});
  assert.equal(inside.handled,true);assert.equal(inside.policy.decision,"ALLOW");
  assert.equal(adapter.codexApprovalPolicyDecision(request,{profile:"supervised",workspace:"/repo",files:[{path:"/repo/src/a.js",kind:"update"}]}).decision,"CONFIRM","supervised still asks");
});

test("a Codex file-change approval reaches the window with the files its item/started named, and a path rule applies to them",async()=>{
  const fixture=await startCodexGui("trebell-file-change-approvals-"),{upstream,home}=fixture,threadId="file-change-thread";
  try{
    await fixture.thread(threadId,{permissionProfile:"supervised"});
    await fetch(fixture.gui.url+"/api/settings",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({policyRules:[{runtime:"codex",kind:"edit",pathPrefix:join(home,"generated"),effect:"deny",reason:"Generated files are rebuilt, not edited."}]})});
    const window=await fixture.window();await window.request("initialize",{clientInfo:{name:"file-change-approvals"}});
    const asks=()=>window.requests("item/fileChange/requestApproval");
    const outside=join(home,"..","shared-notes.md");
    const changes=[
      {path:join(home,"src","app.js"),kind:{type:"update",move_path:null},diff:"@@ -1 +1 @@\n-a\n+b\n"},
      {path:join(home,"src","old.js"),kind:{type:"update",move_path:join(home,"src","renamed.js")},diff:""},
      {path:join(home,"notes.md"),kind:{type:"add"},diff:"+# Notes\n"},
    ];
    upstream.notify("item/started",{threadId,turnId:"turn-1",item:{type:"fileChange",id:"patch-1",status:"inProgress",changes}});
    await sleep(50);
    upstream.ask("item/fileChange/requestApproval",{threadId,turnId:"turn-1",itemId:"patch-1",startedAtMs:Date.now()});
    assert.ok(await until(()=>asks().length===1));
    // Named from the thread's workspace, as the person knows them.
    assert.deepEqual(asks()[0].params.trebellFileChanges,[
      {path:join("src","app.js"),kind:"update",movePath:null},
      {path:join("src","old.js"),kind:"update",movePath:join("src","renamed.js")},
      {path:"notes.md",kind:"add",movePath:null},
    ],"the card gets the files Codex's request leaves out");
    assert.equal(adapter.workspaceFilePath(home,outside),outside,"a file outside the workspace keeps its whole path");
    const decision=(await fixture.traces(threadId)).find(item=>item.name==="policy.decision"&&item.data?.method==="item/fileChange/requestApproval");
    assert.equal(decision?.data?.pathInsideWorkspace,true,"the policy saw a path");
    // A change that touches a file a rule denies is declined by the policy, and never reaches the window.
    upstream.notify("item/started",{threadId,turnId:"turn-1",item:{type:"fileChange",id:"patch-2",status:"inProgress",changes:[{path:join(home,"src","ok.js"),kind:{type:"update"},diff:""},{path:join(home,"generated","api.js"),kind:{type:"update"},diff:""}]}});
    await sleep(50);
    const denied=upstream.ask("item/fileChange/requestApproval",{threadId,turnId:"turn-1",itemId:"patch-2",startedAtMs:Date.now()});
    assert.ok(await until(()=>denied.answers().length===1));assert.deepEqual(denied.answers()[0].result,{decision:"decline"});
    assert.equal(asks().length,1);
    // An item that completed takes its files with it: a request for it names none.
    upstream.notify("item/completed",{threadId,turnId:"turn-1",item:{type:"fileChange",id:"patch-1",status:"completed",changes}});
    await sleep(50);
    upstream.ask("item/fileChange/requestApproval",{threadId,turnId:"turn-1",itemId:"patch-1",startedAtMs:Date.now()});
    assert.ok(await until(()=>asks().length===2));assert.equal(asks()[1].params.trebellFileChanges,undefined);
    // So does its turn's end.
    upstream.notify("item/started",{threadId,turnId:"turn-2",item:{type:"fileChange",id:"patch-3",status:"inProgress",changes}});
    upstream.notify("turn/completed",{threadId,turn:{id:"turn-2",status:"completed",items:[]}});
    await sleep(50);
    upstream.ask("item/fileChange/requestApproval",{threadId,turnId:"turn-2",itemId:"patch-3",startedAtMs:Date.now()});
    assert.ok(await until(()=>asks().length===3));assert.equal(asks()[2].params.trebellFileChanges,undefined);
    // A legacy patch approval names its files itself; the card gets them the same way.
    upstream.ask("applyPatchApproval",{conversationId:threadId,callId:"call-1",fileChanges:{[join(home,"README.md")]:{type:"update",unified_diff:"@@",move_path:null}}});
    assert.ok(await until(()=>window.requests("applyPatchApproval").length===1));
    assert.deepEqual(window.requests("applyPatchApproval")[0].params.trebellFileChanges,[{path:"README.md",kind:"update",movePath:null}]);
  }finally{await fixture.close()}
});
