import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import { createGuiServer } from "../src/gui-server.mjs";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";
import * as tiers from "../src/model-service-tier.mjs";
import * as catalog from "../src/codex-model-catalog.mjs";
import { codexModelChoices } from "../ui/src/codex-turn-options.js";

// A person whose Codex config runs Fast (service_tier = "fast" in config.toml) saw the Speed picker read Standard until the open
// thread reported its own settings, while Codex ran each new thread at Fast. The catalog now reads the configured tier with
// config/read, without the launch folder's project layers (T3 Code 3b844dab5), and gives it as each model's default tier: the
// picker shows it while nothing is picked, and no turn sends it, so Codex keeps applying its own config.
const require=createRequire(import.meta.url);
async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

test("a model's tier that the Codex config names is its default tier: the Speed picker shows it while nothing is picked, and no turn sends it",()=>{
  const metadata={serviceTiers:[{id:"priority",name:"Fast",description:""},{id:"flex",name:"Flex",description:""}],defaultServiceTier:null};
  const configured=value=>tiers.codexConfiguredServiceTier(metadata,value);
  assert.equal(configured("fast"),"priority","Codex's config says fast for the tier its models list as priority");
  assert.equal(configured("priority"),"priority");assert.equal(configured("flex"),"flex");assert.equal(configured("default"),"default");
  for(const value of ["ultrafast",null,"",undefined,"Not a tier!"])assert.equal(configured(value),null,String(value));
  assert.equal(tiers.codexConfiguredServiceTier({},"fast"),null,"a model with no tiers has none to show");
  assert.equal(tiers.codexConfiguredServiceTier({additionalSpeedTiers:["fast"]},"fast"),"fast","an older catalog's own fast tier");
  const fast={...metadata,defaultServiceTier:configured("fast")};
  assert.equal(tiers.codexServiceTierPickerValue(null,fast),"priority");
  assert.equal(tiers.codexServiceTierForTurn({metadata:fast}),null,"nothing is sent, so Codex keeps applying its config");
  assert.deepEqual((({serviceTier,serviceTierPicker})=>({serviceTier,serviceTierPicker}))(codexModelChoices({settings:{},provider:"codex",model:"gpt-6.1-sol",metadata:fast})),{serviceTier:null,serviceTierPicker:"priority"});
  // A pick still shows and goes with the turn.
  const picked={modelServiceTiers:{[tiers.modelServiceTierKey("codex","codex","gpt-6.1-sol")]:"default"}};
  assert.deepEqual((({serviceTier,serviceTierPicker})=>({serviceTier,serviceTierPicker}))(codexModelChoices({settings:picked,provider:"codex",model:"gpt-6.1-sol",metadata:fast})),{serviceTier:"default",serviceTierPicker:"default"});
});

// The model list's step for the config (T3 applyConfiguredCodexServiceTier), over rows shaped as Codex 0.162.0's model/list gives them:
// a model whose tiers hold the configured one takes it as its default tier, and the others keep their own.
test("each Codex model that lists the configured tier takes it as its default tier, and the others keep Codex's",()=>{
  const fast={id:"priority",name:"Fast",description:""};
  const rows=[{id:"gpt-6.1-sol",serviceTiers:[fast],defaultServiceTier:null},{id:"gpt-6-luna",serviceTiers:[fast],defaultServiceTier:"priority"},{id:"gpt-6-mini",serviceTiers:[],defaultServiceTier:null}];
  assert.deepEqual(catalog.withConfiguredCodexServiceTier(rows,"fast").map(row=>row.defaultServiceTier),["priority","priority",null]);
  assert.deepEqual(catalog.withConfiguredCodexServiceTier(rows,"flex").map(row=>row.defaultServiceTier),[null,"priority",null],"a tier no model lists changes none");
  assert.deepEqual(catalog.withConfiguredCodexServiceTier(rows,null),rows,"a config with no tier leaves the list as Codex gave it");
  assert.equal(rows[0].defaultServiceTier,null,"Codex's rows are not changed in place");
  assert.deepEqual(catalog.withConfiguredCodexServiceTier(null,"fast"),[]);
});

// A Codex CLI stand-in for the catalog app-server: model/list lists two models with service tiers and one without, and config/read
// answers with the service_tier its tier file names ("missing" for none, "error" refuses the request, "hang" never answers), logging
// each config/read's params.
const fakeCodexSource=({log,tierFile,wsModule})=>`import { createServer } from "node:http";
import { appendFileSync, readFileSync } from "node:fs";
import ws from ${JSON.stringify(wsModule)};
const args=process.argv.slice(2),listen=args[0]==="app-server"?String(args[args.indexOf("--listen")+1]||""):"";
if(!listen.startsWith("ws://"))process.exit(1);
const model=(id,isDefault,serviceTiers)=>({id,model:id,displayName:id,hidden:false,isDefault,supportedReasoningEfforts:[{reasoningEffort:"high",description:""}],defaultReasoningEffort:"high",serviceTiers,defaultServiceTier:null});
const fast={id:"priority",name:"Fast",description:""};
const server=createServer((req,res)=>{res.writeHead(req.url==="/readyz"?200:404);res.end()});
const wss=new ws.WebSocketServer({noServer:true});
server.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,client=>client.on("message",raw=>{
  const message=JSON.parse(String(raw));if(message.id==null||!message.method)return;
  const reply=result=>client.send(JSON.stringify({id:message.id,result}));
  if(message.method==="initialize")return reply({userAgent:"fake-codex-tier"});
  if(message.method==="account/read")return reply({account:{type:"chatgpt",email:"tier@example.test",planType:"pro"},requiresOpenaiAuth:true});
  if(message.method==="model/list")return reply({data:[model("gpt-6.1-sol",true,[fast]),model("gpt-6-luna",false,[fast,{id:"flex",name:"Flex",description:""}]),model("gpt-6-mini",false,[])],nextCursor:null});
  if(message.method==="config/read"){
    appendFileSync(${JSON.stringify(log)},JSON.stringify(message.params??null)+"\\n");
    const tier=readFileSync(${JSON.stringify(tierFile)},"utf8").trim();
    if(tier==="hang")return;
    if(tier==="error")return client.send(JSON.stringify({id:message.id,error:{code:-32601,message:"unsupported"}}));
    return reply({config:tier==="missing"?{}:{service_tier:tier},origins:{},layers:null});
  }
  reply({data:[],nextCursor:null});
})));
server.listen(Number(new URL(listen).port),"127.0.0.1");
`;

