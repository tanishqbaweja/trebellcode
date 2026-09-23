import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { WebSocket } from "ws";
import { AgentThreadStore } from "../src/agent-thread-store.mjs";
import { agentThreadResumePayload,attachAgentRelay,paginateAgentThreadItems,paginateAgentThreads,paginateAgentThreadTurns,restoreClaudeRejectedRewind,searchAgentThreadOccurrences } from "../src/agent-relay.mjs";

test("rejected Claude rewind restores the original provider session and removed turns",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-claude-rewind-"));
  const env={...process.env,TREBELL_HOME:home};
  try{
    const store=new AgentThreadStore(env);
    const source="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",target="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const original=[
      {id:"turn-1",status:"completed",items:[],providerMessageId:"assistant-1"},
      {id:"turn-2",status:"completed",items:[],providerMessageId:"assistant-2"},
      {id:"turn-3",status:"completed",items:[],providerMessageId:"assistant-3"},
    ];
    const thread=store.create({runtime:"claude",cwd:process.cwd(),providerSessionId:source});
    store.update(thread.id,{
      providerSessionId:target,
      turns:[original[0],{id:"replacement",status:"inProgress",items:[]}],
      providerMeta:{
        keep:"value",
        claudeFork:{sourceSessionId:source,targetSessionId:target,resumeSessionAt:"assistant-1"},
        claudeRewindBackup:{sourceSessionId:source,retainedCount:1,removedTurns:original.slice(1),createdAt:Date.now()},
      },
    });
    const restored=restoreClaudeRejectedRewind(store,thread.id,{claudeFork:{sourceSessionId:source}});
    assert.equal(restored.providerSessionId,source);
    assert.deepEqual(restored.turns.map(turn=>turn.id),["turn-1","turn-2","turn-3"]);
    assert.equal(restored.providerMeta.keep,"value");
    assert.equal(Object.prototype.hasOwnProperty.call(restored.providerMeta,"claudeFork"),false);
    assert.equal(Object.prototype.hasOwnProperty.call(restored.providerMeta,"claudeRewindBackup"),false);
  }finally{await rm(home,{recursive:true,force:true})}
});

test("agent thread item pagination uses stable bounded cursors in both directions",()=>{
  const thread={id:"thread-1",turns:[
    {id:"turn-1",items:[{id:"u1",type:"userMessage",text:"one"},{id:"a1",type:"agentMessage",text:"answer one"}]},
    {id:"turn-2",items:[{id:"u2",type:"userMessage",text:"two"},{id:"a2",type:"agentMessage",text:"answer two"}]},
    {id:"turn-3",items:[{id:"u3",type:"userMessage",text:"three"},{id:"a3",type:"agentMessage",text:"answer three"}]},
  ]};
  const latest=paginateAgentThreadItems(thread,{limit:2,sortDirection:"desc"});
  assert.deepEqual(latest.data.map(entry=>entry.item.id),["a3","u3"]);assert.ok(latest.nextCursor);assert.ok(latest.backwardsCursor);
  thread.turns.push({id:"turn-4",items:[{id:"u4",type:"userMessage",text:"new while paging"}]});
  const older=paginateAgentThreadItems(thread,{cursor:latest.nextCursor,limit:2,sortDirection:"desc"});
  assert.deepEqual(older.data.map(entry=>entry.item.id),["a2","u2"],"newer items must not shift an existing cursor");
  const turnOnly=paginateAgentThreadItems(thread,{turnId:"turn-2",limit:10,sortDirection:"asc"});
  assert.deepEqual(turnOnly.data.map(entry=>entry.item.id),["u2","a2"]);assert.equal(turnOnly.nextCursor,null);
  assert.throws(()=>paginateAgentThreadItems(thread,{cursor:"not-a-cursor"}),/invalid thread item cursor/i);
});

test("metadata-only agent resumes advertise bounded item history without embedding turns",()=>{
  const thread={id:"thread-1",historyMode:null,turns:[{id:"turn-1",items:[{id:"u1",type:"userMessage",text:"hello"}]}]};
  const bounded=agentThreadResumePayload(thread,{excludeTurns:true});
  assert.equal(bounded.thread.historyMode,"paginated");assert.deepEqual(bounded.thread.turns,[]);assert.ok(bounded.itemsBackwardsCursor);assert.ok(bounded.turnsBackwardsCursor);
  const full=agentThreadResumePayload(thread,{excludeTurns:false});assert.equal(full.thread.turns.length,1);assert.equal(full.itemsBackwardsCursor,undefined);
});

