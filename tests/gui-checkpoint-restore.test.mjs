import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { createGuiServer } from "../src/gui-server.mjs";
import { git } from "../src/git-service.mjs";
import { TrebellStateStore } from "../src/trebell-state.mjs";

async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}
const THREAD="codex-restore-thread";

// A stand-in Codex app-server on the port a mock server is given. thread/read answers the status it holds; turn/start starts a turn
// (turn/started to every connection, then its answer), or waits with its answer while holdStarts is on. startTurn() starts one by
// itself, as Codex does for a goal's next turn.
async function fakeCodex(port){
  const http=createServer(),wss=new WebSocketServer({noServer:true}),requests=[],held=[];let status={type:"idle"},turns=0,holdStarts=false;
  http.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  const notify=(method,params)=>{for(const client of wss.clients)client.send(JSON.stringify({method,params}))};
  const start=()=>{const turn={id:"codex-turn-"+(++turns),status:"inProgress",items:[]};status={type:"active",activeFlags:[]};notify("turn/started",{threadId:THREAD,turn});return turn};
  wss.on("connection",ws=>ws.on("message",raw=>{
    const message=JSON.parse(String(raw));if(message.id==null||!message.method)return;requests.push(message);
    const reply=result=>ws.send(JSON.stringify({id:message.id,result}));
    if(message.method==="initialize")return reply({userAgent:"fake-codex-restore"});
    if(message.method==="thread/read"||message.method==="thread/resume")return reply({thread:{id:THREAD,status,turns:[]}});
    if(message.method==="turn/start"){if(holdStarts){held.push(()=>reply({turn:start()}));return}return reply({turn:start()})}
    reply({});
  }));
  await new Promise((resolve,reject)=>http.listen(port,"127.0.0.1",resolve).once("error",reject));
  return {requests,startTurn:start,hold(on){holdStarts=on},release(){for(const send of held.splice(0))send()},
    async close(){for(const client of wss.clients)try{client.terminate()}catch{}wss.close();await new Promise(resolve=>http.close(resolve))}};
}

// The app's Codex socket: requests by id, and the notices it is sent.
async function codexSocket(gui){
  const ws=new WebSocket(gui.url.replace(/^http/,"ws")+"/api/codex/ws"),seen=[];let nextId=1;
  ws.on("message",raw=>seen.push(JSON.parse(String(raw))));
  await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});
  const send=(method,params)=>{const id=nextId++;ws.send(JSON.stringify({id,method,params}));return id};
  const answer=async(id,timeoutMs=20_000)=>{for(const deadline=Date.now()+timeoutMs;Date.now()<deadline;await new Promise(resolve=>setTimeout(resolve,20))){const found=seen.find(message=>message.id===id&&!message.method);if(found)return found}throw new Error("no answer to request "+id)};
  const ask=async(method,params)=>answer(send(method,params));
  await ask("initialize",{clientInfo:{name:"test",version:"0"}});ws.send(JSON.stringify({method:"initialized",params:{}}));
  return {ws,seen,send,answer,ask};
}

// A Codex thread in a managed worktree of its own with a checkpoint, then the turn's work on the files: one changed, one deleted, one
// staged and one added. files() reads what a person would check: each file and git status.
async function restoreFixture(prefix,{many=0}={}){
  const root=await mkdtemp(join(tmpdir(),prefix)),home=join(root,"home"),repo=join(root,"repo"),worktree=join(root,"worktree");
  await mkdir(repo,{recursive:true});
  await git(repo,["init"]);await git(repo,["config","user.email","trebell@example.test"]);await git(repo,["config","user.name","Trebell Test"]);await git(repo,["checkout","-b","main"]);
  for(const name of ["edited.txt","deleted.txt","staged.txt"])await writeFile(join(repo,name),"base\n");
  // many: extra files, so that a restore takes a moment as a real project's does.
  if(many){await mkdir(join(repo,"many"),{recursive:true});for(let index=0;index<many;index++)await writeFile(join(repo,"many",`file-${index}.txt`),"base "+index+"\n")}
  await git(repo,["add","."]);await git(repo,["commit","-m","Base"]);await git(repo,["branch","feature"]);await git(repo,["worktree","add",worktree,"feature"]);
  const env={...process.env,TREBELL_HOME:home,OPENAI_API_KEY:"",ANTHROPIC_API_KEY:"",GEMINI_API_KEY:"",GOOGLE_API_KEY:""};
  const state=new TrebellStateStore(env);
  state.touchProject(worktree,{managedWorktree:{root:repo,branch:"feature",baseBranch:"main",submodules:"none",createdAt:Date.now(),cleanedAt:null}});
  state.updateThreadMeta(THREAD,{cwd:worktree,runtime:"codex",runtimeInstanceId:"codex-default",environmentId:null,archived:false});
  state.close();
  const [port,appPort]=await Promise.all([freePort(),freePort()]),codex=await fakeCodex(appPort);
  const gui=await createGuiServer({port,appPort,mock:true,env});
  const post=(path,body)=>fetch(gui.url+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}).then(async response=>({status:response.status,body:await response.json()}));
  const checkpoint=(await post("/api/checkpoints",{cwd:worktree,threadId:THREAD,label:"Before the turn"})).body;
  assert.equal(checkpoint.supported,true);
  await writeFile(join(worktree,"edited.txt"),"turn work\n");await rm(join(worktree,"deleted.txt"));
  await writeFile(join(worktree,"staged.txt"),"staged work\n");await git(worktree,["add","staged.txt"]);await writeFile(join(worktree,"added.txt"),"new file\n");
  for(let index=0;index<many;index++)await writeFile(join(worktree,"many",`file-${index}.txt`),"turn work "+index+"\n");
  const files=async()=>{
    const out={};for(const name of ["edited.txt","deleted.txt","staged.txt","added.txt"])out[name]=await readFile(join(worktree,name),"utf8").catch(()=>null);
    out.status=(await git(worktree,["status","--porcelain=v1","--untracked-files=all"])).stdout;return out;
  };
  return {root,worktree,gui,codex,checkpoint,post,files,async close(){await gui.close().catch(()=>{});await codex.close();await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100})}};
}

