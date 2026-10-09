import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createGuiServer } from "../src/gui-server.mjs";
import { NO_ACCOUNT_SIGN_IN_MESSAGE, main } from "../src/trebell.mjs";
import { RETIRED_MODEL_PROVIDERS, isRetiredModelProvider, isRetiredProviderModel, isRetiredProviderSelection, migrateLegacyNativeThread, migrateLegacyProjectSettings, migrateLegacyProviderSettings, migrateLegacyQueueItems, removeRetiredProviderData, retiredProviderDataPaths } from "../src/legacy-provider-migration.mjs";
import { DEFAULT_MODEL_PROVIDER, MODEL_PROVIDERS, ProviderManager, normalizeProviderId } from "../src/provider-manager.mjs";
import { providerCapabilities, providerFeatureEnabled } from "../src/provider-capabilities.mjs";
import { SqliteStateCollections } from "../src/sqlite-state-collections.mjs";
import { TrebellStateStore } from "../src/trebell-state.mjs";

async function exists(path){try{await lstat(path);return true}catch(error){if(error?.code==="ENOENT")return false;throw error}}
// A Trebell home as an older install left it: the retired provider's bridge directory and instance id next to
// unrelated data, including look-alike names, all of which must survive the cleanup.
async function seedRetiredProviderHome(home){
  const bridge=join(home,"freebuff2api");await mkdir(bridge,{recursive:true});
  await writeFile(join(bridge,"credentials.json"),JSON.stringify({default:{id:"fixture-user",email:"user@example.invalid",name:"Fixture",authToken:"FIXTURE-NOT-A-SECRET"}}));
  await writeFile(join(bridge,"fingerprint"),"fixture-fingerprint");
  await writeFile(join(bridge,"pending-login.json"),JSON.stringify({fingerprintId:"fixture"}));
  await writeFile(join(home,"freebuff-instance-id"),"00000000-0000-4000-8000-000000000000");
  await writeFile(join(home,"ui-state.json"),JSON.stringify({version:2,settings:{onboardingComplete:true,modelProvider:"agentrouter"},projects:[]}));
  await mkdir(join(home,"codex"),{recursive:true});await writeFile(join(home,"codex","config.toml"),"# fixture\n");
  await mkdir(join(home,"attachments"),{recursive:true});await writeFile(join(home,"attachments","keep.txt"),"keep");
  await mkdir(join(home,"freebuff2api.bak"),{recursive:true});await writeFile(join(home,"freebuff2api.bak","credentials.json"),"{}");
  await writeFile(join(home,"freebuff-instance-id.old"),"keep");
  return {kept:["ui-state.json","codex","attachments","freebuff2api.bak","freebuff-instance-id.old"]};
}

function deepFreeze(value){if(value&&typeof value==="object"){Object.freeze(value);for(const child of Object.values(value))deepFreeze(child)}return value}
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

test("the retired provider id and its model prefix are recognised case-insensitively",()=>{
  assert.deepEqual(RETIRED_MODEL_PROVIDERS,["freebuff"]);assert.equal(Object.isFrozen(RETIRED_MODEL_PROVIDERS),true);
  for(const id of ["freebuff"," FreeBuff ","FREEBUFF"])assert.equal(isRetiredModelProvider(id),true,id);
  for(const id of ["openai","agentrouter","",null,undefined,"freebuff2api","freebuff/test"])assert.equal(isRetiredModelProvider(id),false,String(id));
  for(const model of ["freebuff/deepseek/deepseek-v4-flash","freebuff/test/coding-fast","FreeBuff/z-ai/glm-5.3-flash"," freebuff/test/coding-large"])assert.equal(isRetiredProviderModel(model),true,model);
  for(const model of ["freebuff","freebuff-test","deepseek/deepseek-v4-flash","test/coding-fast","gpt-6-luna","openai/freebuff/x","",null,undefined,42,{id:"freebuff/x"}])assert.equal(isRetiredProviderModel(model),false,String(model));
});

