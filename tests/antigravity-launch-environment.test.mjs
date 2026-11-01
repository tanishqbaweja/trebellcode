// The environment an Antigravity process starts with (antigravityEnvironment): none of the variables Google's tools read on their own
// (a Gemini or Google key, Application Default Credentials' file, a Google Cloud project, quota project or region, the Gen AI
// client's switch to Vertex AI, a GEMINI_HOME) and none of Antigravity's own AGY_ACP_ switches, whatever the case of the name, and
// every other variable as it was. Trebell's home for it, its logins kept as files, and the Gemini key as GEMINI_API_KEY only when
// a profile runs on it. The launches Settings and chats make: antigravity-api-key.test.mjs.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { antigravityEnvironment } from "../src/antigravity-auth.mjs";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";
import { ProviderManager } from "../src/provider-manager.mjs";

const GOOGLE=["GEMINI_API_KEY","GOOGLE_API_KEY","GOOGLE_APPLICATION_CREDENTIALS","GOOGLE_CLOUD_PROJECT","GCLOUD_PROJECT","CLOUDSDK_CORE_PROJECT",
  "GOOGLE_CLOUD_QUOTA_PROJECT","GOOGLE_CLOUD_LOCATION","GOOGLE_GENAI_USE_VERTEXAI","GEMINI_HOME"];
const SWITCHES=["AGY_ACP_ENABLE_OAUTH","AGY_ACP_CCPA_PROJECT","agy_acp_force_file_storage","Agy_Acp_Anything","AGY_ACP_"];
// Upper, lower and mixed case: Windows reads each as the same variable.
const spellings=name=>[name,name.toLowerCase(),[...name.toLowerCase()].map((c,i)=>i%2?c.toUpperCase():c).join("")];
const HOME="/trebell/antigravity-home";

test("an Antigravity launch inherits no Google key, credential file, project, region, Vertex AI switch or home, nor an AGY_ACP_ switch, in any case",()=>{
  for(const name of [...GOOGLE.flatMap(spellings),...SWITCHES]){
    const launch=antigravityEnvironment({PATH:"/usr/bin",[name]:"inherited"},{home:HOME});
    const left=Object.keys(launch).filter(key=>launch[key]==="inherited");
    assert.deepEqual(left,[],`${name} stays out`);
    assert.equal(launch.PATH,"/usr/bin");
  }
});

test("a name that only contains one of them, and every other variable, passes through as it was and in its order",()=>{
  const value={kept:"by identity"};
  const env={PATH:"/usr/bin",MY_GEMINI_API_KEY:"a",GEMINI_API_KEY_FILE:"b",GOOGLE_CLOUD_PROJECT_ID:"c",XAGY_ACP_X:"d",AGY_ACPX:"e",AGY_ACP:"f",GEMINI_HOMES:"g",
    GOOGLE_API_KEY:"withheld",TREBELL_AGY_SCENARIO:"h",Path:"i",EMPTY:"",COUNT:3,OBJECT:value,LEFT_OUT:undefined};
  const launch=antigravityEnvironment(env,{home:HOME});
  assert.deepEqual(Object.keys(launch),["PATH","MY_GEMINI_API_KEY","GEMINI_API_KEY_FILE","GOOGLE_CLOUD_PROJECT_ID","XAGY_ACP_X","AGY_ACPX","AGY_ACP","GEMINI_HOMES",
    "TREBELL_AGY_SCENARIO","Path","EMPTY","COUNT","OBJECT","LEFT_OUT","GEMINI_HOME","AGY_ACP_FORCE_FILE_STORAGE"],"the variables kept in their order, then Trebell's own");
  for(const name of Object.keys(env))if(name!=="GOOGLE_API_KEY")assert.ok(Object.is(launch[name],env[name]),`${name} as it was`);
  assert.equal(launch.OBJECT,value);
});

// An environment that already holds what Trebell sets: the person's own home, in two cases, a file-storage switch turned off, and
// keys.
const STALE={PATH:"/usr/bin",GEMINI_HOME:"/home/me/.gemini",gemini_home:"C:\\Users\\me\\.gemini",AGY_ACP_FORCE_FILE_STORAGE:"0",GEMINI_API_KEY:"inherited",google_api_key:"inherited"};
const KEY="AIzaSyTrebellFixtureKey0123456789abcdef";

