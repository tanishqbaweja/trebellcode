import test from "node:test";
import assert from "node:assert/strict";
import { delegationContextValue, delegationGoalPatch, delegationPolicies, normalizeDelegationRequest } from "../src/delegation-state.mjs";

test("delegation spec normalizes permissions, isolation, ownership, context and child budgets",()=>{
  const spec=normalizeDelegationRequest({task:" Fix auth race ",permission:"read-only",isolation:"shared",ownership:["src/auth.js"],model:"m1",context:{text:"Focus on refresh flow"},budget:{tokenBudget:5000,timeBudgetMinutes:30,turnBudget:4,toolCallBudget:10,childAgentBudget:1,costBudgetUsd:2.5}});
  assert.equal(spec.task,"Fix auth race");assert.equal(spec.permission,"read-only");assert.equal(spec.permissions,"read-only");assert.equal(spec.isolation,"inherit");assert.equal(spec.requestedIsolation,"shared");assert.deepEqual(spec.ownership,["src/auth.js"]);assert.equal(spec.context,"Focus on refresh flow");
  assert.deepEqual(spec.budget,{tokenBudget:5000,timeBudgetMinutes:30,turnBudget:4,toolCallBudget:10,childAgentBudget:1,costBudgetUsd:2.5});
  const defaults=normalizeDelegationRequest({task:"x"});assert.equal(defaults.permission,"inherit");assert.equal(defaults.permissions,"supervised");assert.equal(defaults.isolation,"worktree");
});

test("delegation permissions map to real approval and sandbox semantics",()=>{
  assert.deepEqual(delegationPolicies("read-only","/repo"),{approvalPolicy:"on-request",sandbox:"read-only",sandboxPolicy:{type:"readOnly",networkAccess:false}});
  assert.equal(delegationPolicies("full","/repo").sandboxPolicy.type,"dangerFullAccess");
  assert.deepEqual(delegationPolicies("workspace-write","/repo").sandboxPolicy.writableRoots,["/repo"]);
});

test("delegated child goal and context preserve bounded task ownership",()=>{
  const spec=normalizeDelegationRequest({task:"Implement parser",permissions:"workspace-write",isolation:"worktree",ownership:["src/parser.js"],context:"Only touch parser files",budget:{turnBudget:3}});
  const goal=delegationGoalPatch(spec);assert.equal(goal.objective,"Implement parser");assert.equal(goal.turnBudget,3);assert.match(goal.constraints.join("\n"),/workspace-write/);
  const context=delegationContextValue({parentThreadId:"parent-1",spec});assert.match(context,/Parent thread: parent-1/);assert.match(context,/src\/parser\.js/);assert.match(context,/Only touch parser files/);assert.match(context,/Do not broaden scope silently/);
});

test("delegation rejects empty tasks and invalid budgets",()=>{
  assert.throws(()=>normalizeDelegationRequest({task:""}),/task is required/i);
  assert.throws(()=>normalizeDelegationRequest({task:"x",budget:{turnBudget:0}}),/positive whole numbers/i);
});
