import test from "node:test";
import assert from "node:assert/strict";
import { activitySummary, cardRowsFromItemEntries, cardRowsFromTurns, emptyTurnActivity, itemPageBoundaryTurnId, itemPageCompleteness, mergeTurnActivity, newestCardTurnId, storeCardTurnIds, storeIncompleteTurnIds } from "../ui/src/turn-activity.js";

const command=(id,text,extra={})=>({id,type:"commandExecution",command:text,status:"completed",exitCode:0,aggregatedOutput:"",...extra});
const entry=(turnId,item)=>({turnId,item});
const ids=rows=>rows.map(row=>row.id);

test("a turn's card holds its steps in order, never its messages or thoughts",()=>{
  const rows=cardRowsFromItemEntries([
    entry("t1",{id:"u1",type:"userMessage",content:[{type:"text",text:"go"}]}),
    entry("t1",{id:"r1",type:"reasoning",summary:["thinking"]}),
    entry("t1",command("c1","npm test")),
    entry("t1",{id:"f1",type:"fileChange",changes:[{path:"a.js",kind:"update"}],status:"completed"}),
    entry("t1",{id:"a1",type:"agentMessage",text:"done"}),
    entry("t2",command("c2","npm run build")),
  ]);
  assert.deepEqual(Object.keys(rows),["t1","t2"]);
  assert.deepEqual(ids(rows.t1),["c1","f1"]);assert.deepEqual(ids(rows.t2),["c2"]);
  assert.equal(rows.t1[0].turnId,"t1");assert.equal(rows.t1[0].title,"npm test");
});

test("a step with no id is left out, and a step listed twice is kept once where it first stood",()=>{
  const rows=cardRowsFromItemEntries([entry("t1",command("c1","first")),entry("t1",{type:"commandExecution",command:"no id"}),entry("t1",command("c2","second")),entry("t1",command("c1","first, finished",{aggregatedOutput:"ok"}))]);
  assert.deepEqual(ids(rows.t1),["c1","c2"]);assert.equal(rows.t1[0].title,"first, finished");assert.equal(rows.t1[0].output,"ok");
});

test("a page asked for one turn keeps only that turn's entries",()=>{
  const rows=cardRowsFromItemEntries([entry("t1",command("c1","a")),entry("t2",command("c2","b")),entry("t1",command("c3","c"))],{turnId:"t1"});
  assert.deepEqual(Object.keys(rows),["t1"]);assert.deepEqual(ids(rows.t1),["c1","c3"]);
});

test("a turn the entries name gets its list even without steps, so its completeness is still kept",()=>{
  const rows=cardRowsFromItemEntries([entry("t1",{id:"u1",type:"userMessage"}),entry("t1",{id:"a1",type:"agentMessage",text:"hi"}),entry("t2",command("c2","b"))]);
  assert.deepEqual(rows.t1,[]);assert.equal(rows.t2.length,1);
  const store=mergeTurnActivity(emptyTurnActivity("th"),rows,{complete:true});
  assert.deepEqual(store.turns.t1,{rows:[],complete:true});
  assert.deepEqual(storeCardTurnIds(store),["t2"]);assert.deepEqual(storeIncompleteTurnIds(store),[]);
});

test("steps of ended turns are not running; the active turn's keep their status",()=>{
  const running={id:"c1",type:"commandExecution",command:"watch",status:"inProgress"};
  const rows=cardRowsFromItemEntries([entry("t1",running),entry("t2",{...running,id:"c2"})],{activeTurnId:"t2"});
  assert.equal(rows.t1[0].status,"done");assert.equal(rows.t2[0].status,"running");
  const turns=cardRowsFromTurns([{id:"t1",items:[running]},{id:"t2",items:[{...running,id:"c2"}]}],{activeTurnId:"t2"});
  assert.equal(turns.t1[0].status,"done");assert.equal(turns.t2[0].status,"running");
});

test("turns read whole give each turn its steps, a turn with none an empty list",()=>{
  const rows=cardRowsFromTurns([{id:"t1",items:[{id:"u1",type:"userMessage"},command("c1","a"),{id:"a1",type:"agentMessage"}]},{id:"t2",items:[{id:"u2",type:"userMessage"}]},{items:[command("x","no turn id")]}]);
  assert.deepEqual(Object.keys(rows),["t1","t2"]);assert.deepEqual(ids(rows.t1),["c1"]);assert.deepEqual(rows.t2,[]);
});

test("the same step id in two turns makes two rows",()=>{
  const rows=cardRowsFromTurns([{id:"t1",items:[command("item-1","a")]},{id:"t2",items:[command("item-1","b")]}]);
  assert.equal(rows.t1[0].title,"a");assert.equal(rows.t2[0].title,"b");
  const store=mergeTurnActivity(emptyTurnActivity("th"),rows,{complete:true});
  assert.equal(store.turns.t1.rows[0].title,"a");assert.equal(store.turns.t2.rows[0].title,"b");
});