test("the launch gets Trebell's home for Antigravity, its logins as files, and the Gemini key as GEMINI_API_KEY only when one is given",()=>{
  for(const apiKey of [undefined,null,""]){
    const launch=antigravityEnvironment(STALE,apiKey===undefined?{home:HOME}:{home:HOME,apiKey});
    assert.deepEqual(launch,{PATH:"/usr/bin",GEMINI_HOME:HOME,AGY_ACP_FORCE_FILE_STORAGE:"1"},`no key for ${JSON.stringify(apiKey)}`);
  }
  const keyed=antigravityEnvironment(STALE,{home:HOME,apiKey:KEY});
  assert.deepEqual(Object.entries(keyed),[["PATH","/usr/bin"],["GEMINI_HOME",HOME],["AGY_ACP_FORCE_FILE_STORAGE","1"],["GEMINI_API_KEY",KEY]]);
  assert.deepEqual(Object.keys(keyed).filter(name=>/^(?:gemini_api_key|google_api_key|gemini_home|agy_acp_force_file_storage)$/i.test(name)),["GEMINI_HOME","AGY_ACP_FORCE_FILE_STORAGE","GEMINI_API_KEY"],
    "one of each, and no GOOGLE_API_KEY, which Google's client would take before the key Antigravity's key method reads");
});

test("the environment it is given is left as it was, and none given still gives a launch",()=>{
  const env=Object.freeze({PATH:"/usr/bin",GEMINI_API_KEY:"inherited",AGY_ACP_ENABLE_OAUTH:"1"});
  const launch=antigravityEnvironment(env,{home:HOME,apiKey:"key"});
  assert.notEqual(launch,env);
  assert.deepEqual(env,{PATH:"/usr/bin",GEMINI_API_KEY:"inherited",AGY_ACP_ENABLE_OAUTH:"1"});
  assert.equal(Object.getPrototypeOf(launch),Object.prototype);
  for(const none of [undefined,null])assert.deepEqual(antigravityEnvironment(none,{home:HOME}),{GEMINI_HOME:HOME,AGY_ACP_FORCE_FILE_STORAGE:"1"});
  assert.deepEqual(antigravityEnvironment(),{GEMINI_HOME:undefined,AGY_ACP_FORCE_FILE_STORAGE:"1"},"no home given, none set");
});

test("the installer's start check, made from a profile's launch, runs in its own throwaway home with no key",()=>{
  const profileLaunch=antigravityEnvironment({PATH:"/usr/bin",GOOGLE_CLOUD_PROJECT:"project-a"},{home:HOME,apiKey:"key"});
  const check=antigravityEnvironment(profileLaunch,{home:"/tmp/trebell-antigravity-check-1"});
  assert.deepEqual(check,{PATH:"/usr/bin",GEMINI_HOME:"/tmp/trebell-antigravity-check-1",AGY_ACP_FORCE_FILE_STORAGE:"1"});
});

test("a profile's own variables with these names stay out of an Antigravity launch, as its approved names do",async t=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-agy-env-"));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100}));
  for(const platform of ["linux","win32"]){
    const env={PATH:"/usr/bin",HOME:join(root,"person"),USERPROFILE:join(root,"person"),TREBELL_HOME:join(root,"trebell")};
    const environment={GOOGLE_CLOUD_PROJECT:"profile-project",gemini_home:"/profile/.gemini",Google_Genai_Use_Vertexai:"true",GCLOUD_PROJECT:"profile-project",
      AGY_ACP_ENABLE_OAUTH:"1",agy_acp_ccpa_project:"profile-project",TREBELL_AGY_LABEL:"kept"};
    const profile={id:"antigravity-default",kind:"antigravity",displayName:"Antigravity",enabled:true,environment,approvedEnvironmentKeys:[]};
    const settings={agentRuntimeInstances:[profile]};
    const manager=new AgentRuntimeManager({state:{settings:()=>settings,updateSettings:patch=>{Object.assign(settings,patch)}},env,platform,providers:new ProviderManager({env})});
    const launch=manager.childEnv(manager.instances().find(item=>item.kind==="antigravity"));
    for(const name of Object.keys(environment))if(name!=="TREBELL_AGY_LABEL")assert.ok(!Object.keys(launch).some(key=>key.toUpperCase()===name.toUpperCase()&&launch[key]===environment[name]),`${platform}: ${name} stays out`);
    assert.equal(launch.TREBELL_AGY_LABEL,"kept",`${platform}: a profile's other variable is kept`);
    assert.equal(launch.GEMINI_HOME,join(root,"trebell","antigravity-home"),`${platform}: Trebell's home for Antigravity`);
    assert.equal(launch.AGY_ACP_FORCE_FILE_STORAGE,"1");
  }
});