// Edit from here restores the files, then rewinds the conversation. A rewind the harness refuses takes the restore back
// (/api/checkpoints/undo): every file is as it was before Edit from here, once.
test("a file restore Edit from here takes back leaves every file as it was before it",async()=>{
  const fixture=await restoreFixture("trebell-gui-restore-undo-");
  try{
    const before=await fixture.files();
    const restored=await fixture.post("/api/checkpoints/restore",{id:fixture.checkpoint.id,threadId:THREAD});
    assert.equal(restored.status,200,JSON.stringify(restored.body));assert.ok(restored.body.undoId,"the restore can be taken back");
    assert.equal((await fixture.files())["edited.txt"],"base\n");
    const refused=await fixture.post("/api/checkpoints/undo",{undoId:restored.body.undoId,threadId:"another-thread"});
    assert.equal(refused.status,400);
    const undone=await fixture.post("/api/checkpoints/undo",{undoId:restored.body.undoId,threadId:THREAD});
    assert.equal(undone.status,200,JSON.stringify(undone.body));
    assert.deepEqual(await fixture.files(),before);
    assert.equal((await fixture.post("/api/checkpoints/undo",{undoId:restored.body.undoId,threadId:THREAD})).status,400,"a restore is taken back once");
  }finally{await fixture.close()}
});

// The app reads the Codex thread (thread/read) before it restores any file. A turn that starts after that read, from another window,
// is refused by the restore itself: no file changes.
test("a Codex turn another window started after the app's thread/read gets no files restored under it",async()=>{
  const fixture=await restoreFixture("trebell-gui-restore-codex-started-");
  let shown=null,other=null;
  try{
    shown=await codexSocket(fixture.gui);other=await codexSocket(fixture.gui);
    const read=await shown.ask("thread/read",{threadId:THREAD,includeTurns:false});
    assert.equal(read.result.thread.status.type,"idle");
    const started=await other.ask("turn/start",{threadId:THREAD,input:[{type:"text",text:"Keep working on the files"}]});
    assert.ok(!started.error,JSON.stringify(started.error));
    const before=await fixture.files();
    const restored=await fixture.post("/api/checkpoints/restore",{id:fixture.checkpoint.id,threadId:THREAD});
    assert.deepEqual(await fixture.files(),before,"no file is restored under the running turn");
    assert.equal(restored.status,409,JSON.stringify(restored.body));assert.equal(restored.body.error,"Stop the running turn first.");
  }finally{for(const socket of [shown,other])try{socket?.ws.terminate()}catch{}await fixture.close()}
});

