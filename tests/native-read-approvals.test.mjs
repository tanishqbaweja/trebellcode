import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { WebSocket } from "ws";
import { attachAgentRelay } from "../src/agent-relay.mjs";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";
import { AgentThreadStore } from "../src/agent-thread-store.mjs";
import { ContextEngine } from "../src/context-engine.mjs";
import { TrebellStateStore } from "../src/trebell-state.mjs";

// Trebell Native's Supervised and Auto-accept edits modes asked before every file read, where Codex (on-request), Claude Code and the
// ACP harnesses read without asking. Decided 2026-10-13: reads, listings and searches inside the thread's project root run without an
// approval in those two modes. A path that leads out of the root (by '..', an absolute path elsewhere, another drive, or a junction or
// symlink), desktop screenshots, browser capture and every other tool keep their approvals, and Read only is unchanged.

const SECRET="TREBELL-OUTSIDE-SECRET-7f3a";

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

// A Native thread on a project with a file inside it, a folder outside it, and a junction (a directory symlink elsewhere) in the
// project that points at that outside folder. The scripted model makes one tool call per step from the turn's plan; the window
// declines every approval it is asked, so nothing that asks ever runs.
async function readApprovalFixture(t,{permissionProfile,dynamicTools=[]}){
  const root=await mkdtemp(join(tmpdir(),"trebell-native-read-approvals-")),home=join(root,"home"),repo=join(root,"repo"),outside=join(root,"outside");
  await mkdir(join(repo,"src"),{recursive:true});await mkdir(outside,{recursive:true});
  await writeFile(join(repo,"src","app.js"),"export const answer = 42;\n");
  await writeFile(join(outside,"secret.txt"),SECRET+"\n");
  await symlink(outside,join(repo,"linked"),process.platform==="win32"?"junction":"dir");
  // A file symlink too, where the system lets this user make one (Windows asks for Developer Mode or an administrator).
  const fileLink=await symlink(join(outside,"secret.txt"),join(repo,"secret-link.txt"),"file").then(()=>true,()=>false);
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env);
  let calls=0,plan=[];const toolMessages=[];
  const nativeProviderTurn=async request=>{
    calls++;
    const reply=(text,toolCalls=[])=>({id:"read-approvals-"+calls,provider:request.provider,model:request.model,text,toolCalls,finishReason:toolCalls.length?"tool_calls":"stop",usage:{}});
    if(request.toolChoice==="none")return reply('{"status":"complete","unresolved":[],"reason":"Every planned call was made."}');
    const last=request.messages.at(-1);if(last?.role==="tool")toolMessages.push(JSON.stringify(last.content));
    const next=plan.shift();
    return next?reply("",[{id:"call-"+calls,namespace:next.namespace,name:next.name,arguments:JSON.stringify(next.arguments||{})}]):reply("Done.");
  };
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});
  const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"test"});
  const port=await listen(server),ws=new WebSocket(`ws://127.0.0.1:${port}/api/agent/ws`);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});
  const rpc=client(ws),asked=[];
  ws.on("message",raw=>{
    const message=JSON.parse(String(raw));if(message.method!=="item/tool/requestApproval")return;
    asked.push(message.params?.toolCall?.title+" "+JSON.stringify(message.params?.toolCall?.rawInput??{}));
    ws.send(JSON.stringify({id:message.id,result:{decision:"decline"}}));
  });
  t.after(async()=>{try{ws.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})});
  const thread=(await rpc.request("thread/start",{model:"model-a",modelProvider:"agentrouter",cwd:repo,projectless:false,permissionProfile,dynamicTools})).thread;
  // One turn of the planned calls: the approvals it asked, and each call's tool row once the turn ended.
  const turn=async(steps)=>{
    plan=[...steps];const before=asked.length,toolsBefore=toolMessages.length;
    const started=(await rpc.request("turn/start",{threadId:thread.id,model:"model-a",modelProvider:"agentrouter",permissionProfile,input:[{type:"text",text:"Run the planned calls"}]})).turn;
    await rpc.waitFor(message=>message.method==="turn/completed"&&message.params?.turn?.id===started.id,90_000);
    assert.equal(plan.length,0,"the turn made every planned call");
    const rows=threadStore.get(thread.id).turns.find(item=>item.id===started.id).items.filter(item=>item.type==="dynamicToolCall");
    return {asked:asked.slice(before),rows,toolMessages:toolMessages.slice(toolsBefore)};
  };
  return {root,repo,outside,fileLink,turn};
}

