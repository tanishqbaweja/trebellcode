// What a turn costs at the prices saved in Settings, as the Usage page and the composer's cost label work it out (ui/src/usage-pricing.js),
// from each harness's own usage record. Codex, Trebell Native and Muse Code count cache reads and writes inside their input tokens,
// Claude Code and OpenCode beside them, and Cursor, Grok Build and Antigravity report no cached part: each cached token is priced once,
// at the cache price (or the input price when none is saved), and the Usage page's Input card counts every input token once.
// The figures of the live check on 2.1.3 (2026-11-02) are its own records, priced at Meta's Contributor prices.
import test from "node:test";
import assert from "node:assert/strict";
import { estimateUsageCost, priceUsage, savedPrice, usageTokens } from "../ui/src/usage-pricing.js";
import { withCustomModels } from "../src/custom-model-catalog.mjs";
import { createCodexTurnUsage } from "../src/codex-turn-usage.mjs";
import { museTurnUsage } from "../src/muse-agent-session.mjs";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";

const META={inputPrice:0.10,cacheReadPrice:0.002,outputPrice:0.20};
const near=(actual,expected,label)=>assert.ok(Math.abs(actual-expected)<1e-12,`${label}: ${actual} is not ${expected}`);
// The live check's records (state_usage), as Trebell stored them.
const NATIVE_TURN={id:"native:b043ff9d:46705736",runtime:"native",provider:"meta",model:"muse-spark-1.3-contributor",usage:{totalTokens:43402,inputTokens:42232,cachedInputTokens:33845,cacheWriteInputTokens:0,outputTokens:1170,reasoningOutputTokens:149},cost:null};
const MUSE_TURN={id:"muse:4dbe4ba4:d0196b04",runtime:"muse",provider:"muse-default",model:"muse-spark-1.3-contributor",usage:{totalTokens:273693,inputTokens:272402,cachedInputTokens:203942,cacheWriteInputTokens:0,outputTokens:1291,reasoningOutputTokens:456},cost:null};

test("the live check's Native and Muse Code turns cost what Meta's prices give, each cached token charged once at the cache price",()=>{
  const settings={customModels:[
    {id:"muse-spark-1.3-contributor",name:"muse-spark-1.3-contributor",runtime:"native",provider:"meta",...META},
    {id:"muse-spark-1.3-contributor",name:"Muse Spark 1.3 Contributor",runtime:"muse",provider:null,...META},
  ]};
  const native=estimateUsageCost(NATIVE_TURN,settings),muse=estimateUsageCost(MUSE_TURN,settings);
  assert.equal(native.estimated,true);near(native.amount,(8387*0.10+33845*0.002+1170*0.20)/1e6,"Native");
  assert.equal(native.amount.toFixed(5),"0.00114");
  assert.equal(muse.estimated,true);near(muse.amount,(68460*0.10+203942*0.002+1291*0.20)/1e6,"Muse Code");
  assert.equal(muse.amount.toFixed(4),"0.0075");
  // The formula before this fix charged the cached tokens a second time: $0.00452 and $0.02791.
  assert.ok(native.amount<0.0012&&muse.amount<0.0076);
});

