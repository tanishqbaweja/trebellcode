import test from "node:test";
import assert from "node:assert/strict";
import { continuityAdditionalContext, continuityContextValue, continuitySnapshot, normalizeContinuityNotes } from "../src/continuity-state.mjs";

test("continuity notes normalize bounded explicit state",()=>{
  const notes=normalizeContinuityNotes(null,{completedWork:"Built auth\nAdded tests",importantDecisions:["Keep JWT compatibility"],unknown:"ignored"},1000);
  assert.deepEqual(notes.completedWork,["Built auth","Added tests"]);assert.deepEqual(notes.importantDecisions,["Keep JWT compatibility"]);assert.equal(notes.updatedAt,1000);assert.equal(Object.prototype.hasOwnProperty.call(notes,"unknown"),false);
});

test("continuity snapshot merges explicit notes with factual verification, queue, checkpoints, and failures",()=>{
  const snapshot=continuitySnapshot({
    threadId:"thread-1",
    thread:{id:"thread-1",runtime:"claude",cwd:"/repo",turns:[{id:"turn-1",status:"completed"},{id:"turn-2",status:"failed"}]},
    meta:{branch:"feature/x",continuityNotes:{completedWork:["Implemented parser"],unresolvedFailures:["Known flaky test"],importantDecisions:["Keep public API"],artifactsCreated:[],pendingNextActions:["Run smoke test"],updatedAt:1000},queuedSubmissions:[{input:[{type:"text",text:"Publish the package"}]}]},
    verificationRecords:[{status:"failed",risk:"high",assessment:{verified:false,summary:"Browser flow still fails"},updatedAt:2000}],
    checkpoints:[{label:"before fix",commit:"abc123",root:"/repo",createdAt:1500}],
    traces:[{status:"error",name:"error",data:{message:"Provider disconnected"},at:2500}],
  });
  assert.equal(snapshot.workspace.branch,"feature/x");assert.equal(snapshot.verification.status,"failed");assert.deepEqual(snapshot.completedTurnIds,["turn-1"]);
  assert.deepEqual(snapshot.unresolvedFailures,["Known flaky test"]);assert.ok(snapshot.recentFailures.includes("Provider disconnected"));
  assert.ok(snapshot.artifactsCreated.some(item=>item.includes("before fix")));assert.ok(snapshot.pendingNextActions.includes("Publish the package"));assert.equal(snapshot.meaningful,true);
  const value=continuityContextValue(snapshot);assert.match(value,/Persistent Trebell continuity state/);assert.match(value,/Browser flow still fails/);assert.match(value,/Keep public API/);
  assert.match(value,/Recent failure evidence/);assert.match(value,/Provider disconnected/);
  const merged=continuityAdditionalContext({"trebell.goal":{kind:"application",value:"goal"}},snapshot);assert.equal(merged["trebell.goal"].value,"goal");assert.match(merged["trebell.continuity"].value,/Implemented parser/);
});

test("derived-only continuity does not invent an explicit-note update timestamp",()=>{
  const snapshot=continuitySnapshot({threadId:"thread-1",thread:{id:"thread-1",turns:[{id:"done",status:"completed"}]},meta:{}});
  assert.equal(snapshot.notes.updatedAt,0);assert.equal(snapshot.meaningful,true);assert.deepEqual(snapshot.completedTurnIds,["done"]);
});
