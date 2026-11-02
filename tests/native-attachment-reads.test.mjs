import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { attachAgentRelay } from "../src/agent-relay.mjs";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";
import { AgentThreadStore } from "../src/agent-thread-store.mjs";
import { ContextEngine } from "../src/context-engine.mjs";
import { TrebellStateStore } from "../src/trebell-state.mjs";

// L10-8 (tour L10, 2026-11-02): Trebell Native could not read a document attached to its thread in Supervised (the default) or Read
// only. The composer extracted no text while Native was the harness, and Native's read tool refused the attachments folder in the
// Trebell home, which is outside the project, so Native asked the person to copy the files into the project. Now Native's line for
// an attached document names the text Trebell extracted, as every other harness's does, and its read tool opens the thread's own
// attachments and their text where they are, at every access level and without asking: only those exact files. Another thread's
// attachment beside them, a listing of their folder, a file elsewhere outside the project and every other tool stay as they were.

const FIXTURES=fileURLToPath(new URL("./fixtures/documents/",import.meta.url));
const DOCUMENT_FACT="VAULT-TEAL-1655",NOTES_FACT="NOTES-HAZEL-7724",OTHER_THREAD="OTHER-THREAD-SECRET-3141",OUTSIDE="OUTSIDE-SECRET-2718";

async function listen(server){
  await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));return server.address().port;
}
function client(ws){
  let id=0;const pending=new Map(),notifications=[],waiters=[];
  ws.on("message",raw=>{
    const message=JSON.parse(String(raw));
    if(message.id!=null&&pending.has(message.id)){
      const target=pending.get(message.id);pending.delete(message.id);message.error?target.reject(new Error(message.error.message)):target.resolve(message.result);return;
    }
    if(message.method){notifications.push(message);for(let index=waiters.length-1;index>=0;index--){const waiter=waiters[index];if(waiter.predicate(message)){waiters.splice(index,1);clearTimeout(waiter.timer);waiter.resolve(message)}}}
  });
  return {
    request(method,params={}){return new Promise((resolve,reject)=>{const requestId=++id;pending.set(requestId,{resolve,reject});ws.send(JSON.stringify({id:requestId,method,params}))})},
    waitFor(predicate,timeoutMs){const found=notifications.find(predicate);if(found)return Promise.resolve(found);return new Promise((resolve,reject)=>{const waiter={predicate,resolve,reject,timer:setTimeout(()=>{const index=waiters.indexOf(waiter);if(index>=0)waiters.splice(index,1);reject(new Error("Timed out waiting for relay notification"))},timeoutMs)};waiters.push(waiter)})},
  };
}