const call=(namespace,name,args={})=>({namespace,name,arguments:args});
const row=(rows,namespace,tool,index=0)=>rows.filter(item=>item.namespace===namespace&&item.tool===tool)[index];
const otherDrive=root=>{const drive=parse(root).root.slice(0,1).toUpperCase();return (drive==="Q"?"R":"Q")+":/outside/secret.txt"};
function assertNothingOutsideRead(result){
  for(const message of result.toolMessages)assert.equal(message.includes(SECRET),false,"the model never sees the outside file: "+message.slice(0,300));
  for(const item of result.rows)assert.equal(JSON.stringify(item).includes(SECRET),false,"no tool row shows the outside file");
}

test("Supervised: reading, listing and searching inside the project run without an approval",{timeout:180_000},async t=>{
  const fixture=await readApprovalFixture(t,{permissionProfile:"supervised"});
  const inside=await fixture.turn([
    call("trebell_workspace","read_file",{path:"src/app.js"}),
    call("trebell_workspace","list",{path:"."}),
    call("trebell_workspace","list"),
    call("trebell_repo","search_code",{query:"answer"}),
    call("trebell_repo","search_files",{query:"app"}),
    call("trebell_repo","search_symbols",{query:"answer"}),
    call("trebell_repo","read_source",{path:"src/app.js"}),
    call("trebell_workspace","read_file",{path:join(fixture.repo,"src","app.js")}),
    call("trebell_workspace","read_file",{path:"/src/app.js"}),
    call("trebell_workspace","read_file",{path:"docs/not-there.md"}),
  ]);
  assert.deepEqual(inside.asked,[],"no read, listing or search inside the project asks");
  assert.equal(row(inside.rows,"trebell_workspace","read_file").success,true);
  assert.match(inside.toolMessages[0],/answer = 42/,"the file was read");
  assert.equal(row(inside.rows,"trebell_workspace","list").success,true);
  assert.equal(row(inside.rows,"trebell_workspace","list",1).success,true);
  assert.equal(row(inside.rows,"trebell_repo","search_code").success,true);
  assert.match(inside.toolMessages[3],/answer = 42/,"the search found the line");
  assert.equal(row(inside.rows,"trebell_repo","search_files").success,true);
  assert.equal(row(inside.rows,"trebell_repo","search_symbols").success,true);
  assert.equal(row(inside.rows,"trebell_repo","read_source").success,true);
  assert.equal(row(inside.rows,"trebell_workspace","read_file",1).success,true,"an absolute path inside the project is inside");
  assert.equal(row(inside.rows,"trebell_workspace","read_file",2).success,true,"a path from the project root's / is inside");
  assert.equal(row(inside.rows,"trebell_workspace","read_file",3).success,false,"a file that is not there is read as not found, without asking");
});

test("Supervised: a read outside the project never runs without the person, by '..', an absolute path elsewhere or another drive",{timeout:180_000},async t=>{
  const fixture=await readApprovalFixture(t,{permissionProfile:"supervised"});
  const escaping=await fixture.turn([
    call("trebell_workspace","read_file",{path:"../outside/secret.txt"}),
    call("trebell_workspace","read_file",{path:"src/../../outside/secret.txt"}),
    call("trebell_workspace","read_file",{path:join(fixture.outside,"secret.txt")}),
    call("trebell_workspace","list",{path:"../outside"}),
    call("trebell_repo","read_source",{path:"../outside/secret.txt"}),
    call("trebell_workspace","read_file",{path:otherDrive(fixture.root)}),
  ]);
  // These were refused before any approval, as they are in every mode but Full access: Native's workspace tools never reach outside.
  assert.deepEqual(escaping.asked,[],"a path out of the project is refused, not offered for approval");
  for(const item of escaping.rows)assert.equal(item.success,false,`${item.namespace}/${item.tool} did not run`);
  assert.equal(escaping.rows.length,6);
  assertNothingOutsideRead(escaping);
});

test("Supervised: a read through a junction or symlink that leads out of the project still asks",{timeout:180_000},async t=>{
  const fixture=await readApprovalFixture(t,{permissionProfile:"supervised"});
  const steps=[
    call("trebell_workspace","read_file",{path:"linked/secret.txt"}),
    call("trebell_workspace","list",{path:"linked"}),
    call("trebell_repo","read_source",{path:"linked/secret.txt"}),
    call("trebell_workspace","read_file",{path:"linked/not-there.txt"}),
    ...(fixture.fileLink?[call("trebell_workspace","read_file",{path:"secret-link.txt"}),call("trebell_repo","read_source",{path:"secret-link.txt"})]:[]),
  ];
  const linked=await fixture.turn(steps);
  assert.equal(linked.asked.length,steps.length,"each read through a link asks: "+JSON.stringify(linked.asked));
  assert.match(linked.asked[0],/^trebell_workspace\/read_file .*linked\/secret\.txt/);
  assert.match(linked.asked[1],/^trebell_workspace\/list .*linked/);
  assert.match(linked.asked[2],/^trebell_repo\/read_source .*linked\/secret\.txt/);
  assert.match(linked.asked[3],/^trebell_workspace\/read_file .*linked\/not-there\.txt/,"a file not made yet behind the link is placed by the link");
  if(fixture.fileLink){assert.match(linked.asked[4],/^trebell_workspace\/read_file .*secret-link\.txt/);assert.match(linked.asked[5],/^trebell_repo\/read_source .*secret-link\.txt/)}
  for(const item of linked.rows)assert.equal(item.success,false,`${item.namespace}/${item.tool} did not run once declined`);
  assertNothingOutsideRead(linked);
});