test("the retired provider is gone from the registry and resolves to the default and the conservative capability profile",async()=>{
  assert.equal(Object.prototype.hasOwnProperty.call(MODEL_PROVIDERS,"freebuff"),false);
  assert.equal(normalizeProviderId("freebuff"),DEFAULT_MODEL_PROVIDER);assert.equal(normalizeProviderId(" Freebuff "),"openai");
  assert.deepEqual(providerCapabilities("freebuff"),providerCapabilities(null));
  assert.equal(providerFeatureEnabled("freebuff","promptCaching"),false);assert.equal(providerFeatureEnabled("freebuff","persistentConnection"),false);
  const home=await mkdtemp(join(tmpdir(),"trebell-retired-provider-registry-"));
  try{
    const manager=new ProviderManager({env:{TREBELL_HOME:home},fetchFn:async()=>{throw new Error("no network")}});
    assert.equal(manager.definitions().some(item=>item.id==="freebuff"),false);assert.equal(manager.get("freebuff").id,"openai");
    assert.deepEqual(await manager.models("freebuff"),{models:[],defaultModel:null,source:"none",error:"API key required"});
  }finally{await rm(home,{recursive:true,force:true})}
});

test("retired provider account routes are gone from the GUI server",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-retired-provider-routes-"));
  const [port,appPort]=await Promise.all([freePort(),freePort()]);
  const gui=await createGuiServer({port,appPort,mock:true,env:{...process.env,TREBELL_HOME:home,TREBELL_HISTORY_DISABLE_CLAUDE:"1"}});
  try{
    for(const [path,method] of [["/api/freebuff/overview?timezone=UTC","GET"],["/api/freebuff/heartbeat","POST"]]){
      const response=await fetch(gui.url+path,{method,...(method==="POST"?{headers:{"content-type":"application/json"},body:"{}"}:{})});
      assert.equal(response.status,404,path+" must not remain an API surface");
      assert.deepEqual(await response.json(),{error:"API route not found"});
    }
  }finally{
    await gui.close();
    await rm(home,{recursive:true,force:true,maxRetries:30,retryDelay:100});
  }
});

test("legacy settings move the Native provider selection to the default provider",()=>{
  let result=migrateLegacyProviderSettings({modelProvider:"freebuff"},{defaultProvider:"openai"});
  assert.deepEqual(result,{settings:{modelProvider:"openai"},changed:true});
  assert.equal(migrateLegacyProviderSettings({modelProvider:"FreeBuff"},{defaultProvider:"agentrouter"}).settings.modelProvider,"agentrouter");
  assert.equal(migrateLegacyProviderSettings({modelProvider:"made-up-provider"}).settings.modelProvider,"openai");
  for(const value of [null,"",undefined])assert.deepEqual(migrateLegacyProviderSettings({modelProvider:value}),{settings:{modelProvider:"openai"},changed:true},String(value));
  assert.equal(migrateLegacyProviderSettings({modelProvider:"freebuff"},{defaultProvider:"freebuff"}).settings.modelProvider,"openai","a retired default never survives");
  assert.deepEqual(migrateLegacyProviderSettings({modelProvider:" AgentRouter "}),{settings:{modelProvider:"agentrouter"},changed:true});
  assert.deepEqual(migrateLegacyProviderSettings({modelProvider:"hcnsec"}),{settings:{modelProvider:"hcnsec"},changed:false});
  result=migrateLegacyProviderSettings({notifications:true});
  assert.deepEqual(result,{settings:{notifications:true},changed:false});assert.equal(Object.prototype.hasOwnProperty.call(result.settings,"modelProvider"),false);
  for(const value of [null,undefined,"settings",[]])assert.deepEqual(migrateLegacyProviderSettings(value),{settings:value,changed:false});
});

test("legacy settings clear retired model ids at global and environment scope only",()=>{
  const {settings,changed}=migrateLegacyProviderSettings({
    modelProvider:"agentrouter",defaultModel:"freebuff/deepseek/deepseek-v4-flash",sourceControlTextModel:"FREEBUFF/test/coding-fast",
    environmentDefaults:{
      "ssh-a":{defaultModel:"freebuff/test/coding-large",sourceControlTextModel:"model-writing",defaultPermissionMode:"full"},
      "ssh-b":{defaultModel:"glm-5.3",sourceControlTextModel:"freebuff/z-ai/glm-5.3-flash"},
      "ssh-c":{defaultModel:"deepseek-v4-flash"},"broken":null,
    },
  });
  assert.equal(changed,true);
  assert.equal(settings.modelProvider,"agentrouter");assert.equal(settings.defaultModel,null);assert.equal(settings.sourceControlTextModel,null);
  assert.deepEqual(settings.environmentDefaults,{
    "ssh-a":{defaultModel:null,sourceControlTextModel:"model-writing",defaultPermissionMode:"full"},
    "ssh-b":{defaultModel:"glm-5.3",sourceControlTextModel:null},
    "ssh-c":{defaultModel:"deepseek-v4-flash"},"broken":null,
  });
  const clean=migrateLegacyProviderSettings({modelProvider:"openai",defaultModel:"gpt-6-luna",sourceControlTextModel:null,environmentDefaults:{"ssh-a":{defaultModel:"deepseek-v4-flash"}}});
  assert.equal(clean.changed,false);assert.equal(clean.settings.defaultModel,"gpt-6-luna");
});

