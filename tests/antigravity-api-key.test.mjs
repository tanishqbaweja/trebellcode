// Antigravity runs on the Gemini API key Trebell keeps for it, in a home of its own: its launches take no Google credential, project or
// home from Trebell's environment, from a name a profile approves or from a profile's variable, and carry only the saved key, as
// GEMINI_API_KEY. The key sits in an owner-only file of its own, never in settings.json, a snapshot or Antigravity's settings, which
// name only the key method. Settings' status check says whether a key is saved. The person's global skills are linked into
// Antigravity's home, and its sessions (with a key, they sign in with it when Antigravity asks; without one, they say a key is
// needed) and its model list say when the machine gives Antigravity no IPv6 sockets.
import test from "node:test";
import assert from "node:assert/strict";
import { access, lstat, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";
import { AcpAgentSession } from "../src/acp-agent-session.mjs";
import { acpSession, scriptedAcp } from "./fixtures/scripted-acp.mjs";

const AGENT=fileURLToPath(new URL("./fixtures/antigravity-acp-agent.mjs",import.meta.url));
const KEY="AIzaSyTrebellFixtureKey0123456789abcdef";
const KEY_NEEDED="Antigravity needs a Gemini API key. Create one in Google AI Studio (aistudio.google.com/apikey), then add it to Antigravity in Settings.";
const IPV6="Antigravity needs IPv6 socket support, which this machine does not give it. Turn IPv6 on, then try again (in WSL: remove ipv6.disable=1 from .wslconfig, then run wsl --shutdown).";
// Every Google credential, project and home Antigravity reads, and its own switches, as Trebell's environment could hold them.
const INHERITED={GEMINI_API_KEY:"inherited-gemini-key",GOOGLE_API_KEY:"inherited-google-key",GOOGLE_APPLICATION_CREDENTIALS:"/home/me/adc.json",GOOGLE_CLOUD_PROJECT:"project-a",
  GOOGLE_CLOUD_LOCATION:"us-central1",GOOGLE_CLOUD_QUOTA_PROJECT:"quota-a",GOOGLE_GENAI_USE_VERTEXAI:"true",GCLOUD_PROJECT:"project-b",CLOUDSDK_CORE_PROJECT:"project-c",
  GEMINI_HOME:"/home/me/.gemini",AGY_ACP_ENABLE_OAUTH:"1",AGY_ACP_CCPA_PROJECT:"project-d"};

async function homes(t){
  const root=await mkdtemp(join(tmpdir(),"trebell-agy-key-")),person=join(root,"person"),trebell=join(root,"trebell");
  await mkdir(person,{recursive:true});await mkdir(join(root,"tmp"),{recursive:true});
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100}));
  return {root,person,trebell};
}
// The key as Settings saves it (harness-secrets.json, beside provider-secrets.json); null removes it.
async function saveKey(trebell,key){await mkdir(trebell,{recursive:true});await writeFile(join(trebell,"harness-secrets.json"),JSON.stringify(key?{"antigravity.geminiApiKey":key}:{}))}
const memoryState=settings=>({settings:()=>settings,updateSettings:patch=>{Object.assign(settings,patch)}});
const PROFILE={id:"antigravity-default",kind:"antigravity",displayName:"Antigravity",enabled:true,environment:{},approvedEnvironmentKeys:["GEMINI_API_KEY","GOOGLE_API_KEY","GOOGLE_CLOUD_PROJECT","AGY_ACP_CCPA_PROJECT","TREBELL_AGY_SCENARIO","TREBELL_AGY_LOG"]};

