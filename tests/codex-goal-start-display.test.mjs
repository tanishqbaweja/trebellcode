// A Codex goal's first turn sends Codex "Start working toward this goal: <objective>" (codex-goal-start.mjs), so the model works
// toward the objective rather than echoing it back. The person never typed those words:
// their message, its checkpoint and the thread's title keep the objective, live and once Codex's own record of the message (its
// history, the thread's preview) is read back after a reload. The window's side is turn-support.js and thread-history.js; the
// thread list goes through the GUI server's Codex relay, here in mock mode with a fake Codex app-server (fixtures/codex-gui-fake.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { runSlashCommand } from "../ui/src/turn-support.js";
import { historyFromItemEntries, historyFromTurns } from "../ui/src/thread-history.js";
import { CODEX_GOAL_START, withoutCodexGoalStart } from "../src/codex-goal-start.mjs";
import { startCodexGui, until } from "./fixtures/codex-gui-fake.mjs";

const OBJECTIVE="Ship the release notes";

test("a new Codex goal's first turn sends Codex the goal start, while the message and its checkpoint keep the objective",async()=>{
  const sent=[];
  const deps={agentRuntime:"codex",agentRuntimeLabel:"Codex",currentProject:null,projectPath:null,models:["gpt-test"],model:"gpt-test",attachments:[],contextChips:[],runtimeCapabilities:{},running:false,
    rpc:{request:async()=>({}),subscribeNotifications:()=>()=>{}},activeThread:{id:"goal-thread"},activeThreadRef:{current:{id:"goal-thread"}},
    async startTurn(text,paths,model,thread,cwd,focus,options={}){sent.push({text,inputText:options.inputText??null})},
    setGoal:()=>{},openRightPanel:()=>{},setComposerAlert:()=>{},setEvents:()=>{}};
  assert.equal(await runSlashCommand(deps,"/goal "+OBJECTIVE),true);
  assert.deepEqual(sent,[{text:OBJECTIVE,inputText:CODEX_GOAL_START+OBJECTIVE}],"the message is the objective; Codex gets the goal start before it");
});

test("Codex's record of a goal's first message reads back as the objective in the thread's history",()=>{
  const item={type:"userMessage",id:"user-1",content:[{type:"text",text:CODEX_GOAL_START+OBJECTIVE}]};
  assert.deepEqual(historyFromTurns([{id:"turn-1",items:[item]}]).map(message=>message.text),[OBJECTIVE]);
  assert.deepEqual(historyFromItemEntries([{turnId:"turn-1",item}]).map(message=>message.text),[OBJECTIVE]);
  assert.equal(withoutCodexGoalStart(CODEX_GOAL_START.trim()),CODEX_GOAL_START.trim(),"the words alone are a message of their own");
  assert.equal(withoutCodexGoalStart("Start working on the parser"),"Start working on the parser");
});

test("a thread a Codex goal began is listed by its objective, as Codex's preview of it is read through the relay",async()=>{
  const fixture=await startCodexGui("trebell-goal-start-display-"),{upstream}=fixture;
  try{
    const goalThread={id:"goal-thread",preview:CODEX_GOAL_START+OBJECTIVE,name:null},other={id:"other-thread",preview:"Fix the login test",name:null};
    upstream.answerWith("thread/list",{data:[goalThread,other],nextCursor:null});
    upstream.answerWith("thread/read",{thread:{...goalThread,turns:[]}});
    const window=await fixture.window();await window.request("initialize",{clientInfo:{name:"goal-start-display"}});
    const listed=await window.request("thread/list",{limit:20});
    assert.deepEqual(listed.data.map(thread=>thread.preview),[OBJECTIVE,"Fix the login test"],"the sidebar lists the thread by its objective");
    assert.equal((await window.request("thread/read",{threadId:"goal-thread"})).thread.preview,OBJECTIVE);
    upstream.notify("thread/started",{thread:goalThread});
    assert.ok(await until(()=>window.notifications("thread/started").length===1));
    assert.equal(window.notifications("thread/started")[0].params.thread.preview,OBJECTIVE);
  }finally{await fixture.close()}
});
