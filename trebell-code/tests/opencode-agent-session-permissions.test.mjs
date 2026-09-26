import test from "node:test";
import assert from "node:assert/strict";
import { OpenCodeAgentSession, openCodePermissionDisposition } from "../src/opencode-agent-session.mjs";

test("OpenCode permission events follow Trebell shared policy using provider permission types",()=>{
  assert.equal(openCodePermissionDisposition("full","bash"),"allow");
  assert.equal(openCodePermissionDisposition("auto","webfetch"),"allow");
  assert.equal(openCodePermissionDisposition("edits","edit"),"allow");
  assert.equal(openCodePermissionDisposition("edits","write"),"allow");
  assert.equal(openCodePermissionDisposition("edits","bash"),"ask");
  assert.equal(openCodePermissionDisposition("edits","webfetch"),"ask");
  assert.equal(openCodePermissionDisposition("edits","unknown-provider-permission"),"ask");
  assert.equal(openCodePermissionDisposition("supervised","edit"),"ask");
});

test("OpenCode read-only keeps its conservative deny-on-permission behavior",()=>{
  assert.equal(openCodePermissionDisposition("read-only","read"),"deny");
  assert.equal(openCodePermissionDisposition("read-only","edit"),"deny");
  assert.equal(openCodePermissionDisposition("read-only","bash"),"deny");
});

test("OpenCode fork rewind and compaction map to the real SDK session operations",async()=>{
  const calls=[];
  const session=new OpenCodeAgentSession({cwd:"/repo"});
  session.sessionId="session-1";session.model="provider-a/model-a";session.modelMap.set("provider-a/model-a",{providerID:"provider-a",modelID:"model-a"});
  session.client={session:{
    fork:async request=>{calls.push(["fork",request]);return {data:{id:"forked-session"}}},
    revert:async request=>{calls.push(["revert",request]);return {data:{ok:true}}},
    summarize:async request=>{calls.push(["summarize",request]);return {data:{ok:true}}},
  }};
  assert.deepEqual(await session.fork(),{id:"forked-session"});
  assert.deepEqual(await session.revert("user-message-2"),{ok:true});
  assert.deepEqual(await session.compact(),{ok:true});
  assert.deepEqual(calls,[
    ["fork",{path:{id:"session-1"},query:{directory:"/repo"},body:{}}],
    ["revert",{path:{id:"session-1"},query:{directory:"/repo"},body:{messageID:"user-message-2"}}],
    ["summarize",{path:{id:"session-1"},query:{directory:"/repo"},body:{providerID:"provider-a",modelID:"model-a"}}],
  ]);
});

test("OpenCode advertised controls surface SDK failures instead of pretending success",async()=>{
  const session=new OpenCodeAgentSession({cwd:"/repo"});session.sessionId="session-1";session.model="provider-a/model-a";session.modelMap.set("provider-a/model-a",{providerID:"provider-a",modelID:"model-a"});
  session.client={session:{fork:async()=>({error:{message:"fork unavailable"}}),revert:async()=>({error:{data:{message:"rewind rejected"}}}),summarize:async()=>({error:{message:"summary failed"}})}};
  await assert.rejects(()=>session.fork(),/fork unavailable/i);
  await assert.rejects(()=>session.revert("message-1"),/rewind rejected/i);
  await assert.rejects(()=>session.compact(),/summary failed/i);
  session.model="unknown";session.modelMap.clear();await assert.rejects(()=>session.compact(),/select a model/i);
});