test("an Antigravity launch takes no Google credential, project or home of Trebell's environment, and carries only the saved key",async t=>{
  const {person,trebell}=await homes(t);
  for(const platform of ["linux","win32"]){
    // On Windows a name is one variable whatever its case.
    const inherited=platform==="win32"?{...INHERITED,Gemini_Api_Key:INHERITED.GEMINI_API_KEY,google_api_key:INHERITED.GOOGLE_API_KEY}:INHERITED;
    const env={PATH:"/usr/bin",HOME:person,USERPROFILE:person,TREBELL_HOME:trebell,...inherited};
    const manager=new AgentRuntimeManager({state:memoryState({agentRuntimeInstances:[{...PROFILE}]}),env,platform});
    const instance=manager.instances().find(item=>item.kind==="antigravity");
    let launch=manager.childEnv(instance);
    for(const name of Object.keys(inherited))if(name.toUpperCase()!=="GEMINI_HOME")assert.equal(launch[name],undefined,`${platform}: ${name} stays out`);
    assert.equal(launch.GEMINI_HOME,join(trebell,"antigravity-home"),`${platform}: Antigravity's home is Trebell's for it, not the person's ~/.gemini`);
    assert.equal(launch.AGY_ACP_FORCE_FILE_STORAGE,"1","its logins stay files in that home, never the system keychain's");
    assert.equal(launch.PATH,"/usr/bin");
    await saveKey(trebell,KEY);
    launch=manager.childEnv(instance);
    assert.equal(launch.GEMINI_API_KEY,KEY,`${platform}: the saved key, as GEMINI_API_KEY`);
    for(const name of Object.keys(inherited))if(!["GEMINI_API_KEY","GEMINI_HOME"].includes(name.toUpperCase()))assert.equal(launch[name],undefined,`${platform}: ${name} stays out with a key`);
    assert.equal(Object.keys(launch).filter(name=>/^gemini_api_key$/i.test(name)).length,1,"one GEMINI_API_KEY");
    await saveKey(trebell,null);
    assert.equal(manager.childEnv(instance).GEMINI_API_KEY,undefined,`${platform}: a key removed is gone from the next launch`);
  }
});

test("the key sits in an owner-only file of its own, written whole, and Antigravity's settings name only its method",async t=>{
  const {antigravityApiKey,prepareAntigravityHome,saveAntigravityApiKey}=await import("../src/antigravity-auth.mjs");
  const {person,trebell}=await homes(t),env={HOME:person,USERPROFILE:person,TREBELL_HOME:trebell},secrets=join(trebell,"harness-secrets.json");
  saveAntigravityApiKey(KEY,{env});saveAntigravityApiKey("AIzaSyReplacedFixtureKey000000000000000",{env});saveAntigravityApiKey(KEY,{env});
  assert.equal(antigravityApiKey(env),KEY);
  assert.deepEqual(JSON.parse(await readFile(secrets,"utf8")),{"antigravity.geminiApiKey":KEY});
  if(process.platform!=="win32")assert.equal((await stat(secrets)).mode&0o777,0o600,"owner-only");
  assert.deepEqual((await readdir(trebell)).filter(name=>name.endsWith(".tmp")),[],"no temporary file left");
  // Antigravity's own settings keep what the agent wrote there, and get the key method, never the key.
  const settingsPath=join(trebell,"antigravity-home","antigravity-acp","settings.json");
  await mkdir(join(trebell,"antigravity-home","antigravity-acp"),{recursive:true});await writeFile(settingsPath,JSON.stringify({ui:{theme:"dark"},auth:{type:"oauth-personal",note:"kept"}}));
  assert.equal((await prepareAntigravityHome({env})).settingsPath,settingsPath);
  assert.deepEqual(JSON.parse(await readFile(settingsPath,"utf8")),{ui:{theme:"dark"},auth:{type:"gemini-api-key",note:"kept"}});
  assert.ok(!(await readFile(settingsPath,"utf8")).includes(KEY));
  await assert.rejects(access(join(person,".gemini","antigravity-acp","settings.json")),{code:"ENOENT"},"the person's own ~/.gemini settings, which Zed or JetBrains share, are not written");
  saveAntigravityApiKey(null,{env});
  assert.equal(antigravityApiKey(env),null);assert.deepEqual(JSON.parse(await readFile(secrets,"utf8")),{});
});

