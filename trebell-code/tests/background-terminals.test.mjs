import test from "node:test";
import assert from "node:assert/strict";
import { backgroundTerminalResourceText, listThreadBackgroundTerminals } from "../ui/src/background-terminals.js";

test("background terminal listing follows bounded pagination and removes duplicates",async()=>{
  const calls=[];
  const rpc={request:async(method,params)=>{
    calls.push({method,params});
    if(!params.cursor)return {data:[{processId:"p1",command:"npm run dev"},{processId:"p2",command:"vite"}],nextCursor:"next"};
    return {data:[{processId:"p2",command:"duplicate"},{processId:"p3",command:"tests"}],nextCursor:null};
  }};
  const items=await listThreadBackgroundTerminals(rpc,"thread-1",{pageSize:2});
  assert.deepEqual(items.map(item=>item.processId),["p1","p2","p3"]);
  assert.equal(calls.length,2);
  assert.equal(calls[0].method,"thread/backgroundTerminals/list");
  assert.deepEqual(calls[1].params,{threadId:"thread-1",limit:2,cursor:"next"});
});

test("background terminal resource labels stay compact",()=>{
  assert.equal(backgroundTerminalResourceText({cpuPercent:12.345,rssKb:15360,osPid:42}),"12.3% CPU · 15 MB · PID 42");
  assert.equal(backgroundTerminalResourceText({}),"");
});
