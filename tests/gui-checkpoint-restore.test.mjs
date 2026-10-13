import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { WebSocketServer } from "ws";
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

// A Codex thread in a managed worktree of its own with a checkpoint, then the turn's work on the files: one changed, one deleted, one
// staged and one added. files() reads what a person would check: each file and git status.
async function restoreFixture(prefix){
  const root=await mkdtemp(join(tmpdir(),prefix)),home=join(root,"home"),repo=join(root,"repo"),worktree=join(root,"worktree");
  await mkdir(repo,{recursive:true});
  await git(repo,["init"]);await git(repo,["config","user.email","trebell@example.test"]);await git(repo,["config","user.name","Trebell Test"]);await git(repo,["checkout","-b","main"]);
  for(const name of ["edited.txt","deleted.txt","staged.txt"])await writeFile(join(repo,name),"base\n");
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
