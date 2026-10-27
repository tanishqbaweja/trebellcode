// Settings' Antigravity sign-in through the GUI server's /api/agent-runtime-auth, outside mock mode, with a stand-in for Antigravity's
// ACP server (fixtures/antigravity-acp-agent.mjs) as the profile's executable: it signs in with the Gemini API key typed, or the one
// saved, with no Google credential of Trebell's environment and in Trebell's own home for Antigravity, opens its session in a
// throwaway folder rather than the project, and saves the key once that worked, in harness-secrets.json and nowhere else. The answer
// never carries the key, a refused key is not saved, and Remove key takes it out.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGuiServer } from "../src/gui-server.mjs";
import { TrebellStateStore } from "../src/trebell-state.mjs";

const AGENT=fileURLToPath(new URL("./fixtures/antigravity-acp-agent.mjs",import.meta.url));
const KEY="AIzaSyTrebellFixtureKey0123456789abcdef";
const inside=(path,root)=>{const rel=relative(resolve(root),resolve(path));return Boolean(rel)&&!rel.startsWith("..")&&!isAbsolute(rel)};
// The files under root (links left out) whose bytes hold text.
async function filesHolding(root,text){
  const found=[];
  for(const entry of await readdir(root,{withFileTypes:true}).catch(()=>[])){
    const path=join(root,entry.name);
    if(entry.isDirectory())found.push(...await filesHolding(path,text));
    else if(entry.isFile()&&(await readFile(path).catch(()=>Buffer.alloc(0))).includes(text))found.push(path);
  }
  return found;
}
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

// The GUI server with Antigravity's stand-in as its executable (the profile's binaryPath) and every other harness missing from this
// machine as the server sees it: a person's home, PATH, temp folder and Trebell home of the test's own.
async function guiWithStandIn(t){
  const root=await mkdtemp(join(tmpdir(),"trebell-agy-route-")),person=join(root,"person"),trebellHome=join(root,"trebell"),scenarioPath=join(root,"scenario.json"),logPath=join(root,"log.jsonl");
  // The server closes before its folders go (Windows keeps a running process's folder busy).
  let gui=null;t.after(async()=>{await gui?.close();await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100})});
  await mkdir(join(person,".gemini","antigravity-acp"),{recursive:true});await mkdir(join(root,"tmp"),{recursive:true});
  const ownSettings=join(person,".gemini","antigravity-acp","settings.json");await writeFile(ownSettings,JSON.stringify({auth:{type:"oauth-personal"},theme:"the person's own"}));
  const windows=process.platform==="win32",wrapper=join(root,windows?"agy.cmd":"agy"),noCodex=join(root,windows?"no-codex.cmd":"no-codex");
  await writeFile(wrapper,windows?`@"${process.execPath}" "${AGENT}" %*\r\n`:`#!/bin/sh\nexec "${process.execPath}" "${AGENT}" "$@"\n`,{mode:0o755});
  await writeFile(noCodex,windows?"@exit /b 1\r\n":"#!/bin/sh\nexit 1\n",{mode:0o755});
  const system=windows?{SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR,COMSPEC:process.env.COMSPEC,PATHEXT:process.env.PATHEXT,PATH:[dirname(process.execPath),join(process.env.SystemRoot||"C:\\Windows","System32")].join(";")}:{PATH:[dirname(process.execPath),"/usr/bin","/bin"].join(":")};
  const env={...system,TEMP:join(root,"tmp"),TMP:join(root,"tmp"),TMPDIR:join(root,"tmp"),USERPROFILE:person,HOME:person,APPDATA:join(person,"AppData","Roaming"),LOCALAPPDATA:join(person,"AppData","Local"),
    TREBELL_HOME:trebellHome,CODEX_HOME:join(root,"codex"),TREBELL_CODEX_BIN:noCodex,TREBELL_HISTORY_DISABLE_CLAUDE:"1",
    // The person's own Antigravity home and Google keys in Trebell's environment, which the launch must not take.
    GEMINI_HOME:join(person,".gemini"),GEMINI_API_KEY:"inherited-gemini-key-value",GOOGLE_API_KEY:"inherited-google-key-value",
    TREBELL_AGY_SCENARIO:scenarioPath,TREBELL_AGY_LOG:logPath};
  const state=new TrebellStateStore(env);
  state.updateSettings({onboardingComplete:true,agentRuntime:"native",agentRuntimeInstances:[{id:"antigravity-default",kind:"antigravity",displayName:"Antigravity",enabled:true,binaryPath:wrapper,environment:{},approvedEnvironmentKeys:["TREBELL_AGY_SCENARIO","TREBELL_AGY_LOG","GEMINI_API_KEY","GOOGLE_API_KEY"]}]});
  state.close();
  gui=await createGuiServer({port:await freePort(),mock:false,env});
  const scenario=value=>writeFile(scenarioPath,JSON.stringify({expectKey:KEY,...value}));await scenario({});
  const post=async body=>{const response=await fetch(gui.url+"/api/agent-runtime-auth",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({runtime:"antigravity",instanceId:"antigravity-default",cwd:join(root,"project"),...body})});return {status:response.status,text:await response.text()}};
  const log=async()=>{try{return (await readFile(logPath,"utf8")).trim().split("\n").filter(Boolean).map(line=>JSON.parse(line))}catch{return []}};
  return {root,person,trebellHome,agyHome:join(trebellHome,"antigravity-home"),ownSettings,post,scenario,log,secrets:()=>readFile(join(trebellHome,"harness-secrets.json"),"utf8").catch(()=>"{}")};
}

