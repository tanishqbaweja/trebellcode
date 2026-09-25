import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { WebSocket } from "ws";
import { AgentThreadStore } from "../src/agent-thread-store.mjs";
import { acpPlanEvent,agentPermissionModeFromStart,agentPermissionPolicyDecision,agentPermissionTraceData,agentThreadResumePayload,agentToolLifecycle,attachAgentRelay,contextualAgentPrompt,materializeAgentFork,paginateAgentAttachments,paginateAgentQueue,paginateAgentThreadItems,paginateAgentThreads,paginateAgentThreadTurns,restoreClaudeRejectedRewind,searchAgentThreadOccurrences,searchAgentThreads } from "../src/agent-relay.mjs";

test("permission trace metadata excludes raw tool arguments",()=>{
  const trace=agentPermissionTraceData({toolCall:{toolCallId:"tool-1",title:"Run deployment",kind:"execute",rawInput:{command:"do-not-persist"}},options:[{kind:"allow_once"},{kind:"allow_once"},{kind:"reject_once"}]});
  assert.deepEqual(trace,{toolCallId:"tool-1",title:"Run deployment",kind:"execute",optionKinds:["allow_once","reject_once"]});
  assert.equal(Object.prototype.hasOwnProperty.call(trace,"rawInput"),false);
});

test("external thread starts preserve Trebell permission profiles across runtime sessions",()=>{
  assert.equal(agentPermissionModeFromStart({sandbox:"read-only",approvalPolicy:"on-request"}),"read-only");
  assert.equal(agentPermissionModeFromStart({approvalPolicy:"never",sandbox:"danger-full-access"}),"full");
  assert.equal(agentPermissionModeFromStart({approvalPolicy:"untrusted",sandbox:"workspace-write"}),"auto");
  assert.equal(agentPermissionModeFromStart({approvalPolicy:"never",sandbox:"workspace-write"}),"auto");
  assert.equal(agentPermissionModeFromStart({approvalPolicy:"never"}),"auto");
  assert.equal(agentPermissionModeFromStart({permissionProfile:"workspace-write"}),"edits");
  assert.equal(agentPermissionModeFromStart({approvalPolicy:"on-request",sandbox:"workspace-write"}),"supervised");
});

test("external runtime approval requests use the unified policy decision before asking the user",()=>{
  const thread={id:"t",runtime:"claude",cwd:"/repo",providerMeta:{permissionProfile:"auto"}};
  const deploy=agentPermissionPolicyDecision(thread,{params:{toolCall:{title:"Deploy production",kind:"execute",rawInput:{command:"deploy"}},policy:{externalSideEffect:true,riskLevel:"high",reversibility:"none"}}});
  assert.equal(deploy.decision,"CONFIRM");
  const injected=agentPermissionPolicyDecision(thread,{params:{toolCall:{title:"Destroy production",kind:"execute"},policy:{externalSideEffect:true,riskLevel:"critical",reversibility:"none",provenance:"untrusted"}}});
  assert.equal(injected.decision,"REJECT");
  const outside=agentPermissionPolicyDecision({...thread,providerMeta:{permissionProfile:"edits"}},{params:{toolCall:{title:"Edit outside",kind:"edit"},policy:{requestedPath:"/other/a.js"}}});
  assert.equal(outside.decision,"REJECT");
  const allowedByRule=agentPermissionPolicyDecision({...thread,providerMeta:{permissionProfile:"supervised"}},{params:{toolCall:{title:"npm test",kind:"execute"}}},{policyRules:[{effect:"ALLOW",action:"npm test"}]});
  assert.equal(allowedByRule.decision,"ALLOW");
});

