import test from "node:test";
import assert from "node:assert/strict";
import {completedItemStatus,toolEventFailed} from "../ui/src/tool-event-status.js";

test("a completed item keeps a failed or declined outcome",()=>{
  // A Claude tool the read-only mode disabled ends with a failed tool_call_update; Codex reports a declined command as declined.
  assert.equal(completedItemStatus({type:"commandExecution",status:"failed"}),"failed");
  assert.equal(completedItemStatus({type:"fileChange",status:"declined"}),"declined");
  assert.equal(completedItemStatus({type:"dynamicToolCall",status:"failed",success:false}),"failed");
});

// A harness's call its stopped or failed turn cut off while still pending ends stopped (agent-relay.mjs finishTurn): it may have run, so
// its row says it stopped with its turn, not done, and it is no failure.
test("a completed item keeps the stopped end of a call its turn cut off, which is no failure",()=>{
  assert.equal(completedItemStatus({type:"fileChange",status:"stopped"}),"stopped");
  assert.equal(completedItemStatus({type:"commandExecution",status:"stopped"}),"stopped");
  assert.equal(toolEventFailed({kind:"fileChange",status:"stopped"}),false);
});

test("a completed item without a failed outcome is completed",()=>{
  assert.equal(completedItemStatus({type:"commandExecution",status:"completed"}),"completed");
  assert.equal(completedItemStatus({type:"mcpToolCall",status:"inProgress"}),"completed");
  assert.equal(completedItemStatus({type:"reasoning"}),"completed");
  assert.equal(completedItemStatus(null),"completed");
});

test("failed and declined tools share the error styling of error rows",()=>{
  assert.equal(toolEventFailed({kind:"commandExecution",status:"failed"}),true);
  assert.equal(toolEventFailed({kind:"fileChange",status:"declined"}),true);
  assert.equal(toolEventFailed({kind:"error",status:"done"}),true);
  assert.equal(toolEventFailed({kind:"autoReview",status:"error"}),true);
  assert.equal(toolEventFailed({kind:"commandExecution",status:"done"}),false);
  assert.equal(toolEventFailed({kind:"fileChange",status:"running"}),false);
  assert.equal(toolEventFailed(undefined),false);
  // A harness retrying its request (activity-item.js retryActivityRow) has not failed: the turn goes on.
  assert.equal(toolEventFailed({kind:"retry",status:"running"}),false);
  assert.equal(toolEventFailed({kind:"retry",status:"stopped"}),false);
});