test("each harness's own record shape reads as one meaning of input",()=>{
  // Codex: the turn's growth of its thread total, cache reads inside input (codex-turn-usage.mjs).
  const codexUsage=createCodexTurnUsage().update({threadId:"t",turnId:"u",running:true,tokenUsage:{last:{totalTokens:10500,inputTokens:10000,cachedInputTokens:8000,outputTokens:500,reasoningOutputTokens:200},total:{totalTokens:10500,inputTokens:10000,cachedInputTokens:8000,outputTokens:500,reasoningOutputTokens:200}}});
  assert.deepEqual(usageTokens(codexUsage,"codex"),{input:10000,fresh:2000,cacheRead:8000,cacheWrite:0,output:500});
  // Muse Code: its counters as Trebell keeps them (museTurnUsage), cache reads and writes inside input.
  const museUsage=museTurnUsage({input:5000,output:300,cacheRead:3000,cacheWrite:500,reasoning:100});
  assert.deepEqual(usageTokens(museUsage,"muse"),{input:5000,fresh:1500,cacheRead:3000,cacheWrite:500,output:300});
  // Trebell Native: its loop's sum of the provider's usage, prompt tokens with the cached ones inside (on Anthropic's API too).
  assert.deepEqual(usageTokens(NATIVE_TURN.usage,"native"),{input:42232,fresh:8387,cacheRead:33845,cacheWrite:0,output:1170});
  // Claude Code: the SDK's input_tokens, cache_read_input_tokens and cache_creation_input_tokens, each apart (the relay's record).
  const claudeUsage={totalTokens:32806,inputTokens:6,cachedInputTokens:30000,cacheWriteInputTokens:2000,outputTokens:800,reasoningOutputTokens:0};
  assert.deepEqual(usageTokens(claudeUsage,"claude"),{input:32006,fresh:6,cacheRead:30000,cacheWrite:2000,output:800});
  // OpenCode: its tokens.input beside tokens.cache.read and write.
  const openCodeUsage={totalTokens:21900,inputTokens:1500,cachedInputTokens:20000,cacheWriteInputTokens:0,outputTokens:300,reasoningOutputTokens:100};
  assert.deepEqual(usageTokens(openCodeUsage,"opencode"),{input:21500,fresh:1500,cacheRead:20000,cacheWrite:0,output:300});
  // Cursor, Grok Build and Antigravity: the ACP usage_update's used tokens as the turn's input, nothing cached.
  for(const runtime of ["cursor","grok","antigravity"])assert.deepEqual(usageTokens({totalTokens:12000,inputTokens:12000,cachedInputTokens:0,cacheWriteInputTokens:0,outputTokens:0},runtime),{input:12000,fresh:12000,cacheRead:0,cacheWrite:0,output:0});
  // A record whose cached parts exceed what it says came in never makes a negative fresh count.
  assert.deepEqual(usageTokens({inputTokens:100,cachedInputTokens:150},"native"),{input:150,fresh:0,cacheRead:150,cacheWrite:0,output:0});
  assert.deepEqual(usageTokens(null,"codex"),{input:0,fresh:0,cacheRead:0,cacheWrite:0,output:0});
  // Priced: Codex's cached tokens once, at the cache price (the old formula said $0.0185); Claude Code's as before.
  near(priceUsage(codexUsage,"codex",{inputPrice:1.25,cacheReadPrice:0.125,outputPrice:10}),(2000*1.25+8000*0.125+500*10)/1e6,"Codex");
  near(priceUsage(claudeUsage,"claude",{inputPrice:3,cacheReadPrice:0.3,cacheWritePrice:3.75,outputPrice:15}),(6*3+30000*0.3+2000*3.75+800*15)/1e6,"Claude Code");
  near(priceUsage(openCodeUsage,"opencode",{inputPrice:2,cacheReadPrice:0.5,outputPrice:8}),(1500*2+20000*0.5+300*8)/1e6,"OpenCode");
});

test("a cache read or write without a price of its own costs what input does, and prices that name neither input nor output give no estimate",()=>{
  near(priceUsage(NATIVE_TURN.usage,"native",{inputPrice:0.10,outputPrice:0.20}),(42232*0.10+1170*0.20)/1e6,"no cache price");
  near(priceUsage(NATIVE_TURN.usage,"native",{outputPrice:0.20}),1170*0.20/1e6,"output price only");
  assert.equal(priceUsage(NATIVE_TURN.usage,"native",{id:"muse-spark-1.3-contributor"}),null);
  assert.equal(priceUsage(NATIVE_TURN.usage,"native",{inputPrice:null,outputPrice:null,cacheReadPrice:0.002}),null);
  assert.equal(priceUsage(NATIVE_TURN.usage,"native",null),null);
  assert.equal(estimateUsageCost(NATIVE_TURN,{customModels:[{id:"muse-spark-1.3-contributor",runtime:"native",provider:"meta",inputPrice:null,outputPrice:null}]}),null);
  // A cost the harness reported is the cost, whatever is saved.
  assert.deepEqual(estimateUsageCost({...NATIVE_TURN,cost:{amount:0.5,currency:"USD"}},{customModels:[]}),{amount:0.5,estimated:false});
});

test("a price saved for Native's Meta model applies to Native's Meta turns only",()=>{
  const settings={customModels:[{id:"muse-spark-1.3-contributor",runtime:"native",provider:"meta",...META}]};
  assert.equal(savedPrice(settings,"native","muse-spark-1.3-contributor","meta"),settings.customModels[0]);
  assert.equal(savedPrice(settings,"native","muse-spark-1.3-contributor","openai"),null);
  assert.equal(savedPrice(settings,"muse","muse-spark-1.3-contributor","muse-default"),null);
  assert.equal(estimateUsageCost({...NATIVE_TURN,provider:"agentrouter"},settings),null);
  assert.equal(estimateUsageCost(MUSE_TURN,settings),null,"Muse Code's turn takes Muse Code's own prices");
  // A harness Trebell does not choose the provider of takes its price whatever provider its record names.
  const muse={customModels:[{id:"muse-spark-1.3-contributor",runtime:"muse",provider:null,...META}]};
  assert.equal(savedPrice(muse,"muse","muse-spark-1.3-contributor","muse-default"),muse.customModels[0]);
});

