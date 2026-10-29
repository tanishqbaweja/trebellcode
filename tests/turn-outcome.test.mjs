import test from "node:test";
import assert from "node:assert/strict";
import { appendTurnOrder, assistantRowDecorations, cardFailedTurnIds, formatTurnDuration, mergeTurnOutcomes, permissionModeLabel, prependTurnOrder, recordTurnCompletion, turnEndRows, turnFailureText, turnIdsOldestFirst, turnInfoKey, turnOutcomePill, turnOutcomeStatus, turnOutcomesFromTurns, turnStartedAgain, turnTrailers } from "../ui/src/turn-outcome.js";

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

test("the outcome pill says done, with the time when one was measured, and always names a stop or failure",()=>{
  assert.deepEqual(turnOutcomePill({status:"completed",durationMs:2100}),{label:"done · 2.1s",tone:"ok"});
  assert.deepEqual(turnOutcomePill({status:"completed",durationMs:null}),{label:"done",tone:"ok"});
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

// A failed turn whose harness wrote part of a reply first (a Claude Code turn that got past a usage limit, a Cursor line before its
// lost-connection dump) has no row of its own to say why it failed: its last reply says it under the pill, as that row would, a stop
// too. While the live card lists the failure, the card says it, once.
test("the last reply of a turn that failed or was stopped says the error the turn ended with, unless the live card lists that failure",()=>{
  const turnInfo={
    [turnInfoKey("th","t1")]:{status:"failed",durationMs:1200,error:"Claude gave up after repeated API errors."},
    [turnInfoKey("th","t2")]:{status:"interrupted",error:"Stopped while the tests ran."},[turnInfoKey("th","t3")]:{status:"completed",durationMs:900},
    [turnInfoKey("th","t4")]:{status:"failed"},
  };
  const messages=[user("u1","t1"),reply("a1","t1"),thought("r1","t1"),reply("a2","t1"),user("u2","t2"),reply("a3","t2"),user("u3","t3"),reply("a4","t3"),user("u4","t4"),reply("a5","t4")];
  const rows=assistantRowDecorations(messages,{harnessLabel:"Claude Code",turnInfo,threadId:"th"});
  assert.deepEqual(rows.get("a1"),{heading:"Claude Code",outcomeLabel:"",outcomeTone:""});
  assert.deepEqual(rows.get("a2"),{heading:"",outcomeLabel:"failed · 1.2s",outcomeTone:"err",outcomeMessage:"Claude gave up after repeated API errors."});
  assert.deepEqual(rows.get("a3"),{heading:"Claude Code",outcomeLabel:"stopped",outcomeTone:"warn",outcomeMessage:"Stopped while the tests ran."});
  assert.deepEqual(rows.get("a4"),{heading:"Claude Code",outcomeLabel:"done · 0.9s",outcomeTone:"ok"});
  assert.deepEqual(rows.get("a5"),{heading:"Claude Code",outcomeLabel:"failed",outcomeTone:"err"},"an error nobody sent is not made up");
  const live=assistantRowDecorations(messages,{harnessLabel:"Claude Code",turnInfo,threadId:"th",cardFailedTurnIds:new Set(["t1","t2"])});
  assert.deepEqual(live.get("a2"),{heading:"",outcomeLabel:"failed · 1.2s",outcomeTone:"err"},"the card says it");
  assert.equal(live.get("a3").outcomeMessage,"Stopped while the tests ran.","the card never says a stop");
});

test("a turn's error reads as the activity card worded it, and a turn that recorded none has no message",()=>{
  assert.equal(turnFailureText({status:"failed",error:{message:"Grok usage limit reached. Try again later."}}),"Grok usage limit reached. Try again later.");
  assert.equal(turnFailureText({status:"failed",error:{message:"You've hit your usage limit.",codexErrorInfo:"usageLimitExceeded"}}),"You've hit your usage limit. · See Usage for your Codex limits.");
  assert.equal(turnFailureText({status:"failed",error:{message:"stream disconnected",additionalDetails:"Connection reset by peer"}}),"Connection reset by peer");
  assert.equal(turnFailureText({status:"failed",error:"  Claude Code could not authenticate.  "}),"Claude Code could not authenticate.");
  for(const error of [null,undefined,{},{message:""},{message:"   "},{message:"",codexErrorInfo:"badRequest"},{codexErrorInfo:{responseStreamDisconnected:{httpStatusCode:null}}},42])assert.equal(turnFailureText({status:"failed",error}),"",JSON.stringify(error));
  assert.equal(turnFailureText(null),"");
});

test("a Codex error with a code and no text reads as the card worded it when the code carries a hint",()=>{
  // The card shows "Agent error · <hint>" for these: the row says the same once the card moves on, and after a reload.
  assert.equal(turnFailureText({status:"failed",error:{message:"",codexErrorInfo:"unauthorized",additionalDetails:null}}),"Agent error · Sign in to Codex again from Agents & models, or run codex login.");
  assert.equal(turnFailureText({status:"failed",error:{codexErrorInfo:"usageLimitExceeded"}}),"Agent error · See Usage for your Codex limits.");
  assert.deepEqual(turnOutcomesFromTurns([{id:"t1",status:"failed",durationMs:2100,error:{message:"",codexErrorInfo:"unauthorized"}}]).t1.error,"Agent error · Sign in to Codex again from Agents & models, or run codex login.");
});

test("history pages carry a turn's error, and every page keeps its completed turns too",()=>{
  const turns=[
    {id:"t1",status:"completed",durationMs:3000},
    {id:"t2",status:"failed",durationMs:2100,error:{message:"Usage limit reached."}},
    {id:"t3",status:"interrupted",durationMs:null,error:null},
  ];
  assert.deepEqual(turnOutcomesFromTurns(turns),{t1:{status:"completed",durationMs:3000},t2:{status:"failed",durationMs:2100,error:"Usage limit reached."},t3:{status:"interrupted",durationMs:null}});
  const keys=value=>Object.keys(value).sort();
  assert.deepEqual(keys(mergeTurnOutcomes({},"th",turns)),[turnInfoKey("th","t1"),turnInfoKey("th","t2"),turnInfoKey("th","t3")].sort());
  // The error this window was sent is kept over the page's; a page adds one where none was known.
  const key=turnInfoKey("th","t2");
  assert.equal(mergeTurnOutcomes({[key]:{mode:"Supervised",status:"failed",durationMs:2140,error:"Sent live."}},"th",turns)[key].error,"Sent live.");
  assert.deepEqual(mergeTurnOutcomes({[key]:{mode:"Supervised",status:"failed",durationMs:2140}},"th",turns)[key],{mode:"Supervised",status:"failed",durationMs:2140,error:"Usage limit reached."});
  // A page that adds nothing returns the same object, so nothing re-renders.
  const settled=mergeTurnOutcomes({},"th",turns);assert.equal(mergeTurnOutcomes(settled,"th",turns),settled);
});

test("a page holding a later completion of a turn replaces what this window recorded of an earlier one, error and all",()=>{
  const key=turnInfoKey("th","t1"),note="Trebell restarted while this turn was running. Recovery is queued.",real="Could not continue after restart: provider refused the session.";
  const recorded={[key]:{mode:"Supervised",status:"interrupted",durationMs:800,completedAt:1000,error:note}};
  // The relay ran the turn again after a restart and it failed: the page says so, with a later completion time.
  const rerun=mergeTurnOutcomes(recorded,"th",[{id:"t1",status:"failed",durationMs:3000,completedAt:1012,error:{message:real}}]);
  assert.deepEqual(rerun[key],{mode:"Supervised",status:"failed",durationMs:3000,completedAt:1012,error:real});
  // A later completion with no error drops the old one.
  assert.deepEqual(mergeTurnOutcomes(recorded,"th",[{id:"t1",status:"completed",durationMs:3000,completedAt:1012}])[key],{mode:"Supervised",status:"completed",durationMs:3000,completedAt:1012});
  // The same completion (or an older one, read before the turn ran again) leaves the window's record as it is.
  for(const completedAt of [1000,990])assert.equal(mergeTurnOutcomes(recorded,"th",[{id:"t1",status:"failed",durationMs:3000,completedAt,error:{message:real}}]),recorded);
  // A completed turn this window holds no outcome for is added, so its reply has its done pill after a reload.
  assert.deepEqual(mergeTurnOutcomes({},"th",[{id:"t2",status:"completed",durationMs:3000,completedAt:1012}]),{[turnInfoKey("th","t2")]:{status:"completed",durationMs:3000,completedAt:1012}});
});

test("a completion records its own error, a replay keeps the first, and a turn that starts again is not ended any more",()=>{
  const note="Trebell restarted while this turn was running. Recovery is queued.",real="Could not continue after restart: provider refused the session.";
  const first=recordTurnCompletion({mode:"Supervised"},{status:"interrupted",durationMs:800,completedAt:1000,error:note});
  assert.deepEqual(first,{mode:"Supervised",status:"interrupted",durationMs:800,completedAt:1000,error:note});
  // A replay (same status) keeps the time measured first, and the error when it sends none.
  assert.deepEqual(recordTurnCompletion(first,{status:"interrupted",durationMs:2100,completedAt:1000,error:""}),first);
  // The relay's restart recovery: turn/started for the same turn clears its outcome, so the new completion is recorded whole.
  const restarted=turnStartedAgain(first);
  assert.deepEqual(restarted,{mode:"Supervised"});
  assert.deepEqual(recordTurnCompletion(restarted,{status:"failed",durationMs:3000,completedAt:1012,error:real}),{mode:"Supervised",status:"failed",durationMs:3000,completedAt:1012,error:real});
  // Missed turn/started: a completion that changes the status still replaces the old error, time and all.
  assert.deepEqual(recordTurnCompletion(first,{status:"failed",durationMs:3000,completedAt:1012,error:real}),{mode:"Supervised",status:"failed",durationMs:3000,completedAt:1012,error:real});
  assert.deepEqual(recordTurnCompletion(first,{status:"failed",durationMs:3000,completedAt:1012,error:""}),{mode:"Supervised",status:"failed",durationMs:3000,completedAt:1012});
  // A turn that had no outcome yet (its first start) is left as it is.
  const sent={mode:"Supervised"};assert.equal(turnStartedAgain(sent),sent);assert.equal(turnStartedAgain(undefined),undefined);
});

test("a turn that failed, was stopped or completed before any reply ends with a row of its own after its last row",()=>{
  const turnInfo={
    [turnInfoKey("th","t1")]:{mode:"Supervised",status:"failed",durationMs:2100,error:"Usage limit reached."},
    [turnInfoKey("th","t2")]:{status:"completed",durationMs:900},
    [turnInfoKey("th","t3")]:{status:"interrupted",durationMs:null},
    [turnInfoKey("th","t4")]:{status:"failed",durationMs:500,error:"Lost the connection."},
    [turnInfoKey("th","t5")]:{status:"completed",durationMs:null},
  };
  const messages=[user("u1","t1"),thought("r1","t1"),user("u2","t2"),reply("a2","t2"),user("u3","t3"),user("u4","t4"),reply("a4","t4"),user("u5","t5"),user("u6",null)];
  const rows=turnEndRows(messages,{harnessLabel:"Grok Build",turnInfo,threadId:"th"});
  // A reply carries its own pill (t2, t4); a turn completed with no reply says so (t5); an unfinished one has no outcome yet.
  assert.deepEqual([...rows.keys()],["r1","u3","u5"]);
  assert.deepEqual(rows.get("r1"),[{turnId:"t1",heading:"Grok Build · Supervised",outcomeLabel:"failed · 2.1s",outcomeTone:"err",message:"Usage limit reached.",latest:false}]);
  // A stop recorded no error: the pill alone.
  assert.deepEqual(rows.get("u3"),[{turnId:"t3",heading:"Grok Build",outcomeLabel:"stopped",outcomeTone:"warn",message:"",latest:false}]);
  assert.deepEqual(rows.get("u5"),[{turnId:"t5",heading:"Grok Build",outcomeLabel:"done",outcomeTone:"ok",message:"Finished without a reply.",latest:false}]);
  assert.equal(turnEndRows(messages,{harnessLabel:"",turnInfo,threadId:"th"}).get("r1")[0].heading,"");
  assert.equal(turnEndRows(messages,{harnessLabel:"Grok Build",turnInfo,threadId:"other"}).size,0);
  assert.equal(turnEndRows(messages,{harnessLabel:"Grok Build",turnInfo:null,threadId:"th"}).size,0);
});

test("the card's own turn's outcome row reads below the card, an earlier turn's stays above it, and a failure the card lists is not repeated",()=>{
  const turnInfo={[turnInfoKey("th","t1")]:{status:"failed",error:"Boom."},[turnInfoKey("th","t2")]:{status:"interrupted"}};
  const messages=[user("u1","t1"),user("u2","t2")];
  const latest=options=>Object.fromEntries([...turnEndRows(messages,{turnInfo,threadId:"th",...options})].map(([id,rows])=>[id,rows[0].latest]));
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
  assert.deepEqual([...goalRows.keys()],["r2"]);assert.equal(goalRows.get("r2")[0].latest,true);
});

test("the turns whose failure the card lists are the ones it shows an error row for",()=>{
  const events=[
    {id:"codex-error-t1",kind:"error",title:"You've hit your usage limit. · See Usage for your Codex limits.",status:"done",raw:{message:"You've hit your usage limit."}},
    {id:"error-1700000000000",kind:"error",title:"Grok usage limit reached.",status:"done",raw:{threadId:"th",turnId:"t2",message:"Grok usage limit reached."}},
    // A harness's own retry is its own kind of row (activity-item.js retryActivityRow), retrying or settled.
    {id:"retry-t3",kind:"retry",title:"Retrying (1/5): stream disconnected",status:"running",output:"stream disconnected",raw:{threadId:"th",turnId:"t3"},turnId:"t3"},
    {id:"retry-t8",kind:"retry",title:"Stopped while retrying",status:"stopped",output:"stream disconnected",raw:{threadId:"th",turnId:"t8"},turnId:"t8"},
    {id:"queue-refresh-error-1",kind:"error",title:"Could not refresh queued follow-ups: offline",status:"done",raw:{}},
    {id:"cmd-1",kind:"commandExecution",title:"npm test",status:"done",raw:{turnId:"t4"}},
    // An auto review's denial or time-out, and a verification error, carry the turn's id but are not how the turn ended.
    {id:"auto-review-r5",kind:"error",title:"Auto review · rm generated.tmp · denied",status:"error",raw:{threadId:"th",turnId:"t5",review:{status:"denied"}}},
    {id:"auto-review-r6",kind:"error",title:"Auto review · rm generated.tmp · timed out",status:"error",raw:{threadId:"th",turnId:"t6",review:{status:"timedOut"}}},
    {id:"verification-plan-error-t7",kind:"error",title:"Could not plan turn verification: offline",status:"done",raw:{threadId:"th",turnId:"t7"}},
  ];
  assert.deepEqual(cardFailedTurnIds(events),["t1","t2"]);
  assert.deepEqual(cardFailedTurnIds([]),[]);assert.deepEqual(cardFailedTurnIds(null),[]);
});

test("a stop has its row while the card is on screen, even when the card shows an error for that turn",()=>{
  // The card lists a denied action and a runtime error for t2, but never that the turn was stopped: the row says so.
  const turnInfo={[turnInfoKey("th","t2")]:{mode:"Supervised",status:"interrupted",durationMs:200}};
  const rows=turnEndRows([user("u1","t1"),reply("a1","t1"),user("u2","t2")],{harnessLabel:"Codex",turnInfo,threadId:"th",cardTurnId:"t2",cardFailedTurnIds:new Set(["t2"])});
  assert.deepEqual(rows.get("u2"),[{turnId:"t2",heading:"Codex · Supervised",outcomeLabel:"stopped · 0.2s",outcomeTone:"warn",message:"",latest:true}]);
});

test("a turn with no rows of its own ends after the turn before it, once the card no longer lists its failure",()=>{
  // A goal continues after t3 with a turn of the harness's own (t4) that hits the usage limit before any item; t5 is the next message.
  const usage="You have hit your usage limit. Try again in 3 hours. · See Usage for your Codex limits.";
  const turnInfo={[turnInfoKey("th","t3")]:{status:"completed",durationMs:100},[turnInfoKey("th","t4")]:{status:"failed",durationMs:2100,error:usage}};
  const answered=[user("u3","t3"),reply("a3","t3")],order=["t1","t2","t3","t4"];
  const ends=(messages,options={})=>Object.fromEntries([...turnEndRows(messages,{harnessLabel:"Codex",turnInfo,threadId:"th",turnOrder:order,...options})].map(([id,rows])=>[id,rows.map(row=>row.turnId+":"+row.message+":"+row.latest)]));
  // While the card lists the failure, there is none; once it moves on, the row follows the answer, above the next message.
  assert.deepEqual(ends(answered,{cardTurnId:"t4",cardFailedTurnIds:new Set(["t4"])}),{});
  assert.deepEqual(ends([...answered,user("u5",null)],{cardTurnId:"t4"}),{a3:["t4:"+usage+":false"]});
  assert.deepEqual(ends([...answered,user("u5","t5")],{turnOrder:[...order,"t5"],cardTurnId:"t5"}),{a3:["t4:"+usage+":false"]});
  // Stopped while its card is on screen (no failure on the card), it reads below the card with the rest of its turn.
  const stopped={...turnInfo,[turnInfoKey("th","t4")]:{status:"interrupted",durationMs:300}};
  assert.deepEqual(ends(answered,{turnInfo:stopped,cardTurnId:"t4",cardFailedTurnIds:new Set(["t4"])}),{a3:["t4::true"]});
  // Two such turns in a row both end there, in order; one after a turn that failed without a reply follows that turn's row.
  const more={...turnInfo,[turnInfoKey("th","t5")]:{status:"failed",error:"Second."},[turnInfoKey("th","t2")]:{status:"failed",error:"First."}};
  assert.deepEqual(ends([user("u2","t2"),...answered],{turnInfo:more,turnOrder:["t2","t3","t4","t5"]}),{u2:["t2:First.:false"],a3:["t4:"+usage+":true","t5:Second.:true"]});
  assert.deepEqual(ends([user("u2","t2"),user("u6","t6")],{turnInfo:more,turnOrder:["t2","t5","t6"]}),{u2:["t2:First.:false","t5:Second.:false"]});
  // A virtualized list keeps its order: no row is latest.
  assert.deepEqual(ends(answered,{turnInfo:stopped,cardTurnId:"t4",reorder:false}),{a3:["t4::false"]});
});

test("a turn with no rows of its own is placed only where the loaded history holds both sides of it",()=>{
  const turnInfo={[turnInfoKey("th","t2")]:{status:"failed",error:"Usage limit reached."}};
  const ends=(messages,options={})=>Object.fromEntries([...turnEndRows(messages,{turnInfo,threadId:"th",turnOrder:["t1","t2","t3"],...options})].map(([id,rows])=>[id,rows.map(row=>row.turnId)]));
  assert.deepEqual(ends([user("u1","t1"),user("u3","t3")]),{u1:["t2"]});
  // The turn before it is not loaded (an older page): its place is not known yet, so no row; nor without the turn order.
  assert.deepEqual(ends([user("u3","t3")]),{});
  assert.deepEqual(ends([user("u1","t1"),user("u3","t3")],{turnOrder:null}),{});
  // Rows between the two sides: the history gap under a detached find hit, or a turn the order does not hold.
  assert.deepEqual(ends([user("u1","t1"),user("u3","t3")],{gapBeforeId:"u3"}),{});
  assert.deepEqual(ends([user("u1","t1"),user("ux","tx"),user("u3","t3")]),{});
  assert.deepEqual(ends([user("u1","t1"),user("ux","tx")],{turnOrder:["t1","t2"]}),{});
  // It opens the thread when the thread's start is loaded: before the first row, or alone in an empty conversation.
  assert.deepEqual(ends([user("u3","t3")],{turnOrder:["t2","t3"],startLoaded:true}),{"":["t2"]});
  assert.deepEqual(ends([user("u3","t3")],{turnOrder:["t2","t3"],startLoaded:false}),{});
  assert.deepEqual(ends([],{turnOrder:["t2"],startLoaded:true}),{"":["t2"]});
  assert.deepEqual(ends([user("ux","tx"),user("u3","t3")],{turnOrder:["t2","t3"],startLoaded:true}),{});
  // A turn that does have rows (its own thought) ends after them, whatever the order says.
  assert.deepEqual(ends([user("u1","t1"),thought("r2","t2"),user("u3","t3")]),{r2:["t2"]});
});

test("the turn order takes older pages in front and new turns at the end, each turn once",()=>{
  assert.deepEqual(turnIdsOldestFirst([{id:"t3"},{id:"t2"},{},{id:"t1"}]),["t1","t2","t3"]);
  const order=["t3","t4"];
  assert.deepEqual(prependTurnOrder(order,["t1","t2"]),["t1","t2","t3","t4"]);
  assert.deepEqual(prependTurnOrder(order,["t2","t3"]),["t2","t3","t4"]);
  assert.equal(prependTurnOrder(order,["t3","t4"]),order);assert.equal(prependTurnOrder(order,["t4"]),order);assert.equal(prependTurnOrder(order,[]),order);
  assert.deepEqual(prependTurnOrder([],["t1"]),["t1"]);
  assert.deepEqual(appendTurnOrder(order,["t5","t4","t5"]),["t3","t4","t5"]);
  assert.equal(appendTurnOrder(order,["t4"]),order);
});

test("a turn completed with no reply and no rows of its own says so where the turn before it ends",()=>{
  const turnInfo={[turnInfoKey("th","t2")]:{status:"completed",durationMs:1000}};
  const rows=turnEndRows([user("u1","t1"),reply("a1","t1"),user("u3","t3")],{harnessLabel:"Codex",turnInfo,threadId:"th",turnOrder:["t1","t2","t3"]});
  assert.deepEqual(rows.get("a1"),[{turnId:"t2",heading:"Codex",outcomeLabel:"done · 1.0s",outcomeTone:"ok",message:"Finished without a reply.",latest:false}]);
  assert.deepEqual([...rows.keys()],["a1"]);
});

test("a turn whose steps are not all loaded never reads as finished without a reply, and a stop or failure still does",()=>{
  const turnInfo={[turnInfoKey("th","t1")]:{status:"completed",durationMs:900},[turnInfoKey("th","t2")]:{status:"failed",error:"Boom."}};
  const messages=[user("u1","t1"),user("u2","t2")];
  assert.deepEqual([...turnEndRows(messages,{turnInfo,threadId:"th"}).keys()],["u1","u2"]);
  assert.deepEqual([...turnEndRows(messages,{turnInfo,threadId:"th",incompleteTurnIds:new Set(["t1","t2"])}).keys()],["u2"]);
  assert.deepEqual([...turnEndRows(messages,{turnInfo,threadId:"th",incompleteTurnIds:["t1"]}).keys()],["u2"]);
});

test("a completed compaction, a turn whose steps are all compactions, has no row, while a stop or failure of it and an ordinary turn without a reply still do",()=>{
  // c2: the turn Compact ran, with no rows of its own, between t1's reply and t3, the person's next turn, which ended with no reply.
  const turnInfo={[turnInfoKey("th","t1")]:{status:"completed",durationMs:900},[turnInfoKey("th","c2")]:{status:"completed",durationMs:1500},[turnInfoKey("th","t3")]:{status:"completed",durationMs:700}};
  const messages=[user("u1","t1"),reply("a1","t1"),user("u3","t3")],options={harnessLabel:"Codex",turnInfo,threadId:"th",turnOrder:["t1","c2","t3"]};
  assert.deepEqual([...turnEndRows(messages,options).keys()],["u3","a1"]);
  const rows=turnEndRows(messages,{...options,compactionTurnIds:["c2"]});
  assert.deepEqual([...rows.keys()],["u3"]);
  assert.deepEqual(rows.get("u3"),[{turnId:"t3",heading:"Codex",outcomeLabel:"done · 0.7s",outcomeTone:"ok",message:"Finished without a reply.",latest:true}]);
  assert.deepEqual([...turnEndRows(messages,{...options,compactionTurnIds:new Set(["c2"])}).keys()],["u3"]);
  // A turn the person asked something in keeps its note when its only step was a compaction (Codex compacted first, then ended with
  // no reply); a harness's /compact turn, which shows its "/compact" message after a reload, has none. A stopped or failed
  // compaction keeps its row.
  assert.deepEqual([...turnEndRows(messages,{...options,compactionTurnIds:["c2","t3"]}).keys()],["u3"]);
  assert.deepEqual(turnEndRows(messages,{...options,compactionTurnIds:["c2","t3"]}).get("u3"),rows.get("u3"));
  const relayed=[...messages,{id:"u4",role:"user",text:"/compact",turnId:"t4"}],relayedOptions={...options,turnInfo:{...turnInfo,[turnInfoKey("th","t4")]:{status:"completed",durationMs:600}},turnOrder:["t1","c2","t3","t4"]};
  assert.deepEqual([...turnEndRows(relayed,relayedOptions).keys()],["u3","u4","a1"]);
  assert.deepEqual([...turnEndRows(relayed,{...relayedOptions,compactionTurnIds:["c2","t4"]}).keys()],["u3"]);
  for(const [status,label,tone,message] of [["interrupted","stopped · 1.5s","warn",""],["failed","failed · 1.5s","err","Compaction failed."]]){
    const ended={...turnInfo,[turnInfoKey("th","c2")]:{status,durationMs:1500,...(message?{error:message}:{})}};
    assert.deepEqual(turnEndRows(messages,{...options,turnInfo:ended,compactionTurnIds:["c2"]}).get("a1"),[{turnId:"c2",heading:"Codex",outcomeLabel:label,outcomeTone:tone,message,latest:false}]);
  }
});

test("a turn the history import made never reads as finished without a reply, while an imported reply keeps its pill",()=>{
  // The import keeps a conversation's messages only and calls every turn it makes completed: an interrupted request, and Claude
  // Code's interrupt marker, are turns without a reply too.
  const turnInfo=Object.fromEntries(["import-u1","import-u2","import-u3","t4"].map(id=>[turnInfoKey("th",id),{status:"completed",durationMs:null}]));
  const messages=[user("u1","import-u1"),user("u2","import-u2"),user("u3","import-u3"),reply("a3","import-u3"),user("u4","t4")];
  assert.deepEqual([...turnEndRows(messages,{harnessLabel:"Trebell Native",turnInfo,threadId:"th"}).keys()],["u4"]);
  assert.equal(assistantRowDecorations(messages,{turnInfo,threadId:"th"}).get("a3").outcomeLabel,"done");
});

test("the card's own turn's no-reply row reads below the card; an earlier turn's stays above it",()=>{
  const turnInfo={[turnInfoKey("th","t1")]:{status:"completed",durationMs:900},[turnInfoKey("th","t2")]:{status:"completed",durationMs:1200}};
  const messages=[user("u1","t1"),user("u2","t2")];
  const latest=options=>Object.fromEntries([...turnEndRows(messages,{turnInfo,threadId:"th",...options})].map(([id,rows])=>[id,rows[0].latest]));
  assert.deepEqual(latest({cardTurnId:"t2"}),{u1:false,u2:true});
  assert.deepEqual(latest({cardTurnId:"t1"}),{u1:false,u2:false});
  assert.deepEqual(latest({cardTurnId:"t2",reorder:false}),{u1:false,u2:false});
});

// Lists a trailers map as {row id: ["card:t1", "end:t1"]} to read the placements at a glance.
const listed=map=>Object.fromEntries([...map].map(([id,entries])=>[id,entries.map(entry=>entry.kind+":"+entry.turnId)]));
const trailers=(messages,options={})=>{const {before,after}=turnTrailers(messages,{threadId:"th",...options});return {before:listed(before),after:listed(after)}};

test("a past card reads where the live card did: after its turn's message, a steered message staying above it",()=>{
  const messages=[user("u1","t1"),reply("a1","t1"),user("u2","t2"),user("s2","t2"),thought("r2","t2"),reply("a2","t2")];
  assert.deepEqual(trailers(messages,{cardTurnIds:["t1","t2"],turnOrder:["t1","t2"]}),{before:{},after:{u1:["card:t1"],s2:["card:t2"]}});
  // A turn with no stored steps has no card.
  assert.deepEqual(trailers(messages,{cardTurnIds:["t2"]}),{before:{},after:{s2:["card:t2"]}});
});

test("a goal turn with no message of its own has its card before its first row, below the history gap when that row opens the newest pages",()=>{
  const messages=[user("u1","t1"),reply("a1","t1"),thought("r2","t2"),reply("a2","t2")];
  assert.deepEqual(trailers(messages,{cardTurnIds:["t2"],turnOrder:["t1","t2"]}),{before:{r2:["card:t2"]},after:{}});
  // The gap marker renders first at its row, then the cards before the row: the card stays with its turn, below the gap.
  assert.deepEqual(trailers(messages,{cardTurnIds:["t2"],turnOrder:["t1","t2"],gapBeforeId:"r2"}),{before:{r2:["card:t2"]},after:{}});
});

test("the turn an item page cut, with none of its rows loaded, has its card at the top of the newest pages",()=>{
  // The newest page holds only t3's tail and t2's last steps: t2 (the boundary) has no message loaded.
  const messages=[reply("a3","t3")];
  assert.deepEqual(trailers(messages,{cardTurnIds:["t2","t3"],boundaryTurnId:"t2",turnOrder:["t2","t3"]}),{before:{a3:["card:t2","card:t3"]},after:{}});
  // Below a find hit's detached rows the newest pages start at the gap.
  const detached=[user("h1","t9"),reply("h2","t9"),reply("a3","t3")];
  assert.deepEqual(trailers(detached,{cardTurnIds:["t2"],boundaryTurnId:"t2",gapBeforeId:"a3"}),{before:{a3:["card:t2"]},after:{}});
  // No rows at all: the card opens the conversation.
  assert.deepEqual(trailers([],{cardTurnIds:["t2"],boundaryTurnId:"t2"}),{before:{},after:{"":["card:t2"]}});
});

test("a turn with no rows of its own has its card where its end row would be, and none where that place is not known",()=>{
  const turnInfo={[turnInfoKey("th","t2")]:{status:"failed",error:"Usage limit reached."}};
  const messages=[user("u1","t1"),reply("a1","t1"),user("u3","t3")];
  // Its card comes before its end row; the turn after it keeps its own place.
  assert.deepEqual(trailers(messages,{turnInfo,cardTurnIds:["t2","t3"],turnOrder:["t1","t2","t3"]}),{before:{},after:{a1:["card:t2","end:t2"],u3:["card:t3"]}});
  assert.deepEqual(trailers(messages,{turnInfo,cardTurnIds:["t2"],turnOrder:["t1","t2","t3"],gapBeforeId:"u3"}),{before:{},after:{}});
  assert.deepEqual(trailers(messages,{turnInfo,cardTurnIds:["t2"],turnOrder:null}),{before:{},after:{}});
  // Opening the thread when its start is loaded.
  assert.deepEqual(trailers([user("u3","t3")],{turnInfo,cardTurnIds:["t2"],turnOrder:["t2","t3"],startLoaded:true}),{before:{},after:{"":["card:t2","end:t2"]}});
});

test("at one row the turns keep their order, each turn's card before its end row",()=>{
  const turnInfo={[turnInfoKey("th","t1")]:{status:"failed",error:"First."},[turnInfoKey("th","t2")]:{status:"interrupted"},[turnInfoKey("th","t3")]:{status:"completed",durationMs:500}};
  const messages=[user("u1","t1"),user("u4","t4")];
  assert.deepEqual(trailers(messages,{turnInfo,cardTurnIds:["t3","t2","t1"],turnOrder:["t1","t2","t3","t4"]}),{before:{},after:{u1:["card:t1","end:t1","card:t2","end:t2","card:t3","end:t3"]}});
  // Without a turn order the turns sort by where their rows start.
  const both=[user("u1","t1"),thought("r1","t1"),thought("r2","t2")];
  assert.deepEqual(listed(turnTrailers(both,{threadId:"th",cardTurnIds:["t2","t1"]}).after),{u1:["card:t1"]});
  assert.deepEqual(listed(turnTrailers(both,{threadId:"th",cardTurnIds:["t2","t1"]}).before),{r2:["card:t2"]});
});

test("the live card's turn has no past card, and its end row keeps the live order",()=>{
  const turnInfo={[turnInfoKey("th","t2")]:{status:"completed",durationMs:500}};
  const messages=[user("u1","t1"),reply("a1","t1"),user("u2","t2")];
  assert.deepEqual(trailers(messages,{turnInfo,cardTurnIds:["t1","t2"],liveCardTurnId:"t2",cardTurnId:"t2"}),{before:{},after:{u1:["card:t1"],u2:["end:t2"]}});
  const {after}=turnTrailers(messages,{threadId:"th",turnInfo,cardTurnIds:["t1","t2"],liveCardTurnId:"t2",cardTurnId:"t2"});
  assert.equal(after.get("u2")[0].latest,true);assert.equal(after.get("u2")[0].message,"Finished without a reply.");
  // Once the live card shows nothing for the turn, the turn's own card is back, above the row.
  assert.deepEqual(trailers(messages,{turnInfo,cardTurnIds:["t1","t2"],cardTurnId:"t2"}),{before:{},after:{u1:["card:t1"],u2:["card:t2","end:t2"]}});
});

test("a turn's session handoff row comes before its steps: the card follows it, and a reply after it still opens its group",()=>{
  const handoff=(id,turnId)=>({id,role:"handoff",text:"Cursor no longer had this conversation, so it continues in a new session.",turnId});
  const messages=[user("u1","t1"),reply("a1","t1"),user("u2","t2"),handoff("h2","t2"),reply("a2","t2")];
  assert.deepEqual(trailers(messages,{cardTurnIds:["t1","t2"],turnOrder:["t1","t2"]}),{before:{},after:{u1:["card:t1"],h2:["card:t2"]}});
  // An item page that cut the turn after its message opens on the handoff row: the card still follows it.
  assert.deepEqual(trailers([handoff("h2","t2"),reply("a2","t2")],{cardTurnIds:["t2"],boundaryTurnId:"t2",turnOrder:["t2"]}),{before:{},after:{h2:["card:t2"]}});
  // The reply after the row names the harness and carries the pill; a turn that ended with no reply ends after the row.
  const turnInfo={[turnInfoKey("th","t2")]:{status:"completed",durationMs:1500},[turnInfoKey("th","t3")]:{status:"failed",error:"Not signed in."}};
  assert.deepEqual(assistantRowDecorations(messages,{harnessLabel:"Cursor",turnInfo,threadId:"th"}).get("a2"),{heading:"Cursor",outcomeLabel:"done · 1.5s",outcomeTone:"ok"});
  const failed=[...messages,user("u3","t3"),handoff("h3","t3")];
  assert.deepEqual(trailers(failed,{turnInfo,cardTurnIds:["t3"],turnOrder:["t1","t2","t3"]}),{before:{},after:{h3:["card:t3","end:t3"]}});
});

test("a turn's heading names the model this window sent it with, between the harness and the mode",()=>{
  const turnInfo={
    [turnInfoKey("th","t1")]:{model:"Vision Mini",mode:permissionModeLabel("supervised"),status:"completed",durationMs:900},
    [turnInfoKey("th","t2")]:{model:"Kestrel Deep",mode:permissionModeLabel("supervised"),status:"failed",durationMs:1200,error:"Boom"},
  };
  const messages=[user("u1","t1"),reply("a1","t1"),user("u2","t2")];
  assert.equal(assistantRowDecorations(messages,{harnessLabel:"Codex",turnInfo,threadId:"th"}).get("a1").heading,"Codex · Vision Mini · Supervised");
  // A turn that ended without a reply has the heading its reply would have had.
  assert.equal(turnEndRows(messages,{harnessLabel:"Codex",turnInfo,threadId:"th"}).get("u2")[0].heading,"Codex · Kestrel Deep · Supervised");
  // A history page keeps what this window sent the turn with; a window that did not send it knows the harness alone.
  const merged=mergeTurnOutcomes(turnInfo,"th",[{id:"t1",status:"completed",durationMs:900,completedAt:100}]);
  assert.equal(merged[turnInfoKey("th","t1")].model,"Vision Mini");
  const reloaded=mergeTurnOutcomes({},"th",[{id:"t1",status:"completed",durationMs:900,completedAt:100}]);
  assert.equal(assistantRowDecorations(messages,{harnessLabel:"Codex",turnInfo:reloaded,threadId:"th"}).get("a1").heading,"Codex");
});