test("legacy settings prune custom models of the retired provider",()=>{
  const kept=[
    {id:"deepseek-v4-flash",name:"DeepSeek",runtime:"native",provider:"agentrouter",inputPrice:1},
    {id:"gpt-5.5",name:"Codex model",runtime:"codex",provider:null,effort:"high"},
    {id:"freebuff-lookalike",runtime:"native",provider:"openai"},
  ];
  const {settings,changed}=migrateLegacyProviderSettings({modelProvider:"openai",customModels:[
    kept[0],{id:"freebuff/deepseek/deepseek-v4-flash",name:"Old",runtime:"native",provider:"freebuff"},{id:"glm-5.3-flash",runtime:"native",provider:"FreeBuff"},
    kept[1],{id:"freebuff/test/coding-fast",runtime:"native",provider:"openai"},kept[2],
  ]});
  assert.equal(changed,true);assert.deepEqual(settings.customModels,kept);
  const clean=migrateLegacyProviderSettings({modelProvider:"openai",customModels:kept});
  assert.equal(clean.changed,false);assert.deepEqual(clean.settings.customModels,kept);
});

test("legacy reasoning-effort and service-tier keys are dropped for Native and renamed for other runtimes",()=>{
  const {settings,changed}=migrateLegacyProviderSettings({
    modelProvider:"freebuff",
    modelReasoningEfforts:{
      "native:freebuff:freebuff/deepseek/deepseek-v4-flash":"high",
      "native:freebuff:custom-model":"low",
      "codex:freebuff:gpt-5.5":"xhigh",
      "claude:freebuff:sonnet":"high","claude:openai:sonnet":"low",
      "opencode:freebuff:anthropic/claude:sonnet-4":"medium",
      "native:openai:freebuff/test/coding-fast":"max",
      "native:openai:gpt-6-luna":"max",
      "malformed-key":"high",
    },
    modelServiceTiers:{"native:freebuff:freebuff/test/coding-fast":"fast","codex:freebuff:gpt-6-sol":"fast","cursor:openai:auto":"fast","cursor:freebuff:auto":"fast"},
  });
  assert.equal(changed,true);assert.equal(settings.modelProvider,"openai");
  assert.deepEqual(settings.modelReasoningEfforts,{
    "codex:openai:gpt-5.5":"xhigh",
    "claude:openai:sonnet":"high",
    "opencode:openai:anthropic/claude:sonnet-4":"medium",
    "native:openai:gpt-6-luna":"max",
    "malformed-key":"high",
  });
  assert.deepEqual(settings.modelServiceTiers,{"codex:openai:gpt-6-sol":"fast","cursor:openai:auto":"fast"});
  const renamed=migrateLegacyProviderSettings({modelProvider:"freebuff",modelReasoningEfforts:{"codex:freebuff:gpt-5.5":"high"}},{defaultProvider:"agentrouter"});
  assert.equal(renamed.settings.modelProvider,"agentrouter");
  assert.deepEqual(renamed.settings.modelReasoningEfforts,{"codex:agentrouter:gpt-5.5":"high"},"non-native keys follow the replacement provider");
  const unused=migrateLegacyProviderSettings({modelProvider:"agentrouter",modelReasoningEfforts:{"codex:freebuff:gpt-5.5":"high"}},{defaultProvider:"agentrouter"});
  assert.deepEqual(unused,{settings:{modelProvider:"agentrouter",modelReasoningEfforts:{}},changed:true},"keys of a provider that was not selected were never read and are dropped");
  const untouched={"native:openai:gpt-6-luna":"max","codex:openai:gpt-5.5":"high"},clean=migrateLegacyProviderSettings({modelProvider:"openai",modelReasoningEfforts:untouched,modelServiceTiers:{}});
  assert.equal(clean.changed,false);assert.deepEqual(clean.settings.modelReasoningEfforts,untouched);
  for(const odd of [null,[],"high"])assert.equal(migrateLegacyProviderSettings({modelProvider:"openai",modelReasoningEfforts:odd}).changed,false);
});

