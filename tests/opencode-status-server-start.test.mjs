import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";
import { discoverOpenCode2ModelCatalog } from "../src/opencode-agent-session.mjs";

// OpenCode 2 converts the shared database on its first run, so `opencode serve` may take up to 30 seconds to start. The status
// check, which every switch and thread start makes first, gave OpenCode's whole answer 20 seconds: a server that took
// 20 to 30 seconds to start failed the switch with "OpenCode did not answer within 20 seconds." Now the 20 seconds start once the
// read's server is up; a read that hangs after that, or one that starts no server, still ends at 20 seconds. On mocked timers.
const flush=async(turns=20)=>{for(let index=0;index<turns;index++)await new Promise(resolve=>setImmediate(resolve))};
async function openCodeManager(t,reader){
  const home=await mkdtemp(join(tmpdir(),"trebell-opencode-status-start-"));t.after(()=>rm(home,{recursive:true,force:true,maxRetries:10,retryDelay:100}));
  const instance={id:"opencode-default",kind:"opencode",displayName:"OpenCode",enabled:true,binaryPath:join(home,"no-opencode-here"),serverUrl:null,environment:{}};
  const settings={agentRuntime:"opencode",agentRuntimeInstanceId:"opencode-default",agentRuntimeInstances:[instance]};
  const manager=new AgentRuntimeManager({state:{settings:()=>settings},platform:"linux",env:{PATH:"",HOME:home,TREBELL_HOME:join(home,"trebell")},
    runFn:async(command,args)=>command===instance.binaryPath&&args[0]==="--version"?{ok:true,code:0,error:null,stdout:"2.0.24\n",stderr:""}:{ok:false,code:null,error:`spawn ${command} ENOENT`,stdout:"",stderr:""}});
  manager.openCodeCatalogReader=reader;
  return manager;
}
const catalog={models:["opencode/big-pickle"],metadata:[{id:"opencode/big-pickle",name:"Big Pickle",provider:"opencode",agent:"OpenCode"}],preferred:"opencode/big-pickle",connectedProviders:["opencode"],inventory:{commands:[],skills:[],agents:[]},source:"live-connected-v2"};
const later=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function settle(promise){const state={done:false};promise.then(value=>Object.assign(state,{done:true,value}),error=>Object.assign(state,{done:true,error}));return state}

test("a status check waits for an OpenCode server that takes 25 seconds to start, and then for its answer",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  const manager=await openCodeManager(t,async({onServerStart})=>{const starting=later(25_000);onServerStart?.(starting);await starting;await later(2_000);return structuredClone(catalog)});
  const status=settle(manager.probe("opencode",{fresh:true}));await flush(100);
  for(let second=0;second<27&&!status.done;second++){t.mock.timers.tick(1_000);await flush()}
  assert.equal(status.done,true,"the check ended");
  assert.equal(status.error,undefined,status.error?.message);
  assert.deepEqual([status.value.available,status.value.authenticated,status.value.message],[true,true,"1 upstream provider connected through OpenCode."]);
});

test("a server that came up after 19 seconds still gets 20 seconds for OpenCode's answer",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  const manager=await openCodeManager(t,async({onServerStart})=>{const starting=later(19_000);onServerStart?.(starting);await starting;await later(10_000);return structuredClone(catalog)});
  const status=settle(manager.probe("opencode",{fresh:true}));await flush(100);
  for(let second=0;second<30&&!status.done;second++){t.mock.timers.tick(1_000);await flush()}
  assert.equal(status.done,true);assert.equal(status.error,undefined,status.error?.message);
  assert.equal(status.value.authenticated,true,status.value.message);
});

test("a status check still ends 20 seconds after OpenCode's server is up when its answer never comes, and at 20 seconds when the read starts no server",async t=>{
  t.mock.timers.enable({apis:["setTimeout"]});
  for(const [reader,ends] of [[async({onServerStart})=>{onServerStart?.(later(1_000));return new Promise(()=>{})},21],[async()=>new Promise(()=>{}),20]]){
    const manager=await openCodeManager(t,reader),status=settle(manager.probe("opencode",{fresh:true}));await flush(100);
    for(let second=0;second<ends-1;second++){t.mock.timers.tick(1_000);await flush()}
    assert.equal(status.done,false,`still waiting at ${ends-1} s`);
    t.mock.timers.tick(1_000);await flush();
    assert.equal(status.done,true,`ended at ${ends} s`);
    assert.deepEqual([status.value.available,status.value.message],[false,"OpenCode could not list its providers: OpenCode did not answer within 20 seconds."]);
  }
});

test("OpenCode's catalog read says when it starts its server, so the status check can tell a server still starting",async t=>{
  // A profile's own server: the read starts nothing of its own, and says so at once.
  const server=createServer((req,res)=>{
    const send=value=>{res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify(value))};
    if(req.url.startsWith("/api/info"))return send({version:"2.0.24"});
    if(req.url.startsWith("/api/model?")||req.url==="/api/model")return send({data:[{providerID:"opencode",id:"big-pickle",name:"Big Pickle",enabled:true,variants:[]}]});
    if(req.url.startsWith("/api/model/default"))return send({data:{providerID:"opencode",id:"big-pickle"}});
    send({data:[]});
  });
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections?.();server.close(resolve)}));
  const starts=[];
  const read=await discoverOpenCode2ModelCatalog({serverUrl:`http://127.0.0.1:${server.address().port}`,cwd:"/repo",env:{},onServerStart:promise=>starts.push(promise)});
  assert.equal(starts.length,1);assert.ok(typeof starts[0]?.then==="function");
  assert.deepEqual(read.models,["opencode/big-pickle"]);
});
