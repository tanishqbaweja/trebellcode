import test from "node:test";
import assert from "node:assert/strict";
import {countUnloadedTurns,detachHistoryTurn,historyFromItemEntries,historyFromTurns,historyGapBeforeId,historyGapLabel,historyGapPage,mergeHistoryGapMessages,mergeHistoryMessages,messageText,resumedActiveTurnId} from "../ui/src/thread-history.js";

test("paginated Codex turns become chronological visible conversation messages",()=>{
  const turns=[
    {id:"t1",items:[{id:"u1",type:"userMessage",content:[{text:"hello"}]},{id:"a1",type:"agentMessage",text:"hi"},{id:"tool",type:"commandExecution"}]},
    {id:"t2",items:[{id:"u2",type:"userMessage",text:"next"},{id:"a2",type:"agentMessage",text:"done"}]},
  ];
  assert.deepEqual(historyFromTurns(turns,{t1:{id:"cp1"}}),[
    {id:"u1",role:"user",text:"hello",turnId:"t1",checkpointId:"cp1"},
    {id:"a1",role:"assistant",text:"hi",turnId:"t1"},
    {id:"u2",role:"user",text:"next",turnId:"t2",checkpointId:null},
    {id:"a2",role:"assistant",text:"done",turnId:"t2"},
  ]);
  assert.equal(messageText({content:[{input_text:"legacy"}]}),"legacy");
});

test("paginated Codex item entries retain turn ownership and checkpoint links",()=>{
  const entries=[
    {turnId:"t1",item:{id:"u1",type:"userMessage",text:"hello"}},
    {turnId:"t1",item:{id:"tool",type:"commandExecution"}},
    {turnId:"t1",item:{id:"a1",type:"agentMessage",text:"hi"}},
  ];
  assert.deepEqual(historyFromItemEntries(entries,{t1:{id:"cp1"}}),[
    {id:"u1",role:"user",text:"hello",turnId:"t1",checkpointId:"cp1"},
    {id:"a1",role:"assistant",text:"hi",turnId:"t1"},
  ]);
});

test("a thread's thoughts are conversation rows in their place, and a thought without text is none",()=>{
  const turns=[{id:"t1",items:[
    {id:"u1",type:"userMessage",text:"hello"},
    {id:"r1",type:"reasoning",summary:[],content:["Weighing the options."]},
    {id:"tool",type:"commandExecution"},
    {id:"r-empty",type:"reasoning",summary:[],content:[]},
    {id:"rs_2",type:"reasoning",summary:["**Answering**"],content:[]},
    {id:"a1",type:"agentMessage",text:"hi"},
  ]}];
  const expected=[
    {id:"u1",role:"user",text:"hello",turnId:"t1",checkpointId:null},
    {id:"r1",role:"reasoning",text:"Weighing the options.",turnId:"t1"},
    {id:"rs_2",role:"reasoning",text:"**Answering**",turnId:"t1"},
    {id:"a1",role:"assistant",text:"hi",turnId:"t1"},
  ];
  assert.deepEqual(historyFromTurns(turns),expected);
  assert.deepEqual(historyFromItemEntries(turns[0].items.map(item=>({turnId:"t1",item}))),expected);
});

test("prepending an overlapping history page does not duplicate messages",()=>{
  const earlier=[{id:"a",text:"old"},{id:"b",text:"middle"}],current=[{id:"b",text:"middle"},{id:"c",text:"new"}];
  assert.deepEqual(mergeHistoryMessages(earlier,current).map(item=>item.id),["a","b","c"]);
});

test("active resumed threads restore only explicit active turn ids",()=>{
  assert.equal(resumedActiveTurnId({thread:{status:{type:"idle"},turns:[{id:"old",status:"completed"}]}}),null);
  assert.equal(resumedActiveTurnId({thread:{status:{type:"active",turnId:"turn-live"},turns:[]}}),"turn-live");
  assert.equal(resumedActiveTurnId({thread:{status:{type:"active"},turns:[{id:"old",status:"completed"},{id:"live",status:"inProgress"}]}}),"live");
  assert.equal(resumedActiveTurnId({thread:{status:{type:"active"},turns:[]},__trebellHistoryPage:{kind:"turns",data:[{id:"old",status:"completed"},{id:"live-page",status:"inProgress"}]}}),"live-page");
  assert.equal(resumedActiveTurnId({thread:{status:{type:"active"},turns:[]},__trebellHistoryPage:{kind:"items",data:[{turnId:"completed-but-unknown"}]}}),null);
});

const msg=(turn,role)=>({id:`${role}-${turn}`,role,text:`${role} ${turn}`,turnId:`t${turn}`});
const turnMessages=(...turns)=>turns.flatMap(turn=>[msg(turn,"user"),msg(turn,"assistant")]);

