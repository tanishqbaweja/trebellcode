import test from "node:test";
import assert from "node:assert/strict";
import {loadLatestTurnTimeline,timelineActivityItems} from "../ui/src/thread-timeline.js";

test("timeline activity excludes conversation messages and keeps tool order",()=>{
  const entries=[
    {type:"item",turnId:"t1",item:{id:"user",type:"userMessage",text:"hello"}},
    {type:"item",turnId:"t1",item:{id:"cmd",type:"commandExecution",command:"npm test",status:"completed",aggregatedOutput:"ok"}},
    {type:"item",turnId:"t1",item:{id:"file",type:"fileChange",status:"completed",changes:[]}},
    {type:"item",turnId:"t1",item:{id:"agent",type:"agentMessage",text:"done"}},
  ];
  assert.deepEqual(timelineActivityItems(entries,"t1").map(item=>item.id),["cmd","file"]);
});

test("latest-turn timeline pages backwards only until that turn start",async()=>{
  const calls=[];
  const pages=new Map([
    ["",{
      data:[
        {type:"item",position:40,turnId:"older",item:{id:"older-agent",type:"agentMessage",text:"old"}},
        {type:"turnCompleted",position:41,turnId:"older",status:"completed"},
        {type:"turnStarted",position:50,turnId:"latest"},
        {type:"item",position:51,turnId:"latest",item:{id:"latest-user",type:"userMessage",text:"go"}},
        {type:"item",position:52,turnId:"latest",item:{id:"cmd-2",type:"commandExecution",command:"second",status:"completed"}},
        {type:"turnCompleted",position:60,turnId:"latest",status:"completed"},
      ],
      nextCursor:"older-page",
    }],
    ["older-page",{
      data:[
        {type:"turnStarted",position:10,turnId:"older"},
        {type:"item",position:11,turnId:"older",item:{id:"old-cmd",type:"commandExecution",command:"old",status:"completed"}},
      ],
      nextCursor:null,
    }],
  ]);
  const client={request:async(method,params)=>{calls.push({method,params});return pages.get(params.cursor||"")}};
  const result=await loadLatestTurnTimeline(client,"thread-1");
  assert.equal(result.turnId,"latest");
  assert.equal(result.complete,true);
  assert.deepEqual(result.items.map(item=>item.id),["cmd-2"]);
  assert.equal(calls.length,1,"the latest page already contains the selected turn start");
  assert.deepEqual(calls[0],{method:"thread/timeline/list",params:{threadId:"thread-1",cursor:null,limit:100}});
});

test("latest-turn timeline prepends older pages when a long turn crosses the page boundary",async()=>{
  const pages={
    first:{data:[
      {type:"item",position:101,turnId:"t2",item:{id:"cmd-2",type:"commandExecution",command:"second",status:"completed"}},
      {type:"turnCompleted",position:110,turnId:"t2",status:"completed"},
    ],nextCursor:"older"},
    older:{data:[
      {type:"turnStarted",position:90,turnId:"t2"},
      {type:"item",position:91,turnId:"t2",item:{id:"cmd-1",type:"commandExecution",command:"first",status:"completed"}},
      {type:"item",position:92,turnId:"t2",item:{id:"cmd-2",type:"commandExecution",command:"duplicate",status:"completed"}},
    ],nextCursor:"oldest"},
  };
  const client={request:async(_method,params)=>params.cursor?pages.older:pages.first};
  const result=await loadLatestTurnTimeline(client,"thread-2",{pageSize:2,maxPages:4});
  assert.equal(result.complete,true);
  assert.deepEqual(result.items.map(item=>item.id),["cmd-1","cmd-2"]);
});