test("the person's global skills are linked into Antigravity's home, and removing that home leaves them",async t=>{
  const {prepareAntigravityHome}=await import("../src/antigravity-auth.mjs");
  const {person,trebell}=await homes(t),env={HOME:person,USERPROFILE:person,TREBELL_HOME:trebell},home=join(trebell,"antigravity-home");
  await mkdir(join(person,".gemini","config","skills","review"),{recursive:true});await writeFile(join(person,".gemini","config","skills","review","SKILL.md"),"---\nname: review\n---\n");
  // antigravity-cli/skills links to a folder the person has not made yet; a second launch keeps the links as they are.
  await prepareAntigravityHome({env});await prepareAntigravityHome({env});
  const link=join(home,"config","skills");
  assert.ok((await lstat(link)).isSymbolicLink(),"config/skills is a link (a junction on Windows)");
  assert.equal(await readFile(join(link,"review","SKILL.md"),"utf8"),"---\nname: review\n---\n");
  assert.ok((await lstat(join(home,"antigravity-cli","skills"))).isSymbolicLink());
  await mkdir(join(person,".gemini","antigravity-cli","skills","later"),{recursive:true});
  await access(join(home,"antigravity-cli","skills","later"));
  await rm(home,{recursive:true,force:true});
  assert.equal(await readFile(join(person,".gemini","config","skills","review","SKILL.md"),"utf8"),"---\nname: review\n---\n","the person's skills are still there");
  // A skills folder of the home's own stays a folder.
  await mkdir(join(home,"config","skills"),{recursive:true});await prepareAntigravityHome({env});
  assert.ok(!(await lstat(join(home,"config","skills"))).isSymbolicLink());
  assert.ok((await lstat(join(home,"antigravity-cli","skills"))).isSymbolicLink());
});

async function install(trebell){
  const current=join(trebell,"agent-runtimes","antigravity","current");await mkdir(current,{recursive:true});
  await writeFile(join(current,"agy_acp_server.exe"),"fixture");await writeFile(join(current,"agy_acp_server.par"),"fixture");
  await writeFile(join(current,"install.json"),JSON.stringify({runtime:"antigravity",version:"1.4.3"}));
}

test("Settings' status check says Antigravity needs a Gemini API key, or that one is saved, and no snapshot holds the key",async t=>{
  const {person,trebell}=await homes(t),env={PATH:process.env.PATH,HOME:person,USERPROFILE:person,TREBELL_HOME:trebell,...INHERITED};
  await install(trebell);
  const state=memoryState({agentRuntime:"antigravity",agentRuntimeInstanceId:"antigravity-default"});
  const manager=new AgentRuntimeManager({state,env,runFn:async()=>({ok:false,code:127,stdout:"",stderr:"not found"})});
  let status=await manager.probe("antigravity",{fresh:true});
  assert.deepEqual({available:status.available,installed:status.installed,authenticated:status.authenticated,account:status.account,message:status.message},
    {available:false,installed:true,authenticated:false,account:null,message:KEY_NEEDED},"an inherited GEMINI_API_KEY is no saved key");
  await saveKey(trebell,KEY);
  status=await manager.probe("antigravity",{fresh:true});
  assert.deepEqual({available:status.available,authenticated:status.authenticated,account:status.account,message:status.message,version:status.version},
    {available:true,authenticated:null,account:{authMethod:"gemini-api-key",label:"Gemini API key"},message:"Gemini API key saved.",version:"1.4.3"});
  const snapshot=JSON.stringify(await manager.snapshot());
  assert.ok(snapshot.includes("Gemini API key saved."));
  assert.ok(!snapshot.includes(KEY),"the key is not in the harness list");
  assert.deepEqual(Object.keys(state.settings()).sort(),["agentRuntime","agentRuntimeInstanceId"],"nothing was saved into Trebell's settings");
});