test("a find hit older than the loaded pages leads the list apart from them, and a later hit replaces it",()=>{
  const window=turnMessages(15,16);
  const first=detachHistoryTurn(window,[],turnMessages(0));
  assert.deepEqual(first.map(message=>message.id),["user-0","assistant-0","user-15","assistant-15","user-16","assistant-16"]);
  assert.equal(historyGapBeforeId(first,{ids:["user-0","assistant-0"]}),"user-15");
  const second=detachHistoryTurn(first,["user-0","assistant-0"],turnMessages(5));
  assert.deepEqual(second.map(message=>message.id),["user-5","assistant-5","user-15","assistant-15","user-16","assistant-16"]);
  assert.equal(historyGapBeforeId(second,null),null);
});

test("an older page shrinks the gap until it reaches the detached turn, then the two join in order",()=>{
  const detached={ids:["user-0","assistant-0"],turnIds:["t0"],cursor:null,missing:{count:14,more:false}};
  const messages=[...turnMessages(0),...turnMessages(15,16)];
  // A page of turns 10-14 lands between turn 0 and the newest pages; turns 1-9 stay missing.
  const partial=historyGapPage(detached,{earlier:turnMessages(10,11,12,13,14),pageTurnIds:["t10","t11","t12","t13","t14"],nextCursor:"before-10",windowTurnIds:["t15","t16"]});
  assert.equal(partial.joined,false);assert.deepEqual(partial.detached.missing,{count:9,more:false});assert.equal(partial.nextCursor,"before-10");
  const shrunk=mergeHistoryGapMessages(messages,detached,turnMessages(10,11,12,13,14),false);
  assert.deepEqual(shrunk.map(message=>message.turnId),["t0","t0","t10","t10","t11","t11","t12","t12","t13","t13","t14","t14","t15","t15","t16","t16"]);
  // The next page reaches turn 0 (and holds it whole): the gap closes and paging continues past it.
  const page=turnMessages(0,1,2,3,4,5,6,7,8,9);
  const joined=historyGapPage(partial.detached,{earlier:page,pageTurnIds:page.map(message=>message.turnId),nextCursor:null,windowTurnIds:["t10"]});
  assert.deepEqual(joined,{joined:true,detached:null,nextCursor:null,itemPaging:undefined});
  const merged=mergeHistoryGapMessages(shrunk,partial.detached,page,true);
  assert.deepEqual(merged.map(message=>message.turnId),Array.from({length:17},(_,index)=>index).flatMap(index=>["t"+index,"t"+index]));
  // A page that reaches only part of the detached turns keeps their own earlier cursor (a turn cursor).
  const wide={ids:["user-3","assistant-3","user-4","assistant-4"],turnIds:["t3","t4"],cursor:"before-3",missing:{count:2,more:false}};
  assert.deepEqual(historyGapPage(wide,{earlier:[msg(4,"assistant"),...turnMessages(5,6)],pageTurnIds:["t4","t5","t6"],nextCursor:"inside-4",windowTurnIds:["t7"]}),{joined:true,detached:null,nextCursor:"before-3",itemPaging:false});
});

test("unloaded turns are counted from metadata pages until a loaded turn",async()=>{
  const calls=[];
  const turns=Array.from({length:65},(_,index)=>({id:"t"+index}));
  const request=async(method,params)=>{
    calls.push({method,params});
    const start=Number(String(params.cursor).slice(1));
    const data=turns.slice(start,start+params.limit);
    return {data,nextCursor:turns[start+params.limit]?"c"+(start+params.limit):null};
  };
  assert.deepEqual(await countUnloadedTurns(request,{threadId:"thread",turnCursor:"c0",turnId:"t0",loadedTurnIds:["t15","t16"],limit:200}),{count:14,more:false});
  assert.deepEqual(calls[0],{method:"thread/turns/list",params:{threadId:"thread",cursor:"c0",limit:200,sortDirection:"asc",itemsView:"notLoaded"}});
  // More pages than allowed: a lower bound. No loaded turn at all: unknown.
  assert.deepEqual(await countUnloadedTurns(request,{threadId:"thread",turnCursor:"c0",turnId:"t0",loadedTurnIds:["t64"],limit:10,maxPages:2}),{count:19,more:true});
  assert.equal(await countUnloadedTurns(request,{threadId:"thread",turnCursor:"c0",turnId:"t0",loadedTurnIds:[],limit:200}),null);
  assert.equal(await countUnloadedTurns(request,{threadId:"thread",turnCursor:null,turnId:"t0"}),null);
  assert.equal(historyGapLabel({count:14,more:false}),"14 turns not loaded");
  assert.equal(historyGapLabel({count:1,more:false}),"1 turn not loaded");
  assert.equal(historyGapLabel({count:1000,more:true}),"1,000+ turns not loaded");
  assert.equal(historyGapLabel(null),"Turns not loaded");
});
