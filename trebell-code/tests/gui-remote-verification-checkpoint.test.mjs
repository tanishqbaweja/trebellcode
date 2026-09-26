import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir,mkdtemp,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket,WebSocketServer } from "ws";
import { createGuiServer } from "../src/gui-server.mjs";
import { git } from "../src/git-service.mjs";

async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}
async function connect(url){const ws=new WebSocket(url);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});return ws}
function rpcClient(ws){let id=0;return (method,params={})=>new Promise((resolve,reject)=>{const requestId=++id,onMessage=raw=>{const message=JSON.parse(String(raw));if(message.id!==requestId)return;ws.off("message",onMessage);message.error?reject(new Error(message.error.message)):resolve(message.result)};ws.on("message",onMessage);ws.send(JSON.stringify({id:requestId,method,params}))})}
async function fakeCodexAppServer(port){
  const http=createServer(),wss=new WebSocketServer({noServer:true}),requests=[];http.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>ws.on("message",raw=>{const message=JSON.parse(String(raw));if(message.id==null||!message.method)return;requests.push(message);if(message.method==="turn/start")return ws.send(JSON.stringify({id:message.id,result:{turn:{id:"remote-repair-turn",status:"inProgress"}}}));ws.send(JSON.stringify({id:message.id,result:{}}))}));
  await new Promise((resolve,reject)=>http.listen(port,"127.0.0.1",resolve).once("error",reject));return {requests,async close(){for(const client of wss.clients)try{client.terminate()}catch{}wss.close();await new Promise(resolve=>http.close(resolve))}};
}

test("Codex verification repair checkpoints a thread-pinned environment before starting repair",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-codex-remote-checkpoint-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  await git(repo,["init"]);await git(repo,["config","user.email","verification@example.invalid"]);await git(repo,["config","user.name","Verification Test"]);await writeFile(join(repo,"file.txt"),"base\n");await git(repo,["add","."]);await git(repo,["commit","-m","base"]);await writeFile(join(repo,"file.txt"),"dirty before repair\n");
  const [port,appPort]=await Promise.all([freePort(),freePort()]),upstream=await fakeCodexAppServer(appPort),gui=await createGuiServer({port,appPort,mock:true,env:{...process.env,TREBELL_HOME:home}});const threadId="codex-pinned-env-repair";let ws;
  try{
    const environment=await fetch(gui.url+"/api/environments",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:"local-pinned",name:"Pinned local fixture",type:"local",cwd:repo})}).then(response=>response.json());assert.equal(environment.profile.id,"local-pinned");
    await fetch(gui.url+"/api/thread-meta",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({threadId,patch:{runtime:"codex",runtimeInstanceId:"codex-default",cwd:repo,environmentId:"local-pinned",active:false}})});
    const plan={risk:"medium",steps:[{id:"tests",kind:"tests",required:true,command:"npm test",reason:"Verify repair"}]};
    const failed=await fetch(gui.url+"/api/verification-records",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:"pinned-env-failure",threadId,turnId:"failed-turn",environmentId:"local-pinned",projectPath:repo,plan,evidence:[{stepId:"tests",status:"failed",exitCode:1}]})}).then(response=>response.json());assert.equal(failed.nextAction.action,"repair");
    ws=await connect(gui.url.replace(/^http/,"ws")+"/api/codex/ws");const rpc=rpcClient(ws),repaired=await rpc("thread/verification/repair",{threadId,recordId:"pinned-env-failure"});assert.equal(repaired.turn.id,"remote-repair-turn");
    const listed=await fetch(gui.url+"/api/checkpoints?threadId="+encodeURIComponent(threadId)).then(response=>response.json());assert.equal(listed.checkpoints.length,1);const checkpoint=listed.checkpoints[0];assert.equal(checkpoint.environmentId,"local-pinned");assert.equal(String(checkpoint.root).replace(/\\/g,"/"),String(repo).replace(/\\/g,"/"));assert.equal(checkpoint.turnId,"remote-repair-turn");
    const checkpointFile=(await git(repo,["show",checkpoint.commit+":file.txt"])).stdout;assert.equal(checkpointFile,"dirty before repair\n");
    const traces=await fetch(gui.url+"/api/traces?threadId="+encodeURIComponent(threadId)+"&category=checkpoint&limit=20").then(response=>response.json());assert.ok(traces.items.some(item=>item.name==="checkpoint.created"&&item.environmentId==="local-pinned"));assert.ok(traces.items.some(item=>item.name==="checkpoint.linked"&&item.turnId==="remote-repair-turn"));
    assert.ok(upstream.requests.some(message=>message.method==="turn/start"&&message.params?.threadId===threadId));
  }finally{try{ws?.close()}catch{}await gui.close();await upstream.close();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
});