// A Native thread on a project. Trebell's home keeps an upload attached to this thread (a Word file, with the text the composer's
// check extracted beside it) and another thread's upload; the person's own notes, outside the project, are attached too. The
// scripted model makes one tool call per step of the turn's plan and notes what each request's newest user message said; the window
// declines every approval it is asked, so nothing that asks ever runs.
async function attachmentFixture(t){
  const root=await mkdtemp(join(tmpdir(),"trebell-native-attachment-reads-")),home=join(root,"home"),attachments=join(home,"attachments"),repo=join(root,"repo"),own=join(root,"own");
  await mkdir(join(repo,"src"),{recursive:true});await mkdir(attachments,{recursive:true});await mkdir(own,{recursive:true});
  await writeFile(join(repo,"src","app.js"),"export const answer = 42;\n");
  const document=join(attachments,"1761500000000-ab12cd34-report.docx"),notes=join(own,"notes.txt"),other=join(attachments,"1761500000001-cd34ef56-other.txt"),outside=join(root,"outside.txt");
  await copyFile(join(FIXTURES,"report.docx"),document);await writeFile(document+".txt","# Quarterly Harbor Report\n\nThe vault code is "+DOCUMENT_FACT+".\n");
  await writeFile(notes,"The notes word is "+NOTES_FACT+".\n");await writeFile(other,OTHER_THREAD+"\n");await writeFile(outside,OUTSIDE+"\n");
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  let plan=[],calls=0;const toolMessages=[],userMessages=[];
  const nativeProviderTurn=async request=>{
    calls++;
    const reply=(text,toolCalls=[])=>({id:"attachment-reads-"+calls,provider:request.provider,model:request.model,text,toolCalls,finishReason:toolCalls.length?"tool_calls":"stop",usage:{}});
    if(request.toolChoice==="none")return reply('{"status":"complete","unresolved":[],"reason":"Every planned call was made."}');
    const last=request.messages.at(-1);if(last?.role==="tool")toolMessages.push(JSON.stringify(last.content));
    const user=request.messages.findLast(message=>message?.role==="user");userMessages.push(typeof user?.content==="string"?user.content:(Array.isArray(user?.content)?user.content:[]).map(part=>part?.text||"").join("\n"));
    const next=plan.shift();
    return next?reply("",[{id:"call-"+calls,namespace:next.namespace,name:next.name,arguments:JSON.stringify(next.arguments||{})}]):reply("Done.");
  };
  const asked=[];let relay=null,server=null,ws=null,rpc=null;
  const open=async threadStore=>{
    server=createServer((_req,res)=>{res.writeHead(404);res.end()});
    relay=attachAgentRelay(server,{runtimeManager:new AgentRuntimeManager({state,env}),threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"test"});
    const port=await listen(server);ws=new WebSocket(`ws://127.0.0.1:${port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});
    rpc=client(ws);
    ws.on("message",raw=>{
      const message=JSON.parse(String(raw));if(message.method!=="item/tool/requestApproval")return;
      asked.push(message.params?.toolCall?.title+" "+JSON.stringify(message.params?.toolCall?.rawInput??{}));
      ws.send(JSON.stringify({id:message.id,result:{decision:"decline"}}));
    });
  };
  const shut=async()=>{try{ws?.close()}catch{}await relay?.close();await new Promise(resolve=>server?server.close(()=>resolve()):resolve())};
  t.after(async()=>{await shut();await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})});
  let threadStore=new AgentThreadStore(env);await open(threadStore);
  return {root,repo,document,notes,other,outside,attachments,
    async start(permissionProfile){return (await rpc.request("thread/start",{model:"model-a",modelProvider:"agentrouter",cwd:repo,projectless:false,permissionProfile})).thread},
    // One turn of the planned calls: the approvals it asked, each call's tool row, what the tools gave the model and what it was asked.
    async turn(thread,permissionProfile,steps,input=[{type:"text",text:"Run the planned calls"}]){
      plan=[...steps];const before={asked:asked.length,tools:toolMessages.length,users:userMessages.length};
      const started=(await rpc.request("turn/start",{threadId:thread.id,model:"model-a",modelProvider:"agentrouter",permissionProfile,input})).turn;
      await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===started.id,90_000);
      assert.equal(plan.length,0,"the turn made every planned call");
      const rows=threadStore.get(thread.id).turns.find(item=>item.id===started.id).items.filter(item=>item.type==="dynamicToolCall");
      return {asked:asked.slice(before.asked),rows,toolMessages:toolMessages.slice(before.tools),userMessages:userMessages.slice(before.users)};
    },
    // The server stops and starts again on the same home: the thread's session is made anew from what the thread keeps.
    async restart(){await shut();threadStore=new AgentThreadStore(env);await open(threadStore)},
  };
}

const read=path=>({namespace:"trebell_workspace",name:"read_file",arguments:{path}});
const escaped=text=>String(text).replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
const attachedInput=fixture=>[{type:"text",text:"What do my files say?"},{type:"mention",name:"report.docx",path:fixture.document},{type:"mention",name:"notes.txt",path:fixture.notes}];
function assertOnlyAttachedRead(result){
  for(const message of result.toolMessages)for(const secret of [OTHER_THREAD,OUTSIDE])assert.equal(message.includes(secret),false,"the model never sees "+secret+": "+message.slice(0,300));
}

for(const permissionProfile of ["supervised","read-only","edits","auto","full"]){
  test(`${permissionProfile}: Native is told of an attached document's text and reads the thread's attachments where they are, without asking`,{timeout:180_000},async t=>{
    const fixture=await attachmentFixture(t),thread=await fixture.start(permissionProfile);
    const result=await fixture.turn(thread,permissionProfile,[
      read(fixture.document+".txt"),
      read(fixture.notes),
      // The same file spelled with forward slashes, as a model may write a Windows path.
      read((fixture.document+".txt").replaceAll("\\","/")),
      read("src/app.js"),
      {namespace:"trebell_repo",name:"read_source",arguments:{path:fixture.document+".txt",startLine:3}},
      // The text's path written from the project, as a model may write it (tour L10's fix check, 2026-11-02 16:16Z).
      read(relative(fixture.repo,fixture.document+".txt")),
      {namespace:"trebell_repo",name:"read_source",arguments:{path:relative(fixture.repo,fixture.document+".txt").replaceAll("\\","/")}},
    ],attachedInput(fixture));
    assert.match(result.userMessages[0],new RegExp(`Attached resource: report\\.docx \\(${escaped(fixture.document)}\\), readable as text at ${escaped(fixture.document+".txt")}`),"the line names the document's text");
    assert.match(result.userMessages[0],new RegExp(`Attached resource: notes\\.txt \\(${escaped(fixture.notes)}\\)(?!, readable)`),"a plain file is named as before");
    assert.deepEqual(result.asked,[],"no read of an attachment asks");
    assert.deepEqual(result.rows.map(row=>row.success),[true,true,true,true,true,true,true],"every attachment was read, and the project's file too");
    assert.match(result.toolMessages[5],new RegExp(DOCUMENT_FACT),"a path from the project to the document's text reads it");
    assert.match(result.toolMessages[6],new RegExp(DOCUMENT_FACT));
    assert.match(result.toolMessages[0],new RegExp(DOCUMENT_FACT),"the document's text was read");
    assert.match(result.toolMessages[1],new RegExp(NOTES_FACT),"the person's own attached file was read");
    assert.match(result.toolMessages[2],new RegExp(DOCUMENT_FACT));
    assert.match(result.toolMessages[3],/answer = 42/);
    assert.match(result.toolMessages[4],new RegExp(`^"The vault code is ${DOCUMENT_FACT}\\.`),"read_source reads the text's lines from the third");
  });
}

