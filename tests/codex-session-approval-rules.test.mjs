// "Allow session" on a Codex approval answers the thread's later commands or file changes for the person (codex-session-approvals.mjs),
// but never one the person's own policy rule says to ask about: a rule with effect "ask" asks every time, as it did before Allow
// session covered the thread's session. A change that touches any file such a rule names asks too, whatever its other files are.
// The server runs in mock mode with a fake Codex app-server (fixtures/codex-gui-fake.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { codexApprovalPolicyDecision } from "../src/codex-policy-adapter.mjs";
import { startCodexGui, until } from "./fixtures/codex-gui-fake.mjs";

const SUPERVISED={approvalPolicy:"on-request",sandboxPolicy:{type:"workspaceWrite",writableRoots:[],networkAccess:true}};
const command=(threadId,itemId,text)=>["item/commandExecution/requestApproval",{threadId,turnId:"turn-1",itemId,command:text,startedAtMs:Date.now()}];

test("a file change touching a file an ask rule names is decided by that rule, wherever the file comes in the change",()=>{
  const request={id:1,method:"item/fileChange/requestApproval",params:{threadId:"t",turnId:"u",itemId:"patch-1",startedAtMs:1}};
  const rules=[{runtime:"codex",kind:"edit",pathPrefix:"/repo/secrets",effect:"ask",reason:"Secrets are reviewed by hand."}];
  const decided=codexApprovalPolicyDecision(request,{profile:"supervised",workspace:"/repo",rules,files:[{path:"/repo/src/app.js",kind:"update"},{path:"/repo/secrets/token.txt",kind:"update"}]});
  assert.equal(decided.decision,"CONFIRM");assert.equal(decided.reason,"Secrets are reviewed by hand.");assert.equal(decided.rule,rules[0],"the rule's own decision, not the profile's for the first file");
});

test("after Allow session, a command or file change the person's ask rule names still reaches the window, each time",async()=>{
  const fixture=await startCodexGui("trebell-session-rules-"),{upstream,home}=fixture,threadId="ruled-thread";
  try{
    await fixture.thread(threadId,{permissionProfile:"supervised"});
    const rules=[{runtime:"codex",actionPrefix:"git push",effect:"ask",reason:"Pushes are confirmed."},{runtime:"codex",kind:"edit",pathPrefix:join(home,"secrets"),effect:"ask",reason:"Secrets are reviewed by hand."}];
    await fetch(fixture.gui.url+"/api/settings",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({policyRules:rules})});
    const window=await fixture.window();await window.request("initialize",{clientInfo:{name:"session-rules"}});
    await window.request("turn/start",{threadId,input:[],...SUPERVISED});
    const asks=()=>window.requests("item/commandExecution/requestApproval");
    // Allow session on an ordinary command; the next ordinary command is answered for the person.
    const first=upstream.ask(...command(threadId,"cmd-1","npm test"));
    assert.ok(await until(()=>asks().length===1));window.answer(asks()[0],{decision:"acceptForSession"});
    assert.ok(await until(()=>first.answers().length===1));
    const lint=upstream.ask(...command(threadId,"cmd-2","npm run lint"));
    assert.ok(await until(()=>lint.answers().length===1),"Allow session covers the thread's next command");
    // A push, which the rule asks about, reaches the window, every time.
    upstream.ask(...command(threadId,"cmd-3","git push origin main"));
    assert.ok(await until(()=>asks().length===2,5000),"the ruled command asks after Allow session");
    assert.equal(asks()[1].params.itemId,"cmd-3");
    window.answer(asks()[1],{decision:"acceptForSession"});
    upstream.ask(...command(threadId,"cmd-4","git push --tags"));
    assert.ok(await until(()=>asks().length===3,5000),"and again after its own Allow session");
    // File changes: Allow session on one, then a change with a file the rule names asks again.
    const fileAsks=()=>window.requests("item/fileChange/requestApproval");
    const started=(id,changes)=>{const from=window.notifications("item/started").length;upstream.notify("item/started",{threadId,turnId:"turn-1",item:{type:"fileChange",id,status:"inProgress",changes}});return until(()=>window.notifications("item/started").length>from)};
    assert.ok(await started("patch-1",[{path:join(home,"src","app.js"),kind:{type:"update"},diff:""}]));
    const patch=upstream.ask("item/fileChange/requestApproval",{threadId,turnId:"turn-1",itemId:"patch-1",startedAtMs:Date.now()});
    assert.ok(await until(()=>fileAsks().length===1));
    window.answer(fileAsks()[0],{decision:"acceptForSession"});assert.ok(await until(()=>patch.answers().length===1));
    assert.ok(await started("patch-2",[{path:join(home,"src","util.js"),kind:{type:"update"},diff:""}]));
    const covered=upstream.ask("item/fileChange/requestApproval",{threadId,turnId:"turn-1",itemId:"patch-2",startedAtMs:Date.now()});
    assert.ok(await until(()=>covered.answers().length===1),"Allow session covers the next file change");
    assert.ok(await started("patch-3",[{path:join(home,"src","config.js"),kind:{type:"update"},diff:""},{path:join(home,"secrets","token.txt"),kind:{type:"update"},diff:""}]));
    upstream.ask("item/fileChange/requestApproval",{threadId,turnId:"turn-1",itemId:"patch-3",startedAtMs:Date.now()});
    assert.ok(await until(()=>fileAsks().length===2,5000),"a change touching a ruled file asks");
    assert.equal(fileAsks()[1].params.itemId,"patch-3");
  }finally{await fixture.close()}
});
