// OpenCode on its API keys runs with none of the sign-ins `opencode auth login` keeps, by its line. OpenCode 1.x reads
// OPENCODE_AUTH_CONTENT in place of the ones in its data home, so it gets an empty set of them. OpenCode 2.x keeps them in its
// database, puts them ahead of a key in its environment and reads no OPENCODE_AUTH_CONTENT, so it runs on a database of Trebell's own
// for the profile (OPENCODE_DB), which holds none of them. Its status and catalog read, and Git text, ask for the environment of the
// version the status read (the relay's own test is in agent-relay-opencode2.test.mjs). Fakes only: fixture keys, fresh folders.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";
import { ProviderManager } from "../src/provider-manager.mjs";
import { generateTextWithHarness } from "../src/harness-text-generation.mjs";

const OPENCODE={id:"opencode-default",kind:"opencode",displayName:"OpenCode",enabled:true,environment:{}};
// The database of Trebell's own for a profile (agent-runtime-manager.mjs openCodeApiKeyDatabase).
const databaseOf=(env,profile)=>join(env.TREBELL_HOME,"opencode-api-key-homes",profile.id,"opencode.db");
function manager(t,profiles,{runFn}={}){
  const home=mkdtempSync(join(tmpdir(),"trebell-opencode-db-"));t.after(()=>rmSync(home,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  const env={PATH:"",HOME:home,USERPROFILE:home,TREBELL_HOME:join(home,"trebell"),CODEX_HOME:join(home,"codex")};
  const providers=new ProviderManager({env});
  let settings={agentRuntime:"native",agentRuntimeInstanceId:"native-default",agentRuntimeInstances:profiles};
  const state={settings:()=>settings,updateSettings:patch=>{settings={...settings,...patch};return settings}};
  return {env,providers,runtimes:new AgentRuntimeManager({state,env,platform:"linux",providers,runFn,claudeCapabilitiesCache:{peek:()=>null,load:async()=>null,drop:()=>{}}})};
}

test("OpenCode on its API keys leaves its stored sign-ins out by its line: 1.x on an empty set of them, 2.x on a database of Trebell's own",t=>{
  const onKey={...OPENCODE,auth:"api-key",environment:{OPENCODE_DB:"/the/person/opencode.db"}};
  const {env,providers,runtimes}=manager(t,[onKey]);
  providers.setKey("anthropic","sk-ant-fixture");
  const database=databaseOf(env,onKey);
  const v1=runtimes.childEnv(onKey,{version:"1.18.32"});
  assert.equal(v1.ANTHROPIC_API_KEY,"sk-ant-fixture");assert.equal(v1.OPENCODE_AUTH_CONTENT,"{}","1.x reads an empty set of stored sign-ins");
  const v2=runtimes.childEnv(onKey,{version:"2.2.1"});
  assert.equal(v2.ANTHROPIC_API_KEY,"sk-ant-fixture");
  assert.equal(v2.OPENCODE_DB,database,"2.x runs on Trebell's database for the profile, not the one its environment names");
  assert.equal(Object.hasOwn(v2,"OPENCODE_AUTH_CONTENT"),false,"which 2.x never reads");
  assert.equal(existsSync(dirname(database)),true,"its folder is there for OpenCode to make the database in");
  assert.equal(runtimes.childEnv(onKey,{version:"opencode v2.0.24"}).OPENCODE_DB,database);
  const unknown=runtimes.childEnv(onKey);
  assert.equal(unknown.OPENCODE_AUTH_CONTENT,"{}");assert.equal(unknown.OPENCODE_DB,database,"a version not given takes both");
  // On Sign in its own sign-ins serve, whatever its line; an install or update takes nothing of the key method's.
  for(const version of ["1.18.32","2.2.1",null]){
    const own=runtimes.childEnv({...OPENCODE},{version});
    assert.equal(Object.hasOwn(own,"OPENCODE_AUTH_CONTENT"),false,String(version));assert.equal(Object.hasOwn(own,"OPENCODE_DB"),false,String(version));assert.equal(Object.hasOwn(own,"ANTHROPIC_API_KEY"),false,String(version));
  }
  const install=runtimes.childEnv(onKey,{key:false,version:"2.2.1"});
  assert.equal(Object.hasOwn(install,"OPENCODE_AUTH_CONTENT"),false);assert.notEqual(install.OPENCODE_DB,database);assert.equal(Object.hasOwn(install,"ANTHROPIC_API_KEY"),false);
});

test("OpenCode's status and catalog on its API keys are read in the environment of the version its check gave",async t=>{
  for(const [version,line] of [["2.2.1",2],["1.18.32",1]]){
    const onKey={...OPENCODE,auth:"api-key",binaryPath:"/no/opencode/here"};
    const {env,providers,runtimes}=manager(t,[onKey],{runFn:async(_command,args)=>args[0]==="--version"?{ok:true,code:0,error:null,stdout:version+"\n",stderr:""}:{ok:false,code:null,error:"spawn ENOENT",stdout:"",stderr:""}});
    providers.setKey("anthropic","sk-ant-fixture");
    const reads=[];
    runtimes.openCodeCatalogReader=async options=>{reads.push(options);return {models:["anthropic/model"],metadata:[{id:"anthropic/model",name:"Model",provider:"opencode",agent:"OpenCode"}],preferred:"anthropic/model",connectedProviders:["anthropic"],inventory:{commands:[],skills:[],agents:[{name:"build"}]},source:"live-connected"}};
    const status=await runtimes.probe(onKey);
    assert.equal(status.available,true,status.message);
    assert.deepEqual((await runtimes.models(onKey)).models,["anthropic/model"]);
    assert.equal(reads.length,1);assert.equal(reads[0].version,version);assert.equal(reads[0].env.ANTHROPIC_API_KEY,"sk-ant-fixture");
    if(line===2){assert.equal(reads[0].env.OPENCODE_DB,databaseOf(env,onKey),"2.x on Trebell's database");assert.equal(Object.hasOwn(reads[0].env,"OPENCODE_AUTH_CONTENT"),false)}
    else{assert.equal(reads[0].env.OPENCODE_AUTH_CONTENT,"{}","1.x on no stored sign-in");assert.equal(Object.hasOwn(reads[0].env,"OPENCODE_DB"),false)}
  }
});

test("OpenCode's Git text asks for the environment of the version its status read, 2.x's and 1.x's",async t=>{
  for(const version of ["2.0.24","1.18.32"]){
    const asked=[],instance={...OPENCODE,auth:"api-key"};
    const runtimeManager={
      definitions:()=>[{id:"opencode",name:"OpenCode",protocol:"sdk"}],activeInstance:()=>instance,
      probe:async()=>({id:instance.id,kind:"opencode",name:"OpenCode",available:true,authenticated:true,version}),recheck:async()=>null,keyRefusal:()=>null,
      executable:()=>process.execPath,childEnv:(_instance,options)=>{asked.push(options??null);throw new Error("the environment was asked for")},
      authMethod:()=>"api-key",processSpawner:()=>null,remoteIo:()=>null,runtimeCwd:cwd=>cwd,
    };
    const cwd=mkdtempSync(join(tmpdir(),"trebell-opencode-db-text-"));t.after(()=>rmSync(cwd,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
    await assert.rejects(generateTextWithHarness({runtimeManager,instance,prompt:"Write a commit message for: fix",cwd,version:"0.0.0",timeoutMs:30_000}),/the environment was asked for/);
    assert.deepEqual(asked,[{version}],version);
  }
});
