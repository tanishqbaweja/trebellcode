import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir,mkdtemp,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGuiServer } from "../src/gui-server.mjs";
import { git } from "../src/git-service.mjs";

async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}
async function repoFixture(prefix){
  const root=await mkdtemp(join(tmpdir(),prefix)),repo=join(root,"repo");await mkdir(repo,{recursive:true});await git(repo,["init"]);await git(repo,["config","user.email","hooks@example.invalid"]);await git(repo,["config","user.name","Hooks Test"]);await writeFile(join(repo,"README.md"),"base\n");await git(repo,["add","."]);await git(repo,["commit","-m","base"]);return {root,repo};
}

test("installed verification hooks become required deterministic verification steps",async()=>{
  const {root,repo}=await repoFixture("trebell-hook-verification-"),home=join(root,"home"),gui=await createGuiServer({port:await freePort(),appPort:await freePort(),mock:true,env:{...process.env,TREBELL_HOME:home}});
  try{
    const saved=await fetch(gui.url+"/api/projects",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({path:repo,hooks:[{id:"lint-gate",name:"Lint gate",event:"verification.required",command:"npm run lint",timeoutMs:45000}]})}).then(response=>response.json());assert.equal(saved.project.hooks.length,1);assert.equal(saved.project.hooks[0].failureMode,"block");
    const plan=await fetch(gui.url+"/api/context/verification?"+new URLSearchParams({path:repo,file:"README.md"})).then(response=>response.json()),step=plan.steps.find(item=>item.hookId==="lint-gate");
    assert.ok(step,JSON.stringify(plan));assert.equal(step.id,"project_hook_lint_gate");assert.equal(step.kind,"command");assert.equal(step.required,true);assert.equal(step.command,"npm run lint");assert.match(step.reason,/Required project hook: Lint gate/);
  }finally{await gui.close();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
});

test("blocking source-control hooks stop mutations while warning and after hooks only trace failures",async()=>{
  const {root,repo}=await repoFixture("trebell-hook-source-control-"),home=join(root,"home"),gui=await createGuiServer({port:await freePort(),appPort:await freePort(),mock:true,env:{...process.env,TREBELL_HOME:home}});
  const failing=process.platform==="win32"?"exit /b 7":"exit 7",afterFail=process.platform==="win32"?"echo TOP_SECRET_HOOK_OUTPUT & exit /b 5":"printf TOP_SECRET_HOOK_OUTPUT; exit 5";
  try{
    const base=(await git(repo,["rev-parse","HEAD"])).stdout.trim();await writeFile(join(repo,"README.md"),"changed\n");
    const save=hooks=>fetch(gui.url+"/api/projects",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({path:repo,hooks})}).then(response=>response.json());
    await save([
      {id:"pre",name:"Commit gate",event:"source-control.before",command:failing,failureMode:"block",actions:["git.commit"]},
      {id:"after",name:"After notifier",event:"source-control.after",command:afterFail,actions:["git.commit"]},
    ]);
    const blocked=await fetch(gui.url+"/api/git/action",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"commit",cwd:repo,message:"blocked commit"})});assert.equal(blocked.status,400);assert.match((await blocked.json()).error,/Project hook Commit gate exited with code 7/);assert.equal((await git(repo,["rev-parse","HEAD"])).stdout.trim(),base);
    await save([
      {id:"pre",name:"Commit gate",event:"source-control.before",command:failing,failureMode:"warn",actions:["git.commit"]},
      {id:"after",name:"After notifier",event:"source-control.after",command:afterFail,actions:["git.commit"]},
    ]);
    const committed=await fetch(gui.url+"/api/git/action",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"commit",cwd:repo,message:"allowed commit"})});assert.equal(committed.status,200,await committed.text());assert.notEqual((await git(repo,["rev-parse","HEAD"])).stdout.trim(),base);
    const traces=await fetch(gui.url+"/api/traces?category=hook&limit=50").then(response=>response.json()),failed=traces.items.filter(item=>item.name==="hook.failed");assert.ok(failed.some(item=>item.data?.hookId==="pre"&&item.data?.exitCode===7&&item.data?.failureMode==="warn"));assert.ok(failed.some(item=>item.data?.hookId==="after"&&item.data?.exitCode===5&&item.data?.failureMode==="warn"));assert.doesNotMatch(JSON.stringify(traces.items),/TOP_SECRET_HOOK_OUTPUT|process\.stdout|process\.exit/);
  }finally{await gui.close();await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
});
