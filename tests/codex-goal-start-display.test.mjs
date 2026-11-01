// A Codex goal's first turn sends Codex the objective behind an instruction to begin (codex-goal-start.mjs), so the model starts
// the work instead of repeating the objective back. The person never typed that instruction: their message, its checkpoint and the
// thread's title keep the objective, live and once Codex's own record of the message (its history, the thread's preview) is read
// back after a reload. Threads begun by earlier releases hold another instruction, whose words Trebell no longer keeps: what
// Trebell recorded the person typing (the turn's checkpoint label, the thread's goal) says where it ends. The window's side is
// turn-support.js and thread-history.js; the thread list goes through the GUI server's Codex relay, here in mock mode with a fake
// Codex app-server (fixtures/codex-gui-fake.mjs).
import test from "node:test";
import assert from "node:assert/strict";
import { runSlashCommand } from "../ui/src/turn-support.js";
import { historyFromItemEntries, historyFromTurns } from "../ui/src/thread-history.js";
import { CODEX_GOAL_LEAD_IN, codexGoalFirstMessage, codexMessageAsTyped } from "../src/codex-goal-start.mjs";
import { startCodexGui, until } from "./fixtures/codex-gui-fake.mjs";

const OBJECTIVE="Ship the release notes";
// A stand-in for an instruction an earlier release put in front of an objective: Trebell's own made-up words, of that shape (one
// short line ending in a colon and a space).
const EARLIER="An instruction an earlier release sent: ";
// The turn's checkpoint as the window has it: Trebell labels it with the first 80 characters of what the person typed.
const checkpointFor=typed=>({"turn-1":{id:"cp-1",label:typed.slice(0,80)}});
const userItem=text=>({type:"userMessage",id:"user-1",clientId:null,content:[{type:"text",text,text_elements:[]}]});
const shownInHistory=(text,checkpoints={})=>[
  historyFromTurns([{id:"turn-1",items:[userItem(text)]}],checkpoints).map(message=>message.text),
  historyFromItemEntries([{turnId:"turn-1",item:userItem(text)}],checkpoints).map(message=>message.text),
];

test("a goal's first message to Codex is an instruction to begin, then the objective",()=>{
  assert.equal(CODEX_GOAL_LEAD_IN,"Begin work on the goal: ");
  assert.equal(codexGoalFirstMessage(OBJECTIVE),"Begin work on the goal: Ship the release notes");
});

test("a new Codex goal's first turn sends Codex the instruction, while the message and its checkpoint keep the objective",async()=>{
  const sent=[];
  const deps={agentRuntime:"codex",agentRuntimeLabel:"Codex",currentProject:null,projectPath:null,models:["gpt-test"],model:"gpt-test",attachments:[],contextChips:[],runtimeCapabilities:{},running:false,
    rpc:{request:async()=>({}),subscribeNotifications:()=>()=>{}},activeThread:{id:"goal-thread"},activeThreadRef:{current:{id:"goal-thread"}},
    async startTurn(text,paths,model,thread,cwd,focus,options={}){sent.push({text,inputText:options.inputText??null,objective:options.goalPatch?.objective??null})},
    setGoal:()=>{},openRightPanel:()=>{},setComposerAlert:()=>{},setEvents:()=>{}};
  assert.equal(await runSlashCommand(deps,"/goal "+OBJECTIVE),true);
  assert.deepEqual(sent,[{text:OBJECTIVE,inputText:codexGoalFirstMessage(OBJECTIVE),objective:OBJECTIVE}],"the message and the goal are the objective; only Codex gets the instruction");
});

