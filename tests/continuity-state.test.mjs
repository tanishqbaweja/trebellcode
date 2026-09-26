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
    goal:{threadId:"thread-1",status:"active",objective:"Preserve the public API while fixing the parser."},
    thread:{id:"thread-1",runtime:"claude",cwd:"/repo",turns:[{id:"turn-1",status:"completed"},{id:"turn-2",status:"failed"}]},
    meta:{branch:"feature/x",continuityNotes:{completedWork:["Implemented parser"],unresolvedFailures:["Known flaky test"],importantDecisions:["Keep public API"],artifactsCreated:[],pendingNextActions:["Run smoke test"],updatedAt:1000},queuedSubmissions:[{input:[{type:"text",text:"Publish the package"}]}]},
    verificationRecords:[{status:"failed",risk:"high",assessment:{verified:false,summary:"Browser flow still fails"},updatedAt:2000}],
    checkpoints:[{label:"before fix",commit:"abc123",root:"/repo",createdAt:1500}],
    traces:[{status:"error",name:"error",data:{message:"Provider disconnected"},at:2500}],
  });
  assert.equal(snapshot.workspace.branch,"feature/x");assert.equal(snapshot.verification.status,"failed");assert.deepEqual(snapshot.completedTurnIds,["turn-1"]);
  assert.deepEqual(snapshot.unresolvedFailures,["Known flaky test"]);assert.ok(snapshot.recentFailures.includes("Provider disconnected"));
  assert.ok(snapshot.artifactsCreated.some(item=>item.includes("before fix")));assert.ok(snapshot.pendingNextActions.includes("Publish the package"));assert.equal(snapshot.meaningful,true);
  const value=continuityContextValue(snapshot);assert.match(value,/Persistent Trebell continuity state/);assert.match(value,/Active goal: Preserve the public API while fixing the parser/);assert.match(value,/Browser flow still fails/);assert.match(value,/Keep public API/);
  assert.match(value,/Recent failure evidence/);assert.match(value,/Provider disconnected/);
  const merged=continuityAdditionalContext({"trebell.goal":{kind:"application",value:"goal"}},snapshot);assert.equal(merged["trebell.goal"].value,"goal");assert.match(merged["trebell.continuity"].value,/Implemented parser/);
});

test("continuity preserves an explicit active goal without inventing one when absent",()=>{
  const snapshot=continuitySnapshot({
    threadId:"thread-goal",
    thread:{id:"thread-goal",cwd:"/repo",turns:[]},
    goal:{status:"active",objective:"Keep the parser API stable while fixing incremental invalidation."},
  });
  assert.equal(snapshot.objective,"Keep the parser API stable while fixing incremental invalidation.");
  assert.match(continuityContextValue(snapshot),/Active goal: Keep the parser API stable while fixing incremental invalidation/);
});

test("derived-only continuity does not invent an explicit-note update timestamp",()=>{
  const snapshot=continuitySnapshot({threadId:"thread-1",thread:{id:"thread-1",turns:[{id:"done",status:"completed"}]},meta:{}});
  assert.equal(snapshot.notes.updatedAt,0);assert.equal(snapshot.meaningful,true);assert.deepEqual(snapshot.completedTurnIds,["done"]);
});

test("continuity formats structured verification summaries and preserves missing or failed evidence for the same-agent loop",()=>{
  const snapshot=continuitySnapshot({
    threadId:"thread-verify",
    verificationRecords:[{
      status:"incomplete",risk:"medium",updatedAt:3000,
      assessment:{verified:false,summary:{required:4,passed:1,failed:1,blocked:0,missing:2},missing:[{id:"visual",reason:"No screenshot yet."},{id:"browser_runtime",reason:"Console not checked."}],failures:[{id:"tests",reason:"Command exited with code 1."}]},
    }],
  });
  assert.equal(snapshot.verification.summary,"1/4 required checks passed · 1 failed · 2 missing");
  assert.deepEqual(snapshot.verification.missing,["visual · No screenshot yet.","browser_runtime · Console not checked."]);
  assert.deepEqual(snapshot.verification.failures,["tests · Command exited with code 1."]);
  const value=continuityContextValue(snapshot);
  assert.doesNotMatch(value,/\[object Object\]/);assert.match(value,/Verification still required/);assert.match(value,/visual · No screenshot yet/);assert.match(value,/Verification failures/);assert.match(value,/tests · Command exited with code 1/);
});

test("continuity preserves blocked restart recovery and uncertain tool state",()=>{
  const snapshot=continuitySnapshot({
    threadId:"thread-recovery",
    thread:{id:"thread-recovery",cwd:"/repo",runtime:"native",turns:[{id:"turn-1",status:"interrupted"}],recovery:{pending:false,blocked:true,turnId:"turn-1",reason:"uncertain_tool_action",message:"A tool may already have completed.",uncertainTools:[{id:"tool-1",namespace:"trebell_browser",tool:"click",status:"inProgress"}] }},
    meta:{},
  });
  assert.equal(snapshot.recovery.blocked,true);assert.deepEqual(snapshot.recovery.uncertainTools,["trebell_browser/click · inProgress"]);assert.ok(snapshot.unresolvedFailures.includes("A tool may already have completed."));assert.ok(snapshot.pendingNextActions.some(item=>/Inspect the uncertain restart-time tool/i.test(item)));
  const value=continuityContextValue(snapshot);assert.match(value,/Restart recovery: blocked/i);assert.match(value,/trebell_browser\/click · inProgress/);assert.match(value,/before repeating any side effect/i);
});
