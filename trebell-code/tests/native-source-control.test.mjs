import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp,readFile,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeSourceControl,createNativeSourceControlExecutor } from "../src/native-source-control.mjs";

const execFileAsync=promisify(execFile);
async function git(cwd,args){return execFileAsync("git",args,{cwd,windowsHide:true,encoding:"utf8"})}

test("Native source control performs bounded local Git actions inside the active project",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-source-control-"));
  try{
    await git(root,["init"]);await git(root,["config","user.email","trebell-test@example.invalid"]);await git(root,["config","user.name","Trebell Test"]);
    await writeFile(join(root,"README.md"),"one\n","utf8");await git(root,["add","README.md"]);await git(root,["commit","-m","seed"]);
    const execute=createNativeSourceControl({root,environment:{...process.env,NATIVE_SC_SECRET:"do-not-leak"}});
    const status=await execute({name:"status",arguments:{}});assert.equal(status.isGit,true);assert.equal(status.status.length,0);
    const branched=await execute({name:"branch_create",arguments:{name:"trebell/native-test"}});assert.equal(branched.info.branch,"trebell/native-test");
    await writeFile(join(root,"README.md"),"two\n","utf8");const committed=await execute({name:"commit_all",arguments:{message:"Native source-control commit"}});assert.equal(committed.info.status.length,0);
    const body=await readFile(join(root,"README.md"),"utf8");assert.equal(body,"two\n");
    const subject=(await git(root,["log","-1","--pretty=%s"])).stdout.trim();assert.equal(subject,"Native source-control commit");
  }finally{await rm(root,{recursive:true,force:true})}
});

test("Native source-control executor keeps unrelated parent secrets out of Git subprocesses",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-source-control-env-"));
  try{
    const executor=createNativeSourceControlExecutor({environment:{...process.env,NATIVE_SC_SECRET:"super-secret-source-control"}});
    const script='process.stdout.write(JSON.stringify({secret:process.env.NATIVE_SC_SECRET||null,cwd:process.cwd()}))';
    const result=await executor.run(process.execPath,["-e",script],{cwd:root,timeout:5000,maxBuffer:64*1024});assert.equal(result.ok,true);
    const parsed=JSON.parse(result.stdout);assert.equal(parsed.secret,null);assert.equal(parsed.cwd,root);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("Native source-control results redact credential-bearing remote URLs before the model sees them",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-source-control-redaction-"));
  try{
    await git(root,["init"]);await git(root,["remote","add","origin","https://alice:super-secret-token@example.invalid/acme/repo.git"]);
    const execute=createNativeSourceControl({root});const status=await execute({name:"status",arguments:{}});const serialized=JSON.stringify(status);
    assert.doesNotMatch(serialized,/alice:super-secret-token/);assert.match(serialized,/\[redacted\]@example\.invalid/);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("Native remote source control forwards only the approved environment-name allowlist",async()=>{
  let launch=null;
  const environments={
    get:id=>id==="ssh-1"?{id:"ssh-1",name:"Build",type:"ssh",cwd:"/srv/app"}:null,
    executeArgv:async(id,options)=>{launch={id,options};return {exitCode:0,stdout:"ok",stderr:""}},
  };
  const executor=createNativeSourceControlExecutor({environments,environmentId:"ssh-1",environment:{TOP_SECRET:"hidden"},environmentNames:["PATH","HOME"]});
  const result=await executor.run("git",["status","--porcelain"],{cwd:"/srv/app",timeout:5000,maxBuffer:128*1024});assert.equal(result.ok,true);
  assert.equal(launch.id,"ssh-1");assert.deepEqual(launch.options.environmentNames,["PATH","HOME"]);assert.equal(Object.prototype.hasOwnProperty.call(launch.options,"environment"),false);
});
