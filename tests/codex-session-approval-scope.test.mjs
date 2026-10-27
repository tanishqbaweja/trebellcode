// "Allow session" on a Codex command or file change allows every later one of that kind in the thread's session (codex-session-
// approvals.mjs), far more than Codex's own acceptForSession, which skips only that same command or patch. So the card the window
// gets says which kind its Allow session covers (trebellSessionScope: command or fileChange), and the window names the button for
// it; a request Allow session covers no more of (network access, extra permissions, no thread) says nothing. The server runs in mock
// mode with a fake Codex app-server (fixtures/codex-gui-fake.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { startCodexGui, until } from "./fixtures/codex-gui-fake.mjs";

test("a Codex approval card says which kind its Allow session covers for the rest of the thread's session",async()=>{
  const fixture=await startCodexGui("trebell-session-scope-"),{upstream}=fixture,threadId="scope-thread";
  try{
    await fixture.thread(threadId,{permissionProfile:"supervised"});
    const window=await fixture.window();await window.request("initialize",{clientInfo:{name:"session-scope"}});
    const asked=async(method,params)=>{const from=window.received.length;upstream.ask(method,{threadId,turnId:"turn-1",startedAtMs:Date.now(),...params});assert.ok(await until(()=>window.received.slice(from).some(item=>item.method===method&&item.id!=null)));return window.received.slice(from).find(item=>item.method===method&&item.id!=null).params};
    assert.equal((await asked("item/commandExecution/requestApproval",{itemId:"cmd-1",command:"npm test"})).trebellSessionScope,"command");
    assert.equal((await asked("item/fileChange/requestApproval",{itemId:"patch-1"})).trebellSessionScope,"fileChange");
    assert.equal((await asked("execCommandApproval",{conversationId:threadId,callId:"call-1",command:["npm","test"]})).trebellSessionScope,"command","Codex's legacy requests too");
    assert.equal((await asked("item/commandExecution/requestApproval",{itemId:"net-1",command:"curl https://example.com",networkApprovalContext:{host:"example.com",protocol:"https"}})).trebellSessionScope,undefined,"network access stays per request");
    assert.equal((await asked("item/commandExecution/requestApproval",{itemId:"wide-1",command:"npm ci",additionalPermissions:{network:{enabled:true}}})).trebellSessionScope,undefined,"so do extra permissions");
    assert.equal((await asked("item/permissions/requestApproval",{itemId:"perm-1",permissions:{network:{enabled:true}}})).trebellSessionScope,undefined);
  }finally{await fixture.close()}
});