test("the retired provider counts as selected when the stored selection was retired, absent, empty or unknown",()=>{
  for(const value of ["freebuff"," FreeBuff ",undefined,null,""," ","made-up-provider"])assert.equal(isRetiredProviderSelection(value),true,String(value));
  for(const value of ["openai"," AgentRouter ","hcnsec","vyceai"])assert.equal(isRetiredProviderSelection(value),false,value);
});

test("a renamed preference of the selected retired provider replaces a stale key whatever the key order",()=>{
  const stale={"codex:openai:gpt-5.5":"low"},current={"codex:freebuff:gpt-5.5":"xhigh"};
  for(const [label,efforts] of [["stale key first",{...stale,...current}],["retired key first",{...current,...stale}]]){
    for(const modelProvider of ["freebuff",undefined]){
      const settings=modelProvider===undefined?{modelReasoningEfforts:efforts}:{modelProvider,modelReasoningEfforts:efforts};
      const {settings:migrated,changed}=migrateLegacyProviderSettings(settings);
      assert.equal(changed,true,label);
      assert.deepEqual(migrated.modelReasoningEfforts,{"codex:openai:gpt-5.5":"xhigh"},label+" / "+String(modelProvider));
    }
  }
  const variants=migrateLegacyProviderSettings({modelProvider:"freebuff",modelServiceTiers:{"codex:openai:gpt-6-sol":"fast","codex:freebuff:gpt-6-sol":"fast","codex:FreeBuff:gpt-6-sol":"fast"}});
  assert.deepEqual(variants.settings.modelServiceTiers,{"codex:openai:gpt-6-sol":"fast"},"case variants of the retired id collapse onto one key");
  const firstVariant=migrateLegacyProviderSettings({modelProvider:"freebuff",modelReasoningEfforts:{"claude:FreeBuff:sonnet":"low","claude:freebuff:sonnet":"high"}});
  assert.deepEqual(firstVariant.settings.modelReasoningEfforts,{"claude:openai:sonnet":"low"},"the first case variant wins");
});

test("preferences of a retired provider that was not selected are dropped instead of moved",()=>{
  const {settings,changed}=migrateLegacyProviderSettings({modelProvider:"openai",modelReasoningEfforts:{"codex:freebuff:gpt-5.5":"low","codex:openai:gpt-5.5":"xhigh","native:freebuff:x":"high"},modelServiceTiers:{"codex:freebuff:gpt-6-sol":"fast"}});
  assert.equal(changed,true);
  assert.deepEqual(settings.modelReasoningEfforts,{"codex:openai:gpt-5.5":"xhigh"});
  assert.deepEqual(settings.modelServiceTiers,{});
  const onlyRetired=migrateLegacyProviderSettings({modelProvider:"openai",modelReasoningEfforts:{"codex:freebuff:gpt-5.5":"low"}});
  assert.deepEqual(onlyRetired.settings.modelReasoningEfforts,{},"a retired key never lands in another provider's namespace");
  const explicit=migrateLegacyProviderSettings({modelProvider:"openai",modelReasoningEfforts:{"codex:freebuff:gpt-5.5":"low","codex:openai:gpt-5.5":"xhigh"}},{retiredProviderActive:true});
  assert.deepEqual(explicit.settings.modelReasoningEfforts,{"codex:openai:gpt-5.5":"low"},"the caller's selection flag wins over the merged settings");
  const explicitOff=migrateLegacyProviderSettings({modelProvider:"freebuff",modelReasoningEfforts:{"codex:freebuff:gpt-5.5":"low"}},{retiredProviderActive:false});
  assert.deepEqual(explicitOff.settings.modelReasoningEfforts,{});assert.equal(explicitOff.settings.modelProvider,"openai");
});

test("settings migration is pure and always returns a new settings object",()=>{
  const input=deepFreeze({modelProvider:"freebuff",defaultModel:"freebuff/test/coding-fast",environmentDefaults:{"ssh-a":{defaultModel:"freebuff/test/coding-large"}},customModels:[{id:"x",runtime:"native",provider:"freebuff"}],modelReasoningEfforts:{"codex:freebuff:gpt-5.5":"high"},modelServiceTiers:{"native:freebuff:x":"fast"}});
  const before=JSON.stringify(input),result=migrateLegacyProviderSettings(input);
  assert.equal(JSON.stringify(input),before);assert.notEqual(result.settings,input);assert.equal(result.changed,true);
  const clean=deepFreeze({modelProvider:"openai"}),unchanged=migrateLegacyProviderSettings(clean);
  assert.notEqual(unchanged.settings,clean);assert.deepEqual(unchanged.settings,clean);assert.equal(unchanged.changed,false);
});