test("Codex's record of a goal's first message reads back as the objective in the thread's history",()=>{
  // Sent now: the instruction is Trebell's own, so it comes off with or without a checkpoint.
  assert.deepEqual(shownInHistory(codexGoalFirstMessage(OBJECTIVE)),[[OBJECTIVE],[OBJECTIVE]]);
  assert.deepEqual(shownInHistory(codexGoalFirstMessage(OBJECTIVE),checkpointFor(OBJECTIVE)),[[OBJECTIVE],[OBJECTIVE]]);
  // Sent by an earlier release: the checkpoint's label says where the objective starts.
  assert.deepEqual(shownInHistory(EARLIER+OBJECTIVE,checkpointFor(OBJECTIVE)),[[OBJECTIVE],[OBJECTIVE]]);
  // A long objective's label is only its start, which is enough; the whole objective shows.
  const long="Ship the release notes for every platform, with the changelog, the screenshots and the store listings updated";
  assert.deepEqual(shownInHistory(EARLIER+long,checkpointFor(long)),[[long],[long]]);
  // A turn outside Git has no checkpoint: the thread's goal, when the window has it, says where the objective starts.
  const withGoal=(text,goal)=>[
    historyFromTurns([{id:"turn-1",items:[userItem(text)]}],{},goal).map(message=>message.text),
    historyFromItemEntries([{turnId:"turn-1",item:userItem(text)}],{},goal).map(message=>message.text),
  ];
  assert.deepEqual(withGoal(EARLIER+OBJECTIVE,OBJECTIVE),[[OBJECTIVE],[OBJECTIVE]]);
  assert.deepEqual(withGoal(EARLIER+OBJECTIVE,"Tidy the changelog"),[[EARLIER+OBJECTIVE],[EARLIER+OBJECTIVE]],"another goal says nothing of it");
  // With nothing recorded (no checkpoint, the goal since cleared), the message shows as Codex keeps it.
  assert.deepEqual(shownInHistory(EARLIER+OBJECTIVE),[[EARLIER+OBJECTIVE],[EARLIER+OBJECTIVE]]);
  // A message the person typed with a colon in it shows whole: its label is the message itself.
  assert.deepEqual(shownInHistory("Note: "+OBJECTIVE,checkpointFor("Note: "+OBJECTIVE)),[["Note: "+OBJECTIVE],["Note: "+OBJECTIVE]]);
});

test("only Trebell's present instruction at the very start of a message, with an objective after it, comes off, and only once",()=>{
  const lead=CODEX_GOAL_LEAD_IN;
  assert.equal(codexMessageAsTyped(lead+OBJECTIVE),OBJECTIVE);
  assert.equal(codexMessageAsTyped(lead),lead,"the instruction alone is a message of its own");
  assert.equal(codexMessageAsTyped(lead.trim()),lead.trim());
  assert.equal(codexMessageAsTyped(lead+"  "),lead+"  ","spaces after it are no objective");
  assert.equal(codexMessageAsTyped(lead+lead+OBJECTIVE),lead+OBJECTIVE,"an objective that begins with the same words keeps them");
  assert.equal(codexMessageAsTyped(lead.toUpperCase()+OBJECTIVE),lead.toUpperCase()+OBJECTIVE,"other letter case is the person's own text");
  assert.equal(codexMessageAsTyped("Note: "+lead+OBJECTIVE),"Note: "+lead+OBJECTIVE,"words further in stay");
  assert.equal(codexMessageAsTyped("Begin work on the parser"),"Begin work on the parser");
  assert.equal(codexMessageAsTyped(null),"");assert.equal(codexMessageAsTyped(undefined),"");assert.equal(codexMessageAsTyped(42),"42");
});