// The same for a turn whose start is still on its way to Codex (sent, not answered yet).
test("a Codex turn start still on its way when the restore comes gets no files restored under it",async()=>{
  const fixture=await restoreFixture("trebell-gui-restore-codex-starting-");
  let shown=null,other=null;
  try{
    shown=await codexSocket(fixture.gui);other=await codexSocket(fixture.gui);
    assert.equal((await shown.ask("thread/read",{threadId:THREAD,includeTurns:false})).result.thread.status.type,"idle");
    fixture.codex.hold(true);
    const pending=other.send("turn/start",{threadId:THREAD,input:[{type:"text",text:"Keep working on the files"}]});
    for(const deadline=Date.now()+10_000;!fixture.codex.requests.some(message=>message.method==="turn/start")&&Date.now()<deadline;)await new Promise(resolve=>setTimeout(resolve,20));
    const before=await fixture.files();
    const restored=await fixture.post("/api/checkpoints/restore",{id:fixture.checkpoint.id,threadId:THREAD});
    assert.deepEqual(await fixture.files(),before,"no file is restored under the turn that is starting");
    assert.equal(restored.status,409,JSON.stringify(restored.body));assert.equal(restored.body.error,"Stop the running turn first.");
    fixture.codex.release();assert.ok(!(await other.answer(pending)).error);
  }finally{for(const socket of [shown,other])try{socket?.ws.terminate()}catch{}await fixture.close()}
});

// A turn Codex starts by itself (a goal's next turn) while the files go back: once the restore sees it, it puts every file back as it
// was and refuses. Whether the turn starts before the restore begins or while it runs, no file stays changed under it.
test("a Codex turn that starts while the files are being restored leaves every file as it was",async()=>{
  const fixture=await restoreFixture("trebell-gui-restore-codex-during-");
  let shown=null;
  try{
    shown=await codexSocket(fixture.gui);
    assert.equal((await shown.ask("thread/read",{threadId:THREAD,includeTurns:false})).result.thread.status.type,"idle");
    const before=await fixture.files();
    const restoring=fixture.post("/api/checkpoints/restore",{id:fixture.checkpoint.id,threadId:THREAD});
    await new Promise(resolve=>setTimeout(resolve,40));fixture.codex.startTurn();
    const restored=await restoring;
    assert.deepEqual(await fixture.files(),before,"every file is as it was");
    assert.equal(restored.status,409,JSON.stringify(restored.body));assert.equal(restored.body.error,"Stop the running turn first.");
  }finally{try{shown?.ws.terminate()}catch{}await fixture.close()}
});

// Verification's next turn (thread/verification/continue, and thread/verification/repair) is a turn the server starts itself, with
// its own turn/start to Codex: another window's, or the auto verification flow's. One on its way when the restore comes refuses the
// restore, and one asked for while the files go back is refused, as a turn start is.
const verificationPlan={risk:"medium",steps:[{id:"diagnostics",kind:"diagnostics",scope:"changed",cost:"low",required:true,reason:"Check syntax"},{id:"tests",kind:"tests",scope:"affected",cost:"medium",required:true,command:"npm test",reason:"Run affected tests"}]};
const verificationRecord=(fixture,method)=>fixture.post("/api/verification-records",{id:"restore-record",threadId:THREAD,turnId:"user-turn",projectPath:fixture.worktree,plan:verificationPlan,evidence:[{stepId:"diagnostics",status:method==="thread/verification/repair"?"failed":"passed",rawOutput:method==="thread/verification/repair"?"error: syntax":"ok"}]});
for(const method of ["thread/verification/continue","thread/verification/repair"])test(`a verification turn on its way (${method}) gets no files restored under it`,async()=>{
  const fixture=await restoreFixture("trebell-gui-restore-verification-starting-");
  let shown=null,other=null;
  try{
    await verificationRecord(fixture,method);
    shown=await codexSocket(fixture.gui);other=await codexSocket(fixture.gui);
    assert.equal((await shown.ask("thread/read",{threadId:THREAD,includeTurns:false})).result.thread.status.type,"idle");
    assert.equal((await other.ask("thread/verification/get",{threadId:THREAD})).result.nextAction.action,method==="thread/verification/repair"?"repair":"verify");
    fixture.codex.hold(true);
    const pending=other.send(method,{threadId:THREAD,recordId:"restore-record",auto:true});
    for(const deadline=Date.now()+20_000;!fixture.codex.requests.some(message=>message.method==="turn/start")&&Date.now()<deadline;)await new Promise(resolve=>setTimeout(resolve,20));
    assert.ok(fixture.codex.requests.some(message=>message.method==="turn/start"),"the verification's turn start reached Codex");
    const before=await fixture.files();
    const restored=await fixture.post("/api/checkpoints/restore",{id:fixture.checkpoint.id,threadId:THREAD});
    assert.deepEqual(await fixture.files(),before,"no file is restored under the verification turn that is starting");
    assert.equal(restored.status,409,JSON.stringify(restored.body));assert.equal(restored.body.error,"Stop the running turn first.");
    fixture.codex.release();assert.ok(!(await other.answer(pending)).error);
  }finally{for(const socket of [shown,other])try{socket?.ws.terminate()}catch{}await fixture.close()}
});

