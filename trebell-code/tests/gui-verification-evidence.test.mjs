import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdir,mkdtemp,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createGuiServer } from "../src/gui-server.mjs";
import { EventJournal } from "../src/event-journal.mjs";

const execFileAsync=promisify(execFile);
async function freePort(){const server=createServer();await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}
async function git(cwd,args){return execFileAsync("git",args,{cwd,windowsHide:true,encoding:"utf8"})}

test("turn verification reuses matching persisted runtime command evidence",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-verification-evidence-")),repo=join(home,"repo"),env={...process.env,TREBELL_HOME:home};await mkdir(join(repo,"src"),{recursive:true});
  await git(repo,["init"]);await git(repo,["config","user.email","verification@example.invalid"]);await git(repo,["config","user.name","Verification Test"]);
  await writeFile(join(repo,"package.json"),JSON.stringify({scripts:{test:"node --test"}},null,2)+"\n");await writeFile(join(repo,"src","a.js"),"export const answer = 1;\n");await git(repo,["add","."]);await git(repo,["commit","-m","seed"]);
  const gui=await createGuiServer({port:await freePort(),appPort:await freePort(),mock:true,env});let evidenceJournal=null;
  try{
    const checkpoint=await fetch(gui.url+"/api/checkpoints",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({cwd:repo,threadId:"verification-thread",label:"before edit"})}).then(r=>r.json());assert.equal(checkpoint.supported,true);
    const linked=await fetch(gui.url+"/api/checkpoints/link",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:checkpoint.id,patch:{turnId:"verification-turn"}})}).then(r=>r.json());assert.equal(linked.checkpoint.turnId,"verification-turn");
    await writeFile(join(repo,"src","a.js"),"export const answer = 2;\n");
    evidenceJournal=new EventJournal(env);evidenceJournal.recordProtocol({runtime:"codex",method:"item/completed",params:{threadId:"verification-thread",turnId:"verification-turn",item:{id:"tests-1",type:"commandExecution",status:"completed",command:["npm","test"],exitCode:0,durationMs:42,success:true}}});await evidenceJournal.flush();
    const planned=await fetch(gui.url+"/api/verification/plan-turn",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({threadId:"verification-thread",turnId:"verification-turn"})}).then(r=>r.json());
    assert.equal(planned.supported,true);const tests=planned.record.evidence.find(item=>item.stepId==="project_tests");assert.ok(tests,JSON.stringify(planned.record.plan));assert.deepEqual(tests,{stepId:"project_tests",status:"passed",exitCode:0,source:"runtime-trace",toolCallId:"tests-1"});
    assert.equal(planned.record.assessment.results.find(item=>item.id==="project_tests")?.status,"passed");const diagnostics=planned.record.evidence.find(item=>item.stepId==="diagnostics");assert.equal(diagnostics?.status,"passed");assert.equal(diagnostics?.source,"harness-diagnostics");assert.equal(planned.nextAction.action,"complete");assert.equal(planned.nextAction.nextStep,null);
  }finally{await evidenceJournal?.close();await gui.close();await rm(home,{recursive:true,force:true,maxRetries:20,retryDelay:100})}
});

test("turn verification automatically records deterministic syntax failures and routes them to repair",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-verification-diagnostics-")),repo=join(home,"repo"),env={...process.env,TREBELL_HOME:home};await mkdir(join(repo,"src"),{recursive:true});
  await git(repo,["init"]);await git(repo,["config","user.email","verification@example.invalid"]);await git(repo,["config","user.name","Verification Test"]);await writeFile(join(repo,"src","broken.js"),"export const answer = 1;\n");await git(repo,["add","."]);await git(repo,["commit","-m","seed"]);
  const gui=await createGuiServer({port:await freePort(),appPort:await freePort(),mock:true,env});
  try{
    const checkpoint=await fetch(gui.url+"/api/checkpoints",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({cwd:repo,threadId:"diagnostics-thread",label:"before broken edit"})}).then(r=>r.json());assert.equal(checkpoint.supported,true);
    const linked=await fetch(gui.url+"/api/checkpoints/link",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id:checkpoint.id,patch:{turnId:"diagnostics-turn"}})}).then(r=>r.json());assert.equal(linked.checkpoint.turnId,"diagnostics-turn");
    await writeFile(join(repo,"src","broken.js"),"export const answer = ;\n");
    const planned=await fetch(gui.url+"/api/verification/plan-turn",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({threadId:"diagnostics-thread",turnId:"diagnostics-turn"})}).then(r=>r.json());
    const diagnostics=planned.record.evidence.find(item=>item.stepId==="diagnostics");assert.equal(diagnostics?.status,"failed");assert.ok(diagnostics?.errorCount>0);assert.equal(diagnostics?.source,"harness-diagnostics");assert.equal(planned.nextAction.action,"repair");assert.deepEqual(planned.nextAction.failedSteps,["diagnostics"]);
    const traces=await fetch(gui.url+"/api/traces?"+new URLSearchParams({threadId:"diagnostics-thread",turnId:"diagnostics-turn",limit:"20"})).then(r=>r.json());assert.ok(traces.items.some(item=>item.name==="diagnostics.generated"&&item.status==="failed"&&item.data?.errorCount>0));
  }finally{await gui.close();await rm(home,{recursive:true,force:true,maxRetries:20,retryDelay:100})}
});
