// "Allow session" covers the thread's later commands, not what goes beyond running a command: a command approval that also asks
// for extra filesystem or network permission for that one command (additionalPermissions, Codex 0.162's schema) asks every time, as
// network access does. Input a command sends to a process it started (kind writeStdin) is part of running it, and is covered. The
// server runs in mock mode with a fake Codex app-server (fixtures/codex-gui-fake.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { sessionApprovalKind } from "../src/codex-session-approvals.mjs";
import { startCodexGui, until } from "./fixtures/codex-gui-fake.mjs";

const SUPERVISED={approvalPolicy:"on-request",sandboxPolicy:{type:"workspaceWrite",writableRoots:[],networkAccess:true}};
const EXTRA={fileSystem:{entries:null,globScanMaxDepth:null,read:null,write:["/etc/hosts"]},network:{enabled:true}};
const command=(threadId,itemId,extra={})=>["item/commandExecution/requestApproval",{threadId,turnId:"turn-1",itemId,command:"npm run "+itemId,startedAtMs:Date.now(),...extra}];

test("a command approval that asks for extra permissions is not a kind Allow session covers; input to a running command is",()=>{
  assert.equal(sessionApprovalKind("item/commandExecution/requestApproval",{command:"npm test",additionalPermissions:EXTRA}),null);
  assert.equal(sessionApprovalKind("item/commandExecution/requestApproval",{command:"npm test",additionalPermissions:null}),"command");
  assert.equal(sessionApprovalKind("item/commandExecution/requestApproval",{command:"y",kind:"writeStdin"}),"command");
});

test("after Allow session, a command that asks for extra permissions still reaches the window, each time",async()=>{
  const fixture=await startCodexGui("trebell-session-escalations-"),{upstream}=fixture,threadId="escalation-thread";
  try{
    await fixture.thread(threadId,{permissionProfile:"supervised"});
    const window=await fixture.window();await window.request("initialize",{clientInfo:{name:"session-escalations"}});
    await window.request("turn/start",{threadId,input:[],...SUPERVISED});
    const asks=()=>window.requests("item/commandExecution/requestApproval");
    const first=upstream.ask(...command(threadId,"cmd-1"));
    assert.ok(await until(()=>asks().length===1));window.answer(asks()[0],{decision:"acceptForSession"});
    assert.ok(await until(()=>first.answers().length===1));
    const next=upstream.ask(...command(threadId,"cmd-2"));
    assert.ok(await until(()=>next.answers().length===1),"Allow session covers the next command");
    upstream.ask(...command(threadId,"cmd-wider",{additionalPermissions:EXTRA}));
    assert.ok(await until(()=>asks().length===2,5000),"the command asking for more permission reaches the window");
    assert.equal(asks()[1].params.itemId,"cmd-wider");
    const typed=upstream.ask(...command(threadId,"cmd-input",{kind:"writeStdin"}));
    assert.ok(await until(()=>typed.answers().length===1),"input to a running command is covered");
    assert.deepEqual(typed.answers()[0].result,{decision:"acceptForSession"});
  }finally{await fixture.close()}
});
