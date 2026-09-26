import test from "node:test";
import assert from "node:assert/strict";
import {historyFromItemEntries,historyFromTurns,mergeHistoryMessages,messageText,resumedActiveTurnId} from "../ui/src/thread-history.js";

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
