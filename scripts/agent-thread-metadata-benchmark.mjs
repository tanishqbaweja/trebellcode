import assert from "node:assert/strict";
import {mkdtemp,rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {performance} from "node:perf_hooks";
import {AgentThreadStore} from "../src/agent-thread-store.mjs";

const home=await mkdtemp(join(tmpdir(),"trebell-thread-metadata-bench-")),env={...process.env,TREBELL_HOME:home};
try{
  const store=new AgentThreadStore(env),turns=Array.from({length:350},(_,turn)=>({id:`turn-${turn}`,status:"completed",startedAt:turn+1,completedAt:turn+2,durationMs:1000,error:null,items:[{type:"userMessage",id:`u-${turn}`,content:[{type:"text",text:`request ${turn} `+"u".repeat(700)}]},{type:"dynamicToolCall",id:`t-${turn}`,namespace:"trebell_workspace",tool:"read_file",status:"completed",rawInput:{path:`src/${turn}.mjs`},rawOutput:{path:`src/${turn}.mjs`,content:"x".repeat(1800)}},{type:"agentMessage",id:`a-${turn}`,text:`answer ${turn} `+"a".repeat(700)}]}));
  const thread=store.importHistory({runtime:"native",cwd:home,providerSessionId:"bench",model:"fixture",providerMeta:{permissionProfile:"supervised",modelProvider:"vyceai",environmentId:null},turns}),iterations=80,rounds=7,fullRuns=[],metadataRuns=[];
  assert.equal(store.get(thread.id).turns.length,turns.length);assert.deepEqual(store.getMetadata(thread.id).turns,[]);
  const measure=fn=>{global.gc?.();const started=performance.now();let checksum=0;for(let index=0;index<iterations;index++)checksum+=fn();return {durationMs:performance.now()-started,checksum}};
  const median=values=>{const ordered=[...values].sort((a,b)=>a-b);return ordered[Math.floor(ordered.length/2)]};
  for(let warm=0;warm<3;warm++){store.get(thread.id);store.getMetadata(thread.id)}
  for(let round=0;round<rounds;round++){
    if(round%2===0){fullRuns.push(measure(()=>store.get(thread.id)?.turns?.length||0));metadataRuns.push(measure(()=>store.getMetadata(thread.id)?.providerMeta?.permissionProfile?.length||0))}
    else{metadataRuns.push(measure(()=>store.getMetadata(thread.id)?.providerMeta?.permissionProfile?.length||0));fullRuns.push(measure(()=>store.get(thread.id)?.turns?.length||0))}
  }
  assert.ok(fullRuns.every(run=>run.checksum===turns.length*iterations));assert.ok(metadataRuns.every(run=>run.checksum==="supervised".length*iterations));
  const fullMedian=median(fullRuns.map(run=>run.durationMs)),metadataMedian=median(metadataRuns.map(run=>run.durationMs));
  console.log(JSON.stringify({ok:true,benchmark:"agent-thread-metadata-read",turns:turns.length,iterationsPerRound:iterations,rounds,fullGet:{medianDurationMs:Number(fullMedian.toFixed(3)),perCallMs:Number((fullMedian/iterations).toFixed(4)),runsMs:fullRuns.map(run=>Number(run.durationMs.toFixed(3)))},metadataGet:{medianDurationMs:Number(metadataMedian.toFixed(3)),perCallMs:Number((metadataMedian/iterations).toFixed(4)),runsMs:metadataRuns.map(run=>Number(run.durationMs.toFixed(3)))},speedup:Number((fullMedian/metadataMedian).toFixed(1)),note:"Deterministic local store benchmark. getMetadata returns the synchronized metadata catalog with no transcript turns; full get still hydrates complete history when callers need it."},null,2));
}finally{await rm(home,{recursive:true,force:true,maxRetries:8,retryDelay:50})}