test("the Codex model list gives each model the tier the person's Codex config runs as its default, and is unchanged when the config names none",{timeout:120_000},async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-codex-config-tier-")),log=join(root,"config-read.log"),tierFile=join(root,"tier.txt"),script=join(root,"fake-codex.mjs");
  await mkdir(join(root,"codex-home"),{recursive:true});await mkdir(join(root,"home"),{recursive:true});await writeFile(log,"");
  await writeFile(script,fakeCodexSource({log,tierFile,wsModule:pathToFileURL(require.resolve("ws")).href}));
  const bin=join(root,process.platform==="win32"?"fake-codex.cmd":"fake-codex");
  await writeFile(bin,process.platform==="win32"?`@"${process.execPath}" "${script}" %*\r\n`:`#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,{mode:0o755});
  await writeFile(join(root,"home","ui-state.json"),JSON.stringify({settings:{agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",onboardingComplete:true}}));
  const env={...process.env,TREBELL_HOME:join(root,"home"),CODEX_HOME:join(root,"codex-home"),CLAUDE_CONFIG_DIR:join(root,"claude-config"),TREBELL_CODEX_BIN:bin,TREBELL_GUI_MOCK:"",TREBELL_E2E_OFFLINE:"",TREBELL_APP_SERVER_PORT:"",TREBELL_HISTORY_DISABLE_CLAUDE:"1",OPENAI_API_KEY:"",ANTHROPIC_API_KEY:"",GEMINI_API_KEY:"",GOOGLE_API_KEY:""};
  const probe=AgentRuntimeManager.prototype.probe;
  AgentRuntimeManager.prototype.probe=async function(instanceOrKind){
    const instance=typeof instanceOrKind==="string"?this.instances().find(item=>item.kind===instanceOrKind):instanceOrKind;
    return {id:instance?.id,kind:instance?.kind,name:instance?.kind,available:true,installed:true,authenticated:true,version:"fixture"};
  };
  let gui=null;
  const catalogFor=async tier=>{
    await writeFile(tierFile,tier);const started=Date.now();
    const catalog=await fetch(gui.url+"/api/models").then(response=>response.json());
    const rows=Object.fromEntries((catalog.metadata?.models||[]).map(row=>[row.id,row]));
    return {ms:Date.now()-started,models:catalog.models,tiers:Object.fromEntries(Object.entries(rows).map(([id,row])=>[id,row.defaultServiceTier??null])),picker:Object.fromEntries(Object.entries(rows).map(([id,row])=>[id,tiers.codexServiceTierPickerValue(null,row)]))};
  };
  try{
    gui=await createGuiServer({port:await freePort(),mock:false,env});
    const fast=await catalogFor("fast");
    assert.deepEqual(fast.models,["gpt-6.1-sol","gpt-6-luna","gpt-6-mini"]);
    assert.deepEqual(fast.tiers,{"gpt-6.1-sol":"priority","gpt-6-luna":"priority","gpt-6-mini":null});
    assert.deepEqual(fast.picker,{"gpt-6.1-sol":"priority","gpt-6-luna":"priority","gpt-6-mini":"default"},"the Speed picker reads Fast on every model that has it");
    const flex=await catalogFor("flex");
    assert.deepEqual(flex.tiers,{"gpt-6.1-sol":null,"gpt-6-luna":"flex","gpt-6-mini":null},"a tier a model does not list leaves it as Codex listed it");
    // No configured tier, a Codex that refuses config/read, and one that never answers it: the catalog as Codex listed it.
    for(const tier of ["missing","error","hang"]){
      const read=await catalogFor(tier);
      assert.deepEqual(read.tiers,{"gpt-6.1-sol":null,"gpt-6-luna":null,"gpt-6-mini":null},tier);
      assert.deepEqual(read.picker,{"gpt-6.1-sol":"default","gpt-6-luna":"default","gpt-6-mini":"default"},tier);
      assert.ok(read.ms<10_000,`${tier}: the model list took ${read.ms} ms`);
    }
    // The shared catalog reads the person's config without the launch folder's project layers, as T3 does.
    assert.deepEqual((await readFile(log,"utf8")).trim().split(/\r?\n/).map(line=>JSON.parse(line)),Array(5).fill({includeLayers:false}));
  }finally{
    AgentRuntimeManager.prototype.probe=probe;
    if(gui)await gui.close();
    await rm(root,{recursive:true,force:true,maxRetries:30,retryDelay:100});
  }
});