test("legacy project settings clear retired model ids in the project default and its overrides",()=>{
  const input=deepFreeze({id:"project-1",path:"/repo",environmentId:null,defaultModel:"freebuff/test/coding-fast",permissionMode:"full",settingsOverrides:{defaultModel:"freebuff/test/coding-fast",sourceControlTextModel:"freebuff/deepseek/deepseek-v4-flash",autoPull:true,defaultPermissionMode:"full"}});
  const {project,changed}=migrateLegacyProjectSettings(input);
  assert.equal(changed,true);assert.notEqual(project,input);
  assert.deepEqual(project,{id:"project-1",path:"/repo",environmentId:null,defaultModel:null,permissionMode:"full",settingsOverrides:{defaultModel:null,sourceControlTextModel:null,autoPull:true,defaultPermissionMode:"full"}});
  const partial=migrateLegacyProjectSettings({id:"project-2",defaultModel:"gpt-6-luna",settingsOverrides:{sourceControlTextModel:"freebuff/test/coding-large"}});
  assert.equal(partial.changed,true);assert.deepEqual(partial.project,{id:"project-2",defaultModel:"gpt-6-luna",settingsOverrides:{sourceControlTextModel:null}});
  const clean=migrateLegacyProjectSettings({id:"project-3",defaultModel:"deepseek-v4-flash",settingsOverrides:{defaultModel:"deepseek-v4-flash"}});
  assert.equal(clean.changed,false);assert.equal(clean.project.defaultModel,"deepseek-v4-flash");
  for(const value of [null,undefined,"project"])assert.deepEqual(migrateLegacyProjectSettings(value),{project:value,changed:false});
});

test("legacy Native threads move to the selected provider and lose their model",()=>{
  const input=deepFreeze({id:"thread-1",runtime:"native",model:"freebuff/deepseek/deepseek-v4-flash",providerSessionId:"native_legacy",providerMeta:{modelProvider:"freebuff",permissionProfile:"auto",runtimeInstanceId:"native-default",nativeCompaction:{provider:"freebuff",model:"freebuff/deepseek/deepseek-v4-flash",summary:"history"}}});
  const {thread,changed}=migrateLegacyNativeThread(input,{provider:"agentrouter"});
  assert.equal(changed,true);assert.notEqual(thread,input);assert.equal(input.providerMeta.modelProvider,"freebuff");
  assert.equal(thread.model,null);assert.equal(thread.providerMeta.modelProvider,"agentrouter");
  assert.equal(thread.providerMeta.permissionProfile,"auto");assert.deepEqual(thread.providerMeta.nativeCompaction,input.providerMeta.nativeCompaction,"compaction history stays as recorded");
  const unprefixed=migrateLegacyNativeThread({id:"thread-2",runtime:"native",model:"deepseek/deepseek-v4-flash",providerMeta:{modelProvider:"Freebuff",model:"deepseek/deepseek-v4-flash"}},{provider:"openai"});
  assert.equal(unprefixed.changed,true);assert.equal(unprefixed.thread.model,null,"a model picked from the retired catalog is never sent to another vendor");assert.equal(unprefixed.thread.providerMeta.model,null);assert.equal(unprefixed.thread.providerMeta.modelProvider,"openai");
  const strayModel=migrateLegacyNativeThread({id:"thread-3",runtime:"native",model:"freebuff/test/coding-fast",providerMeta:{modelProvider:"hcnsec"}},{provider:"openai"});
  assert.equal(strayModel.changed,true);assert.equal(strayModel.thread.model,null);assert.equal(strayModel.thread.providerMeta.modelProvider,"hcnsec");
  assert.equal(migrateLegacyNativeThread({id:"thread-4",runtime:"native",model:null,providerMeta:{modelProvider:"freebuff"}},{provider:"freebuff"}).thread.providerMeta.modelProvider,"openai","the replacement provider is always a registry id");
  assert.equal(migrateLegacyNativeThread({id:"thread-5",runtime:"native",providerMeta:{modelProvider:"freebuff"}}).thread.providerMeta.modelProvider,"openai");
  const clean=migrateLegacyNativeThread({id:"thread-6",runtime:"native",model:"model-a",providerMeta:{modelProvider:"agentrouter"}},{provider:"openai"});
  assert.equal(clean.changed,false);assert.equal(clean.thread.model,"model-a");assert.equal(clean.thread.providerMeta.modelProvider,"agentrouter");
  const codex={id:"thread-7",runtime:"codex",model:"freebuff/test/coding-fast",providerMeta:{modelProvider:"freebuff"}};
  assert.deepEqual(migrateLegacyNativeThread(codex,{provider:"openai"}),{thread:codex,changed:false});
  for(const value of [null,undefined])assert.deepEqual(migrateLegacyNativeThread(value),{thread:value,changed:false});
});