test("agent turn pagination supports summary, full and metadata-only views with stable cursors",()=>{
  const thread={id:"thread-1",turns:[
    {id:"turn-1",status:"completed",items:[{id:"u1",type:"userMessage",text:"one"},{id:"tool1",type:"commandExecution"},{id:"draft1",type:"agentMessage",text:"draft"},{id:"a1",type:"agentMessage",text:"final one"}]},
    {id:"turn-2",status:"completed",items:[{id:"u2",type:"userMessage",text:"two"},{id:"a2",type:"agentMessage",text:"final two"}]},
    {id:"turn-3",status:"completed",items:[{id:"u3",type:"userMessage",text:"three"},{id:"a3",type:"agentMessage",text:"final three"}]},
  ]};
  const summary=paginateAgentThreadTurns(thread,{limit:1,sortDirection:"desc",itemsView:"summary"});
  assert.equal(summary.data[0].id,"turn-3");assert.equal(summary.data[0].itemsView,"summary");assert.deepEqual(summary.data[0].items.map(item=>item.id),["u3","a3"]);assert.ok(summary.nextCursor);
  thread.turns.push({id:"turn-4",status:"completed",items:[{id:"u4",type:"userMessage",text:"newer"}]});
  const older=paginateAgentThreadTurns(thread,{cursor:summary.nextCursor,limit:1,sortDirection:"desc",itemsView:"notLoaded"});
  assert.equal(older.data[0].id,"turn-2","new turns must not shift an existing turn cursor");assert.equal(older.data[0].itemsView,"notLoaded");assert.deepEqual(older.data[0].items,[]);
  const full=paginateAgentThreadTurns(thread,{cursor:older.nextCursor,limit:1,sortDirection:"desc",itemsView:"full"});
  assert.equal(full.data[0].id,"turn-1");assert.deepEqual(full.data[0].items.map(item=>item.id),["u1","tool1","draft1","a1"]);
  const asc=paginateAgentThreadTurns(thread,{limit:1,sortDirection:"asc",itemsView:"summary"});assert.equal(asc.data[0].id,"turn-1");assert.deepEqual(asc.data[0].items.map(item=>item.id),["u1","a1"]);
  assert.throws(()=>paginateAgentThreadTurns(thread,{cursor:"bad"}),/invalid thread turn cursor/i);
});

test("agent thread search returns every visible occurrence while excluding tools and draft assistant messages",()=>{
  const thread={id:"thread-search",turns:[
    {id:"turn-1",items:[
      {id:"u1",type:"userMessage",content:[{type:"text",text:"Needle first and NEEDLE second"}]},
      {id:"tool1",type:"commandExecution",aggregatedOutput:"needle hidden tool output"},
      {id:"draft1",type:"agentMessage",text:"needle hidden draft"},
      {id:"a1",type:"agentMessage",text:"Final answer contains needle once"},
    ]},
    {id:"turn-2",items:[{id:"u2",type:"userMessage",text:"No match here"},{id:"a2",type:"agentMessage",text:"Another needle"}]},
  ]};
  const first=searchAgentThreadOccurrences(thread,{searchTerm:"needle",limit:2});
  assert.deepEqual(first.data.map(item=>item.itemId),["u1","u1"]);assert.ok(first.nextCursor);
  assert.ok(first.data.every(item=>item.snippet.slice(item.snippetMatchRange.start,item.snippetMatchRange.end).toLowerCase()==="needle"));
  const second=searchAgentThreadOccurrences(thread,{searchTerm:"needle",cursor:first.nextCursor,limit:10});
  assert.deepEqual(second.data.map(item=>item.itemId),["a1","a2"]);assert.equal(second.nextCursor,null);
  assert.ok(second.data.every(item=>item.turnCursor?.startsWith("agent-turn-v1:")));
  assert.doesNotMatch(JSON.stringify([...first.data,...second.data]),/hidden tool output|hidden draft/);
  assert.throws(()=>searchAgentThreadOccurrences(thread,{searchTerm:"other",cursor:first.nextCursor}),/invalid thread search cursor/i);
});