test("Supervised and Read only: only the thread's own attachments are read outside the project, and no other tool reaches them",{timeout:180_000},async t=>{
  const fixture=await attachmentFixture(t);
  for(const permissionProfile of ["supervised","read-only"]){
    const thread=await fixture.start(permissionProfile);
    const result=await fixture.turn(thread,permissionProfile,[
      read(fixture.other),
      {namespace:"trebell_workspace",name:"list",arguments:{path:fixture.attachments}},
      read(fixture.outside),
      read(join(fixture.attachments,"..","attachments","1761500000001-cd34ef56-other.txt")),
      {namespace:"trebell_repo",name:"read_source",arguments:{path:fixture.other}},
      {namespace:"trebell_repo",name:"read_source",arguments:{path:fixture.outside}},
      {namespace:"trebell_repo",name:"search_code",arguments:{query:"VAULT",path:fixture.document+".txt"}},
      {namespace:"trebell_workspace",name:"write_file",arguments:{path:fixture.document+".txt",content:"overwritten"}},
      read(relative(fixture.repo,fixture.other)),
    ],attachedInput(fixture));
    assert.deepEqual(result.asked,[],`${permissionProfile}: a path out of the project is refused, not offered for approval`);
    assert.deepEqual(result.rows.map(row=>row.success),[false,false,false,false,false,false,false,false,false],`${permissionProfile}: none of them ran`);
    assertOnlyAttachedRead(result);
    assert.equal(result.toolMessages[6].includes(DOCUMENT_FACT),false,"a search does not reach an attachment");
    // A thread that has no attachment cannot read another thread's.
    const bare=await fixture.start(permissionProfile);
    const other=await fixture.turn(bare,permissionProfile,[read(fixture.document+".txt")]);
    assert.deepEqual(other.rows.map(row=>row.success),[false],`${permissionProfile}: another thread's attachment stays out of reach`);
    assert.equal(other.toolMessages.some(message=>message.includes(DOCUMENT_FACT)),false);
  }
});

