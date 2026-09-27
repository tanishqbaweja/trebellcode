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
  function measure(cached){global.gc?.();const localCache=cached?new WeakMap():null;if(cached)nativeRequestMetrics(messages,tools,{toolSchemaCache:localCache});const started=performance.now();let checksum=0;for(let index=0;index<iterations;index++){const result=nativeRequestMetrics(messages,tools,cached?{toolSchemaCache:localCache}:undefined);checksum+=result.totalLogical.bytes}return {durationMs:Number((performance.now()-started).toFixed(3)),checksum}}
  for(let index=0;index<4;index++){measure(false);measure(true)}
  const baselineRuns=[],cachedRuns=[];for(let round=0;round<rounds;round++){if(round%2===0){baselineRuns.push(measure(false));cachedRuns.push(measure(true))}else{cachedRuns.push(measure(true));baselineRuns.push(measure(false))}}
  assert.ok(baselineRuns.every(run=>run.checksum===cachedRuns[0].checksum));assert.ok(cachedRuns.every(run=>run.checksum===baselineRuns[0].checksum));
  const baselineMedian=median(baselineRuns.map(run=>run.durationMs)),cachedMedian=median(cachedRuns.map(run=>run.durationMs)),savedMs=Number((baselineMedian-cachedMedian).toFixed(3));
  return {name,messages:messages.length,namespaces:tools.length,functions:tools.reduce((sum,entry)=>sum+(entry.tools?.length||0),0),toolSchemaBytes:expected.toolSchemas.bytes,iterationsPerRound:iterations,baseline:{medianDurationMs:baselineMedian,runsMs:baselineRuns.map(run=>run.durationMs)},cached:{medianDurationMs:cachedMedian,runsMs:cachedRuns.map(run=>run.durationMs)},savings:{medianDurationMs:savedMs,medianPercent:Number((savedMs/baselineMedian*100).toFixed(2))}};
}

const actual=benchmark("current-native-coding-surface",actualTools,300),stress=benchmark("large-schema-stress",stressTools,120);
console.log(JSON.stringify({ok:true,benchmark:"native-tool-schema-metrics-cache",rounds,actual,stress,note:"Deterministic local telemetry benchmark. The candidate reuses the exact JSON-safe tool-schema serialization, metric, and full SHA-256 fingerprint within one Native agent turn; output metrics and fingerprints are asserted identical."},null,2));