test("a verification turn asked for while Edit from here restores the files is refused like a turn start",{timeout:240_000},async()=>{
  const fixture=await restoreFixture("trebell-gui-restore-verification-during-",{many:300});
  let shown=null,other=null;
  try{
    await verificationRecord(fixture,"thread/verification/continue");
    shown=await codexSocket(fixture.gui);other=await codexSocket(fixture.gui);
    assert.equal((await shown.ask("thread/read",{threadId:THREAD,includeTurns:false})).result.thread.status.type,"idle");
    assert.equal((await other.ask("thread/verification/get",{threadId:THREAD})).result.nextAction.action,"verify");
    let restoreSettledAt=null;
    const restoring=fixture.post("/api/checkpoints/restore",{id:fixture.checkpoint.id,threadId:THREAD}).then(result=>{restoreSettledAt=Date.now();return result});
    // Once the restore is writing the checkpoint's files (edited.txt reads the checkpoint's text), another window's auto verification
    // asks for the next verification turn.
    for(const deadline=Date.now()+120_000;Date.now()<deadline&&restoreSettledAt==null;await new Promise(resolve=>setTimeout(resolve,5))){
      if(await readFile(join(fixture.worktree,"edited.txt"),"utf8").catch(()=>null)==="base\n")break;
    }
    const continued=await other.ask("thread/verification/continue",{threadId:THREAD,recordId:"restore-record",auto:true});
    const answeredAt=Date.now(),restored=await restoring;
    const upstreamTurnStart=fixture.codex.requests.find(message=>message.method==="turn/start");
    console.log(JSON.stringify({continueAnsweredDuringRestore:answeredAt<restoreSettledAt,continued:continued.error||continued.result?.turn||null,restore:{status:restored.status,body:restored.body},upstreamTurnStart:Boolean(upstreamTurnStart)}));
    assert.ok(answeredAt<restoreSettledAt,"the verification request was answered while the restore still ran");
    assert.ok(continued.error,"the verification turn is refused while the thread's files go back: "+JSON.stringify(continued.result||null));
    assert.match(continued.error.message,/going back for Edit from here/);
    assert.equal(upstreamTurnStart,undefined,"no turn reached Codex while the files went back");
    assert.equal(restored.status,200,"and Edit from here's restore goes through: "+JSON.stringify(restored.body));
  }finally{for(const socket of [shown,other])try{socket?.ws.terminate()}catch{}await fixture.close()}
});

// A turn Codex starts by itself while the files go back writes a file at once: the restore refuses (409) and puts back what it
// changed, and the turn's new file is still there.
test("a Codex turn that starts while the files are being restored keeps the file it writes meanwhile",{timeout:240_000},async()=>{
  const fixture=await restoreFixture("trebell-gui-restore-turn-work-",{many:300});
  let shown=null;
  try{
    shown=await codexSocket(fixture.gui);
    assert.equal((await shown.ask("thread/read",{threadId:THREAD,includeTurns:false})).result.thread.status.type,"idle");
    const before=await fixture.files();
    let restoreSettledAt=null;
    const restoring=fixture.post("/api/checkpoints/restore",{id:fixture.checkpoint.id,threadId:THREAD}).then(result=>{restoreSettledAt=Date.now();return result});
    // Codex starts the turn once the restore is writing the checkpoint's files (edited.txt reads the checkpoint's text).
    for(const deadline=Date.now()+120_000;Date.now()<deadline&&restoreSettledAt==null;await new Promise(resolve=>setTimeout(resolve,5))){
      if(await readFile(join(fixture.worktree,"edited.txt"),"utf8").catch(()=>null)==="base\n")break;
    }
    fixture.codex.startTurn();
    const wroteAt=Date.now();await writeFile(join(fixture.worktree,"turn-output.txt"),"written by the running turn\n");
    const restored=await restoring;
    const output=await readFile(join(fixture.worktree,"turn-output.txt"),"utf8").catch(()=>null);
    console.log(JSON.stringify({turnWroteBeforeRestoreAnswered:wroteAt<restoreSettledAt,restore:{status:restored.status,body:restored.body},turnOutputAfter:output}));
    assert.ok(wroteAt<restoreSettledAt,"the turn wrote its file while the restore still ran");
    assert.equal(restored.status,409,JSON.stringify(restored.body));assert.equal(restored.body.filesPutBack,true);
    assert.equal(output,"written by the running turn\n","the running turn's file is still there");
    const {status:_status,...files}=await fixture.files(),{status:_before,...beforeFiles}=before;
    assert.deepEqual(files,beforeFiles,"and every file the restore changed is as it was");
  }finally{try{shown?.ws.terminate()}catch{}await fixture.close()}
});