test("older rows go before the rows held, known ones update where they stand, and twice is once",()=>{
  const newest=cardRowsFromItemEntries([entry("t1",command("c3","third")),entry("t1",command("c4","fourth")),entry("t2",command("d1","other"))]);
  const store=mergeTurnActivity(emptyTurnActivity("th"),newest,{complete:{t1:false,t2:true}});
  const otherTurn=store.turns.t2.rows;
  const older=cardRowsFromItemEntries([entry("t1",command("c1","first")),entry("t1",command("c2","second")),entry("t1",command("c3","third, finished",{aggregatedOutput:"ok"}))]);
  const merged=mergeTurnActivity(store,older,{complete:{t1:true}});
  assert.deepEqual(ids(merged.turns.t1.rows),["c1","c2","c3","c4"]);
  assert.equal(merged.turns.t1.rows[2].title,"third, finished");assert.equal(merged.turns.t1.complete,true);
  assert.equal(merged.turns.t2.rows,otherTurn,"a turn the merge did not name keeps its array");
  assert.equal(mergeTurnActivity(merged,older,{complete:{t1:true}}),merged,"the same rows again change nothing");
  // A turn once whole stays whole when a later page reads it as cut.
  assert.equal(mergeTurnActivity(merged,older,{complete:{t1:false}}),merged);
});

test("replace makes the incoming rows the turn's and sets its completeness",()=>{
  const first=mergeTurnActivity(emptyTurnActivity("th"),{t1:cardRowsFromTurns([{id:"t1",items:[command("c1","a"),command("c2","b")]}]).t1},{complete:true});
  const sealed=cardRowsFromTurns([{id:"t1",items:[command("c2","b"),command("c5","e")]}]);
  const next=mergeTurnActivity(first,sealed,{mode:"replace",complete:true});
  assert.deepEqual(ids(next.turns.t1.rows),["c2","c5"]);
  // The same rows read again keep the array held, so the card does not re-render.
  const again=mergeTurnActivity(next,cardRowsFromTurns([{id:"t1",items:[command("c2","b"),command("c5","e")]}]),{mode:"replace",complete:true});
  assert.equal(again,next);
  const cut=mergeTurnActivity(next,{t1:next.turns.t1.rows},{mode:"replace",complete:false});
  assert.equal(cut.turns.t1.complete,false);assert.equal(cut.turns.t1.rows,next.turns.t1.rows);
});

test("an item page's oldest turn is whole when its user message is on the page or nothing older is left",()=>{
  const page=[entry("t3",{id:"a3",type:"agentMessage"}),entry("t3",command("c3","x")),entry("t3",{id:"u3",type:"userMessage"}),entry("t2",{id:"a2",type:"agentMessage"}),entry("t2",command("c2","y"))];
  assert.deepEqual(itemPageCompleteness(page,"cursor"),{t3:true,t2:false});
  assert.deepEqual(itemPageCompleteness([...page,entry("t2",{id:"u2",type:"userMessage"})],"cursor"),{t3:true,t2:true});
  assert.deepEqual(itemPageCompleteness(page,null),{t3:true,t2:true});
  assert.deepEqual(itemPageCompleteness([],"cursor"),{});
});

test("the turn a page may have cut is its oldest, and only while older pages remain",()=>{
  const page=[entry("t3",command("c3","x")),entry("t2",command("c2","y")),{item:{id:"loose"}}];
  assert.equal(itemPageBoundaryTurnId(page,"cursor"),"t2");
  assert.equal(itemPageBoundaryTurnId(page,null),null);
  assert.equal(itemPageBoundaryTurnId([],"cursor"),null);
});

test("the card head counts steps and failures, and says when steps are not all loaded",()=>{
  const rows=cardRowsFromTurns([{id:"t1",items:[command("c1","a"),command("c2","b",{exitCode:1}),{id:"m",type:"mcpToolCall",server:"s",tool:"t",status:"failed"},command("c4","d")]}]).t1;
  assert.deepEqual(activitySummary(rows),{text:"4 steps",failed:2});
  assert.deepEqual(activitySummary(rows.slice(0,1)),{text:"1 step",failed:0});
  assert.deepEqual(activitySummary(rows,{complete:false}),{text:"4 steps · some steps not loaded",failed:2});
  assert.deepEqual(activitySummary([]),{text:"0 steps",failed:0});
  const many=Array.from({length:1200},(_,index)=>({id:"s"+index,status:"done"}));
  assert.equal(activitySummary(many).text,"1,200 steps");
});

test("the card that opens by itself is the newest turn's, none while a sent message waits for its turn",()=>{
  assert.equal(newestCardTurnId({messages:[{role:"user",text:"hi",turnId:"t1"},{role:"user",text:"next"}],turnOrder:["t1"]}),null);
  assert.equal(newestCardTurnId({messages:[{role:"user",turnId:"t1"},{role:"assistant",turnId:"t1"}],turnOrder:["t1","t2"]}),"t2");
  assert.equal(newestCardTurnId({messages:[{role:"user",turnId:"t1"},{role:"assistant",turnId:"t2"},{role:"assistant"}],turnOrder:[]}),"t2");
  assert.equal(newestCardTurnId({messages:[],turnOrder:null,turns:{t1:{rows:[{id:"c"}]},t2:{rows:[]}}}),"t1");
  assert.equal(newestCardTurnId({}),null);
});
