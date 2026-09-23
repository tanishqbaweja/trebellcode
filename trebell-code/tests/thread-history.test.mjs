import test from "node:test";
import assert from "node:assert/strict";
import {historyFromTurns,mergeHistoryMessages,messageText} from "../ui/src/thread-history.js";

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

test("prepending an overlapping history page does not duplicate messages",()=>{
  const earlier=[{id:"a",text:"old"},{id:"b",text:"middle"}],current=[{id:"b",text:"middle"},{id:"c",text:"new"}];
  assert.deepEqual(mergeHistoryMessages(earlier,current).map(item=>item.id),["a","b","c"]);
});
