import test from "node:test";
import assert from "node:assert/strict";
import { OpenCodeAgentSession, configureOpenCodeMcpServers, openCodePermissionDisposition } from "../src/opencode-agent-session.mjs";

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

test("OpenCode repository MCP setup uses the SDK MCP endpoint and reports setup failures honestly",async()=>{
  const calls=[],client={mcp:{add:async request=>{
    calls.push(request);
    if(request.body.name==="broken")return {error:{message:"MCP launch failed"}};
    return {data:{[request.body.name]:{status:"connected"}}};
  }}};
  const local={type:"local",command:["node","repo.mjs"],environment:{TREBELL_REPOSITORY_ROOT:"/repo"},enabled:true,timeout:15_000};
  const results=await configureOpenCodeMcpServers(client,{cwd:"/repo",servers:[{name:"trebell_repository",config:local},{name:"broken",config:local}]});
  assert.deepEqual(calls,[
    {query:{directory:"/repo"},body:{name:"trebell_repository",config:local}},
    {query:{directory:"/repo"},body:{name:"broken",config:local}},
  ]);
  assert.deepEqual(results[0],{name:"trebell_repository",configured:true,status:{status:"connected"}});
  assert.equal(results[1].configured,false);assert.match(results[1].error,/MCP launch failed/);
});
