import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { createGuiServer } from "../src/gui-server.mjs";
import { git, gitInfo } from "../src/git-service.mjs";
import { TrebellStateStore } from "../src/trebell-state.mjs";
import { createLiveSmokeGuard } from "../src/live-smoke-policy.mjs";

const MODEL=process.env.VYCE_MODEL||"deepseek-v4.1";
const PROOF="TREBELL_BACKGROUND_OK_9217";
const liveGuard=createLiveSmokeGuard({provider:"vyceai",model:MODEL,runtime:"codex",maxTurns:1,timeoutMs:180_000});

async function freePort(){
  const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}
function wait(ms){return new Promise(resolve=>setTimeout(resolve,ms))}
function decodeText(buffer){
  if(!Buffer.isBuffer(buffer))return String(buffer||"");
  if(buffer.length>=2&&buffer[0]===0xff&&buffer[1]===0xfe)return buffer.subarray(2).toString("utf16le");
  if(buffer.length>=2&&buffer[0]===0xfe&&buffer[1]===0xff){
    const swapped=Buffer.allocUnsafe(buffer.length-2);
    for(let i=2;i+1<buffer.length;i+=2){swapped[i-2]=buffer[i+1];swapped[i-1]=buffer[i]}
    return swapped.toString("utf16le");
  }
  return buffer.toString("utf8");
}
class Rpc{
  constructor(ws){this.ws=ws;this.next=1;this.pending=new Map();this.waiters=[];ws.on("message",data=>this.onMessage(data))}
  request(method,params={}){const id=this.next++;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(method+" timed out"))},180000);this.pending.set(id,{resolve,reject,timer});this.ws.send(JSON.stringify({id,method,params}))})}
  waitFor(predicate,timeout=180000){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.waiters=this.waiters.filter(item=>item.resolve!==resolve);reject(new Error("notification wait timed out"))},timeout);this.waiters.push({predicate,resolve,reject,timer})})}
  respond(id,result){this.ws.send(JSON.stringify({id,result}))}
  async onMessage(data){
    let msg;try{msg=JSON.parse(String(data))}catch{return}
    if(msg.id!=null&&this.pending.has(msg.id)){const entry=this.pending.get(msg.id);this.pending.delete(msg.id);clearTimeout(entry.timer);return msg.error?entry.reject(new Error(msg.error.message||JSON.stringify(msg.error))):entry.resolve(msg.result)}
    if(msg.id!=null&&msg.method){
      if(msg.method.includes("requestApproval")||msg.method==="applyPatchApproval"||msg.method==="execCommandApproval")return this.respond(msg.id,{decision:"accept"});
      if(msg.method==="item/tool/requestUserInput")return this.respond(msg.id,{answers:{}});
      return this.respond(msg.id,null);
    }
    if(msg.method)for(const waiter of [...this.waiters])if(waiter.predicate(msg)){this.waiters=this.waiters.filter(item=>item!==waiter);clearTimeout(waiter.timer);waiter.resolve(msg)}
  }
}

const key=String(process.env.VYCEAI_API_KEY||process.env.VYCE_API_KEY||"").trim();
if(!key)throw new Error("VYCEAI_API_KEY or VYCE_API_KEY is missing");

const root=await mkdtemp(join(tmpdir(),"trebell-vyce-background-"));
const repo=join(root,"repo"),worktree=join(root,"worktree"),home=join(root,"state");
let gui=null,ws=null;
try{
  await import("node:fs/promises").then(fs=>fs.mkdir(repo,{recursive:true}));
  await git(repo,["init"]);await git(repo,["config","user.email","trebell@example.test"]);await git(repo,["config","user.name","Trebell Live Test"]);
  await writeFile(join(repo,"README.md"),"background isolation fixture\n","utf8");await git(repo,["add","README.md"]);await git(repo,["commit","-m","fixture"]);
  const base=(await gitInfo(repo)).branch;assert.ok(base,"fixture branch missing");

  const env={...process.env,VYCEAI_API_KEY:key,TREBELL_HOME:home};new TrebellStateStore(env).updateSettings({modelProvider:"vyceai",worktreeSubmodules:"none"});
  const [port,appPort]=await Promise.all([freePort(),freePort()]);gui=await createGuiServer({port,appPort,mock:false,env});
  let boot=null;for(let i=0;i<120;i++){boot=await fetch(gui.url+"/api/bootstrap").then(r=>r.json()).catch(()=>null);if(boot?.appServerReady)break;await wait(250)}
  assert.equal(boot?.appServerReady,true,"Codex app-server never became ready");

  const created=await fetch(gui.url+"/api/git/action",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"worktree-create",cwd:repo,branch:"trebell/live-background",path:worktree,baseBranch:base})}).then(async r=>{const body=await r.json();if(!r.ok)throw new Error(body.error||JSON.stringify(body));return body});
  assert.equal(created.result?.worktree,worktree);assert.equal((await gitInfo(worktree)).branch,"trebell/live-background");

  ws=new WebSocket(boot.wsUrl,{origin:gui.url});await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("relay websocket timed out")),15000);ws.once("open",()=>{clearTimeout(timer);resolve()});ws.once("error",reject)});
  const rpc=new Rpc(ws);await rpc.request("initialize",{clientInfo:{name:"trebell-live-background",title:"Trebell Live Background",version:"1.2.0-test"},capabilities:{experimentalApi:true}});ws.send(JSON.stringify({method:"initialized",params:{}}));
  const thread=await rpc.request("thread/start",{model:MODEL,modelProvider:"vyceai",cwd:worktree,approvalPolicy:"never",sandbox:"danger-full-access",ephemeral:false,threadSource:"trebell-live-background"});assert.ok(thread.thread?.id);
  liveGuard.consumeTurn("background agent turn");
  const turn=await liveGuard.withTimeout(rpc.request("turn/start",{threadId:thread.thread.id,model:MODEL,cwd:worktree,approvalPolicy:"never",sandboxPolicy:{type:"dangerFullAccess"},input:[{type:"text",text:`Use your shell/file tools. Create background-proof.txt in the current workspace containing exactly ${PROOF} and nothing else. Read it back, verify it, then reply exactly BACKGROUND_DONE.`,text_elements:[]}]}),"background agent turn");assert.ok(turn.turn?.id);
  const completed=await rpc.waitFor(msg=>msg.method==="turn/completed"&&(msg.params?.turn?.id===turn.turn.id||msg.params?.turnId===turn.turn.id));
  assert.equal(completed.params?.turn?.status||completed.params?.status,"completed");
  assert.equal(decodeText(await readFile(join(worktree,"background-proof.txt"))).trim(),PROOF);
  await assert.rejects(()=>readFile(join(repo,"background-proof.txt"),"utf8"),/ENOENT|no such file/i);
  console.log(JSON.stringify({ok:true,provider:"vyceai",model:MODEL,isolatedWorktree:true,branch:"trebell/live-background",proof:PROOF,turnStatus:"completed",fingerprint:liveGuard.fingerprint()},null,2));
}finally{
  try{ws?.close()}catch{};if(gui)await gui.close().catch(()=>{});await rm(root,{recursive:true,force:true,maxRetries:30,retryDelay:100});
}
