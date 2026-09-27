import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { nativeRequestMetrics, NATIVE_TOOL_SCHEMA_FINGERPRINT } from "../src/native-request-metrics.mjs";
import { platformDynamicToolNamespaces } from "../src/platform-tool-catalog.mjs";

const messages=[{role:"system",content:"system"},{role:"developer",content:"developer"}];
for(let index=0;index<180;index++){messages.push({role:"user",content:`request-${index} `+"u".repeat(120)});messages.push({role:"assistant",content:`answer-${index} `+"a".repeat(180)})}
const actualTools=platformDynamicToolNamespaces({repository:true,progressiveRepository:true,workspaceTools:true,terminal:true,output:true,browser:false,computer:false,sourceControl:false,delegation:false});
const stressTools=Array.from({length:18},(_,namespace)=>({type:"namespace",name:`ns_${namespace}`,description:"namespace "+"n".repeat(200),tools:Array.from({length:7},(_,tool)=>({name:`tool_${tool}`,description:"description "+"d".repeat(1700),inputSchema:{type:"object",properties:{path:{type:"string",description:"path "+"p".repeat(450)},query:{type:"string",description:"query "+"q".repeat(450)}},required:["path"]}}))}));
const rounds=9;

function median(values){const ordered=[...values].sort((a,b)=>a-b);return ordered[Math.floor(ordered.length/2)]}
function benchmark(name,tools,iterations){
  const expected=nativeRequestMetrics(messages,tools),cache=new WeakMap(),first=nativeRequestMetrics(messages,tools,{toolSchemaCache:cache}),second=nativeRequestMetrics(messages,tools,{toolSchemaCache:cache});
  assert.deepEqual(first,expected);assert.deepEqual(second,expected);assert.equal(first[NATIVE_TOOL_SCHEMA_FINGERPRINT],expected[NATIVE_TOOL_SCHEMA_FINGERPRINT]);assert.equal(second[NATIVE_TOOL_SCHEMA_FINGERPRINT],expected[NATIVE_TOOL_SCHEMA_FINGERPRINT]);
  function cacheFor(mode){
    if(mode==="uncached")return null;
    if(mode==="full")return new WeakMap();
    const inner=new WeakMap();
    return {get:key=>{const value=inner.get(key);return value?{...value,stablePrefix:null}:value},set:(key,value)=>inner.set(key,value)};
  }
  function measure(mode){global.gc?.();const localCache=cacheFor(mode);if(localCache)nativeRequestMetrics(messages,tools,{toolSchemaCache:localCache});const started=performance.now();let checksum=0;for(let index=0;index<iterations;index++){const result=nativeRequestMetrics(messages,tools,localCache?{toolSchemaCache:localCache}:undefined);checksum+=result.totalLogical.bytes}return {durationMs:Number((performance.now()-started).toFixed(3)),checksum}}
  for(let index=0;index<4;index++){measure("uncached");measure("tool-schema-only");measure("full")}
  const uncachedRuns=[],toolSchemaRuns=[],fullRuns=[];
  for(let round=0;round<rounds;round++){
    const order=round%2===0?["uncached","tool-schema-only","full"]:["full","tool-schema-only","uncached"];
    for(const mode of order){const run=measure(mode);if(mode==="uncached")uncachedRuns.push(run);else if(mode==="tool-schema-only")toolSchemaRuns.push(run);else fullRuns.push(run)}
  }
  const checksum=uncachedRuns[0].checksum;assert.ok([...uncachedRuns,...toolSchemaRuns,...fullRuns].every(run=>run.checksum===checksum));
  const uncachedMedian=median(uncachedRuns.map(run=>run.durationMs)),toolSchemaMedian=median(toolSchemaRuns.map(run=>run.durationMs)),fullMedian=median(fullRuns.map(run=>run.durationMs)),toolSaved=Number((uncachedMedian-toolSchemaMedian).toFixed(3)),prefixSaved=Number((toolSchemaMedian-fullMedian).toFixed(3));
  return {name,messages:messages.length,namespaces:tools.length,functions:tools.reduce((sum,entry)=>sum+(entry.tools?.length||0),0),toolSchemaBytes:expected.toolSchemas.bytes,iterationsPerRound:iterations,uncached:{medianDurationMs:uncachedMedian,runsMs:uncachedRuns.map(run=>run.durationMs)},toolSchemaCached:{medianDurationMs:toolSchemaMedian,runsMs:toolSchemaRuns.map(run=>run.durationMs)},stablePrefixCached:{medianDurationMs:fullMedian,runsMs:fullRuns.map(run=>run.durationMs)},toolSchemaSavings:{medianDurationMs:toolSaved,medianPercent:Number((toolSaved/uncachedMedian*100).toFixed(2))},additionalStablePrefixSavings:{medianDurationMs:prefixSaved,medianPercent:Number((prefixSaved/toolSchemaMedian*100).toFixed(2))}};
}

const actual=benchmark("current-native-coding-surface",actualTools,300),stress=benchmark("large-schema-stress",stressTools,120);
console.log(JSON.stringify({ok:true,benchmark:"native-tool-schema-metrics-cache",rounds,actual,stress,note:"Deterministic local telemetry benchmark. Tool-schema-only mode reuses the exact JSON-safe schema serialization/metric/full SHA-256 fingerprint but deliberately disables stable-prefix reuse. Full mode additionally reuses system/developer metrics and hashes plus the combined stable-prefix hash only when their exact serialized strings are unchanged. Output metrics and fingerprints are asserted identical."},null,2));
