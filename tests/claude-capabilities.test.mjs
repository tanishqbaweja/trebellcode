import test from "node:test";
import assert from "node:assert/strict";
import { claudeModelCatalog, createClaudeCapabilitiesCache, probeClaudeCapabilities } from "../src/claude-capabilities.mjs";

function fakeQuery({init={models:[{value:"default",displayName:"Default"}],commands:[{name:"review"}],agents:[{name:"Plan"}],account:{email:"user@example.test"}},usage={rate_limits_available:false},usageError=null,hangInit=false}={}){
  const calls=[];
  const query=({prompt,options})=>{
    const call={prompt,options,usageArgs:null,closed:false,yielded:false};calls.push(call);
    // The probe's prompt must never offer a message: a yielded message would reach the model API.
    call.consumed=(async()=>{for await(const _ of prompt)call.yielded=true})();
    return {
      initializationResult:()=>hangInit?new Promise(()=>{}):Promise.resolve(init),
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET:async args=>{call.usageArgs=args;if(usageError)throw usageError;return usage},
      close(){call.closed=true},
    };
  };
  return {query,calls};
}

test("Claude capability probe reads the initialize answer and plan usage without sending a prompt",async()=>{
  const usage={rate_limits_available:true,rate_limits:{five_hour:{utilization:12,resets_at:"2026-10-09T22:59:59Z"}}};
  const {query,calls}=fakeQuery({usage});
  const probe=await probeClaudeCapabilities({command:"claude",cwd:"/repo",env:{CLAUDE_CONFIG_DIR:"/home/u/.claude",FORCE_CODE_TERMINAL:"1"},query});
  assert.deepEqual(probe.models,[{value:"default",displayName:"Default"}]);
  assert.deepEqual(probe.commands,[{name:"review"}]);assert.deepEqual(probe.agents,[{name:"Plan"}]);
  assert.deepEqual(probe.account,{email:"user@example.test"});
  assert.deepEqual(probe.usage,usage);assert.equal(probe.usageError,null);
  const {options,usageArgs}=calls[0];
  assert.deepEqual(usageArgs,{skipBehaviors:true});
  assert.equal(options.persistSession,false);assert.equal(options.cwd,"/repo");
  assert.deepEqual(options.settingSources,["user","project","local"],"project commands and agents are listed");
  assert.deepEqual(options.settings,{disableAllHooks:true});assert.deepEqual(options.mcpServers,{});assert.equal(options.strictMcpConfig,true);
  assert.equal(options.env.CLAUDE_CONFIG_DIR,"/home/u/.claude");assert.equal(options.env.FORCE_CODE_TERMINAL,undefined);
  assert.equal(options.env.ENABLE_CLAUDEAI_MCP_SERVERS,"false");
  assert.equal(options.abortController.signal.aborted,true,"the process is stopped once the answer is read");
  assert.equal(calls[0].closed,true);
  await calls[0].consumed;assert.equal(calls[0].yielded,false);
});

test("Claude capability probe keeps the initialize answer when only usage fails, and skips usage when not asked",async()=>{
  const {query}=fakeQuery({usageError:new Error("usage unavailable")});
  const probe=await probeClaudeCapabilities({command:"claude",query});
  assert.deepEqual(probe.models,[{value:"default",displayName:"Default"}]);
  assert.equal(probe.usage,null);assert.equal(probe.usageError,"usage unavailable");
  const {query:noUsage,calls}=fakeQuery();
  const inventory=await probeClaudeCapabilities({command:"claude",cwd:"/repo",includeUsage:false,query:noUsage});
  assert.equal(calls[0].usageArgs,null);assert.equal(inventory.usage,null);
  const {query:machine,calls:machineCalls}=fakeQuery();
  await probeClaudeCapabilities({command:"claude",query:machine});
  assert.equal(Object.prototype.hasOwnProperty.call(machineCalls[0].options,"cwd"),false,"the machine-wide probe sets no folder");
  const {query:hanging,calls:hangingCalls}=fakeQuery({hangInit:true});
  await assert.rejects(()=>probeClaudeCapabilities({command:"claude",query:hanging,timeoutMs:20}),/did not report its capabilities in time/);
  assert.equal(hangingCalls[0].closed,true);
});

test("Claude capability cache shares a probe per Claude home, folder and remote environment for five minutes",async()=>{
  let clock=0,probes=0,fail=false;
  const cache=createClaudeCapabilitiesCache({now:()=>clock,probe:async input=>{probes++;if(fail)throw new Error("probe failed");return {models:[],cwd:input.cwd,scope:input.scope,n:probes}}});
  const local={command:"claude",cwd:null,env:{CLAUDE_CONFIG_DIR:"/a"}};
  const [first,second]=await Promise.all([cache.load(local),cache.load(local)]);
  assert.equal(probes,1,"concurrent readers share the probe in flight");assert.equal(first,second);
  assert.equal(cache.peek(local),first);
  assert.equal((await cache.load({...local,cwd:"/repo"})).n,2,"each folder has its own probe");
  assert.equal((await cache.load({...local,env:{CLAUDE_CONFIG_DIR:"/b"}})).n,3,"each Claude home has its own probe");
  const spawnProcess=()=>{};
  assert.equal((await cache.load({...local,spawnProcess,scope:"ssh-1"})).n,4);
  assert.equal((await cache.load({...local,spawnProcess,scope:"ssh-2"})).n,5,"remote environments sharing an executable are kept apart");
  assert.equal((await cache.load({...local,spawnProcess,scope:"ssh-1"})).n,4);
  clock=5*60_000+1;
  assert.equal(cache.peek(local),null,"an expired probe is not offered");
  assert.equal(cache.peek(local,{maxAgeMs:Infinity}),first,"a caller may accept an older answer");
  assert.equal((await cache.load(local)).n,6);
  assert.equal((await cache.load(local,{fresh:true})).n,7);
  fail=true;
  await assert.rejects(()=>cache.load({...local,cwd:"/broken"}),/probe failed/);
  fail=false;
  assert.equal((await cache.load({...local,cwd:"/broken"})).n,9,"a failed probe is not cached");
});

test("Claude model catalog keeps Claude Code's rows, efforts and fast mode, with its default preferred",()=>{
  const catalog=claudeModelCatalog({models:[
    {value:"default",displayName:"Default (recommended)",description:"Opus 5.5 · Most capable",supportedEffortLevels:["low","medium","high","xhigh","max"],supportsFastMode:true},
    {value:"fable",displayName:"Fable",resolvedModel:"claude-fable-5-1",supportedEffortLevels:["low","bogus"]},
    {value:"",displayName:"Empty"},
  ]});
  assert.deepEqual(catalog.models,["default","fable"]);
  assert.equal(catalog.preferred,"default");
  assert.deepEqual(catalog.metadata[1],{id:"fable",name:"Fable",provider:"claude",agent:"Claude Code",resolvedModel:"claude-fable-5-1",supportedReasoningEfforts:["low"],supportsFastMode:false});
  assert.deepEqual(claudeModelCatalog(null),{models:[],metadata:[],preferred:null});
});
