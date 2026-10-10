import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { spawn } from "node:child_process";
import { codexBin } from "../src/paths.mjs";
import { codexAccountLabel, codexAccountStatus, codexVersionFromUserAgent, readCodexAccount } from "../src/codex-account-probe.mjs";
import { codexReasoningEffortLabel, preferredCodexDefaultModel } from "../src/codex-model-catalog.mjs";
import { codexGoalRecord, codexGoalSetParams, codexGoalStatus } from "../src/codex-goal.mjs";
import { normalizeGoal } from "../src/goal-state.mjs";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";
import { prepareCodexHome } from "../src/codex-home-layout.mjs";
import { TrebellStateStore } from "../src/trebell-state.mjs";

const WINDOWS_ONLY={skip:process.platform!=="win32"&&"runs Windows command launchers"};

test("Trebell runs the user's installed Codex, never the package it depends on itself",()=>{
  const root="C:\\Apps\\Trebell",own="C:\\Apps\\Trebell\\node_modules\\.bin",npm="C:\\Users\\me\\AppData\\Roaming\\npm";
  const native=win32.join(npm,"node_modules","@openai","codex","node_modules","@openai","codex-win32-x64","vendor","x86_64-pc-windows-msvc","bin","codex.exe");
  const files=new Set([win32.join(own,"codex.cmd"),win32.join(npm,"codex.cmd"),native]);
  const exists=path=>files.has(path);
  assert.equal(codexBin({PATH:[own,npm].join(";")},"win32","x64",{exists,root}),native,"npm's launcher resolves to the native executable behind it, past Trebell's own node_modules");
  assert.equal(codexBin({Path:own,APPDATA:"C:\\Users\\me\\AppData\\Roaming"},"win32","x64",{exists,root}),native,"a stale desktop PATH still finds npm's global Codex");
  files.delete(native);
  assert.equal(codexBin({PATH:[own,npm].join(";")},"win32","x64",{exists,root}),win32.join(npm,"codex.cmd"));
  const scoop="C:\\Users\\me\\scoop\\shims";files.add(win32.join(scoop,"codex.exe"));
  assert.equal(codexBin({PATH:[own,scoop,npm].join(";")},"win32","x64",{exists,root}),win32.join(scoop,"codex.exe"));
  assert.equal(codexBin({PATH:own},"win32","x64",{exists,root}),"codex","with no installed Codex the bare name reports it missing");
  assert.equal(codexBin({PATH:"/opt/trebell/node_modules/.bin:/usr/local/bin"},"linux","x64",{exists:path=>path==="/opt/trebell/node_modules/.bin/codex"||path==="/usr/local/bin/codex",root:"/opt/trebell"}),"/usr/local/bin/codex");
  assert.equal(codexBin({TREBELL_CODEX_BIN:" D:\\builds\\codex.exe ",PATH:npm},"win32","x64",{exists,root}),"D:\\builds\\codex.exe");
});

test("Codex readiness is its own account/read answer, as in T3's provider probe",()=>{
  assert.deepEqual(codexAccountStatus({account:{type:"chatgpt",email:"a@b.c",planType:"pro"},requiresOpenaiAuth:true}),{ready:true,authenticated:true,authType:"chatgpt",label:"ChatGPT Pro 20x",message:"Signed in with ChatGPT Pro 20x"});
  assert.equal(codexAccountStatus({account:{type:"apiKey"}}).label,"OpenAI API key");
  assert.deepEqual(codexAccountStatus({account:null,requiresOpenaiAuth:true}),{ready:false,authenticated:false,authType:null,label:null,message:"Codex CLI is not authenticated. Run codex login and try again."});
  const ollama=codexAccountStatus({account:null,requiresOpenaiAuth:false});
  assert.equal(ollama.ready,true,"a model provider without OpenAI sign-in is ready as configured");assert.equal(ollama.authenticated,null);
  assert.equal(codexAccountLabel({type:"chatgpt",planType:"something-new"}),"ChatGPT");
  assert.equal(codexVersionFromUserAgent("codex_cli_rs/0.162.0 (Windows 11; x86_64) trebell"),"0.162.0");
});

// A stand-in `codex` CLI: --version, and an app-server on stdio that answers initialize and account/read.
const FAKE_CODEX=String.raw`
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
const [mode,log,...args]=process.argv.slice(2);
appendFileSync(log,JSON.stringify(args)+"\n");
if(args[0]==="--version"){console.log("codex-cli 0.162.0");process.exit(0)}
const accounts={chatgpt:{account:{type:"chatgpt",email:"user@example.test",planType:"plus"},requiresOpenaiAuth:true},local:{account:null,requiresOpenaiAuth:false},signedout:{account:null,requiresOpenaiAuth:true}};
const lines=createInterface({input:process.stdin});
lines.on("line",line=>{
  const message=JSON.parse(line);if(message.id===undefined)return;
  const result=message.method==="initialize"?{userAgent:"codex_cli_rs/0.162.0 (Windows 11; x86_64) trebell"}:message.method==="account/read"?accounts[mode]:{};
  process.stdout.write(JSON.stringify({id:message.id,result})+"\n");
});
lines.on("close",()=>process.exit(0));
`;

