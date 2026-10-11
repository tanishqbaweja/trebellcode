import test from "node:test";
import assert from "node:assert/strict";
import { assistantRowDecorations, cardFailedTurnIds, formatTurnDuration, mergeTurnOutcomes, permissionModeLabel, turnEndRows, turnFailureText, turnInfoKey, turnOutcomePill, turnOutcomeStatus, turnOutcomesFromTurns } from "../ui/src/turn-outcome.js";

const user=(id,turnId)=>({id,role:"user",text:"Message "+id,turnId}),reply=(id,turnId)=>({id,role:"assistant",text:"Reply "+id,turnId}),thought=(id,turnId)=>({id,role:"reasoning",text:"Thought "+id,turnId});

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

test("a turn's error reads as the activity card worded it, and a turn that recorded none has no message",()=>{
  assert.equal(turnFailureText({status:"failed",error:{message:"Grok usage limit reached. Try again later."}}),"Grok usage limit reached. Try again later.");
  assert.equal(turnFailureText({status:"failed",error:{message:"You've hit your usage limit.",codexErrorInfo:"usageLimitExceeded"}}),"You've hit your usage limit. · See Usage for your Codex limits.");
  assert.equal(turnFailureText({status:"failed",error:{message:"stream disconnected",additionalDetails:"Connection reset by peer"}}),"Connection reset by peer");
  assert.equal(turnFailureText({status:"failed",error:"  Claude Code could not authenticate.  "}),"Claude Code could not authenticate.");
  for(const error of [null,undefined,{},{message:""},{message:"   "},{codexErrorInfo:"unauthorized"},42])assert.equal(turnFailureText({status:"failed",error}),"",JSON.stringify(error));
  assert.equal(turnFailureText(null),"");
});

test("history pages carry a turn's error, and an item-paged thread takes only the failed and stopped turns from them",()=>{
  const turns=[
    {id:"t1",status:"completed",durationMs:3000},
    {id:"t2",status:"failed",durationMs:2100,error:{message:"Usage limit reached."}},
    {id:"t3",status:"interrupted",durationMs:null,error:null},
  ];
  assert.deepEqual(turnOutcomesFromTurns(turns),{t1:{status:"completed",durationMs:3000},t2:{status:"failed",durationMs:2100,error:"Usage limit reached."},t3:{status:"interrupted",durationMs:null}});
  const keys=value=>Object.keys(value).sort();
  assert.deepEqual(keys(mergeTurnOutcomes({},"th",turns)),[turnInfoKey("th","t1"),turnInfoKey("th","t2"),turnInfoKey("th","t3")].sort());
  assert.deepEqual(keys(mergeTurnOutcomes({},"th",turns,{failuresOnly:true})),[turnInfoKey("th","t2"),turnInfoKey("th","t3")].sort());
  // The error this window was sent is kept over the page's; a page adds one where none was known.
  const key=turnInfoKey("th","t2");
  assert.equal(mergeTurnOutcomes({[key]:{mode:"Supervised",status:"failed",durationMs:2140,error:"Sent live."}},"th",turns,{failuresOnly:true})[key].error,"Sent live.");
  assert.deepEqual(mergeTurnOutcomes({[key]:{mode:"Supervised",status:"failed",durationMs:2140}},"th",turns,{failuresOnly:true})[key],{mode:"Supervised",status:"failed",durationMs:2140,error:"Usage limit reached."});
  // A page that adds nothing returns the same object, so nothing re-renders.
  const settled=mergeTurnOutcomes({},"th",turns);assert.equal(mergeTurnOutcomes(settled,"th",turns),settled);
});

