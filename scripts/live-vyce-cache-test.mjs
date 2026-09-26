import assert from "node:assert/strict";
import { ProviderManager } from "../src/provider-manager.mjs";
import { platformDynamicToolNamespaces } from "../src/platform-tool-catalog.mjs";
import { nativeRequestMetrics } from "../src/native-request-metrics.mjs";

const apiKey=String(process.env.TREBELL_TEST_VYCE_API_KEY||process.env.VYCEAI_API_KEY||process.env.VYCE_API_KEY||"").trim();
if(!apiKey)throw new Error("Set TREBELL_TEST_VYCE_API_KEY, VYCEAI_API_KEY, or VYCE_API_KEY before running the Vyce cache experiment.");

const env={...process.env,VYCEAI_API_KEY:apiKey};
const manager=new ProviderManager({env});
const catalog=await manager.models("vyceai"),requested=String(process.env.VYCE_MODEL||"deepseek-v4.1").trim(),model=catalog.models.includes(requested)?requested:catalog.models[0];
if(!model)throw new Error("Vyce did not advertise a model for the cache experiment.");

const tools=platformDynamicToolNamespaces({
  repository:true,progressiveRepository:true,output:true,workspaceTools:true,terminal:true,
  browser:false,computer:false,sourceControl:false,delegation:false,
});
const stableReference=[
  "Trebell cache experiment reference. This block is intentionally deterministic.",
  ...Array.from({length:180},(_,index)=>"Reference line "+String(index+1).padStart(3,"0")+": alpha beta gamma delta epsilon repository tool cache prefix stability."),
].join("\n");
const baseSystem=[
  "You are a deterministic cache experiment assistant.",
  "Do not call tools. Reply with exactly the requested short marker.",
  stableReference,
].join("\n");

async function run(label,{system=baseSystem,toolSet=tools,user}){
  const messages=[{role:"system",content:system},{role:"user",content:user}];
  const metrics=nativeRequestMetrics(messages,toolSet),started=performance.now();
  const response=await manager.turn("vyceai",{model,messages,tools:toolSet,toolChoice:"none",maxOutputTokens:16},{});
  return {
    label,
    text:String(response.text||"").trim(),
    elapsedMs:Number((performance.now()-started).toFixed(3)),
    usage:response.usage,
    rawUsage:response.raw?.usage||null,
    telemetry:response.telemetry,
    stablePrefixHash:metrics.stablePrefixHash,
    systemHash:metrics.systemHash,
    toolSchemaHash:metrics.toolSchemaHash,
    logicalEstimatedTokens:metrics.totalLogical.estimatedTokens,
  };
}

const runs=[];
runs.push(await run("stable-1",{user:"Reply CACHE_A"}));
runs.push(await run("stable-2",{user:"Reply CACHE_B"}));
runs.push(await run("system-mutated",{system:baseSystem+"\nOne changed system line.",user:"Reply CACHE_C"}));
const reversedTools=tools.map(namespace=>({...namespace,tools:[...(namespace.tools||[])].reverse()}));
runs.push(await run("tool-order-mutated",{toolSet:reversedTools,user:"Reply CACHE_D"}));

assert.equal(runs[0].stablePrefixHash,runs[1].stablePrefixHash,"stable requests must retain the same prefix hash");
assert.notEqual(runs[1].stablePrefixHash,runs[2].stablePrefixHash,"system mutation must change the prefix hash");
assert.notEqual(runs[1].toolSchemaHash,runs[3].toolSchemaHash,"tool-order mutation must change the schema hash");

const report={
  ok:true,provider:"vyceai",model,
  observedCacheHit:Boolean(runs.some(run=>Number(run.usage?.cachedInputTokens||0)>0)),
  runs:runs.map(run=>({
    label:run.label,
    usage:run.usage,
    rawUsage:run.rawUsage,
    requestBytes:run.telemetry?.requestBytes||0,
    responseBytes:run.telemetry?.responseBytes||0,
    latencyMs:run.telemetry?.totalLatencyMs??run.elapsedMs,
    stablePrefixHash:run.stablePrefixHash,
    systemHash:run.systemHash,
    toolSchemaHash:run.toolSchemaHash,
    logicalEstimatedTokens:run.logicalEstimatedTokens,
  })),
};
console.log(JSON.stringify(report,null,2));