test("legacy queued follow-ups keep their text but lose a retired model",()=>{
  const input=deepFreeze([{id:"q1",text:"later",model:"freebuff/test/coding-fast",attachments:[]},{id:"q2",text:"keep",model:"gpt-5.5"},{id:"q3",text:"none"},null]);
  const {items,changed}=migrateLegacyQueueItems(input);
  assert.equal(changed,true);assert.notEqual(items,input);
  assert.deepEqual(items,[{id:"q1",text:"later",model:null,attachments:[]},{id:"q2",text:"keep",model:"gpt-5.5"},{id:"q3",text:"none"},null]);
  assert.equal(items[1],input[1],"untouched items keep their identity");
  assert.equal(migrateLegacyQueueItems([{id:"q4",model:"test/coding-fast"}]).changed,false);
  for(const value of [undefined,null,{}])assert.deepEqual(migrateLegacyQueueItems(value),{items:value,changed:false});
});

test("TrebellStateStore keeps the retired provider's preferences when ui-state.json never stored a provider",async()=>{
  for(const [label,efforts] of [["stale key first",{"codex:openai:gpt-5.5":"low","codex:freebuff:gpt-5.5":"xhigh"}],["retired key first",{"codex:freebuff:gpt-5.5":"xhigh","codex:openai:gpt-5.5":"low"}]]){
    const home=await mkdtemp(join(tmpdir(),"trebell-legacy-provider-implicit-")),env={...process.env,TREBELL_HOME:home},file=join(home,"ui-state.json");
    try{
      await writeFile(file,JSON.stringify({version:2,projects:[],settings:{onboardingComplete:true,agentRuntime:"codex",modelReasoningEfforts:efforts,modelServiceTiers:{"codex:freebuff:gpt-6-sol":"fast"}}}));
      const settings=new TrebellStateStore(env).settings();
      assert.equal(settings.modelProvider,"openai",label);
      assert.deepEqual(settings.modelReasoningEfforts,{"codex:openai:gpt-5.5":"xhigh"},label+": the implicit default was the retired provider, so its value was the one in use");
      assert.deepEqual(settings.modelServiceTiers,{"codex:openai:gpt-6-sol":"fast"},label);
      assert.doesNotMatch(await readFile(file,"utf8"),/freebuff/i,label);
    }finally{await rm(home,{recursive:true,force:true})}
  }
  const home=await mkdtemp(join(tmpdir(),"trebell-legacy-provider-explicit-")),env={...process.env,TREBELL_HOME:home};
  try{
    await writeFile(join(home,"ui-state.json"),JSON.stringify({version:2,projects:[],settings:{onboardingComplete:true,modelProvider:"openai",modelReasoningEfforts:{"codex:openai:gpt-5.5":"low","codex:freebuff:gpt-5.5":"xhigh"}}}));
    assert.deepEqual(new TrebellStateStore(env).settings().modelReasoningEfforts,{"codex:openai:gpt-5.5":"low"},"an explicitly selected provider keeps its own value");
  }finally{await rm(home,{recursive:true,force:true})}
});

