// How each official harness signs in, as the person picks it in Settings for a profile (harness-auth.mjs): Sign in, its own login,
// by default; or API key, its vendor's key from Trebell's one key per provider (the Model provider card's store, else the variable
// Native reads). Nothing else decides it: keys in Trebell's environment, in the store and in a profile's approved names never reach a
// harness on Sign in, and one on API key gets only its own vendor's key. Cursor has no API key. Fixture values and fakes only.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntimeManager, codexApiKeyHome, installEnvironment } from "../src/agent-runtime-manager.mjs";
import { ProviderManager } from "../src/provider-manager.mjs";
import { HARNESS_KEY_VARIABLES, harnessAuthMethod, normalizeHarnessAuthMethod } from "../src/harness-auth.mjs";
import { museEnvironment } from "../src/muse-host.mjs";
import { migrateHarnessSecrets } from "../src/legacy-harness-key-migration.mjs";
import { buildRuntimeEnvironment } from "../src/runtime-environment.mjs";

const HARNESSES=["codex","claude","cursor","grok","opencode","antigravity","muse"];
// Every key and sign-in name a harness, or Native, reads from an environment.
const KEYS={OPENAI_API_KEY:"env-openai",CODEX_API_KEY:"env-codex",ANTHROPIC_API_KEY:"env-anthropic",ANTHROPIC_AUTH_TOKEN:"env-anthropic-token",CLAUDE_CODE_OAUTH_TOKEN:"env-claude-oauth",
  GEMINI_API_KEY:"env-gemini",GOOGLE_API_KEY:"env-google",XAI_API_KEY:"env-xai",GROK_AUTH:"{\"key\":\"env-grok\"}",META_API_KEY:"env-meta",MODEL_API_KEY:"env-model",
  CURSOR_API_KEY:"env-cursor",CURSOR_AUTH_TOKEN:"env-cursor-token",OPENCODE_API_KEY:"env-opencode",OPENCODE_AUTH_CONTENT:"{}",HF_TOKEN:"env-hf",
  AWS_ACCESS_KEY_ID:"AKIAFIXTURE",AWS_SECRET_ACCESS_KEY:"env-aws",GITHUB_TOKEN:"env-github"};
const STORED={openai:"store-openai",anthropic:"store-anthropic",gemini:"store-gemini",xai:"store-xai",meta:"store-meta"};
const VALUES=new Set([...Object.values(KEYS),...Object.values(STORED)]);

