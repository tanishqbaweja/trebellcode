import test from "node:test";
import assert from "node:assert/strict";
import { assistantRowDecorations, formatTurnDuration, mergeTurnOutcomes, permissionModeLabel, turnInfoKey, turnOutcomePill, turnOutcomeStatus, turnOutcomesFromTurns } from "../ui/src/turn-outcome.js";

test("turn durations read like the conversation pill",()=>{
  assert.equal(formatTurnDuration(3240),"3.2s");
  assert.equal(formatTurnDuration(40),"0.1s");
  assert.equal(formatTurnDuration(42_400),"42s");
  assert.equal(formatTurnDuration(252_000),"4m 12s");
  assert.equal(formatTurnDuration(120_000),"2m");
  assert.equal(formatTurnDuration(3_780_000),"1h 3m");
  for(const missing of [0,-5,null,undefined,"",Number.NaN])assert.equal(formatTurnDuration(missing),"");
});

test("only finished turns have an outcome, and imported zero durations are not measurements",()=>{
  assert.equal(turnOutcomeStatus("completed"),"completed");
  assert.equal(turnOutcomeStatus({type:"interrupted"}),"interrupted");
  assert.equal(turnOutcomeStatus("failed"),"failed");
  assert.equal(turnOutcomeStatus("inProgress"),"");
  assert.deepEqual(turnOutcomesFromTurns([
    {id:"t1",status:"completed",durationMs:3000},
    {id:"t2",status:"completed",durationMs:0},
    {id:"t3",status:"inProgress",durationMs:null},
    {id:"t4",status:"interrupted"},
    {status:"completed",durationMs:10},
  ]),{t1:{status:"completed",durationMs:3000},t2:{status:"completed",durationMs:null},t4:{status:"interrupted",durationMs:null}});
});

test("the outcome pill says done only with a measured time, and always names a stop or failure",()=>{
  assert.deepEqual(turnOutcomePill({status:"completed",durationMs:2100}),{label:"done · 2.1s",tone:"ok"});
  assert.equal(turnOutcomePill({status:"completed",durationMs:null}),null);
  assert.equal(turnOutcomePill({mode:"Supervised"}),null);
  assert.deepEqual(turnOutcomePill({status:"interrupted",durationMs:61_000}),{label:"stopped · 1m 1s",tone:"warn"});
  assert.deepEqual(turnOutcomePill({status:"failed"}),{label:"failed",tone:"err"});
});

test("history pages add outcomes without replacing what this window measured or recorded",()=>{
  const key=turnInfoKey("thread-1","t1");
  const current={[key]:{mode:"Full access",status:"completed",durationMs:3412}};
  const same=mergeTurnOutcomes(current,"thread-1",[{id:"t1",status:"completed",durationMs:3000}]);
  assert.equal(same,current);
  const next=mergeTurnOutcomes(current,"thread-1",[{id:"t2",status:"completed",durationMs:5000},{id:"t3",status:"inProgress"}]);
  assert.notEqual(next,current);
  assert.deepEqual(next[key],{mode:"Full access",status:"completed",durationMs:3412});
  assert.deepEqual(next[turnInfoKey("thread-1","t2")],{status:"completed",durationMs:5000});
  assert.equal(next[turnInfoKey("thread-1","t3")],undefined);
  const modeOnly={[key]:{mode:"Supervised"}};
  assert.deepEqual(mergeTurnOutcomes(modeOnly,"thread-1",[{id:"t1",status:"completed",durationMs:3000}])[key],{mode:"Supervised",status:"completed",durationMs:3000});
  assert.notEqual(turnInfoKey("thread-1","t1"),turnInfoKey("thread-2","t1"));
  assert.equal(turnInfoKey(null,"t1"),"");
});

test("a turn's first reply carries the harness heading and its last reply carries the outcome",()=>{
  const turnInfo={[turnInfoKey("th","t1")]:{mode:permissionModeLabel("full"),status:"completed",durationMs:2500},[turnInfoKey("th","t2")]:{status:"interrupted",durationMs:null}};
  const messages=[
    {id:"u1",role:"user",text:"Fix it",turnId:"t1"},
    {id:"a1",role:"assistant",text:"Looking",turnId:"t1"},
    {id:"r1",role:"reasoning",text:"Reading the test",turnId:"t1"},
    {id:"a2",role:"assistant",text:"Fixed",turnId:"t1"},
    {id:"u2",role:"user",text:"Again",turnId:"t2"},
    {id:"a3",role:"assistant",text:"Stopping",turnId:"t2"},
    {id:"u3",role:"user",text:"Running now",turnId:"t3"},
    {id:"a4",role:"assistant",text:"Working",turnId:"t3"},
  ];
  const rows=assistantRowDecorations(messages,{harnessLabel:"Codex",turnInfo,threadId:"th"});
  assert.deepEqual(rows.get("a1"),{heading:"Codex · Full access",outcomeLabel:"",outcomeTone:""});
  assert.deepEqual(rows.get("a2"),{heading:"",outcomeLabel:"done · 2.5s",outcomeTone:"ok"});
  assert.deepEqual(rows.get("a3"),{heading:"Codex",outcomeLabel:"stopped",outcomeTone:"warn"});
  assert.deepEqual(rows.get("a4"),{heading:"Codex",outcomeLabel:"",outcomeTone:""});
  assert.equal(rows.has("u1"),false);assert.equal(rows.has("r1"),false);
  assert.equal(assistantRowDecorations(messages,{harnessLabel:"",turnInfo:null,threadId:"th"}).size,0);
  assert.equal(permissionModeLabel("unknown"),"");
});