test("Settings' Antigravity sign-in saves the key once Antigravity signed in with it, in Trebell's own home for it, and never shows it again",{timeout:90_000},async t=>{
  const fx=await guiWithStandIn(t);
  const before=await readFile(fx.ownSettings,"utf8");
  const answer=await fx.post({action:"login",apiKey:KEY});
  assert.equal(answer.status,200,answer.text);
  const body=JSON.parse(answer.text);
  assert.equal(body.ok,true);assert.equal(body.authenticated,true);assert.equal(body.auth.methodId,"gemini-api-key");
  assert.ok(Array.isArray(body.agentSnapshot?.statuses),"the harness list comes with the answer");
  assert.ok(!answer.text.includes(KEY),"the key is not in the answer or its harness list");
  const log=await fx.log(),authenticate=log.find(entry=>entry.method==="authenticate"),created=log.find(entry=>entry.method==="session/new");
  assert.equal(authenticate.params.methodId,"gemini-api-key");assert.equal(authenticate.keyIsExpected,true,"the typed key, as GEMINI_API_KEY");
  assert.equal(authenticate.googleApiKey,false,"the inherited GOOGLE_API_KEY stays out");
  assert.equal(authenticate.geminiHome,fx.agyHome,"Trebell's home for Antigravity, not the person's ~/.gemini");
  assert.ok(!inside(created.params.cwd,join(fx.root,"project"))&&basename(created.params.cwd).startsWith("trebell-antigravity-sign-in-"),`session/new in a throwaway folder, not ${created.params.cwd}`);
  assert.equal(await readFile(fx.ownSettings,"utf8"),before,"the person's own Antigravity settings, which Zed or JetBrains share, are as they were");
  assert.deepEqual(JSON.parse(await readFile(join(fx.agyHome,"antigravity-acp","settings.json"),"utf8")),{auth:{type:"gemini-api-key"}});
  assert.equal(JSON.parse(await fx.secrets())["antigravity.geminiApiKey"],KEY,"the key is saved in harness-secrets.json");
  const holding=[...await filesHolding(fx.trebellHome,KEY),...await filesHolding(fx.person,KEY),...await filesHolding(join(fx.root,"tmp"),KEY)];
  assert.deepEqual(holding,[join(fx.trebellHome,"harness-secrets.json")],"nowhere else: not in Trebell's settings and state, its logs, Antigravity's settings or the person's home");

  // A sign-in that fails keeps the key saved before; Sign in with no key typed signs in with the saved one.
  await fx.scenario({authenticate:{code:-32602,message:"Invalid params"}});
  const refused=await fx.post({action:"login",apiKey:"AIzaSyAnotherFixtureKey000000000000000"});
  assert.equal(refused.status,400);assert.match(JSON.parse(refused.text).error,/^Antigravity rejected the Gemini API key\./);
  assert.equal(JSON.parse(await fx.secrets())["antigravity.geminiApiKey"],KEY,"the refused key is not saved");
  await fx.scenario({});
  const again=await fx.post({action:"login"});
  assert.equal(again.status,200,again.text);assert.equal((await fx.log()).filter(entry=>entry.method==="authenticate").at(-1).keyIsExpected,true,"the saved key");

  const removed=await fx.post({action:"remove-key"});
  assert.equal(removed.status,200,removed.text);assert.equal(JSON.parse(removed.text).authenticated,false);
  assert.equal(JSON.parse(await fx.secrets())["antigravity.geminiApiKey"],undefined,"Remove key takes it out");
  const none=await fx.post({action:"login"});
  assert.equal(none.status,400);assert.match(JSON.parse(none.text).error,/^Antigravity needs a Gemini API key\./);
});
