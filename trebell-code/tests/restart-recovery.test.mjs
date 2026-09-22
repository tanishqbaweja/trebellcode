import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrebellStateStore } from "../src/trebell-state.mjs";
import { createGuiServer } from "../src/gui-server.mjs";

async function freePort(){
  const server=createServer();await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}

test("Codex stale active markers become recoverable only when restart continuation is enabled",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-codex-recovery-"));const env={...process.env,TREBELL_HOME:home};
  const state=new TrebellStateStore(env);state.updateSettings({continueThreadsAfterRestart:true});state.updateThreadMeta("thread-old",{restartRecovery:{runtime:"codex",bootId:"previous-boot",threadId:"thread-old",turnId:"turn-old",status:"active",startedAt:123}});
  const gui=await createGuiServer({port:await freePort(),appPort:await freePort(),mock:true,env});
  try{
    const pending=await fetch(gui.url+"/api/recovery").then(r=>r.json());assert.equal(pending.enabled,true);assert.deepEqual(pending.items.map(item=>({threadId:item.threadId,turnId:item.turnId})),[{threadId:"thread-old",turnId:"turn-old"}]);
    const cleared=await fetch(gui.url+"/api/recovery",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({threadId:"thread-old",action:"clear"})}).then(r=>r.json());assert.deepEqual(cleared.items,[]);
  }finally{await gui.close();await rm(home,{recursive:true,force:true,maxRetries:20,retryDelay:100})}
});

test("Codex stale active markers are not auto-recoverable when continuation is disabled",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-codex-no-recovery-"));const env={...process.env,TREBELL_HOME:home};
  const state=new TrebellStateStore(env);state.updateSettings({continueThreadsAfterRestart:false});state.updateThreadMeta("thread-old",{restartRecovery:{runtime:"codex",bootId:"previous-boot",threadId:"thread-old",turnId:"turn-old",status:"active"}});
  const gui=await createGuiServer({port:await freePort(),appPort:await freePort(),mock:true,env});
  try{
    const pending=await fetch(gui.url+"/api/recovery").then(r=>r.json());assert.equal(pending.enabled,false);assert.deepEqual(pending.items,[]);
    const persisted=new TrebellStateStore(env).threadMeta("thread-old").restartRecovery;assert.equal(persisted.status,"interrupted");assert.match(persisted.message,/interrupted by a Trebell restart/i);
  }finally{await gui.close();await rm(home,{recursive:true,force:true,maxRetries:20,retryDelay:100})}
});
