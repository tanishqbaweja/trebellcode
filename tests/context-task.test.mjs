import test from "node:test";
import assert from "node:assert/strict";
import { contextTaskAnchor, contextTaskText } from "../ui/src/context-task.js";

test("generic continuation turns inherit the previous context task",()=>{
  assert.equal(contextTaskText("Continue","Fix the refresh token session bug"),"Previous task: Fix the refresh token session bug\nCurrent follow-up: Continue");
  assert.match(contextTaskText("continue with the tests","Refactor queue persistence"),/Refactor queue persistence/);
  assert.match(contextTaskText("Continue even if repository context refresh fails","Fix the refresh token session bug"),/Fix the refresh token session bug/);
  assert.match(contextTaskText("fix that","Repair runtime profile switching"),/Repair runtime profile switching/);
});

test("specific new tasks do not inherit stale context",()=>{
  assert.equal(contextTaskText("Fix auth","Refactor queue persistence"),"Fix auth");
  assert.equal(contextTaskText("Redesign the settings page","Fix auth"),"Redesign the settings page");
});

test("continuation memory stays anchored to the last specific task instead of nesting forever",()=>{
  const anchor=contextTaskAnchor("Continue","Fix the refresh token session bug");
  assert.equal(anchor,"Fix the refresh token session bug");
  assert.equal(contextTaskAnchor("continue with the tests",anchor),anchor);
  assert.equal(contextTaskAnchor("Refactor the queue",anchor),"Refactor the queue");
  assert.equal(contextTaskText("Continue again",anchor),"Previous task: Fix the refresh token session bug\nCurrent follow-up: Continue again");
});
