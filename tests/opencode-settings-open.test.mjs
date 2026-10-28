import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";
import { createGuiServer } from "../src/gui-server.mjs";

// Settings lists the harnesses each time a person enters its Agents & models or Diagnostics section, and each read of OpenCode's own
// answer (its providers, models, commands, skills and agents) starts an `opencode serve` per OpenCode profile and takes seconds (2.7 s
// for 1.18.32, 1.3 s for 2.0.24, measured live). Entering a section keeps an answer, as a switch's or a Save's listing does, and reads
// it again once it is ten seconds old; the section's Refresh buttons and a sign-in's follow-up read it again.
// Only the profile's --version answers here (runFn), and the reads are stood in for.
async function openCodeManager(t){
  const home=await mkdtemp(join(tmpdir(),"trebell-opencode-settings-open-"));t.after(()=>rm(home,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  const instance={id:"opencode-default",kind:"opencode",displayName:"OpenCode",enabled:true,binaryPath:join(home,"no-opencode-here"),serverUrl:null,environment:{}};
  const settings={agentRuntime:"native",agentRuntimeInstanceId:"native-default",agentRuntimeInstances:[instance]};
  let clock=1_000_000;const reads=[];
  const manager=new AgentRuntimeManager({state:{settings:()=>settings},platform:"linux",env:{PATH:"",HOME:home,TREBELL_HOME:join(home,"trebell")},now:()=>clock,
    runFn:async(command,args)=>command===instance.binaryPath&&args[0]==="--version"?{ok:true,code:0,error:null,stdout:"1.18.32\n",stderr:""}:{ok:false,code:null,error:`spawn ${command} ENOENT`,stdout:"",stderr:""}});
  const fake={answer:null};
  manager.openCodeCatalogReader=async options=>{reads.push(options);return structuredClone(fake.answer)};
  return {manager,reads,fake,advance:ms=>{clock+=ms}};
}
const catalog=({models:ids=["anthropic/claude-x"]}={})=>({
  models:ids,metadata:ids.map(id=>({id,name:id,provider:"opencode",agent:"OpenCode"})),preferred:ids[0]||null,connectedProviders:["anthropic"],
  inventory:{commands:[],skills:[],agents:[{name:"build"}]},source:"live-connected",
});
const opencode=listing=>listing.statuses.find(status=>status.id==="opencode-default");

test("entering Settings' sections again soon after keeps OpenCode's complete answer, and its Refresh reads OpenCode again",async t=>{
  const {manager,reads,fake,advance}=await openCodeManager(t);
  fake.answer=catalog();
  assert.equal(opencode(await manager.snapshot({refresh:true,keepOpenCode:true})).authenticated,true);
  assert.equal(reads.length,1,"the first open reads it");
  advance(5_000);
  await manager.snapshot({refresh:true,keepOpenCode:true});await manager.snapshot({refresh:true,keepOpenCode:true});
  assert.equal(reads.length,1,"entering Agents & models, then Diagnostics, starts no opencode serve");
  // The person adds a provider's models and presses Refresh.
  fake.answer=catalog({models:["anthropic/claude-x","openai/gpt"]});
  await manager.snapshot({refresh:true});
  assert.equal(reads.length,2,"Refresh reads OpenCode again");
});

test("entering Settings reads an OpenCode answer that is not complete again once it is ten seconds old",async t=>{
  const {manager,reads,fake,advance}=await openCodeManager(t);
  // A connected provider that lists no models yet: not ready, so not complete.
  fake.answer=catalog({models:[]});
  await manager.snapshot({refresh:true,keepOpenCode:true});assert.equal(reads.length,1);
  advance(5_000);await manager.snapshot({refresh:true,keepOpenCode:true});
  assert.equal(reads.length,1,"one read for two sections entered one after the other");
  advance(5_001);fake.answer=catalog();
  assert.equal(opencode(await manager.snapshot({refresh:true,keepOpenCode:true})).authenticated,true,"read again, and now ready");
  assert.equal(reads.length,2);
});

async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

test("Settings' listing route keeps OpenCode's catalogs for a section's open (x-trebell-catalogs: kept) and reads them again otherwise",async t=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-opencode-settings-open-route-"));
  const original=AgentRuntimeManager.prototype.snapshot,asked=[];
  AgentRuntimeManager.prototype.snapshot=async function(options={}){asked.push({refresh:options.refresh===true,keepOpenCode:options.keepOpenCode===true});return {statuses:[],instances:[],definitions:[]}};
  const [port,appPort]=await Promise.all([freePort(),freePort()]);
  let gui=null;
  try{
    gui=await createGuiServer({port,appPort,mock:true,env:{...process.env,TREBELL_HOME:home,TREBELL_HISTORY_DISABLE_CLAUDE:"1"}});
    await fetch(gui.url+"/api/agent-runtimes",{headers:{"x-trebell-catalogs":"kept"}}).then(response=>response.json());
    await fetch(gui.url+"/api/agent-runtimes").then(response=>response.json());
    assert.deepEqual(asked,[{refresh:true,keepOpenCode:true},{refresh:true,keepOpenCode:false}]);
  }finally{
    if(gui)await gui.close();
    AgentRuntimeManager.prototype.snapshot=original;
    await rm(home,{recursive:true,force:true,maxRetries:20,retryDelay:250});
  }
});