test("Supervised: writes, desktop screenshots and browser capture still ask",{timeout:180_000},async t=>{
  const fixture=await readApprovalFixture(t,{permissionProfile:"supervised",dynamicTools:[{type:"namespace",name:"trebell_browser"},{type:"namespace",name:"trebell_computer"}]});
  const others=await fixture.turn([
    call("trebell_workspace","write_file",{path:"notes.txt",content:"written"}),
    call("trebell_workspace","replace_text",{path:"src/app.js",old_text:"42",new_text:"43"}),
    call("trebell_computer","screenshot"),
    call("trebell_browser","screenshot"),
    call("trebell_browser","snapshot"),
  ]);
  assert.deepEqual(others.asked.map(text=>text.split(" ")[0]),["trebell_workspace/write_file","trebell_workspace/replace_text","trebell_computer/screenshot","trebell_browser/screenshot","trebell_browser/snapshot"]);
  for(const item of others.rows)assert.equal(item.success,false,`${item.namespace}/${item.tool} did not run once declined`);
  assert.equal(await readFile(join(fixture.repo,"notes.txt"),"utf8").then(()=>true,()=>false),false,"the declined write wrote nothing");
  assert.equal(await readFile(join(fixture.repo,"src","app.js"),"utf8"),"export const answer = 42;\n");
});

test("Auto-accept edits: reads inside the project need no approval, writes run as before, and commands and links still ask",{timeout:180_000},async t=>{
  const fixture=await readApprovalFixture(t,{permissionProfile:"edits"});
  const result=await fixture.turn([
    call("trebell_workspace","read_file",{path:"src/app.js"}),
    call("trebell_repo","search_code",{query:"answer"}),
    call("trebell_workspace","write_file",{path:"notes.txt",content:"written"}),
    call("trebell_workspace","read_file",{path:"linked/secret.txt"}),
    call("trebell_terminal","run",{command:process.execPath,args:["-e","process.stdout.write('ran')"]}),
  ]);
  assert.deepEqual(result.asked.map(text=>text.split(" ")[0]),["trebell_workspace/read_file","trebell_terminal/run"],"only the read through the link and the command ask");
  assert.match(result.asked[0],/linked\/secret\.txt/);
  assert.equal(row(result.rows,"trebell_workspace","read_file").success,true);
  assert.equal(row(result.rows,"trebell_repo","search_code").success,true);
  assert.equal(row(result.rows,"trebell_workspace","write_file").success,true,"a write inside the project runs without asking, as before");
  assert.equal(await readFile(join(fixture.repo,"notes.txt"),"utf8"),"written");
  assert.equal(row(result.rows,"trebell_workspace","read_file",1).success,false);
  assert.equal(row(result.rows,"trebell_terminal","run").success,false);
  assertNothingOutsideRead(result);
});

test("Read only: reads run and writes are refused, as before",{timeout:180_000},async t=>{
  const fixture=await readApprovalFixture(t,{permissionProfile:"read-only"});
  const result=await fixture.turn([
    call("trebell_workspace","read_file",{path:"src/app.js"}),
    call("trebell_workspace","list"),
    call("trebell_repo","search_code",{query:"answer"}),
    call("trebell_workspace","write_file",{path:"notes.txt",content:"written"}),
    call("trebell_workspace","read_file",{path:"../outside/secret.txt"}),
  ]);
  assert.deepEqual(result.asked,[],"Read only asks nothing");
  assert.equal(row(result.rows,"trebell_workspace","read_file").success,true);
  assert.equal(row(result.rows,"trebell_workspace","list").success,true);
  assert.equal(row(result.rows,"trebell_repo","search_code").success,true);
  assert.equal(row(result.rows,"trebell_workspace","write_file").success,false,"the write is refused");
  assert.equal(await readFile(join(fixture.repo,"notes.txt"),"utf8").then(()=>true,()=>false),false);
  assert.equal(row(result.rows,"trebell_workspace","read_file",1).success,false);
  assertNothingOutsideRead(result);
});
