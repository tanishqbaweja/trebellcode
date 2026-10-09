import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { approvalForeignThreadId, approvalToShow, liveRequests, ownedRequest, requestResolvedBy } from "../ui/src/approval-scope.js";

const root=join(dirname(fileURLToPath(import.meta.url)),"..");
const oldSocket={name:"antigravity socket"},newSocket={name:"cursor socket"};
// The agent relay numbers server requests per socket, so the next socket's first approval reuses the old one's id.
const staleApproval=ownedRequest({id:"agent-1",method:"item/tool/requestApproval",params:{threadId:"antigravity-thread",reason:"git log -n 5"}},oldSocket);
const freshApproval=ownedRequest({id:"agent-1",method:"item/tool/requestApproval",params:{threadId:"cursor-thread",reason:"npm test"}},newSocket);

test("an approval keeps the socket it arrived on",()=>{
  assert.equal(staleApproval.client,oldSocket);
  assert.equal(staleApproval.id,"agent-1");
  assert.equal(staleApproval.params.reason,"git log -n 5");
  assert.equal(ownedRequest({id:1},undefined).client,null);
});

test("once a newer socket is live, approvals from the old one leave the screen",()=>{
  const both=[staleApproval,freshApproval];
  assert.deepEqual(liveRequests(both,newSocket),[freshApproval]);
  assert.deepEqual(liveRequests(both,null),[],"a torn-down transport leaves no answerable request");
  const only=[freshApproval];
  assert.equal(liveRequests(only,newSocket),only,"an unchanged list keeps its identity (no needless render)");
  const questions=[{client:oldSocket,request:{id:"agent-2"}},{client:newSocket,request:{id:"agent-2"}}];
  assert.deepEqual(liveRequests(questions,newSocket),[questions[1]]);
});

test("a resolved notification only resolves the request of that id from the same socket",()=>{
  const resolved={requestId:"agent-1",threadId:null,client:newSocket};
  assert.equal(requestResolvedBy(freshApproval,freshApproval.client,resolved),true);
  assert.equal(requestResolvedBy(staleApproval,staleApproval.client,resolved),false,"same id, other socket");
  assert.equal(requestResolvedBy(freshApproval,freshApproval.client,{...resolved,threadId:"another-thread"}),false);
  assert.equal(requestResolvedBy(freshApproval,freshApproval.client,{...resolved,threadId:"cursor-thread"}),true);
  assert.equal(requestResolvedBy(freshApproval,freshApproval.client,{requestId:"agent-2",client:newSocket}),false);
  assert.equal(requestResolvedBy({id:5,params:{}},null,{requestId:"5"}),true,"a request without a known socket still resolves by id");
});

test("the conversation shows the open thread's approval first and names another thread's",()=>{
  const background=ownedRequest({id:"a",params:{threadId:"background"}},newSocket),mine=ownedRequest({id:"b",params:{threadId:"mine"}},newSocket),legacy=ownedRequest({id:"c",params:{}},newSocket);
  assert.equal(approvalToShow([background,mine,legacy],"mine"),mine);
  assert.equal(approvalToShow([background,legacy],"mine"),legacy,"a request without a thread belongs to the conversation");
  assert.equal(approvalToShow([background],"mine"),background,"another thread's request stays reachable");
  assert.equal(approvalToShow([],"mine"),null);
  assert.equal(approvalForeignThreadId(background,"mine"),"background");
  assert.equal(approvalForeignThreadId(mine,"mine"),null);
  assert.equal(approvalForeignThreadId(legacy,"mine"),null);
  assert.equal(approvalForeignThreadId(background,null),"background");
});

test("App answers an approval on its own socket and drops requests of a replaced socket",()=>{
  const app=readFileSync(join(root,"ui","src","App.jsx"),"utf8");
  assert.match(app,/setApprovals\(prev=>\[\.\.\.prev,ownedRequest\(message,client\)\]\)/,"approvals remember their socket");
  const resolve=app.slice(app.indexOf("function resolveApproval("),app.indexOf("function dropServerRequestsExcept("));
  assert.match(resolve,/const client=request\?\.client\|\|rpc;/);
  assert.doesNotMatch(resolve,/rpc\.respond\(/,"the current transport may be a newer socket that reuses the id");
  assert.match(app,/await current\.connect\(\);if\(disposed\)return;\s*\/\/[^\n]*\n\s*dropServerRequestsExcept\(current\);/,"a reconnect drops requests of the old socket");
  assert.match(app,/client\?\.close\(\);dropServerRequestsExcept\(null\)\}/,"tearing the transport down drops its requests");
  assert.match(app,/onNotification:message=>notificationHandlerRef\.current\?\.\(message,current\)/,"resolved notifications know their socket");
});