test("ACP v1 plan updates map item, markdown, file and removal variants into Trebell plans",()=>{
  assert.deepEqual(acpPlanEvent({sessionUpdate:"plan_update",plan:{type:"items",planId:"p1",entries:[
    {content:"Inspect",status:"in_progress",priority:"high"},{content:"Fix",status:"pending"},
  ]}}),{planId:"p1",plan:[
    {step:"Inspect",status:"inProgress",priority:"high"},{step:"Fix",status:"pending",priority:null},
  ]});
  assert.deepEqual(acpPlanEvent({sessionUpdate:"plan_update",plan:{type:"markdown",planId:"p2",content:"1. Inspect\n2. Fix"}}),{
    planId:"p2",plan:[{step:"1. Inspect\n2. Fix",status:"pending",format:"markdown"}],
  });
  assert.deepEqual(acpPlanEvent({sessionUpdate:"plan_update",plan:{type:"file",planId:"p3",uri:"file:///tmp/plan.md"}}),{
    planId:"p3",plan:[{step:"Plan file · file:///tmp/plan.md",status:"pending",format:"file",uri:"file:///tmp/plan.md"}],
  });
  assert.deepEqual(acpPlanEvent({sessionUpdate:"plan_removed",planId:"p3"}),{planId:"p3",plan:[]});
});

test("external runtimes receive Trebell application context before the visible user prompt",async()=>{
  const prompt=await contextualAgentPrompt([{type:"text",text:"Fix the refresh bug"}],{
    "trebell.repo_context":{kind:"application",value:"src/auth/session.js is relevant because it defines RefreshSession."},
  });
  assert.equal(prompt.length,2);
  assert.match(prompt[0].text,/Trebell supplied the following bounded repository context/);
  assert.match(prompt[0].text,/src\/auth\/session\.js/);
  assert.equal(prompt[1].text,"Fix the refresh bug");
});

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