test("agent thread listing paginates stable filtered sidebar views",()=>{
  const threads=[
    {id:"a",name:"Alpha task",cwd:"/repo/a",createdAt:1,updatedAt:40,archived:false,section:null},
    {id:"b",name:"Beta task",cwd:"/repo/b",createdAt:2,updatedAt:30,archived:false,section:{id:"Pinned",name:"Pinned"}},
    {id:"c",name:"Gamma task",cwd:"/repo/a",createdAt:3,updatedAt:20,archived:false,section:null},
    {id:"d",name:"Archived alpha",cwd:"/repo/a",createdAt:4,updatedAt:50,archived:true,section:null},
  ];
  const first=paginateAgentThreads(threads,{limit:2,sortKey:"updated_at",sortDirection:"desc"});
  assert.deepEqual(first.data.map(thread=>thread.id),["a","b"]);assert.ok(first.nextCursor);assert.ok(first.backwardsCursor);
  threads.push({id:"new",name:"New task",cwd:"/repo/a",createdAt:5,updatedAt:60,archived:false,section:null});
  const second=paginateAgentThreads(threads,{cursor:first.nextCursor,limit:2,sortKey:"updated_at",sortDirection:"desc"});
  assert.deepEqual(second.data.map(thread=>thread.id),["c"]);
  assert.deepEqual(paginateAgentThreads(threads,{archived:true}).data.map(thread=>thread.id),["d"]);
  assert.deepEqual(paginateAgentThreads(threads,{cwd:"/repo/a",searchTerm:"alpha",sortKey:"updated_at"}).data.map(thread=>thread.id),["a"]);
  assert.deepEqual(paginateAgentThreads(threads,{sectionId:null}).data.map(thread=>thread.id),["new","c","a"]);
  assert.deepEqual(paginateAgentThreads(threads,{sectionId:"Pinned"}).data.map(thread=>thread.id),["b"]);
  assert.throws(()=>paginateAgentThreads(threads,{cursor:first.nextCursor,sortKey:"created_at"}),/invalid thread list cursor/i);
});

async function listen(server){
  await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  return server.address().port;
}
async function connect(url){
  const ws=new WebSocket(url);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});return ws;
}
function request(ws){
  let id=0;return (method,params={})=>new Promise((resolve,reject)=>{
    const requestId=++id;
    const onMessage=raw=>{const message=JSON.parse(String(raw));if(message.id!==requestId)return;ws.off("message",onMessage);message.error?reject(new Error(message.error.message)):resolve(message.result)};
    ws.on("message",onMessage);ws.send(JSON.stringify({id:requestId,method,params}));
  });
}

test("agent relay broadcasts Codex-compatible archive, unarchive and delete lifecycle notifications",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-agent-lifecycle-"));
  const env={...process.env,TREBELL_HOME:home};const threadStore=new AgentThreadStore(env);
  const thread=threadStore.create({runtime:"claude",cwd:home,providerSessionId:"fixture-session"});
  const turn=threadStore.addTurn(thread.id,{inputText:"fixture question"});threadStore.addItem(thread.id,turn.id,{id:"fixture-answer",type:"agentMessage",text:"fixture answer"});threadStore.finishTurn(thread.id,turn.id);
  const runtimeManager={instances:()=>[],activeInstance:()=>({id:"claude-default",kind:"claude"}),activeRuntime:()=>"claude"};
  const state={settings:()=>({activeEnvironmentId:null}),updateThreadMeta:()=>({})};
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,version:"test"});
  const port=await listen(server);const url="ws://127.0.0.1:"+port+"/api/agent/ws";const first=await connect(url),second=await connect(url);const rpc=request(first);const notifications=[];
  second.on("message",raw=>{const message=JSON.parse(String(raw));if(message.method&&message.id==null)notifications.push(message)});
  try{
    const listed=await rpc("thread/list",{limit:1,sortKey:"updated_at",sortDirection:"desc"});assert.deepEqual(listed.data.map(item=>item.id),[thread.id]);
    const itemPage=await rpc("thread/items/list",{threadId:thread.id,limit:1,sortDirection:"desc"});
    assert.deepEqual(itemPage.data.map(entry=>entry.item.id),["fixture-answer"]);assert.ok(itemPage.nextCursor);assert.ok(itemPage.backwardsCursor);
    const turnPage=await rpc("thread/turns/list",{threadId:thread.id,limit:1,sortDirection:"desc",itemsView:"notLoaded"});
    assert.deepEqual(turnPage.data.map(entry=>entry.id),[turn.id]);assert.deepEqual(turnPage.data[0].items,[]);assert.equal(turnPage.data[0].itemsView,"notLoaded");
    const search=await rpc("thread/searchOccurrences",{threadId:thread.id,searchTerm:"fixture",limit:10});
    assert.deepEqual(search.data.map(entry=>entry.itemId),["user-"+turn.id,"fixture-answer"]);
    await rpc("thread/archive",{threadId:thread.id});
    await rpc("thread/unarchive",{threadId:thread.id});
    await rpc("thread/delete",{threadId:thread.id});
    for(let attempt=0;attempt<50&&notifications.length<3;attempt++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.deepEqual(notifications.map(message=>message.method),["thread/archived","thread/unarchived","thread/deleted"]);
    assert.ok(notifications.every(message=>message.params?.threadId===thread.id));
  }finally{
    try{first.close()}catch{}try{second.close()}catch{}
    await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(home,{recursive:true,force:true});
  }
});
