import test from "node:test";
import assert from "node:assert/strict";
import { enrichGoal, normalizeGoal } from "../src/goal-state.mjs";

test("durable goals normalize bounded structured fields and status transitions",()=>{
  const goal=normalizeGoal({threadId:"thread-1",now:1000,patch:{objective:" Ship reliable auth ",status:"active",completionConditions:["Tests pass","Login works"],constraints:"No schema change\nKeep compatibility",validationExpectations:["Run auth tests"],tokenBudget:12000,timeBudgetMinutes:90,unexpected:"ignored"}});
  assert.equal(goal.threadId,"thread-1");assert.equal(goal.objective,"Ship reliable auth");assert.equal(goal.status,"active");assert.equal(goal.createdAt,1000);assert.equal(goal.updatedAt,1000);
  assert.deepEqual(goal.constraints,["No schema change","Keep compatibility"]);assert.equal(goal.tokenBudget,12000);assert.equal(goal.timeBudgetMinutes,90);assert.equal(Object.prototype.hasOwnProperty.call(goal,"unexpected"),false);
  const complete=normalizeGoal({threadId:"thread-1",previous:goal,now:2000,patch:{status:"complete"}});
  assert.equal(complete.completedAt,2000);assert.equal(complete.objective,goal.objective);
});

test("goal metrics reconstruct token and agent-work time from persisted evidence",()=>{
  const goal={threadId:"thread-1",objective:"Finish",status:"active",createdAt:10_000,tokenBudget:1000,timeBudgetMinutes:2};
  const enriched=enrichGoal(goal,{usage:{totalTokens:1200},now:25_000,turns:[
    {startedAt:5,durationMs:99_000,status:"completed"},
    {startedAt:11,durationMs:30_000,status:"completed"},
    {startedAt:20,durationMs:null,status:"inProgress"},
  ]});
  assert.equal(enriched.tokensUsed,1200);assert.equal(enriched.timeUsedSeconds,35);assert.equal(enriched.tokenBudgetRemaining,0);assert.equal(enriched.budgetExceeded,true);
});

test("goal budgets reject invalid values instead of silently inventing state",()=>{
  assert.throws(()=>normalizeGoal({threadId:"t",patch:{objective:"x",tokenBudget:-1}}),/positive whole number/i);
  assert.throws(()=>normalizeGoal({threadId:"t",patch:{objective:""}}),/objective is required/i);
});