test("TrebellStateStore migrates a legacy ui-state.json once and rewrites it without the retired provider",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-legacy-provider-state-")),env={...process.env,TREBELL_HOME:home},file=join(home,"ui-state.json");
  try{
    await writeFile(file,JSON.stringify({version:2,
      projects:[
        {id:"project-1",path:"/repo",environmentId:null,name:"Repo",defaultModel:"freebuff/test/coding-fast",settingsOverrides:{defaultModel:"freebuff/test/coding-fast",sourceControlTextModel:"freebuff/deepseek/deepseek-v4-flash",autoPull:true}},
        {id:"project-2",path:"/other",environmentId:"ssh-a",name:"Other",defaultModel:"deepseek-v4-flash",settingsOverrides:{defaultModel:"deepseek-v4-flash"}},
      ],
      threadMeta:{"thread-legacy":{runtime:"native",provider:"freebuff",trebellQueue:[{id:"q1",text:"Queued before the upgrade",model:"freebuff/test/coding-fast",attachments:[],contextChips:[]},{id:"q2",text:"Keep this model",model:"gpt-6-luna",attachments:[],contextChips:[]}],queuedSubmissions:[{id:"native-q1",input:[{type:"text",text:"native"}]}]}},
      settings:{
        onboardingComplete:true,modelProvider:"freebuff",defaultModel:"freebuff/deepseek/deepseek-v4-flash",sourceControlTextModel:"freebuff/test/coding-fast",
        environmentDefaults:{"ssh-a":{defaultModel:"freebuff/test/coding-large",sourceControlTextModel:"model-writing"}},
        customModels:[{id:"freebuff/deepseek/deepseek-v4-flash",runtime:"native",provider:"freebuff"},{id:"deepseek-v4-flash",runtime:"native",provider:"agentrouter"}],
        modelReasoningEfforts:{"native:freebuff:freebuff/deepseek/deepseek-v4-flash":"high","codex:freebuff:gpt-5.5":"xhigh"},
        modelServiceTiers:{"native:freebuff:freebuff/test/coding-fast":"fast","codex:freebuff:gpt-6-sol":"fast"},
      },
    }));
    const state=new TrebellStateStore(env),settings=state.settings();
    assert.equal(settings.modelProvider,"openai");assert.equal(settings.defaultModel,null);assert.equal(settings.sourceControlTextModel,null);
    assert.deepEqual(settings.environmentDefaults["ssh-a"],{defaultModel:null,sourceControlTextModel:"model-writing"});
    assert.equal(state.environmentDefaults("ssh-a").defaultModel,null);assert.equal(state.environmentDefaults("ssh-a").sourceControlTextModel,"model-writing");
    assert.deepEqual(settings.customModels,[{id:"deepseek-v4-flash",runtime:"native",provider:"agentrouter"}]);
    assert.deepEqual(settings.modelReasoningEfforts,{"codex:openai:gpt-5.5":"xhigh"});assert.deepEqual(settings.modelServiceTiers,{"codex:openai:gpt-6-sol":"fast"});
    const repo=state.project("/repo",null);assert.equal(repo.defaultModel,null);assert.deepEqual(repo.settingsOverrides,{defaultModel:null,sourceControlTextModel:null,autoPull:true});
    assert.equal(state.projectSettings("/repo",null).effective.defaultModel,null);assert.equal(state.projectSettings("/repo",null).effective.sourceControlTextModel,null);
    assert.equal(state.project("/other","ssh-a").defaultModel,"deepseek-v4-flash");
    const persisted=await readFile(file,"utf8");
    assert.doesNotMatch(persisted,/freebuff/i,"the rewritten ui-state.json must not keep the retired provider or its model ids");
    assert.match(persisted,/"modelProvider": "openai"/);assert.match(persisted,/deepseek-v4-flash/);
    const meta=state.threadMeta("thread-legacy");
    assert.deepEqual(meta.trebellQueue.map(item=>[item.id,item.text,item.model]),[["q1","Queued before the upgrade",null],["q2","Keep this model","gpt-6-luna"]]);
    assert.deepEqual(meta.queuedSubmissions,[{id:"native-q1",input:[{type:"text",text:"native"}]}]);
    assert.equal(meta.provider,"freebuff","thread catalog history keeps the provider it was recorded with");
    const raw=new SqliteStateCollections(env).threadMeta("thread-legacy");
    assert.equal(raw.trebellQueue[0].model,null,"the queue migration is persisted");assert.equal(raw.trebellQueue[1].model,"gpt-6-luna");
    const again=new TrebellStateStore(env);assert.equal(again.settings().modelProvider,"openai");assert.equal(again.project("/repo",null).defaultModel,null);
    assert.equal(await readFile(file,"utf8"),persisted,"a migrated state file is stable on the next load");
  }finally{await rm(home,{recursive:true,force:true})}
});

test("retired provider data paths are exactly its two leftovers under the Trebell home",()=>{
  const home=join(tmpdir(),"trebell-retired-paths-fixture");
  assert.deepEqual(retiredProviderDataPaths({TREBELL_HOME:home}),[join(home,"freebuff2api"),join(home,"freebuff-instance-id")]);
});