test("a price for a listed model adds no second copy of it to the model list and leaves its listing as it was",()=>{
  const catalog={models:["muse-spark-1.3-contributor","muse-spark-1.3"],metadata:{provider:"meta",models:[{id:"muse-spark-1.3-contributor",name:"Muse Spark 1.3 Contributor",provider:"meta"},{id:"muse-spark-1.3",name:"Muse Spark 1.3",provider:"meta"}]}};
  const customModels=[
    {id:"muse-spark-1.3-contributor",name:"muse-spark-1.3-contributor",runtime:"native",provider:"meta",...META},
    {id:"muse-lab-0.9",name:"Muse Lab",runtime:"native",provider:"meta",inputPrice:1},
    {id:"gpt-other",name:"gpt-other",runtime:"native",provider:"openai",inputPrice:1},
    {id:"muse-spark-1.3",name:"Spark",runtime:"muse",provider:null,...META},
  ];
  const merged=withCustomModels(catalog,{customModels,runtime:"native",provider:"meta"});
  assert.deepEqual(merged.models,["muse-spark-1.3-contributor","muse-spark-1.3","muse-lab-0.9"]);
  assert.deepEqual(merged.metadata.models,[
    {id:"muse-spark-1.3-contributor",name:"Muse Spark 1.3 Contributor",provider:"meta"},
    {id:"muse-spark-1.3",name:"Muse Spark 1.3",provider:"meta"},
    {id:"muse-lab-0.9",name:"Muse Lab",provider:"meta",agent:"native",custom:true,effort:null,serviceTier:null},
  ]);
  // A display name the person gave a listed model shows; a Codex model's effort and service tier join its listing.
  const codex=withCustomModels({models:["gpt-6-luna"],metadata:{models:[{id:"gpt-6-luna",name:"GPT-6 Luna"}]}},{customModels:[{id:"gpt-6-luna",name:"Luna fast",runtime:"codex",effort:"low",serviceTier:"priority"}],runtime:"codex",provider:"openai"});
  assert.deepEqual(codex.models,["gpt-6-luna"]);
  assert.deepEqual(codex.metadata.models,[{id:"gpt-6-luna",name:"Luna fast",effort:"low",serviceTier:"priority"}]);
  // Native on another provider lists none of Meta's.
  assert.deepEqual(withCustomModels(catalog,{customModels,runtime:"native",provider:"openai"}).models,["muse-spark-1.3-contributor","muse-spark-1.3","gpt-other"]);
  const untouched={models:["a"],metadata:{models:[{id:"a"}]}};
  assert.equal(withCustomModels(untouched,{customModels:[],runtime:"native",provider:"meta"}),untouched);
});

test("Muse Code on an API key has no subscription windows, as Claude Code on one has none, whatever a signed-in turn reported before",async()=>{
  const report={observedAtMs:Date.now()-60_000,tier:"tier-1",window:{usedPercent:3,windowDurationMins:300,resetsAtMs:Date.now()+3_600_000},weekly:{usedPercent:8,resetsAtMs:Date.now()+86_400_000}};
  const settings={agentRuntime:"muse",agentRuntimeInstanceId:"muse-default",agentRuntimeInstances:[{id:"muse-default",kind:"muse",displayName:"Muse Code",enabled:true,environment:{},auth:"api-key"},{id:"muse-work",kind:"muse",displayName:"Muse work",enabled:true,environment:{}}]};
  const ran=[];
  const manager=new AgentRuntimeManager({state:{settings:()=>settings,updateSettings:patch=>Object.assign(settings,patch)},env:{PATH:""},platform:"win32",
    providers:{keyFor:id=>id==="meta"?{key:"meta-fixture-key",source:"settings"}:null},
    runFn:async command=>{ran.push(command);return {ok:false,code:null,error:`spawn ${command} ENOENT`,stdout:"",stderr:""}},fetchImpl:async()=>new Response("{}",{status:404})});
  manager.museUsageReport=()=>report;
  const profile=id=>manager.instances().find(item=>item.id===id);
  const onKey=await manager.usageLimits(profile("muse-default"));
  assert.deepEqual([onKey.windows,onKey.unavailable],[[],{reason:"unsupported"}]);
  // Signed in, the same report shows as its windows.
  assert.deepEqual((await manager.usageLimits(profile("muse-work"))).windows.map(row=>row.id),["window","weekly"]);
  assert.deepEqual(ran,[]);
});