test("agent tool lifecycle settles one-shot commands and streams only appended output",()=>{
  const started=agentToolLifecycle({sessionUpdate:"tool_call",toolCallId:"cmd-1",title:"Build",kind:"execute",status:"in_progress",rawOutput:"line one\n"});
  assert.equal(started.item.type,"commandExecution");assert.equal(started.terminal,false);assert.equal(started.outputDelta,"line one\n");
  const progress=agentToolLifecycle({sessionUpdate:"tool_call_update",toolCallId:"cmd-1",title:"Build",kind:"execute",status:"in_progress",rawOutput:"line one\nline two\n"},started.output);
  assert.equal(progress.outputDelta,"line two\n");assert.equal(progress.terminal,false);
  const completed=agentToolLifecycle({sessionUpdate:"tool_call_update",toolCallId:"cmd-1",title:"Build",kind:"execute",status:"completed",rawOutput:"line one\nline two\ndone\n"},progress.output);
  assert.equal(completed.outputDelta,"done\n");assert.equal(completed.terminal,true);assert.equal(completed.item.status,"completed");
  const oneShot=agentToolLifecycle({sessionUpdate:"tool_call",toolCallId:"cmd-2",title:"Quick",kind:"execute",status:"completed",rawOutput:"finished\n"});
  assert.equal(oneShot.terminal,true);assert.equal(oneShot.outputDelta,"finished\n");
  const replaced=agentToolLifecycle({sessionUpdate:"tool_call_update",toolCallId:"cmd-3",title:"Rewrite",kind:"execute",status:"in_progress",rawOutput:"replacement"},"old output");
  assert.equal(replaced.outputDelta,"","non-prefix replacement must not duplicate prior output in the UI");
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

test("agent global thread search finds persisted visible conversation text beyond titles",()=>{
  const threads=[
    {id:"old",name:"Unrelated title",createdAt:1,updatedAt:10,archived:false,turns:[{id:"o1",items:[{id:"ou",type:"userMessage",text:"Needle in an older request"},{id:"ot",type:"commandExecution",aggregatedOutput:"needle tool secret"},{id:"oa",type:"agentMessage",text:"final response"}]}]},
    {id:"new",name:"Another title",createdAt:2,updatedAt:30,archived:false,turns:[{id:"n1",items:[{id:"nu",type:"userMessage",text:"request"},{id:"nd",type:"agentMessage",text:"needle draft should disappear"},{id:"na",type:"agentMessage",text:"Final Needle answer"}]}]},
    {id:"archived",name:"Needle archived",createdAt:3,updatedAt:40,archived:true,turns:[]},
  ];
  const first=searchAgentThreads(threads,{searchTerm:"needle",limit:1,sortKey:"recency_at",sortDirection:"desc",archived:false});
  assert.deepEqual(first.data.map(item=>item.thread.id),["new"]);assert.match(first.data[0].snippet,/Final Needle answer/);assert.ok(first.nextCursor);
  const second=searchAgentThreads(threads,{searchTerm:"needle",cursor:first.nextCursor,limit:2,sortKey:"recency_at",sortDirection:"desc",archived:false});
  assert.deepEqual(second.data.map(item=>item.thread.id),["old"]);assert.match(second.data[0].snippet,/Needle in an older request/);assert.doesNotMatch(JSON.stringify([...first.data,...second.data]),/tool secret|draft should disappear/);
  assert.deepEqual(searchAgentThreads(threads,{searchTerm:"needle",archived:true}).data.map(item=>item.thread.id),["archived"]);
  assert.throws(()=>searchAgentThreads(threads,{searchTerm:"different",cursor:first.nextCursor}),/invalid thread search cursor/i);
});

test("agent forks persist inherited history while bounded responses omit embedded turns",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-agent-fork-"));const store=new AgentThreadStore({...process.env,TREBELL_HOME:home});
  try{
    const source=store.create({runtime:"claude",cwd:home,providerSessionId:"source-session",model:"claude-model",name:"Source",preview:"Source preview",providerMeta:{runtimeInstanceId:"claude-default"}});
    const turn=store.addTurn(source.id,{inputText:"Remember this history"});store.addItem(source.id,turn.id,{id:"fork-answer",type:"agentMessage",text:"Inherited answer"});store.finishTurn(source.id,turn.id);
    const latest=store.get(source.id);
    const bounded=materializeAgentFork(store,latest,{runtime:"claude",providerSessionId:"fork-session",providerMeta:{runtimeInstanceId:"claude-default",setup:{forked:true}},excludeTurns:true});
    assert.equal(bounded.thread.forkedFromId,source.id);assert.equal(bounded.thread.historyMode,"paginated");assert.deepEqual(bounded.thread.turns,[]);
    const persisted=store.get(bounded.thread.id);assert.equal(persisted.providerSessionId,"fork-session");assert.equal(persisted.forkedFromId,source.id);assert.equal(persisted.turns.length,1);
    assert.deepEqual(paginateAgentThreadItems(persisted,{sortDirection:"desc",limit:10}).data.map(entry=>entry.item.id),["fork-answer","user-"+turn.id]);
  }finally{await rm(home,{recursive:true,force:true})}
});

test("agent queue pagination uses bounded native-compatible offsets",()=>{
  const queue=[{id:"q1"},{id:"q2"},{id:"q3"}];
  const first=paginateAgentQueue(queue,{limit:2});assert.deepEqual(first.data.map(item=>item.id),["q1","q2"]);assert.equal(first.nextCursor,"2");
  const second=paginateAgentQueue(queue,{cursor:first.nextCursor,limit:2});assert.deepEqual(second.data.map(item=>item.id),["q3"]);assert.equal(second.nextCursor,null);
  assert.throws(()=>paginateAgentQueue(queue,{cursor:"wat"}),/invalid queue cursor/i);
});

test("agent attachment pagination uses bounded native-compatible offsets",()=>{
  const attachments=[{id:"a1"},{id:"a2"},{id:"a3"}];
  const first=paginateAgentAttachments(attachments,{limit:2});assert.deepEqual(first.data.map(item=>item.id),["a1","a2"]);assert.equal(first.nextCursor,"2");
  const second=paginateAgentAttachments(attachments,{cursor:first.nextCursor,limit:2});assert.deepEqual(second.data.map(item=>item.id),["a3"]);assert.equal(second.nextCursor,null);
  assert.throws(()=>paginateAgentAttachments(attachments,{cursor:"wat"}),/invalid attachment cursor/i);
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
  const runtimeManager={instances:()=>[],activeInstance:()=>({id:"claude-default",kind:"claude"}),activeRuntime:()=>"claude",probe:async()=>({available:false,message:"fixture runtime unavailable"})};
  const meta=new Map();const state={
    settings:()=>({activeEnvironmentId:null}),
    threadMeta:id=>meta.get(id)||{},
    updateThreadMeta:(id,patch)=>{const next={...(meta.get(id)||{}),...patch};meta.set(id,next);return next},
    threadUsage:()=>({totalTokens:threadTokens}),
  };
  let threadTokens=0;const traces=[];const journal={recordProtocol:event=>traces.push(event),record:event=>traces.push(event)};
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,version:"test",journal});
  const port=await listen(server);const url="ws://127.0.0.1:"+port+"/api/agent/ws";const first=await connect(url),second=await connect(url);const rpc=request(first);const notifications=[];
  second.on("message",raw=>{const message=JSON.parse(String(raw));if(message.method&&message.id==null)notifications.push(message)});
  try{
    const listed=await rpc("thread/list",{limit:1,sortKey:"updated_at",sortDirection:"desc"});assert.deepEqual(listed.data.map(item=>item.id),[thread.id]);
    const globalSearch=await rpc("thread/search",{searchTerm:"fixture",limit:10,sortKey:"recency_at",sortDirection:"desc",archived:false});assert.deepEqual(globalSearch.data.map(item=>item.thread.id),[thread.id]);
    const itemPage=await rpc("thread/items/list",{threadId:thread.id,limit:1,sortDirection:"desc"});
    assert.deepEqual(itemPage.data.map(entry=>entry.item.id),["fixture-answer"]);assert.ok(itemPage.nextCursor);assert.ok(itemPage.backwardsCursor);
    const turnPage=await rpc("thread/turns/list",{threadId:thread.id,limit:1,sortDirection:"desc",itemsView:"notLoaded"});
    assert.deepEqual(turnPage.data.map(entry=>entry.id),[turn.id]);assert.deepEqual(turnPage.data[0].items,[]);assert.equal(turnPage.data[0].itemsView,"notLoaded");
    const search=await rpc("thread/searchOccurrences",{threadId:thread.id,searchTerm:"fixture",limit:10});
    assert.deepEqual(search.data.map(entry=>entry.itemId),["user-"+turn.id,"fixture-answer"]);
    state.updateThreadMeta(thread.id,{attachments:[{attachmentType:"legacy",identityKey:"legacy-1",payload:{old:true}}]});
    let attachmentPage=await rpc("thread/attachment/list",{threadId:thread.id,limit:1});assert.equal(attachmentPage.data.length,1);assert.ok(attachmentPage.data[0].id);assert.ok(attachmentPage.data[0].createdAt);
    const created=await rpc("thread/attachment/add",{threadId:thread.id,attachmentType:"pull_request",identityKey:"pr-1",payload:{number:1}});
    assert.equal(created.outcome,"created");assert.ok(created.attachment.id);
    const existing=await rpc("thread/attachment/add",{threadId:thread.id,attachmentType:"pull_request",identityKey:"pr-1",payload:{number:999}});
    assert.equal(existing.outcome,"existing");assert.equal(existing.attachment.id,created.attachment.id);assert.equal(existing.attachment.payload.number,1);
    attachmentPage=await rpc("thread/attachment/list",{threadId:thread.id,limit:1});assert.equal(attachmentPage.nextCursor,"1");
    const secondAttachmentPage=await rpc("thread/attachment/list",{threadId:thread.id,cursor:attachmentPage.nextCursor,limit:5});assert.deepEqual(secondAttachmentPage.data.map(item=>item.id),[created.attachment.id]);
    await rpc("thread/attachment/remove",{threadId:thread.id,attachmentType:"pull_request",identityKey:"pr-1"});
    assert.equal((await rpc("thread/attachment/list",{threadId:thread.id,limit:10})).data.length,1);
    const q1=await rpc("thread/queue/add",{threadId:thread.id,input:[{type:"text",text:"first"}],clientUserMessageId:"client-1"});
    const q2=await rpc("thread/queue/add",{threadId:thread.id,input:[{type:"text",text:"second"}],clientUserMessageId:"client-2"});
    let queue=await rpc("thread/queue/list",{threadId:thread.id,limit:1});assert.deepEqual(queue.data.map(item=>item.id),[q1.queuedSubmission.id]);assert.equal(queue.nextCursor,"1");
    queue=await rpc("thread/queue/list",{threadId:thread.id,cursor:queue.nextCursor,limit:2});assert.deepEqual(queue.data.map(item=>item.id),[q2.queuedSubmission.id]);
    const updated=await rpc("thread/queue/update",{threadId:thread.id,queuedSubmissionId:q2.queuedSubmission.id,input:[{type:"text",text:"second edited"}]});assert.equal(updated.queuedSubmission.clientUserMessageId,"client-2");assert.equal(updated.queuedSubmission.input[0].text,"second edited");
    await rpc("thread/queue/reorder",{threadId:thread.id,queuedSubmissionIds:[q2.queuedSubmission.id,q1.queuedSubmission.id]});
    queue=await rpc("thread/queue/list",{threadId:thread.id,limit:10});assert.deepEqual(queue.data.map(item=>item.id),[q2.queuedSubmission.id,q1.queuedSubmission.id]);
    await assert.rejects(rpc("thread/queue/reorder",{threadId:thread.id,queuedSubmissionIds:[q1.queuedSubmission.id]}),/every queued submission/i);
    const activeTurn=threadStore.addTurn(thread.id,{inputText:"active"});await assert.rejects(rpc("thread/queue/start",{threadId:thread.id,queuedSubmissionId:q2.queuedSubmission.id}),/active or pending turn/i);
    threadStore.finishTurn(thread.id,activeTurn.id);queue=await rpc("thread/queue/list",{threadId:thread.id,limit:10});assert.equal(queue.data.length,2,"failed queue start must not consume the draft");
    const deleted=await rpc("thread/queue/delete",{threadId:thread.id,queuedSubmissionId:q1.queuedSubmission.id});assert.equal(deleted.deleted,true);
    assert.equal((await rpc("thread/queue/list",{threadId:thread.id,limit:10})).data.length,1);
    const goalSet=await rpc("thread/goal/set",{threadId:thread.id,objective:"Ship the fixture safely",completionConditions:["Lifecycle tests pass"],constraints:["Keep compatibility"],tokenBudget:5000,timeBudgetMinutes:30,toolCallBudget:1,childAgentBudget:1,unexpected:"ignored"});
    assert.equal(goalSet.goal.objective,"Ship the fixture safely");assert.equal(goalSet.goal.tokenBudget,5000);assert.equal(goalSet.goal.tokensUsed,0);assert.equal(goalSet.goal.toolCallBudget,1);assert.equal(goalSet.goal.toolCallsUsed,0);assert.equal(goalSet.goal.childAgentBudget,1);assert.equal(goalSet.goal.tokenBudgetRemaining,5000);assert.equal(Object.prototype.hasOwnProperty.call(goalSet.goal,"unexpected"),false);
    const goalRead=await rpc("thread/goal/get",{threadId:thread.id});assert.equal(goalRead.goal.objective,"Ship the fixture safely");assert.deepEqual(goalRead.goal.completionConditions,["Lifecycle tests pass"]);
    const continuitySet=await rpc("thread/continuity/set",{threadId:thread.id,completedWork:["Implemented the fixture"],importantDecisions:["Keep compatibility"],pendingNextActions:["Run the final smoke test"]});
    assert.ok(continuitySet.continuity.meaningful);assert.ok(continuitySet.continuity.completedWork.includes("Implemented the fixture"));assert.ok(continuitySet.continuity.importantDecisions.includes("Keep compatibility"));
    const continuityRead=await rpc("thread/continuity/get",{threadId:thread.id});assert.ok(continuityRead.continuity.pendingNextActions.includes("Run the final smoke test"));
    const occupiedChild=threadStore.create({runtime:"claude",cwd:home,providerSessionId:"child-session"});threadStore.update(occupiedChild.id,{parentThreadId:thread.id,agentRole:"delegate"});
    const childLimited=await rpc("thread/goal/get",{threadId:thread.id});assert.equal(childLimited.goal.childAgentsUsed,1);assert.equal(childLimited.goal.childAgentBudgetRemaining,0);
    await assert.rejects(rpc("thread/delegate",{threadId:thread.id,task:"Must not reach the runtime",isolation:"inherit"}),/child-agent budget exhausted/i);
    threadStore.delete(occupiedChild.id);
    await assert.rejects(rpc("thread/goal/set",{threadId:thread.id,tokenBudget:-1}),/positive whole number/i);
    const toolTurn=threadStore.addTurn(thread.id,{inputText:"use one tool"});
    threadStore.addItem(thread.id,toolTurn.id,{id:"tool-budget-command",type:"commandExecution",status:"completed",command:["node","fixture.mjs"]});
    threadStore.finishTurn(thread.id,toolTurn.id);
    const toolLimited=await rpc("thread/goal/get",{threadId:thread.id});assert.equal(toolLimited.goal.toolCallsUsed,1);assert.equal(toolLimited.goal.toolCallBudgetRemaining,0);assert.equal(toolLimited.goal.budgetExhausted,true);
    await assert.rejects(rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"blocked by tool budget"}]}),/tool-call budget exhausted/i);
    const raisedTools=await rpc("thread/goal/set",{threadId:thread.id,toolCallBudget:2});assert.equal(raisedTools.goal.budgetExhausted,false);
    threadTokens=5000;
    await assert.rejects(rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"blocked direct work"}]}),/Goal budget exhausted/i);
    const queuedBeforeBudgetBlock=await rpc("thread/queue/list",{threadId:thread.id,limit:10});
    await assert.rejects(rpc("thread/queue/start",{threadId:thread.id,queuedSubmissionId:q2.queuedSubmission.id}),/Goal budget exhausted/i);
    const queuedAfterBudgetBlock=await rpc("thread/queue/list",{threadId:thread.id,limit:10});
    assert.deepEqual(queuedAfterBudgetBlock.data,queuedBeforeBudgetBlock.data,"budget-blocked queue start must not consume the draft");
    assert.ok(traces.some(event=>event.name==="goal.budget_blocked"&&event.category==="budget"&&event.status==="blocked"));
    const raisedGoal=await rpc("thread/goal/set",{threadId:thread.id,tokenBudget:6000});assert.equal(raisedGoal.goal.budgetExhausted,false);
    await assert.rejects(rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"allowed past budget gate"}]}),/fixture runtime unavailable/i);
    await rpc("thread/goal/clear",{threadId:thread.id});
    const clearedContinuity=await rpc("thread/continuity/clear",{threadId:thread.id});assert.equal(clearedContinuity.ok,true);assert.equal(clearedContinuity.continuity.completedWork.length,0);
    await assert.rejects(rpc("turn/start",{threadId:thread.id,input:[{type:"text",text:"allowed after clear"}]}),/fixture runtime unavailable/i);
    await rpc("thread/archive",{threadId:thread.id});
    await rpc("thread/unarchive",{threadId:thread.id});
    await rpc("thread/delete",{threadId:thread.id});
    const lifecycleMessages=()=>notifications.filter(message=>["thread/archived","thread/unarchived","thread/deleted"].includes(message.method));
    for(let attempt=0;attempt<50&&lifecycleMessages().length<3;attempt++)await new Promise(resolve=>setTimeout(resolve,10));
    const lifecycle=lifecycleMessages();
    assert.deepEqual(lifecycle.map(message=>message.method),["thread/archived","thread/unarchived","thread/deleted"]);
    assert.ok(notifications.filter(message=>message.method==="thread/queue/changed").length>=5);
    assert.ok(notifications.some(message=>message.method==="thread/goal/updated"&&message.params.goal?.objective==="Ship the fixture safely"));
    assert.ok(notifications.some(message=>message.method==="thread/continuity/updated"&&message.params.continuity?.importantDecisions?.includes("Keep compatibility")));
    assert.deepEqual(notifications.filter(message=>message.method==="thread/attachment/updated").map(message=>message.params.operation),["created","deleted"]);
    assert.ok(notifications.every(message=>message.params?.threadId===thread.id));
    assert.ok(traces.some(event=>event.direction==="client"&&event.method==="thread/archive"));
    assert.ok(traces.some(event=>event.direction==="runtime"&&event.method==="thread/archived"));
    assert.ok(traces.some(event=>event.direction==="runtime"&&event.method==="thread/deleted"));
  }finally{
    try{first.close()}catch{}try{second.close()}catch{}
    await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(home,{recursive:true,force:true});
  }
});
