import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp,readFile,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNativeSourceControl,createNativeSourceControlExecutor,sourceControlEnvironment,sourceControlEnvironmentKeys } from "../src/native-source-control.mjs";

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
    const executor=createNativeSourceControlExecutor({environment:{...process.env,NATIVE_SC_SECRET:"super-secret-source-control",GH_TOKEN:"github-cli-token",GITLAB_TOKEN:"gitlab-cli-token"}});
    const script='process.stdout.write(JSON.stringify({secret:process.env.NATIVE_SC_SECRET||null,gh:process.env.GH_TOKEN||null,gitlab:process.env.GITLAB_TOKEN||null,cwd:process.cwd()}))';
    const result=await executor.run(process.execPath,["-e",script],{cwd:root,timeout:5000,maxBuffer:64*1024});assert.equal(result.ok,true);
    const parsed=JSON.parse(result.stdout);assert.equal(parsed.secret,null);assert.equal(parsed.gh,null);assert.equal(parsed.gitlab,null);assert.equal(parsed.cwd,root);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("Native source-control stdin execution does not expose forge credentials to unrelated executables",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-native-source-control-stdin-"));
  try{
    const executor=createNativeSourceControlExecutor({environment:{...process.env,NATIVE_SC_SECRET:"hidden",AZURE_DEVOPS_EXT_PAT:"azure-cli-token"}});
    const source='let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>process.stdout.write(JSON.stringify({input:d,secret:process.env.NATIVE_SC_SECRET||null,azure:process.env.AZURE_DEVOPS_EXT_PAT||null})))';
    const result=await executor.runStdin(process.execPath,["-e",source],"payload",{cwd:root,timeout:5000,maxBuffer:64*1024});
    assert.equal(result.ok,true);const parsed=JSON.parse(result.stdout);assert.equal(parsed.input,"payload");assert.equal(parsed.secret,null);assert.equal(parsed.azure,null);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("Native source-control environments scope forge credentials to their matching CLI",()=>{
  const environment={PATH:"/usr/bin",GH_TOKEN:"github",GITLAB_TOKEN:"gitlab",AZURE_DEVOPS_EXT_PAT:"azure",TOP_SECRET:"hidden"};
  const git=sourceControlEnvironment(environment,{platform:"linux",command:"git"});
  assert.equal(git.GH_TOKEN,undefined);assert.equal(git.GITLAB_TOKEN,undefined);assert.equal(git.AZURE_DEVOPS_EXT_PAT,undefined);assert.equal(git.TOP_SECRET,undefined);
  const github=sourceControlEnvironment(environment,{platform:"linux",command:"gh"});assert.equal(github.GH_TOKEN,"github");assert.equal(github.GITLAB_TOKEN,undefined);assert.equal(github.AZURE_DEVOPS_EXT_PAT,undefined);
  const gitlab=sourceControlEnvironment(environment,{platform:"linux",command:"glab"});assert.equal(gitlab.GITLAB_TOKEN,"gitlab");assert.equal(gitlab.GH_TOKEN,undefined);assert.equal(gitlab.AZURE_DEVOPS_EXT_PAT,undefined);
  const azure=sourceControlEnvironment(environment,{platform:"linux",command:"az"});assert.equal(azure.AZURE_DEVOPS_EXT_PAT,"azure");assert.equal(azure.GH_TOKEN,undefined);assert.equal(azure.GITLAB_TOKEN,undefined);
});

test("Native source-control executor brokers Bitbucket credentials without exposing unrelated parent secrets",async()=>{
  const executor=createNativeSourceControlExecutor({environment:{TREBELL_BITBUCKET_ACCESS_TOKEN:"bb-secret",NATIVE_SC_SECRET:"unrelated"}});
  assert.deepEqual(await executor.secretValues("source-control.bitbucket"),{TREBELL_BITBUCKET_ACCESS_TOKEN:"bb-secret"});
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

test("Native remote source-control scopes forge credentials by executable",async()=>{
  const calls=[];
  const environments={
    get:id=>id==="ssh-1"?{id:"ssh-1",name:"Build",type:"ssh",cwd:"/srv/app"}:null,
    executeArgv:async(id,options)=>{calls.push({kind:"run",id,options});return {exitCode:0,stdout:"ok",stderr:""}},
    executeArgvInput:async(id,options)=>{calls.push({kind:"stdin",id,options});return {exitCode:0,stdout:"ok",stderr:""}},
  };
  const executor=createNativeSourceControlExecutor({environments,environmentId:"ssh-1",environment:{TOP_SECRET:"hidden"}});
  await executor.run("git",["status"],{cwd:"/srv/app"});await executor.runStdin("glab",["api","projects"],"{}",{cwd:"/srv/app"});
  assert.equal(calls[0].id,"ssh-1");assert.deepEqual(calls[0].options.environmentNames,sourceControlEnvironmentKeys("git"));
  assert.equal(calls[0].options.environmentNames.includes("GH_TOKEN"),false);assert.equal(calls[0].options.environmentNames.includes("GITLAB_TOKEN"),false);assert.equal(calls[0].options.environmentNames.includes("AZURE_DEVOPS_EXT_PAT"),false);
  assert.equal(calls[1].id,"ssh-1");assert.deepEqual(calls[1].options.environmentNames,sourceControlEnvironmentKeys("glab"));
  assert.ok(calls[1].options.environmentNames.includes("GITLAB_TOKEN"));assert.equal(calls[1].options.environmentNames.includes("GH_TOKEN"),false);assert.equal(calls[1].options.environmentNames.includes("AZURE_DEVOPS_EXT_PAT"),false);
  assert.equal(calls[1].options.environmentNames.includes("TOP_SECRET"),false);
});