test("an earlier instruction comes off only before what the person typed, as one short line ending in a colon and a space",()=>{
  assert.equal(codexMessageAsTyped(EARLIER+OBJECTIVE,OBJECTIVE),OBJECTIVE);
  assert.equal(codexMessageAsTyped(EARLIER+OBJECTIVE,[null,7,"  ",OBJECTIVE]),OBJECTIVE,"what is not a text with words in it is passed over");
  assert.equal(codexMessageAsTyped(EARLIER+OBJECTIVE,()=>[OBJECTIVE]),OBJECTIVE,"a function gives the texts");
  assert.equal(codexMessageAsTyped(EARLIER+OBJECTIVE+"\n\nand the rest",OBJECTIVE),OBJECTIVE+"\n\nand the rest","the message goes on after the typed text's start");
  assert.equal(codexMessageAsTyped(EARLIER+OBJECTIVE),EARLIER+OBJECTIVE,"nothing recorded, nothing comes off");
  assert.equal(codexMessageAsTyped(EARLIER+OBJECTIVE,"Tidy the changelog"),EARLIER+OBJECTIVE,"another text recorded");
  assert.equal(codexMessageAsTyped(EARLIER+OBJECTIVE,[EARLIER+OBJECTIVE,OBJECTIVE]),EARLIER+OBJECTIVE,"a message that starts with what was typed is as typed");
  // The earliest place that works: an objective with a colon of its own keeps it.
  assert.equal(codexMessageAsTyped(EARLIER+"Docs: "+OBJECTIVE,"Docs: "+OBJECTIVE),"Docs: "+OBJECTIVE);
  assert.equal(codexMessageAsTyped("Fix it: "+OBJECTIVE,OBJECTIVE),OBJECTIVE);
  // Not an instruction's shape: no colon and space before it, a line break in it, or longer than 64 characters.
  assert.equal(codexMessageAsTyped("Before "+OBJECTIVE,OBJECTIVE),"Before "+OBJECTIVE);
  assert.equal(codexMessageAsTyped("Context\nmore: "+OBJECTIVE,OBJECTIVE),"Context\nmore: "+OBJECTIVE);
  const sixtyFour="x".repeat(62)+": ",sixtyFive="x".repeat(63)+": ";
  assert.equal(codexMessageAsTyped(sixtyFour+OBJECTIVE,OBJECTIVE),OBJECTIVE);
  assert.equal(codexMessageAsTyped(sixtyFive+OBJECTIVE,OBJECTIVE),sixtyFive+OBJECTIVE);
  // A function is asked only when the message could hold an instruction.
  let asked=0;const count=()=>{asked++;return OBJECTIVE};
  codexMessageAsTyped("No instruction here",count);codexMessageAsTyped(codexGoalFirstMessage(OBJECTIVE),count);
  assert.equal(asked,0);
  codexMessageAsTyped(EARLIER+OBJECTIVE,count);assert.equal(asked,1);
});

test("threads Codex goals began, now or by an earlier release, are listed by their objective as the relay reads Codex's previews",async()=>{
  const fixture=await startCodexGui("trebell-goal-start-display-"),{upstream}=fixture;
  try{
    const goalThread={id:"goal-thread",preview:codexGoalFirstMessage(OBJECTIVE),name:null};
    const olderThread={id:"older-goal-thread",preview:EARLIER+"Tidy the changelog",name:null},other={id:"other-thread",preview:"Fix the login test",name:null};
    // An earlier release's goal thread whose goal Trebell no longer has keeps its preview as Codex keeps it.
    const clearedThread={id:"cleared-goal-thread",preview:EARLIER+"Write the guide",name:null};
    const window=await fixture.window();await window.request("initialize",{clientInfo:{name:"goal-start-display"}});
    await window.request("thread/goal/set",{threadId:"older-goal-thread",objective:"Tidy the changelog"});
    upstream.answerWith("thread/list",{data:[goalThread,olderThread,other,clearedThread],nextCursor:null});
    const listed=await window.request("thread/list",{limit:20});
    assert.deepEqual(listed.data.map(thread=>thread.preview),[OBJECTIVE,"Tidy the changelog","Fix the login test",EARLIER+"Write the guide"],"the sidebar lists each goal's thread by its objective");
    upstream.answerWith("thread/read",{thread:{...goalThread,turns:[]}});
    assert.equal((await window.request("thread/read",{threadId:"goal-thread"})).thread.preview,OBJECTIVE);
    upstream.answerWith("thread/read",{thread:{...olderThread,turns:[]}});
    assert.equal((await window.request("thread/read",{threadId:"older-goal-thread"})).thread.preview,"Tidy the changelog");
    upstream.notify("thread/started",{thread:goalThread});
    assert.ok(await until(()=>window.notifications("thread/started").length===1));
    assert.equal(window.notifications("thread/started")[0].params.thread.preview,OBJECTIVE);
  }finally{await fixture.close()}
});
