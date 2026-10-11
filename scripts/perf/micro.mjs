// Server micro-benchmarks for the audit's server-side suspects, on the real stores in an isolated home. Run by run.mjs with the
// server tap preloaded (it counts sqlite connections, bytes and JSON work per call):
//   node --expose-gc --import ./scripts/perf/lib/server-tap.mjs scripts/perf/micro.mjs --home <dir> --repo <git repo> --out <file.json>
// 1  AgentThreadStore.get per streamed chunk (what the relay's handleUpdate does for every non-Native-draft update), by history size.
// 1b AgentThreadStore.addItem per tool_call_update on a mid-size turn: time, sqlite bytes written, WAL growth.
// 2  The Codex relay's per-message work: state.threadMeta twice, state.settings and eventJournal.recordProtocol, by meta size.
// 5  gitInfo on a small repository: time and git processes per call.
// 6  AgentRuntimeManager.probe per installed harness: time and processes per call (the Settings poll runs it every 5 s).
import { statSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { cpus } from "node:os";
import { AgentThreadStore } from "../../src/agent-thread-store.mjs";
import { TrebellStateStore } from "../../src/trebell-state.mjs";
import { EventJournal } from "../../src/event-journal.mjs";
import { AgentRuntimeManager } from "../../src/agent-runtime-manager.mjs";
import { gitInfo } from "../../src/git-service.mjs";
import { codingTurn } from "./lib/seed.mjs";
import { summarize } from "./lib/stats.mjs";

const args=Object.fromEntries(process.argv.slice(2).reduce((pairs,value,index,list)=>value.startsWith("--")?[...pairs,[value.slice(2),list[index+1]]]:pairs,[]));
const home=args.home,repo=args.repo,out=args.out,skipProbes=args["skip-probes"]==="1";
rmSync(home,{recursive:true,force:true});mkdirSync(home,{recursive:true});
const env={...process.env,TREBELL_HOME:home};
const tap=globalThis.__perfTap;if(!tap)throw new Error("run with --import scripts/perf/lib/server-tap.mjs");
function load(){let idle=0,total=0;for(const cpu of cpus()){const t=cpu.times;idle+=t.idle;total+=t.user+t.nice+t.sys+t.idle+t.irq}return {idle,total}}
const loadStart=load();
const machineLoad=()=>{const now=load();return Number((100*(1-(now.idle-loadStart.idle)/Math.max(1,now.total-loadStart.total))).toFixed(1))};

// Times fn over reps calls; each sample carries the tap's counters for that one call.
async function measure(label,reps,fn){
  const ms=[],perCall=[];
  for(let i=0;i<reps;i++){
    tap.snapshot(true);const started=performance.now();await fn(i);const elapsed=performance.now()-started;const snap=tap.snapshot(true);
    ms.push(elapsed);perCall.push({sqliteOpens:snap.sqlite.opens,sqliteBytesRead:snap.sqlite.bytesRead,sqliteBytesWritten:snap.sqlite.bytesWritten,jsonParseChars:snap.json.parseChars,jsonStringifyChars:snap.json.stringifyChars,spawns:snap.spawns.total,spawnKeys:Object.keys(snap.spawns.byCommand)});
  }
  const last=perCall.at(-1)||{};
  return {label,ms:summarize(ms,3),perCall:{sqliteOpens:last.sqliteOpens,sqliteBytesRead:last.sqliteBytesRead,sqliteBytesWritten:last.sqliteBytesWritten,jsonParseChars:last.jsonParseChars,jsonStringifyChars:last.jsonStringifyChars,spawns:summarize(perCall.map(row=>row.spawns),0),spawnKeys:[...new Set(perCall.flatMap(row=>row.spawnKeys))]},machineLoadPercent:machineLoad()};
}

const result={startedAt:new Date().toISOString(),node:process.version,cpus:cpus().length};
const store=new AgentThreadStore(env),state=new TrebellStateStore(env);
const now=Math.floor(Date.now()/1000);
// 1: threads whose stored history is about 0, 0.5, 2 and 5 MB (Native coding turns of ~3 KB each).
const histories=[];
for(const targetMB of [0,0.5,2,5]){
  const turns=[];let bytes=0;let index=0;
  do{const turn=codingTurn("h"+targetMB+"-"+index,index,now-100000+index*60);turns.push(turn);bytes+=JSON.stringify(turn).length;index++}while(bytes<targetMB*1048576);
  const thread=store.importHistory({runtime:"claude",cwd:repo,providerSessionId:"micro-"+targetMB,model:null,name:"micro "+targetMB,turns,createdAt:now-100000,updatedAt:now});
  histories.push({targetMB,id:thread.id,turns:turns.length,bytes});
}
result.storeGetPerChunk=[];
for(const history of histories){
  const row=await measure("threadStore.get "+history.targetMB+" MB",30,()=>store.get(history.id));
  // The relay does this once per streamed chunk; Claude and OpenCode stream about 20-60 chunks a second.
  row.historyMB=Number((history.bytes/1048576).toFixed(2));row.turns=history.turns;
  row.coreShareAt50ChunksPerSecond=Number((50*row.ms.median/10).toFixed(1));
  result.storeGetPerChunk.push(row);
}
// 1b: a tool_call_update on a running turn: the turn holds 200 items, the thread 2 MB of earlier history.
{
  const base=histories.find(history=>history.targetMB===2);
  const live=store.addTurn(base.id,{inputText:"run the suite"});
  for(let i=0;i<200;i++)store.addItem(base.id,live.id,{type:"commandExecution",id:"tool-"+i,command:"npm test",status:"completed",aggregatedOutput:"ok\n".repeat(200),exitCode:0});
  const wal=join(home,"trebell.sqlite-wal"),size=()=>{try{return statSync(wal).size}catch{return 0}};
  let output="";const walBefore=size();
  const row=await measure("threadStore.addItem (tool_call_update, 200-item turn, 2 MB thread)",30,i=>{output+="line "+i+" of streamed command output\n".repeat(20);return store.addItem(base.id,live.id,{type:"commandExecution",id:"tool-live",command:"npm test",status:"inProgress",aggregatedOutput:output})});
  row.walGrowthKB=Number(((size()-walBefore)/1024).toFixed(1));row.turnBytes=JSON.stringify(store.get(base.id).turns.at(-1)).length;
  result.addItemPerUpdate=row;
}
// 2: the Codex relay's work per upstream message (onServerMessage + codexRuntimeProvider + recordProtocol), small and 50 KB meta.
{
  const journal=new EventJournal(env);
  const small="codex-small",large="codex-large";
  state.updateThreadMeta(small,{runtime:"codex",runtimeInstanceId:"codex-default",cwd:repo,environmentId:null});
  state.updateThreadMeta(large,{runtime:"codex",runtimeInstanceId:"codex-default",cwd:repo,environmentId:null,codexToolCallIds:Array.from({length:1500},(_,i)=>"call_"+i.toString(36).padStart(24,"0")),attachments:Array.from({length:20},(_,i)=>({attachmentType:"pull_request",payload:{url:"https://example.invalid/pr/"+i,state:"OPEN",title:"PR "+i}}))});
  result.metaBytes={small:JSON.stringify(state.threadMeta(small)).length,large:JSON.stringify(state.threadMeta(large)).length};
  const delta=threadId=>({method:"item/agentMessage/delta",params:{threadId,turnId:"t1",itemId:"i1",delta:"tok"}});
  const perMessage=threadId=>{const message=delta(threadId),params=message.params;const meta=state.threadMeta(threadId);const provider=state.threadMeta(threadId)?.runtimeInstanceId||"codex-default";journal.recordProtocol({runtime:"codex",provider,environmentId:meta?.environmentId??state.settings().activeEnvironmentId??null,direction:"runtime",method:message.method,params})};
  result.codexPerMessage=[await measure("codex relay per delta, small meta",300,()=>perMessage(small)),await measure("codex relay per delta, 50 KB meta",300,()=>perMessage(large))];
  result.stateCalls=[await measure("state.threadMeta (50 KB meta)",300,()=>state.threadMeta(large)),await measure("state.settings()",300,()=>state.settings())];
  for(const row of result.codexPerMessage)row.coreShareAt150MessagesPerSecond=Number((150*row.ms.median/10).toFixed(1));
  await journal.close?.();
}
// 5: the git info poll's server work for one poll on the perf repository.
result.gitInfo=await measure("gitInfo (one /api/git/info poll)",8,()=>gitInfo(repo));
result.gitInfo.gitProcessesPerMinuteAt3500ms=Number((result.gitInfo.perCall.spawns.median*60000/3500).toFixed(0));
// 6: one probe per installed harness, three times (the first is cold).
if(!skipProbes){
  const manager=new AgentRuntimeManager({state,env});result.probes=[];
  for(const instance of manager.instances()){
    if(instance.kind==="native")continue;
    const row=await measure("probe "+instance.kind,3,()=>manager.probe(instance).catch(error=>({error:error.message})));
    row.kind=instance.kind;row.lastStatus=await manager.probe(instance).then(status=>({available:status.available,installed:status.installed,authenticated:status.authenticated,message:String(status.message||"").slice(0,160)})).catch(error=>({error:error.message}));
    result.probes.push(row);
  }
}
result.finishedAt=new Date().toISOString();
writeFileSync(out,JSON.stringify(result,null,2));
console.log(JSON.stringify({ok:true,out}));
process.exit(0);