test("a turn that failed or was stopped before any reply ends with a row of its own after its last row",()=>{
  const turnInfo={
    [turnInfoKey("th","t1")]:{mode:"Supervised",status:"failed",durationMs:2100,error:"Usage limit reached."},
    [turnInfoKey("th","t2")]:{status:"completed",durationMs:900},
    [turnInfoKey("th","t3")]:{status:"interrupted",durationMs:null},
    [turnInfoKey("th","t4")]:{status:"failed",durationMs:500,error:"Lost the connection."},
    [turnInfoKey("th","t5")]:{status:"completed",durationMs:null},
  };
  const messages=[user("u1","t1"),thought("r1","t1"),user("u2","t2"),reply("a2","t2"),user("u3","t3"),user("u4","t4"),reply("a4","t4"),user("u5","t5"),user("u6",null)];
  const rows=turnEndRows(messages,{harnessLabel:"Grok Build",turnInfo,threadId:"th"});
  // A reply carries its own pill (t4); a completed turn has nothing to add (t2, t5); an unfinished one has no outcome yet.
  assert.deepEqual([...rows.keys()],["r1","u3"]);
  assert.deepEqual(rows.get("r1"),{turnId:"t1",heading:"Grok Build · Supervised",outcomeLabel:"failed · 2.1s",outcomeTone:"err",message:"Usage limit reached.",latest:false});
  // A stop recorded no error: the pill alone.
  assert.deepEqual(rows.get("u3"),{turnId:"t3",heading:"Grok Build",outcomeLabel:"stopped",outcomeTone:"warn",message:"",latest:false});
  assert.equal(turnEndRows(messages,{harnessLabel:"",turnInfo,threadId:"th"}).get("r1").heading,"");
  assert.equal(turnEndRows(messages,{harnessLabel:"Grok Build",turnInfo,threadId:"other"}).size,0);
  assert.equal(turnEndRows(messages,{harnessLabel:"Grok Build",turnInfo:null,threadId:"th"}).size,0);
});

test("the card's own turn's outcome row reads below the card, an earlier turn's stays above it, and a failure the card lists is not repeated",()=>{
  const turnInfo={[turnInfoKey("th","t1")]:{status:"failed",error:"Boom."},[turnInfoKey("th","t2")]:{status:"interrupted"}};
  const messages=[user("u1","t1"),user("u2","t2")];
  const latest=options=>Object.fromEntries([...turnEndRows(messages,{turnInfo,threadId:"th",...options})].map(([id,row])=>[id,row.latest]));
  // After a reload no card holds a turn: the latest turn's row moves with the rows after its message.
  assert.deepEqual(latest({}),{u1:false,u2:true});
  assert.deepEqual(latest({cardTurnId:"t2"}),{u1:false,u2:true});
  // A goal continuing has the card: the turn before it keeps its row above the card. A virtualized list keeps its order.
  assert.deepEqual(latest({cardTurnId:"t3"}),{u1:false,u2:false});
  assert.deepEqual(latest({reorder:false}),{u1:false,u2:false});
  // While the card lists a turn's failure, that turn has no row: the failure shows once.
  assert.deepEqual([...turnEndRows(messages,{turnInfo,threadId:"th",cardFailedTurnIds:new Set(["t1"])}).keys()],["u2"]);
  // A goal-continued turn has no message of its own: its row follows its thought, and moves with it below the card.
  const goal=[user("u1","t1"),reply("a1","t1"),thought("r2","t2")];
  const goalRows=turnEndRows(goal,{turnInfo:{[turnInfoKey("th","t2")]:{status:"failed",error:"Usage limit reached."}},threadId:"th",cardTurnId:"t2"});
  assert.deepEqual([...goalRows.keys()],["r2"]);assert.equal(goalRows.get("r2").latest,true);
});

test("the turns whose failure the card lists are the ones it shows an error row for",()=>{
  const events=[
    {id:"codex-error-t1",kind:"error",title:"You've hit your usage limit. · See Usage for your Codex limits.",status:"done",raw:{message:"You've hit your usage limit."}},
    {id:"error-1700000000000",kind:"error",title:"Grok usage limit reached.",status:"done",raw:{threadId:"th",turnId:"t2",message:"Grok usage limit reached."}},
    {id:"codex-retry-t3",kind:"error",title:"Retrying (1/5): stream disconnected",status:"done",raw:{threadId:"th",turnId:"t3"}},
    {id:"queue-refresh-error-1",kind:"error",title:"Could not refresh queued follow-ups: offline",status:"done",raw:{}},
    {id:"cmd-1",kind:"commandExecution",title:"npm test",status:"done",raw:{turnId:"t4"}},
  ];
  assert.deepEqual(cardFailedTurnIds(events),["t1","t2"]);
  assert.deepEqual(cardFailedTurnIds([]),[]);assert.deepEqual(cardFailedTurnIds(null),[]);
});