test("startup cleanup removes only the retired provider's leftovers and is idempotent",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-retired-data-")),home=join(root,"home"),env={TREBELL_HOME:home},logs=[];
  try{
    await mkdir(home,{recursive:true});const {kept}=await seedRetiredProviderHome(home);
    assert.deepEqual(removeRetiredProviderData(env,{log:message=>logs.push(message)}),{removed:2});
    assert.equal(await exists(join(home,"freebuff2api")),false);assert.equal(await exists(join(home,"freebuff-instance-id")),false);
    assert.deepEqual((await readdir(home)).sort(),[...kept].sort(),"unrelated data and look-alike names survive");
    assert.equal(await readFile(join(home,"attachments","keep.txt"),"utf8"),"keep");assert.equal(await readFile(join(home,"freebuff2api.bak","credentials.json"),"utf8"),"{}");
    assert.deepEqual(removeRetiredProviderData(env,{log:message=>logs.push(message)}),{removed:0},"a second run is a no-op");
    assert.deepEqual(removeRetiredProviderData({TREBELL_HOME:join(root,"missing-home")},{log:message=>logs.push(message)}),{removed:0},"a missing home is not an error");
    assert.deepEqual(logs,[]);
    await writeFile(join(home,"freebuff-instance-id"),"x");
    assert.deepEqual(removeRetiredProviderData(env,{log:()=>{throw new Error("a failing logger must not break startup")}}),{removed:1});
  }finally{await rm(root,{recursive:true,force:true})}
});

test("startup cleanup removes a link in place of the retired data directory but never its target",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-retired-data-link-")),home=join(root,"home"),outside=join(root,"outside-target");
  try{
    await mkdir(home,{recursive:true});await mkdir(outside,{recursive:true});await writeFile(join(outside,"credentials.json"),"outside data");
    const link=join(home,"freebuff2api");
    // A junction needs no privilege on Windows; elsewhere a directory symlink behaves the same.
    await symlink(outside,link,process.platform==="win32"?"junction":"dir");
    assert.deepEqual(removeRetiredProviderData({TREBELL_HOME:home}),{removed:1});
    assert.equal(await exists(link),false,"the link itself is removed");
    assert.equal(await readFile(join(outside,"credentials.json"),"utf8"),"outside data","the link target survives");
    const dangling=join(root,"gone");await mkdir(dangling);await symlink(dangling,link,process.platform==="win32"?"junction":"dir");await rm(dangling,{recursive:true,force:true});
    assert.deepEqual(removeRetiredProviderData({TREBELL_HOME:home}),{removed:1},"a dangling link is removed too");
    assert.equal(await exists(link),false);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("the GUI server removes the retired provider's leftovers on startup",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-retired-data-gui-"));
  const [port,appPort]=await Promise.all([freePort(),freePort()]);
  try{
    const {kept}=await seedRetiredProviderHome(home);
    const gui=await createGuiServer({port,appPort,mock:true,env:{...process.env,TREBELL_HOME:home,TREBELL_HISTORY_DISABLE_CLAUDE:"1"}});
    try{
      assert.equal(await exists(join(home,"freebuff2api")),false);assert.equal(await exists(join(home,"freebuff-instance-id")),false);
      for(const name of kept)assert.equal(await exists(join(home,name)),true,name);
      assert.equal((await fetch(gui.url+"/api/health")).ok,true);
    }finally{await gui.close()}
  }finally{await rm(home,{recursive:true,force:true,maxRetries:30,retryDelay:100})}
});

test("every CLI command removes the retired provider's leftovers, including logout",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-retired-data-cli-")),previousHome=process.env.TREBELL_HOME,previousBin=process.env.TREBELL_CODEX_BIN,previousExitCode=process.exitCode;
  const originalError=console.error,errors=[];
  process.env.TREBELL_HOME=home;process.env.TREBELL_CODEX_BIN=join(home,"codex-must-not-run");
  try{
    const {kept}=await seedRetiredProviderHome(home);
    console.error=(...items)=>{errors.push(items.join(" "))};
    let code;try{code=await main(["logout"])}finally{console.error=originalError}
    assert.equal(code,1);assert.deepEqual(errors,[NO_ACCOUNT_SIGN_IN_MESSAGE],"the sign-in message is unchanged and names no provider");
    assert.equal(await exists(join(home,"freebuff2api")),false);assert.equal(await exists(join(home,"freebuff-instance-id")),false);
    for(const name of kept)assert.equal(await exists(join(home,name)),true,name);
  }finally{
    console.error=originalError;process.exitCode=previousExitCode;
    if(previousHome===undefined)delete process.env.TREBELL_HOME;else process.env.TREBELL_HOME=previousHome;
    if(previousBin===undefined)delete process.env.TREBELL_CODEX_BIN;else process.env.TREBELL_CODEX_BIN=previousBin;
    await rm(home,{recursive:true,force:true});
  }
});