test("readCodexAccount runs one short app-server, reads the account and stops it",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-codex-account-"));
  try{
    const script=join(root,"codex.mjs"),log=join(root,"calls.log");await writeFile(script,FAKE_CODEX,"utf8");
    const result=await readCodexAccount({spawnAppServer:args=>spawn(process.execPath,[script,"chatgpt",log,...args],{windowsHide:true,stdio:["pipe","pipe","pipe"]}),clientVersion:"0.0.0-test",timeoutMs:15_000});
    assert.equal(result.version,"0.162.0");assert.equal(result.account.account.planType,"plus");
    assert.deepEqual((await readFile(log,"utf8")).trim().split("\n").map(line=>JSON.parse(line)),[["app-server"]]);
    await assert.rejects(readCodexAccount({spawnAppServer:()=>spawn(process.execPath,["-e","process.exit(3)"],{windowsHide:true,stdio:["pipe","pipe","pipe"]}),timeoutMs:15_000}),/exited with code 3/);
  }finally{await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
});

test("a Codex profile is ready when signed in or when its model provider needs no OpenAI sign-in",WINDOWS_ONLY,async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-codex-probe-"));
  try{
    const script=join(root,"codex.mjs"),log=join(root,"calls.log");await writeFile(script,FAKE_CODEX,"utf8");
    const launcher=async mode=>{const path=join(root,mode,"codex.cmd");await mkdir(join(root,mode),{recursive:true});await writeFile(path,["@echo off",`"${process.execPath}" "${script}" ${mode} "${log}" %*`,""].join("\r\n"),"utf8");return path};
    const env={...process.env,TREBELL_HOME:join(root,"home"),CODEX_HOME:join(root,"codex-home")};
    const manager=new AgentRuntimeManager({state:new TrebellStateStore(env),env,platform:"win32"});
    for(const mode of ["chatgpt","local","signedout"])manager.upsertInstance({id:"codex-"+mode,kind:"codex",displayName:mode,binaryPath:await launcher(mode)});
    const status=async mode=>{const value=await manager.probe(manager.instances().find(item=>item.id==="codex-"+mode));return {available:value.available,authenticated:value.authenticated,version:value.version,message:value.message,account:value.account}};
    assert.deepEqual(await status("chatgpt"),{available:true,authenticated:true,version:"codex-cli 0.162.0",message:"Signed in with ChatGPT Plus",account:{type:"chatgpt",label:"ChatGPT Plus"}});
    assert.deepEqual(await status("local"),{available:true,authenticated:null,version:"codex-cli 0.162.0",message:"Ready · this Codex model provider does not use OpenAI sign-in",account:{type:null,label:null}});
    assert.deepEqual(await status("signedout"),{available:false,authenticated:false,version:"codex-cli 0.162.0",message:"Codex CLI is not authenticated. Run codex login and try again.",account:{type:null,label:null}});
    const before=(await readFile(log,"utf8")).trim().split("\n").length;
    await status("chatgpt");
    assert.equal((await readFile(log,"utf8")).trim().split("\n").length,before+1,"a ready answer is reused: only --version runs again");
  }finally{await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
});

test("a shadow-home Codex profile is probed in the home its app-server runs in",WINDOWS_ONLY,async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-codex-shadow-probe-"));
  try{
    // Like Codex, the stand-in app-server puts its own skills in CODEX_HOME when it starts.
    const fake=FAKE_CODEX.replace("const lines=createInterface",'if(args[0]==="app-server"){const {mkdirSync}=await import("node:fs");mkdirSync(process.env.CODEX_HOME+"/skills/.system",{recursive:true})}\nconst lines=createInterface');
    assert.notEqual(fake,FAKE_CODEX);
    const script=join(root,"codex.mjs"),log=join(root,"calls.log"),launcher=join(root,"codex.cmd");await writeFile(script,fake,"utf8");
    await writeFile(launcher,["@echo off",`"${process.execPath}" "${script}" chatgpt "${log}" %*`,""].join("\r\n"),"utf8");
    const shared=join(root,"shared-codex"),shadow=join(root,"personal-codex");await mkdir(shared,{recursive:true});await writeFile(join(shared,"config.toml"),"model = \"gpt-5.5\"\n","utf8");
    const env={...process.env,TREBELL_HOME:join(root,"home"),CODEX_HOME:join(root,"default-codex")};
    const manager=new AgentRuntimeManager({state:new TrebellStateStore(env),env,platform:"win32"});
    const instance=manager.upsertInstance({id:"codex-personal",kind:"codex",displayName:"Personal",binaryPath:launcher,homePath:shared,shadowHomePath:shadow});
    assert.equal((await manager.probe(instance)).available,true);
    assert.equal((await lstat(join(shadow,"skills"))).isSymbolicLink(),true,"the shadow home links skills to the shared home before Codex starts");
    assert.equal((await lstat(join(shadow,"config.toml"))).isFile()||(await lstat(join(shadow,"config.toml"))).isSymbolicLink(),true,"the probe reads the profile's shared config");
    await stat(join(shared,"skills",".system"));
    // The app-server start that follows prepares the same home without finding a folder in the way.
    await prepareCodexHome({homePath:shared,shadowHomePath:shadow});
  }finally{await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
});

