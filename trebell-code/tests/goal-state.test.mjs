import test from "node:test";
import assert from "node:assert/strict";
import { enrichGoal, goalBudgetGate, normalizeGoal } from "../src/goal-state.mjs";

test("durable goals normalize bounded structured fields and status transitions",()=>{
  const goal=normalizeGoal({threadId:"thread-1",now:1000,patch:{objective:" Ship reliable auth ",status:"active",completionConditions:["Tests pass","Login works"],constraints:"No schema change\nKeep compatibility",validationExpectations:["Run auth tests"],tokenBudget:12000,timeBudgetMinutes:90,turnBudget:8,costBudgetUsd:12.5,unexpected:"ignored"}});
  assert.equal(goal.threadId,"thread-1");assert.equal(goal.objective,"Ship reliable auth");assert.equal(goal.status,"active");assert.equal(goal.createdAt,1000);assert.equal(goal.updatedAt,1000);
  assert.deepEqual(goal.constraints,["No schema change","Keep compatibility"]);assert.equal(goal.tokenBudget,12000);assert.equal(goal.timeBudgetMinutes,90);assert.equal(goal.turnBudget,8);assert.equal(goal.costBudgetUsd,12.5);assert.equal(Object.prototype.hasOwnProperty.call(goal,"unexpected"),false);
  const complete=normalizeGoal({threadId:"thread-1",previous:goal,now:2000,patch:{status:"complete"}});
  assert.equal(complete.completedAt,2000);assert.equal(complete.objective,goal.objective);
});

test("goal metrics reconstruct token and agent-work time from persisted evidence",()=>{
  const goal={threadId:"thread-1",objective:"Finish",status:"active",createdAt:10_000,tokenBudget:1000,timeBudgetMinutes:2,turnBudget:2,costBudgetUsd:2};
  const enriched=enrichGoal(goal,{usage:{totalTokens:1200,costUsd:2.5,costKnown:2,records:2},now:25_000,turns:[
    {startedAt:5,durationMs:99_000,status:"completed"},
    {startedAt:11,durationMs:30_000,status:"completed"},
    {startedAt:20,durationMs:null,status:"inProgress"},
  ]});
  assert.equal(enriched.tokensUsed,1200);assert.equal(enriched.timeUsedSeconds,35);assert.equal(enriched.tokenBudgetRemaining,0);assert.equal(enriched.budgetExceeded,true);
  assert.equal(enriched.turnsUsed,2);assert.equal(enriched.turnBudgetRemaining,0);assert.equal(enriched.costUsedUsd,2.5);assert.equal(enriched.costTelemetryComplete,true);assert.equal(enriched.costBudgetRemainingUsd,0);assert.equal(enriched.budgetExhausted,true);
});

test("goal budgets reject invalid values instead of silently inventing state",()=>{
  assert.throws(()=>normalizeGoal({threadId:"t",patch:{objective:"x",tokenBudget:-1}}),/positive whole number/i);
  assert.throws(()=>normalizeGoal({threadId:"t",patch:{objective:"x",costBudgetUsd:0}}),/positive number/i);
  assert.throws(()=>normalizeGoal({threadId:"t",patch:{objective:""}}),/objective is required/i);
});

test("goal budget gate blocks only new work after an active budget is exhausted",()=>{
  assert.equal(goalBudgetGate(null).allowed,true);
  assert.equal(goalBudgetGate({status:"paused",tokenBudget:100,tokensUsed:100}).allowed,true);
  assert.equal(goalBudgetGate({status:"active",tokenBudget:100,tokensUsed:99}).allowed,true);
  const exact=goalBudgetGate({status:"active",tokenBudget:100,tokensUsed:100,timeBudgetMinutes:10,timeUsedSeconds:30});
  assert.equal(exact.allowed,false);assert.equal(exact.tokenExhausted,true);assert.equal(exact.timeExhausted,false);assert.match(exact.reason,/token budget exhausted/i);
  const timed=goalBudgetGate({status:"active",timeBudgetMinutes:2,timeUsedSeconds:120});
  assert.equal(timed.allowed,false);assert.equal(timed.timeExhausted,true);assert.match(timed.reason,/time budget exhausted/i);
  const turned=goalBudgetGate({status:"active",turnBudget:3,turnsUsed:3});
  assert.equal(turned.allowed,false);assert.equal(turned.turnExhausted,true);assert.match(turned.reason,/turn budget exhausted/i);
  const costed=goalBudgetGate({status:"active",costBudgetUsd:1.5,costUsedUsd:1.5,costTelemetryComplete:true});
  assert.equal(costed.allowed,false);assert.equal(costed.costExhausted,true);assert.match(costed.reason,/cost budget exhausted/i);
  const unknownCost=goalBudgetGate({status:"active",costBudgetUsd:1,costUsedUsd:5,costTelemetryComplete:false});
  assert.equal(unknownCost.allowed,true);assert.equal(unknownCost.costExhausted,false);
});