// A chat's session runs the scripted ACP fixture's sign-in scenario: its setup answers auth_required until it signs in with gemini-api-key.
test("an Antigravity chat with a saved key signs in once with it when Antigravity asks; without one it says a key is needed",async t=>{
  const scenario={initialize:{protocolVersion:1,agentCapabilities:{loadSession:true,sessionCapabilities:{resume:{}}},authMethods:[{id:"oauth-personal",name:"Log in with Google"},{id:"gemini-api-key",name:"Gemini API key"}]},sessionNew:{sessionId:"agy-chat"},signIn:{methodId:"gemini-api-key",env:"GEMINI_API_KEY"}};
  const asked=log=>log.filter(entry=>entry.method&&entry.id!=null).map(entry=>entry.method==="authenticate"?`authenticate ${entry.params.methodId}`:entry.method);
  const keyed=await scriptedAcp(t,scenario);keyed.env={...keyed.env,GEMINI_API_KEY:KEY};
  const {session}=acpSession(t,keyed,{runtime:"antigravity"});
  assert.equal((await session.start()).session.sessionId,"agy-chat");
  assert.deepEqual(asked(await keyed.log()),["initialize","session/new","authenticate gemini-api-key","session/new"]);
  const resumed=await scriptedAcp(t,scenario);resumed.env={...resumed.env,GEMINI_API_KEY:KEY};
  await acpSession(t,resumed,{runtime:"antigravity"}).session.start({providerSessionId:"agy-thread"});
  assert.deepEqual(asked(await resumed.log()),["initialize","session/resume","authenticate gemini-api-key","session/resume"],"a resumed chat too");
  const keyless=await scriptedAcp(t,scenario);keyless.env={...keyless.env};delete keyless.env.GEMINI_API_KEY;
  await assert.rejects(acpSession(t,keyless,{runtime:"antigravity"}).session.start(),error=>error.message===KEY_NEEDED&&error.code===-32000);
  assert.deepEqual(asked(await keyless.log()),["initialize","session/new"],"never its Google login");
});

test("an Antigravity that exits for want of IPv6 sockets says so as a chat starts and on Settings' model list",{timeout:60_000},async t=>{
  const {root,person,trebell}=await homes(t),scenarioPath=join(root,"scenario.json"),logPath=join(root,"log.jsonl");
  await writeFile(scenarioPath,JSON.stringify({exitAt:"initialize",exitCode:1,stderr:"OSError: [Errno 97] Address family not supported by protocol (AF_INET6)\n"}));
  const base={...process.env,TEMP:join(root,"tmp"),TMP:join(root,"tmp"),TREBELL_AGY_SCENARIO:scenarioPath,TREBELL_AGY_LOG:logPath};
  const session=new AcpAgentSession({runtime:"antigravity",command:process.execPath,args:[AGENT],cwd:root,env:base,onUpdate:()=>{}});
  t.after(()=>session.close().catch(()=>{}));
  await assert.rejects(session.start(),error=>error.message===IPV6);
  // The model list: a profile's own executable (a wrapper of the stand-in), read where it runs.
  const windows=process.platform==="win32",wrapper=join(root,windows?"agy.cmd":"agy");
  await writeFile(wrapper,windows?`@"${process.execPath}" "${AGENT}" %*\r\n`:`#!/bin/sh\nexec "${process.execPath}" "${AGENT}" "$@"\n`,{mode:0o755});
  const env={...base,HOME:person,USERPROFILE:person,TREBELL_HOME:trebell};
  const manager=new AgentRuntimeManager({state:memoryState({agentRuntimeInstances:[{...PROFILE,binaryPath:wrapper}]}),env});
  const first=await manager.models("antigravity");
  assert.equal(first.source,"manifest");assert.ok(first.models.length>0,"the stand-in list first");
  let listed=first;
  for(const started=Date.now();!listed.error&&Date.now()-started<15_000;)await new Promise(resolve=>setTimeout(resolve,100)),listed=await manager.models("antigravity");
  assert.equal(listed.error,IPV6);assert.ok(listed.models.length>0,"with the stand-in list");
});
