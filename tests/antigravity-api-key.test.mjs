// Antigravity signs in as the person sets it in Settings, in a home of its own: on Sign in with its own sign-in (the agent's token in
// that home, which Trebell only checks is there), on API key with the Google Gemini key Trebell keeps for Native's Gemini provider,
// through its key method. Its launches take no Google credential, project or home from Trebell's environment, from a name a profile
// approves or from a profile's variable, and carry GEMINI_API_KEY only on API key. Its home's settings name the method it signs in
// with, never a key. Settings' status check says which, and whether it can run. The person's global skills are linked into
// Antigravity's home, and its sessions and its model list say when the machine gives Antigravity no IPv6 sockets.
import test from "node:test";
import assert from "node:assert/strict";
import { access, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";
import { AcpAgentSession } from "../src/acp-agent-session.mjs";
import { ProviderManager } from "../src/provider-manager.mjs";
import { antigravitySignInState, prepareAntigravityHome } from "../src/antigravity-auth.mjs";
import { acpSession, scriptedAcp } from "./fixtures/scripted-acp.mjs";

const AGENT=fileURLToPath(new URL("./fixtures/antigravity-acp-agent.mjs",import.meta.url));
const KEY="AIzaSyTrebellFixtureKey0123456789abcdef";
const SIGN_IN_NEEDED="Antigravity is not signed in. Press Sign in to sign in with Antigravity's own sign-in, or set it to run on a Google Gemini API key.";
const KEY_MISSING="Antigravity is set to run on the Google Gemini API key, and Trebell Code has none. Add it under Antigravity in Settings → Agents & models, or set Antigravity to Sign in.";
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
const memoryState=settings=>({settings:()=>settings,updateSettings:patch=>{Object.assign(settings,patch)}});
const PROFILE={id:"antigravity-default",kind:"antigravity",displayName:"Antigravity",enabled:true,environment:{},approvedEnvironmentKeys:["GEMINI_API_KEY","GOOGLE_API_KEY","GOOGLE_CLOUD_PROJECT","AGY_ACP_CCPA_PROJECT","TREBELL_AGY_SCENARIO","TREBELL_AGY_LOG"]};

test("an Antigravity launch takes no Google credential, project or home of Trebell's environment, and the Gemini key only on API key",async t=>{
  const {person,trebell}=await homes(t);
  for(const platform of ["linux","win32"]){
    // On Windows a name is one variable whatever its case.
    const inherited=platform==="win32"?{...INHERITED,Gemini_Api_Key:INHERITED.GEMINI_API_KEY,google_api_key:INHERITED.GOOGLE_API_KEY}:INHERITED;
    const env={PATH:"/usr/bin",HOME:person,USERPROFILE:person,TREBELL_HOME:trebell,...inherited};
    const providers=new ProviderManager({env});providers.setKey("gemini",KEY);
    const settings={agentRuntimeInstances:[{...PROFILE}]};
    const manager=new AgentRuntimeManager({state:memoryState(settings),env,platform,providers});
    let launch=manager.childEnv(manager.instances().find(item=>item.kind==="antigravity"));
    for(const name of Object.keys(inherited))if(name.toUpperCase()!=="GEMINI_HOME")assert.equal(launch[name],undefined,`${platform}: ${name} stays out on Sign in`);
    assert.equal(launch.GEMINI_HOME,join(trebell,"antigravity-home"),`${platform}: Antigravity's home is Trebell's for it, not the person's ~/.gemini`);
    assert.equal(launch.AGY_ACP_FORCE_FILE_STORAGE,"1","its logins stay files in that home, never the system keychain's");
    assert.equal(launch.PATH,"/usr/bin");
    manager.setAuthMethod("antigravity-default","api-key");
    launch=manager.childEnv(manager.instances().find(item=>item.kind==="antigravity"));
    assert.equal(launch.GEMINI_API_KEY,KEY,`${platform}: the Gemini key saved in Trebell, as GEMINI_API_KEY`);
    for(const name of Object.keys(inherited))if(!["GEMINI_API_KEY","GEMINI_HOME"].includes(name.toUpperCase()))assert.equal(launch[name],undefined,`${platform}: ${name} stays out with a key`);
    assert.equal(Object.keys(launch).filter(name=>/^gemini_api_key$/i.test(name)).length,1,"one GEMINI_API_KEY");
    providers.setKey("gemini","");
    assert.equal(manager.childEnv(manager.instances().find(item=>item.kind==="antigravity")).GEMINI_API_KEY,INHERITED.GEMINI_API_KEY,`${platform}: with none saved, the variable Native reads counts`);
  }
});

test("Antigravity's home names the method it signs in with, never a key, and keeps what the agent wrote there",async t=>{
  const {person,trebell}=await homes(t),env={HOME:person,USERPROFILE:person,TREBELL_HOME:trebell};
  const settingsPath=join(trebell,"antigravity-home","antigravity-acp","settings.json");
  await mkdir(join(trebell,"antigravity-home","antigravity-acp"),{recursive:true});await writeFile(settingsPath,JSON.stringify({ui:{theme:"dark"},auth:{type:"oauth-personal",note:"kept"}}));
  // On Sign in the method its own sign-in recorded stays.
  assert.equal((await prepareAntigravityHome({env})).settingsPath,settingsPath);
  assert.deepEqual(JSON.parse(await readFile(settingsPath,"utf8")),{ui:{theme:"dark"},auth:{type:"oauth-personal",note:"kept"}});
  // On API key the key method, then back on Sign in no method a key left.
  await prepareAntigravityHome({env,method:"gemini-api-key"});
  assert.deepEqual(JSON.parse(await readFile(settingsPath,"utf8")),{ui:{theme:"dark"},auth:{type:"gemini-api-key",note:"kept"}});
  await prepareAntigravityHome({env});
  assert.deepEqual(JSON.parse(await readFile(settingsPath,"utf8")),{ui:{theme:"dark"},auth:{note:"kept"}});
  assert.ok(!(await readFile(settingsPath,"utf8")).includes(KEY));
  await assert.rejects(access(join(person,".gemini","antigravity-acp","settings.json")),{code:"ENOENT"},"the person's own ~/.gemini settings, which Zed or JetBrains share, are not written");
  // Its sign-in state: the method and whether its token file is there, which is never read.
  assert.deepEqual(await antigravitySignInState({env}),{method:null,token:false,signedIn:false});
  await prepareAntigravityHome({env,method:"oauth-personal"});await writeFile(join(trebell,"antigravity-home","antigravity-acp","acp_token.json"),"fixture");
  assert.deepEqual(await antigravitySignInState({env}),{method:"oauth-personal",token:true,signedIn:true});
});

test("the person's global skills are linked into Antigravity's home, and removing that home leaves them",async t=>{
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

test("Settings' status check follows the method: Antigravity's own sign-in, or the Gemini key, and no snapshot holds a key",async t=>{
  const {person,trebell}=await homes(t),env={PATH:process.env.PATH,HOME:person,USERPROFILE:person,TREBELL_HOME:trebell,...INHERITED};
  delete env.GEMINI_API_KEY;delete env.GOOGLE_API_KEY;
  await install(trebell);
  const settings={agentRuntime:"antigravity",agentRuntimeInstanceId:"antigravity-default"},providers=new ProviderManager({env});
  const manager=new AgentRuntimeManager({state:memoryState(settings),env,providers,runFn:async()=>({ok:false,code:127,stdout:"",stderr:"not found"})});
  const read=async()=>{const status=await manager.probe("antigravity",{fresh:true});return {available:status.available,authenticated:status.authenticated,account:status.account,message:status.message,method:status.authMethod}};
  assert.deepEqual(await read(),{available:false,authenticated:false,account:null,message:SIGN_IN_NEEDED,method:"sign-in"});
  // Its own sign-in in its home: the method its settings name and its token file.
  await prepareAntigravityHome({env,method:"oauth-personal"});await writeFile(join(trebell,"antigravity-home","antigravity-acp","acp_token.json"),"fixture");
  assert.deepEqual(await read(),{available:true,authenticated:null,account:{authMethod:"oauth-personal",label:"Antigravity sign-in"},message:"Signed in with Antigravity's own sign-in.",method:"sign-in"});
  // Set to its API key: no key, then the one saved in Trebell.
  manager.setAuthMethod("antigravity-default","api-key");
  assert.deepEqual(await read(),{available:false,authenticated:false,account:null,message:KEY_MISSING,method:"api-key"});
  providers.setKey("gemini",KEY);
  assert.deepEqual(await read(),{available:true,authenticated:null,account:{authMethod:"gemini-api-key",label:"Google Gemini API key"},message:"Runs on the Google Gemini API key.",method:"api-key"});
  const snapshot=JSON.stringify(await manager.snapshot());
  assert.ok(snapshot.includes("Runs on the Google Gemini API key."));
  assert.ok(!snapshot.includes(KEY),"the key is not in the harness list");
});

// A chat's session runs the scripted ACP fixture's sign-in scenario: its setup answers auth_required until it signs in with gemini-api-key.
test("an Antigravity chat on API key signs in once with the key method when Antigravity asks; on Sign in it never signs in itself",async t=>{
  const scenario={initialize:{protocolVersion:1,agentCapabilities:{loadSession:true,sessionCapabilities:{resume:{}}},authMethods:[{id:"oauth-personal",name:"Log in with Google"},{id:"gemini-api-key",name:"Gemini API key"}]},sessionNew:{sessionId:"agy-chat"},signIn:{methodId:"gemini-api-key",env:"GEMINI_API_KEY"}};
  const asked=log=>log.filter(entry=>entry.method&&entry.id!=null).map(entry=>entry.method==="authenticate"?`authenticate ${entry.params.methodId}`:entry.method);
  const keyed=await scriptedAcp(t,scenario);keyed.env={...keyed.env,GEMINI_API_KEY:KEY};
  const {session}=acpSession(t,keyed,{runtime:"antigravity",authMethod:"api-key"});
  assert.equal((await session.start()).session.sessionId,"agy-chat");
  assert.deepEqual(asked(await keyed.log()),["initialize","session/new","authenticate gemini-api-key","session/new"]);
  const resumed=await scriptedAcp(t,scenario);resumed.env={...resumed.env,GEMINI_API_KEY:KEY};
  await acpSession(t,resumed,{runtime:"antigravity",authMethod:"api-key"}).session.start({providerSessionId:"agy-thread"});
  assert.deepEqual(asked(await resumed.log()),["initialize","session/resume","authenticate gemini-api-key","session/resume"],"a resumed chat too");
  const own=await scriptedAcp(t,scenario);own.env={...own.env,GEMINI_API_KEY:KEY};
  await assert.rejects(acpSession(t,own,{runtime:"antigravity"}).session.start(),error=>error.message===SIGN_IN_NEEDED&&error.code===-32000);
  assert.deepEqual(asked(await own.log()),["initialize","session/new"],"on Sign in no method is tried from a chat, a key around or not");
});

test("an Antigravity that exits for want of IPv6 sockets says so as a chat starts and on Settings' model list",{timeout:60_000},async t=>{
  const {root,person,trebell}=await homes(t),scenarioPath=join(root,"scenario.json"),logPath=join(root,"log.jsonl");
  await writeFile(scenarioPath,JSON.stringify({exitAt:"initialize",exitCode:1,stderr:"OSError: [Errno 97] Address family not supported by protocol (AF_INET6)\n"}));
  const base={...process.env,TEMP:join(root,"tmp"),TMP:join(root,"tmp"),TREBELL_AGY_SCENARIO:scenarioPath,TREBELL_AGY_LOG:logPath};
  const session=new AcpAgentSession({runtime:"antigravity",command:process.execPath,args:[AGENT],cwd:root,env:base,onUpdate:()=>{}});
  t.after(()=>session.close().catch(()=>{}));
  await assert.rejects(session.start(),error=>error.message===IPV6);
  // The model list: a profile's own executable (a wrapper of the stand-in), read where it runs, on its API key.
  const windows=process.platform==="win32",wrapper=join(root,windows?"agy.cmd":"agy");
  await writeFile(wrapper,windows?`@"${process.execPath}" "${AGENT}" %*\r\n`:`#!/bin/sh\nexec "${process.execPath}" "${AGENT}" "$@"\n`,{mode:0o755});
  const env={...base,HOME:person,USERPROFILE:person,TREBELL_HOME:trebell},providers=new ProviderManager({env});providers.setKey("gemini",KEY);
  const manager=new AgentRuntimeManager({state:memoryState({agentRuntimeInstances:[{...PROFILE,binaryPath:wrapper,auth:"api-key"}]}),env,providers});
  const first=await manager.models("antigravity");
  assert.equal(first.source,"manifest");assert.ok(first.models.length>0,"the stand-in list first");
  let listed=first;
  for(const started=Date.now();!listed.error&&Date.now()-started<15_000;)await new Promise(resolve=>setTimeout(resolve,100)),listed=await manager.models("antigravity");
  assert.equal(listed.error,IPV6);assert.ok(listed.models.length>0,"with the stand-in list");
});

test("an Antigravity on Sign in that has not signed in starts nothing for its model list",async t=>{
  const {root,person,trebell}=await homes(t),logPath=join(root,"log.jsonl");
  const windows=process.platform==="win32",wrapper=join(root,windows?"agy.cmd":"agy");
  await writeFile(wrapper,windows?`@"${process.execPath}" "${AGENT}" %*\r\n`:`#!/bin/sh\nexec "${process.execPath}" "${AGENT}" "$@"\n`,{mode:0o755});
  const env={...process.env,TEMP:join(root,"tmp"),TMP:join(root,"tmp"),TREBELL_AGY_LOG:logPath,HOME:person,USERPROFILE:person,TREBELL_HOME:trebell,GEMINI_API_KEY:KEY};
  const manager=new AgentRuntimeManager({state:memoryState({agentRuntimeInstances:[{...PROFILE,binaryPath:wrapper}]}),env});
  const listed=await manager.models("antigravity");
  assert.equal(listed.source,"manifest");
  await new Promise(resolve=>setTimeout(resolve,1500));
  let logged="";try{logged=await readFile(logPath,"utf8")}catch{}
  assert.equal(logged.includes("initialize"),false,"no Antigravity was started to list its models");
});