function fixture(t,{env={},instances=[]}={}){
  const home=mkdtempSync(join(tmpdir(),"trebell-sign-in-choice-"));t.after(()=>rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  // Codex's shared home is a fresh folder too: a home of Trebell's own for an API key links into it (never the person's ~/.codex).
  const base={PATH:"/usr/bin",HOME:home,USERPROFILE:home,TREBELL_HOME:join(home,"trebell"),CODEX_HOME:join(home,"codex-shared"),...env};
  const providers=new ProviderManager({env:base});
  let settings={agentRuntimeInstances:instances};
  const state={settings:()=>settings,updateSettings:patch=>{settings={...settings,...patch};return settings}};
  const manager=new AgentRuntimeManager({state,env:base,platform:"linux",providers,runFn:async()=>({ok:false,code:127,error:"spawn ENOENT",stdout:"",stderr:""})});
  return {home,base,providers,manager,state,settings:()=>settings};
}
// A profile saved before approvals were checked, holding every key name: what a launch must still leave out.
const approvedEverything=Object.keys(KEYS);
const leaked=env=>Object.entries(env).filter(([,value])=>VALUES.has(String(value))).map(([name])=>name);

test("each harness on Sign in gets no key from Trebell's environment, its key store or its profile's approved names, here or on a host",t=>{
  const {manager,providers}=fixture(t,{env:KEYS});
  for(const [id,key] of Object.entries(STORED))providers.setKey(id,key);
  for(const kind of HARNESSES){
    const profile={id:kind+"-default",kind,approvedEnvironmentKeys:approvedEverything,environment:{OPENAI_API_KEY:"profile-openai"}};
    assert.equal(harnessAuthMethod(profile),"sign-in",kind);
    const env=manager.childEnv(profile);
    assert.deepEqual(leaked(env),[],kind);assert.equal(env.OPENAI_API_KEY,undefined,kind);
    // On a WSL or SSH host no key name is forwarded from the host's shell either.
    assert.deepEqual(manager.childEnvironmentKeys(profile).filter(name=>Object.hasOwn(KEYS,name)),[],kind);
  }
  // Muse Code's own environment filter keeps a META_API_KEY out whatever a launch held.
  assert.equal(museEnvironment({META_API_KEY:"x",meta_api_key:"y",MODEL_API_KEY:"z",PATH:"/bin"}).PATH,"/bin");
  assert.deepEqual(Object.keys(museEnvironment({META_API_KEY:"x",meta_api_key:"y",MODEL_API_KEY:"z",OPENAI_API_KEY:"o",MUSE_CUSTOM_HEADERS:"h"})),["MUSE_NO_AUTO_UPDATE"]);
});

test("each harness on API key gets only its vendor's key: the one saved in Trebell, else the variable Native reads",t=>{
  const {manager,providers}=fixture(t,{env:KEYS});
  const expectFrom=source=>({
    claude:{ANTHROPIC_API_KEY:source.anthropic},codex:{OPENAI_API_KEY:source.openai},muse:{META_API_KEY:source.meta},
    grok:{XAI_API_KEY:source.xai},antigravity:{GEMINI_API_KEY:source.gemini},
    opencode:{OPENAI_API_KEY:source.openai,ANTHROPIC_API_KEY:source.anthropic,GEMINI_API_KEY:source.gemini,XAI_API_KEY:source.xai},
  });
  const check=(source,label)=>{
    for(const [kind,keys] of Object.entries(expectFrom(source))){
      const env=manager.childEnv({id:kind+"-api",kind,auth:"api-key",approvedEnvironmentKeys:approvedEverything});
      const got=Object.fromEntries(leaked(env).map(name=>[name,env[name]]));
      assert.deepEqual(got,keys,`${label} ${kind}`);
    }
  };
  // Nothing saved: Native's own variables count (Gemini's first name, GEMINI_API_KEY).
  check({openai:KEYS.OPENAI_API_KEY,anthropic:KEYS.ANTHROPIC_API_KEY,gemini:KEYS.GEMINI_API_KEY,xai:KEYS.XAI_API_KEY,meta:KEYS.META_API_KEY},"environment");
  for(const [id,key] of Object.entries(STORED))providers.setKey(id,key);
  check(STORED,"store");
  // Gemini's second name, GOOGLE_API_KEY, reaches Antigravity as GEMINI_API_KEY, the name its key method reads.
  const google=fixture(t,{env:{GOOGLE_API_KEY:"env-google-only"}});
  assert.equal(google.manager.childEnv({id:"antigravity-default",kind:"antigravity",auth:"api-key"}).GEMINI_API_KEY,"env-google-only");
  assert.equal(google.manager.childEnv({id:"antigravity-default",kind:"antigravity",auth:"api-key"}).GOOGLE_API_KEY,undefined);
  // A key saved in Settings counts at once (the server's own ProviderManager), and a key removed goes.
  providers.setKey("anthropic","store-anthropic-2");
  assert.equal(manager.childEnv({id:"claude-api",kind:"claude",auth:"api-key"}).ANTHROPIC_API_KEY,"store-anthropic-2");
  const bare=fixture(t);
  assert.equal(bare.manager.childEnv({id:"claude-api",kind:"claude",auth:"api-key"}).ANTHROPIC_API_KEY,undefined);
});

test("Cursor offers no API key, and a method is only sign-in or api-key",t=>{
  assert.throws(()=>normalizeHarnessAuthMethod("cursor","api-key"),/Cursor has no API key/);
  assert.throws(()=>normalizeHarnessAuthMethod("claude","password"),/sign-in|api-key/);
  assert.equal(normalizeHarnessAuthMethod("claude","API-KEY"),"api-key");
  assert.deepEqual(Object.keys(HARNESS_KEY_VARIABLES).sort(),["antigravity","claude","codex","grok","muse","opencode"]);
  const {manager}=fixture(t,{env:KEYS});
  assert.throws(()=>manager.setAuthMethod("cursor-default","api-key"),/Cursor has no API key/);
  assert.throws(()=>manager.upsertInstance({id:"cursor-default",kind:"cursor",auth:"api-key"}),/Cursor has no API key/);
  // A Cursor profile that holds api-key all the same (edited by hand) still signs in only, with no key.
  const cursor={id:"cursor-default",kind:"cursor",auth:"api-key"};
  assert.equal(harnessAuthMethod(cursor),"sign-in");assert.deepEqual(leaked(manager.childEnv(cursor)),[]);
  assert.equal(manager.authSummary(cursor),null);
});

test("the choice saves on the profile alone, keeps the profile's other settings, and a saved profile keeps it",t=>{
  const {manager,settings}=fixture(t,{instances:[{id:"claude-work",kind:"claude",displayName:"Work",homePath:"/home/me/.claude-work",autoCompactWindow:400000,approvedEnvironmentKeys:["TEAM_FLAG"],environment:{}}]});
  assert.equal(manager.setAuthMethod("claude-work","api-key").changed,true);
  const saved=settings().agentRuntimeInstances.find(item=>item.id==="claude-work");
  assert.deepEqual([saved.auth,saved.homePath,saved.autoCompactWindow,saved.approvedEnvironmentKeys],["api-key","/home/me/.claude-work",400000,["TEAM_FLAG"]]);
  assert.equal(manager.setAuthMethod("claude-work","api-key").changed,false);
  // A profile saved from the editor keeps its method unless it names one, and never stores the list's summary of it.
  manager.upsertInstance({id:"claude-work",kind:"claude",displayName:"Work 2",signIn:{method:"api-key",keys:[]}});
  const again=settings().agentRuntimeInstances.find(item=>item.id==="claude-work");
  assert.equal(again.auth,"api-key");assert.equal(again.signIn,undefined);assert.equal(again.displayName,"Work 2");
  manager.upsertInstance({id:"claude-work",kind:"claude",auth:"sign-in"});
  assert.equal(settings().agentRuntimeInstances.find(item=>item.id==="claude-work").auth,"sign-in");
  // A default profile not saved yet takes the choice too.
  manager.setAuthMethod("grok-default","api-key");
  assert.equal(manager.instances().find(item=>item.id==="grok-default").auth,"api-key");
  // What Settings is told: the method and, per provider, whether a key is there (never the key).
  const listed=manager.authSummary(manager.instances().find(item=>item.id==="grok-default"));
  assert.deepEqual(listed,{method:"api-key",keys:[{provider:"xai",name:"xAI API",variable:"XAI_API_KEY",saved:false,source:null,from:null}]});
});

test("a profile's approved names refuse a key or sign-in for every harness, and Native keeps its own",t=>{
  const {manager}=fixture(t);
  for(const kind of HARNESSES)for(const name of ["ANTHROPIC_API_KEY","AWS_SECRET_ACCESS_KEY","META_API_KEY","XAI_API_KEY","GITHUB_TOKEN","GROK_AUTH","GOOGLE_APPLICATION_CREDENTIALS"])
    assert.throws(()=>manager.upsertInstance({id:kind+"-default",kind,approvedEnvironmentKeys:["HTTPS_PROXY",name]}),new RegExp(name+" holds an API key or sign-in.*Model provider"),kind+" "+name);
  assert.doesNotThrow(()=>manager.upsertInstance({id:"claude-default",kind:"claude",approvedEnvironmentKeys:["HTTPS_PROXY","NO_PROXY"]}));
  assert.deepEqual(manager.upsertInstance({id:"native-default",kind:"native",approvedEnvironmentKeys:["MCP_BEARER_TOKEN"]}).approvedEnvironmentKeys,["MCP_BEARER_TOKEN"]);
});

test("a harness on API key without its key says so in its status, and one with it is ready",async t=>{
  const {manager,providers}=fixture(t);
  // `claude auth status` as Claude Code 2.x answers it (read with a fake key in a fresh home): signed in on the API key only when its
  // launch has ANTHROPIC_API_KEY, else signed out (exit 1).
  const authSeen=[];
  manager.runFn=async(_command,args,options)=>{
    if(args[0]==="--version")return {ok:true,code:0,error:null,stdout:"1.2.3\n",stderr:""};
    if(args[0]!=="auth")return {ok:true,code:0,error:null,stdout:"You are logged in\n",stderr:""};
    authSeen.push(options?.env?.ANTHROPIC_API_KEY);
    return options?.env?.ANTHROPIC_API_KEY?{ok:true,code:0,error:null,stdout:JSON.stringify({loggedIn:true,authMethod:"api_key",apiProvider:"firstParty",apiKeySource:"ANTHROPIC_API_KEY"}),stderr:""}
      :{ok:false,code:1,error:null,stdout:JSON.stringify({loggedIn:false,authMethod:"none",apiProvider:"firstParty"}),stderr:""};
  };
  const claude={id:"claude-api",kind:"claude",auth:"api-key",binaryPath:process.execPath};
  const missing=await manager.probe(claude,{fresh:true});
  assert.deepEqual([missing.available,missing.authenticated,missing.keyMissing,missing.authMethod],[false,false,true,"api-key"]);
  assert.equal(missing.message,"Claude Code is set to run on the Anthropic API key, and Trebell Code has none. Add it under Claude Code in Settings → Agents & models, or set Claude Code to Sign in.");
  providers.setKey("anthropic","store-anthropic");
  const ready=await manager.probe(claude,{fresh:true});
  assert.deepEqual([ready.available,ready.authMethod,ready.keyMissing,ready.message],[true,"api-key",undefined,"Runs on the Anthropic API key."]);
  assert.deepEqual(authSeen,[undefined,"store-anthropic"],"Claude Code's own check reads the key its launch has, the one saved in Trebell");
  // On Sign in its own check runs with no key, and a signed-out Claude Code is told to run claude auth login.
  const own=await manager.probe({id:"claude-own",kind:"claude",binaryPath:process.execPath},{fresh:true});
  assert.deepEqual([own.available,own.authenticated,own.authMethod,authSeen.at(-1)],[false,false,"sign-in",undefined]);
  assert.match(own.message,/claude auth login/);
  // Grok on its key is ready on the key without asking Grok; on Sign in only `grok models` decides, an XAI_API_KEY nowhere.
  const asked=[];manager.runFn=async(_command,args,options)=>{asked.push([args.join(" "),options.env.XAI_API_KEY]);return args[0]==="--version"?{ok:true,code:0,error:null,stdout:"0.9.0\n",stderr:""}:{ok:true,code:0,error:null,stdout:"Not logged in\n",stderr:""}};
  providers.setKey("xai","store-xai");
  const grokKey=await manager.probe({id:"grok-api",kind:"grok",auth:"api-key",binaryPath:process.execPath},{fresh:true});
  assert.deepEqual([grokKey.available,grokKey.authenticated,grokKey.account?.authMethod],[true,true,"api_key"]);
  assert.deepEqual(asked.map(([args])=>args),["--version"]);
  asked.length=0;
  const grokOwn=await manager.probe({id:"grok-own",kind:"grok",binaryPath:process.execPath},{fresh:true});
  assert.deepEqual([grokOwn.available,grokOwn.authenticated],[false,false]);assert.match(grokOwn.message,/grok login/);
  assert.deepEqual(asked,[["--version",undefined],["models",undefined],["models",undefined]]);
});

test("a Codex profile on API key signs in to a home of Trebell's own with codex login --with-api-key, the key on its stdin",async t=>{
  const {manager,providers,base,home}=fixture(t);
  const log=join(home,"codex-calls.json"),fake=join(home,"fake-codex.mjs");
  writeFileSync(fake,`import { appendFileSync } from "node:fs";let input="";process.stdin.on("data",chunk=>{input+=chunk});process.stdin.on("end",()=>{appendFileSync(${JSON.stringify(log)},JSON.stringify({args:process.argv.slice(2),stdinHasKey:input.includes("store-openai"),stdinLength:input.length,home:process.env.CODEX_HOME,keyInEnv:Boolean(process.env.OPENAI_API_KEY)})+"\\n")});`);
  const profile={id:"codex-default",kind:"codex",auth:"api-key"};
  const config=manager.codexHomeConfig(profile);
  assert.equal(config.shadowHomePath,codexApiKeyHome(base,profile));assert.equal(config.homePath,null);assert.equal(config.defaultHome,base.CODEX_HOME);
  // The person's own sign-in home stays the shared one: its threads continue across the choice.
  assert.equal(manager.continuationKey(profile),manager.continuationKey({id:"codex-default",kind:"codex"}));
  providers.setKey("openai","store-openai");
  const calls=()=>existsSync(log)?readFileSync(log,"utf8").trim().split("\n").map(line=>JSON.parse(line)):[];
  // A launcher that runs the fake with the login's arguments stands in for codex.
  const wrapper=join(home,process.platform==="win32"?"codex-wrapper.cmd":"codex-wrapper");
  if(process.platform==="win32")writeFileSync(wrapper,`@"${process.execPath}" "${fake}" %*\r\n`);
  else writeFileSync(wrapper,`#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`,{mode:0o755});
  assert.deepEqual((await manager.codexApiKeyLogin(profile,{command:wrapper})).ran,true);
  assert.deepEqual((await manager.codexApiKeyLogin(profile,{command:wrapper})).ran,false,"the same key and home sign in once");
  providers.setKey("openai","");
  // With no key the earlier key's sign-in goes, once, and Codex does not start: its app-server (a turn's, the model list's) fails
  // with the status's words, so no turn runs on a half sign-in.
  const missing="Codex is set to run on the OpenAI API key, and Trebell Code has none. Add it under Codex in Settings → Agents & models, or set Codex to Sign in.";
  await assert.rejects(manager.codexApiKeyLogin(profile,{command:wrapper}),error=>error.message===missing&&error.code==="HARNESS_KEY_MISSING");
  await assert.rejects(manager.codexApiKeyLogin(profile,{command:wrapper}),error=>error.message===missing,"still none: still refused, with no second logout");
  const [first,second]=calls();
  assert.deepEqual(first.args,["login","--with-api-key"]);assert.equal(first.stdinHasKey,true);assert.equal(first.home,config.shadowHomePath);assert.equal(first.keyInEnv,true);
  assert.deepEqual(second.args,["logout"]);assert.equal(second.stdinLength,0);
  // A profile on Sign in runs no login at all.
  assert.deepEqual(await manager.codexApiKeyLogin({id:"codex-default",kind:"codex"},{command:wrapper}),{ran:false});
  assert.equal(calls().length,2);
});

test("a Codex profile set back to Sign in, or an OpenAI key removed, leaves no copy of the key in Codex's home of Trebell's own",async t=>{
  const {manager,providers,base,home}=fixture(t);
  const log=join(home,"codex-calls.json"),fake=join(home,"fake-codex.mjs");
  writeFileSync(fake,`import { appendFileSync } from "node:fs";let input="";process.stdin.on("data",chunk=>{input+=chunk});process.stdin.on("end",()=>{appendFileSync(${JSON.stringify(log)},JSON.stringify({args:process.argv.slice(2),home:process.env.CODEX_HOME,keyInEnv:Boolean(process.env.OPENAI_API_KEY)})+"\\n")});`);
  const wrapper=join(home,process.platform==="win32"?"codex-wrapper.cmd":"codex-wrapper");
  if(process.platform==="win32")writeFileSync(wrapper,`@"${process.execPath}" "${fake}" %*\r\n`);
  else writeFileSync(wrapper,`#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`,{mode:0o755});
  const calls=()=>existsSync(log)?readFileSync(log,"utf8").trim().split("\n").map(line=>JSON.parse(line)):[];
  const profile={id:"codex-default",kind:"codex",auth:"api-key"},keyHome=codexApiKeyHome(base,profile);
  // A profile that never ran on an API key has no such home: nothing runs.
  assert.deepEqual(await manager.codexApiKeyLogout({id:"codex-default",kind:"codex"},{command:wrapper}),{ran:false});
  providers.setKey("openai","store-openai");
  await manager.codexApiKeyLogin(profile,{command:wrapper});
  const out=await manager.codexApiKeyLogout({id:"codex-default",kind:"codex"},{command:wrapper});
  assert.deepEqual(out,{ran:true,ok:true});
  const [login,logout]=calls();
  assert.deepEqual(login.args,["login","--with-api-key"]);
  assert.deepEqual([logout.args,logout.home,logout.keyInEnv],[["logout"],keyHome,false],"codex logout in that home, with no key in its environment");
  // The next start on an API key signs in again.
  assert.equal((await manager.codexApiKeyLogin(profile,{command:wrapper})).ran,true);
  assert.equal(calls().length,3);
});

test("in a WSL or SSH environment a harness on API key gets no key from the host's shell or Trebell and says to sign in there",async t=>{
  const profile={id:"ssh-keys",type:"ssh",cwd:"/srv/app"},executed=[];
  const environments={get:id=>id===profile.id?profile:null,spawnArgv:()=>{throw new Error("nothing is started on the host")},
    executeArgv:async(_id,{command,args,environmentNames})=>{executed.push({command,args,environmentNames});return {exitCode:0,stdout:"0.9.0\n",stderr:""}}};
  const {base}=fixture(t,{env:KEYS});
  const providers=new ProviderManager({env:base});for(const [id,key] of Object.entries(STORED))providers.setKey(id,key);
  const manager=new AgentRuntimeManager({state:{settings:()=>({activeEnvironmentId:profile.id})},environments,env:base,platform:"linux",providers});
  for(const kind of Object.keys(HARNESS_KEY_VARIABLES)){
    for(const auth of ["api-key","sign-in"]){
      const names=manager.childEnvironmentKeys({id:kind+"-x",kind,auth,approvedEnvironmentKeys:approvedEverything});
      assert.deepEqual(names.filter(name=>Object.hasOwn(KEYS,name)),[],`${kind} on ${auth}`);
    }
    assert.equal(manager.remoteKeyRefusal({id:kind+"-x",kind}),null,`${kind} on Sign in signs in there`);
    assert.match(manager.remoteKeyRefusal({id:kind+"-x",kind,auth:"api-key"}),/runs on an API key only on this machine: Trebell Code never sends a saved key to a WSL or SSH environment\. In this environment, set .+ to Sign in and sign in there/,kind);
  }
  // On this machine nothing is refused.
  assert.equal(manager.remoteKeyRefusal({id:"grok-x",kind:"grok",auth:"api-key"},null),null);
  // Its status there says so, and no host command carries a key name.
  const status=await manager.probe({id:"grok-api",kind:"grok",auth:"api-key"},{fresh:true});
  assert.deepEqual([status.available,status.authenticated,status.authMethod],[false,false,"api-key"]);
  assert.equal(status.message,"Grok Build runs on an API key only on this machine: Trebell Code never sends a saved key to a WSL or SSH environment. In this environment, set Grok Build to Sign in and sign in there with grok login.");
  assert.ok(executed.length>0);
  for(const call of executed)assert.deepEqual((call.environmentNames||[]).filter(name=>Object.hasOwn(KEYS,name)),[]);
});

test("an Antigravity key saved by the old key form moves into the empty Gemini slot and Antigravity starts on its API key",t=>{
  const {base,providers,state,settings}=fixture(t);
  const path=join(base.TREBELL_HOME,"harness-secrets.json");
  mkdirSync(base.TREBELL_HOME,{recursive:true});
  writeFileSync(path,JSON.stringify({"antigravity.geminiApiKey":"old-antigravity-key"}));
  const moved=migrateHarnessSecrets({env:base,providers,state});
  assert.deepEqual([moved.moved,moved.keptSlot,moved.antigravityOnApiKey],[true,false,true]);
  assert.deepEqual(providers.keyFor("gemini"),{provider:"gemini",key:"old-antigravity-key",source:"settings",variable:null});
  assert.equal(existsSync(path),false,"the old store goes");
  assert.equal(settings().agentRuntimeInstances.find(item=>item.id==="antigravity-default").auth,"api-key");
  // A second start finds nothing to move.
  assert.deepEqual(migrateHarnessSecrets({env:base,providers,state}),{migrated:false});
  // A Gemini slot that has a key of its own keeps it; the old entry still goes and Antigravity still starts on its key.
  const other=fixture(t);other.providers.setKey("gemini","native-gemini");
  mkdirSync(other.base.TREBELL_HOME,{recursive:true});
  writeFileSync(join(other.base.TREBELL_HOME,"harness-secrets.json"),JSON.stringify({"antigravity.geminiApiKey":"old-antigravity-key"}));
  const kept=migrateHarnessSecrets({env:other.base,providers:other.providers,state:other.state});
  assert.deepEqual([kept.moved,kept.keptSlot],[false,true]);assert.equal(other.providers.keyFor("gemini").key,"native-gemini");
  assert.equal(existsSync(join(other.base.TREBELL_HOME,"harness-secrets.json")),false);
  assert.equal(other.settings().agentRuntimeInstances.find(item=>item.id==="antigravity-default").auth,"api-key");
});

test("Native still reads its keys: the one saved, else its environment variable, and its approved names still pass",t=>{
  const {providers}=fixture(t,{env:{OPENAI_API_KEY:"env-openai",GOOGLE_API_KEY:"env-google"}});
  assert.equal(providers.key("openai"),"env-openai");assert.equal(providers.key("gemini"),"env-google");
  providers.setKey("openai","store-openai");assert.equal(providers.key("openai"),"store-openai");
  assert.equal(buildRuntimeEnvironment("native",{parent:{PATH:"/bin",OPENAI_API_KEY:"env-openai"},approved:["OPENAI_API_KEY"],platform:"linux"}).OPENAI_API_KEY,"env-openai");
});

test("npm installs and updates run without any key of Trebell's environment",()=>{
  const env=installEnvironment({PATH:"/bin",HOME:"/home/me",npm_config_prefix:"/opt/npm",HTTPS_PROXY:"http://proxy:8080",...KEYS,NPM_TOKEN:"npm-registry",NODE_AUTH_TOKEN:"gh-packages",npm_config__authToken:"npmrc-token"});
  // npm's own registry sign-in stays, as an .npmrc that names ${NPM_TOKEN} needs it; no provider key or harness sign-in does.
  assert.deepEqual(env,{PATH:"/bin",HOME:"/home/me",npm_config_prefix:"/opt/npm",HTTPS_PROXY:"http://proxy:8080",NPM_TOKEN:"npm-registry",NODE_AUTH_TOKEN:"gh-packages",npm_config__authToken:"npmrc-token"});
});

test("a host's Codex app-server exports none of a profile's variables that hold a key or sign-in",async()=>{
  const {remoteCodexProfileSetup}=await import("../src/environment-app-server.mjs");
  const {prelude}=remoteCodexProfileSetup({runtimeInstance:{kind:"codex",environment:{CUSTOM_MODE:"safe",GROK_AUTH:"{}",OPENCODE_AUTH_CONTENT:"{}",AWS_ACCESS_KEY_ID:"AKIAFIXTURE",GOOGLE_APPLICATION_CREDENTIALS:"/adc.json"}}});
  assert.match(prelude,/export CUSTOM_MODE='safe'/);
  for(const name of ["GROK_AUTH","OPENCODE_AUTH_CONTENT","AWS_ACCESS_KEY_ID","GOOGLE_APPLICATION_CREDENTIALS"])assert.equal(prelude.includes(name),false,name);
});