test("Codex's default model follows T3's ranking over the live catalog, and its effort labels include Ultra",()=>{
  assert.equal(preferredCodexDefaultModel([{id:"gpt-5.5",isDefault:true},{id:"gpt-5.6-terra"},{id:"openai.gpt-5.6-sol"}]),"openai.gpt-5.6-sol");
  assert.equal(preferredCodexDefaultModel([{id:"gpt-5.5"},{model:"gpt-5.4",isDefault:true}]),"gpt-5.4");
  assert.equal(preferredCodexDefaultModel([{id:"gpt-5.5"}]),null);
  assert.equal(codexReasoningEffortLabel("ultra"),"Ultra");assert.equal(codexReasoningEffortLabel("xhigh"),"Extra High");assert.equal(codexReasoningEffortLabel("turbo"),"turbo");
});

test("a Codex goal is mirrored with Codex's own status, times and accounting, next to Trebell's guidance",()=>{
  assert.equal(codexGoalStatus("BUDGETLIMITED"),"budgetLimited");assert.equal(codexGoalStatus("usagelimited"),"usageLimited");assert.equal(codexGoalStatus("finished"),null);
  const previous=normalizeGoal({threadId:"t",patch:{objective:"Ship",constraints:["No new deps"],turnBudget:3}});
  const record=codexGoalRecord({threadId:"t",objective:"Ship",status:"budgetLimited",tokenBudget:5000,tokensUsed:1234,timeUsedSeconds:61,createdAt:1_790_000_000,updatedAt:1_790_000_100},{threadId:"t",previous});
  assert.equal(record.status,"budgetLimited");assert.equal(record.tokenBudget,5000);assert.equal(record.createdAt,1_790_000_000_000,"Codex's seconds become milliseconds");
  assert.deepEqual(record.native,{tokensUsed:1234,timeUsedSeconds:61});assert.deepEqual(record.constraints,["No new deps"]);assert.equal(record.turnBudget,3);
  assert.equal(codexGoalRecord({objective:"Done",status:"complete",updatedAt:1_790_000_200},{threadId:"t"}).completedAt,1_790_000_200_000);
  assert.equal(codexGoalRecord({objective:"  "},{threadId:"t"}),null);
});

test("a Trebell goal patch sends Codex only what Codex keeps, and a new objective replaces the goal",()=>{
  const next=(patch,previous=null)=>normalizeGoal({threadId:"t",previous,patch});
  assert.deepEqual(codexGoalSetParams({threadId:"t",patch:{objective:"Ship",tokenBudget:100,turnBudget:2},next:next({objective:"Ship",tokenBudget:100,turnBudget:2})}),{replace:false,params:{threadId:"t",objective:"Ship",status:"active",tokenBudget:100}});
  const current={objective:"Ship",status:"active",tokenBudget:100};
  assert.deepEqual(codexGoalSetParams({threadId:"t",patch:{status:"paused"},current,next:next({status:"paused"},current)}),{replace:false,params:{threadId:"t",status:"paused"}});
  assert.deepEqual(codexGoalSetParams({threadId:"t",patch:{constraints:["x"]},current,next:next({constraints:["x"]},current)}),{replace:false,params:{threadId:"t"}},"guidance alone stays Trebell's");
  assert.deepEqual(codexGoalSetParams({threadId:"t",patch:{objective:"Other",status:"paused"},current,next:next({objective:"Other",status:"paused"},current)}),{replace:true,params:{threadId:"t",objective:"Other",status:"paused"}},"a replaced goal keeps no old token budget");
  assert.deepEqual(codexGoalSetParams({threadId:"t",patch:{objective:"Other",tokenBudget:50},current,next:next({objective:"Other",tokenBudget:50},current)}),{replace:true,params:{threadId:"t",objective:"Other",status:"active",tokenBudget:50}});
  const legacy=normalizeGoal({threadId:"t",patch:{objective:"Legacy",tokenBudget:700}});
  assert.deepEqual(codexGoalSetParams({threadId:"t",patch:{status:"active"},next:next({status:"active"},legacy)}),{replace:false,params:{threadId:"t",objective:"Legacy",status:"active",tokenBudget:700}},"a Trebell-only goal moves to Codex whole when next changed");
  const limited={...current,status:"budgetLimited"};
  assert.deepEqual(codexGoalSetParams({threadId:"t",patch:{status:"budgetLimited",tokenBudget:500},current:limited,next:next({tokenBudget:500},limited)}),{replace:false,params:{threadId:"t",tokenBudget:500}},"a status Codex set itself is left to Codex");
  assert.throws(()=>codexGoalSetParams({threadId:"t",patch:{status:"finished"},current,next:next({},current)}),error=>error.code===-32602);
});