// A document's text runs to 2,000,000 characters, more than the 1 MB one read_file gives: read_source reads any range of an attached
// file's lines, as it reads a project file's, so the end of a long document's text can be read too.
test("Supervised and Read only: a long document's text is read to its end with read_source, without asking",{timeout:180_000},async t=>{
  const fixture=await attachmentFixture(t);
  const lines=Array.from({length:12_000},(_,index)=>`Line ${index+1}. The tide came in and went out again along the old stone quay while the gulls argued over the nets.`);
  await writeFile(fixture.document+".txt",[...lines,"The last line holds END-OCHRE-9001.",""].join("\n"));
  for(const permissionProfile of ["supervised","read-only"]){
    const thread=await fixture.start(permissionProfile);
    const result=await fixture.turn(thread,permissionProfile,[
      {...read(fixture.document+".txt"),arguments:{path:fixture.document+".txt",max_bytes:1_048_576}},
      {namespace:"trebell_repo",name:"read_source",arguments:{path:fixture.document+".txt",startLine:11_995,maxLines:400}},
      {namespace:"trebell_repo",name:"read_source",arguments:{path:(fixture.document+".txt").replaceAll("\\","/"),startLine:1,endLine:3}},
      {namespace:"trebell_repo",name:"read_source",arguments:{path:fixture.document,startLine:1}},
    ],attachedInput(fixture));
    assert.deepEqual(result.asked,[],`${permissionProfile}: no read of an attachment asks`);
    assert.deepEqual(result.rows.map(row=>row.success),[true,true,true,false],`${permissionProfile}: the text's lines are read, the Word file's own bytes are not text`);
    assert.equal(result.toolMessages[0].includes("END-OCHRE-9001"),false,"one read_file gives the text's first megabyte only");
    assert.match(result.toolMessages[1],/^"Line 11995\. The tide[^]*Line 12000\. The tide[^]*The last line holds END-OCHRE-9001\./,"read_source reads the text's last lines");
    assert.match(result.toolMessages[2],/^"Line 1\. The tide[^]*Line 3\. The tide[^]*nets\."$/,"and the first three");
    assert.match(result.toolMessages[3],/binary/);
    assertOnlyAttachedRead(result);
  }
});

test("after a restart, a thread's earlier attachments and their text are still read where they are",{timeout:180_000},async t=>{
  const fixture=await attachmentFixture(t),thread=await fixture.start("supervised");
  await fixture.turn(thread,"supervised",[read(fixture.document+".txt")],attachedInput(fixture));
  await fixture.restart();
  const later=await fixture.turn(thread,"supervised",[read(fixture.document+".txt"),read(fixture.notes),read(fixture.other)],[{type:"text",text:"And again?"}]);
  assert.deepEqual(later.asked,[]);
  assert.deepEqual(later.rows.map(row=>row.success),[true,true,false],"the earlier message's attachments are still the thread's, and only they");
  assert.match(later.toolMessages[0],new RegExp(DOCUMENT_FACT));assert.match(later.toolMessages[1],new RegExp(NOTES_FACT));
  assertOnlyAttachedRead(later);
});
