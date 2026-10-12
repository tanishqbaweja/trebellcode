#!/usr/bin/env node
// The agent relay's server-side cost of an external harness's streamed turn (audit suspects 1, 1b and 8), end to end through the
// real relay (src/agent-relay.mjs) and the real sqlite stores on an isolated home. The harness is a scripted ACP agent (a Node
// script written beside the output, in the shape of the fake ACP agent in tests/agent-relay.test.mjs): it answers initialize,
// session/new and session/resume, and each session/prompt streams the plan it reads from a file at a fixed rate. No model and no
// real harness is involved. Run it with the server tap preloaded, which counts sqlite connections, bytes and JSON work:
//
//   node --expose-gc --import ./scripts/perf/lib/server-tap.mjs scripts/perf/relay-stream.mjs --home <dir> --out <file.json>
//        [--cwd <dir>] [--chunks 600] [--rate 50] [--reps 3] [--sizes 0,0.5,2,5] [--tool-updates 200] [--idle-seconds 60]
//
// 1   text: --chunks agent_message_chunk updates of 24 characters at --rate a second into threads whose stored history is --sizes MB.
// 1b  tools: one command whose output grows by 200 bytes in each of --tool-updates tool_call_update events, on a 0 and a 2 MB thread;
//     disk bytes written come from this process's Windows I/O counters.
// 8   processes: one ACP process per thread that ran a turn or was started; browsing threads afterwards, then --idle-seconds idle,
//     shows whether any is released before the relay closes.
// Each turn records the machine's CPU load; timings repeat --reps times (median and p90).
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join, resolve, dirname } from "node:path";
import { WebSocket } from "ws";
import { attachAgentRelay } from "../../src/agent-relay.mjs";
import { AgentThreadStore } from "../../src/agent-thread-store.mjs";
import { TrebellStateStore } from "../../src/trebell-state.mjs";
import { codingTurn } from "./lib/seed.mjs";
import { summarize } from "./lib/stats.mjs";
import { processTable, descendants, footprintDelta, startLoadMeter } from "./lib/system.mjs";

const argv=process.argv.slice(2),flag=(name,fallback)=>{const index=argv.indexOf("--"+name);return index>=0?argv[index+1]:fallback};
const home=resolve(flag("home")),outFile=resolve(flag("out")),work=join(dirname(outFile),"relay-stream-run");
const chunks=Number(flag("chunks",600))||600,rate=Number(flag("rate",50))||50,reps=Math.max(1,Number(flag("reps",3))||3);
const sizes=String(flag("sizes","0,0.5,2,5")).split(",").map(Number).filter(value=>value>=0),toolUpdates=Number(flag("tool-updates",200))||200;
const idleSeconds=Math.max(10,Number(flag("idle-seconds",60))||60);
const tap=globalThis.__perfTap;if(!tap)throw new Error("run with --import scripts/perf/lib/server-tap.mjs");
rmSync(home,{recursive:true,force:true,maxRetries:10,retryDelay:200});mkdirSync(home,{recursive:true});
rmSync(work,{recursive:true,force:true,maxRetries:10,retryDelay:200});mkdirSync(work,{recursive:true});
const cwd=resolve(flag("cwd",work)),temp=join(work,"tmp");mkdirSync(temp,{recursive:true});
const meter=startLoadMeter(),sleep=ms=>new Promise(done=>setTimeout(done,ms));
const result={startedAt:new Date().toISOString(),node:process.version,chunks,rate,reps,sizes,toolUpdates,idleSeconds,text:[],tools:[],processes:null,errors:[]};

// The scripted ACP agent. Every prompt streams the plan in planFile: an optional command with toolUpdates output updates, then
// chunks text chunks, all paced at ratePerSecond against the clock (not per timer tick, which Windows rounds up to ~15 ms).
const AGENT=String.raw`
import readline from "node:readline";
import { readFileSync } from "node:fs";
const planFile=process.argv[2];let sessionId="perf-session-"+process.pid;
const send=message=>process.stdout.write(JSON.stringify(message)+"\n");
const update=value=>send({jsonrpc:"2.0",method:"session/update",params:{sessionId,update:value}});
const MODELS={currentModelId:"fixture-model",availableModels:[{modelId:"fixture-model",name:"Fixture"}]};
function prompt(id){
  let plan={};try{plan=JSON.parse(readFileSync(planFile,"utf8"))}catch{}
  const steps=[],tools=Number(plan.toolUpdates)||0,width=Number(plan.toolBytesPerUpdate)||200;
  if(tools>0){
    const toolCallId="perf-tool-"+Date.now();let output="";
    steps.push(()=>update({sessionUpdate:"tool_call",toolCallId,title:"npm test",kind:"execute",status:"in_progress",rawInput:{command:"npm test"}}));
    for(let i=0;i<tools;i++)steps.push(()=>{output+=("ok "+i+" streamed test output ").padEnd(width-1,".")+"\n";update({sessionUpdate:"tool_call_update",toolCallId,status:"in_progress",rawOutput:output})});
    steps.push(()=>update({sessionUpdate:"tool_call_update",toolCallId,status:"completed",rawOutput:output}));
  }
  const count=Number(plan.chunks)||0,chars=Number(plan.chunkChars)||24;
  for(let i=0;i<count;i++)steps.push(()=>update({sessionUpdate:"agent_message_chunk",content:{type:"text",text:("w"+i+" ").padEnd(chars-1,"x")+(i%12===11?"\n":" ")}}));
  const perSecond=Number(plan.ratePerSecond)||50,start=performance.now();let sent=0;
  const tick=()=>{const due=Math.min(steps.length,Math.floor((performance.now()-start)/1000*perSecond)+1);while(sent<due)steps[sent++]();if(sent<steps.length)setTimeout(tick,4);else send({jsonrpc:"2.0",id,result:{stopReason:"end_turn"}})};
  tick();
}
function handle(m){
  if(!m.method||m.id==null)return;
  if(m.method==="initialize")return send({jsonrpc:"2.0",id:m.id,result:{protocolVersion:1,agentInfo:{name:"perf-fixture",version:"1"},agentCapabilities:{loadSession:false,sessionCapabilities:{resume:{}}}}});
  if(m.method==="session/new")return send({jsonrpc:"2.0",id:m.id,result:{sessionId,models:MODELS}});
  if(m.method==="session/resume"){if(m.params?.sessionId)sessionId=String(m.params.sessionId);return send({jsonrpc:"2.0",id:m.id,result:{models:MODELS}})}
  if(m.method==="session/prompt")return prompt(m.id);
  return send({jsonrpc:"2.0",id:m.id,result:{}});
}
readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on("line",line=>{try{handle(JSON.parse(line))}catch{}});
`;
const fixture=join(work,"perf-acp-agent.mjs"),planFile=join(work,"plan.json");writeFileSync(fixture,AGENT,"utf8");writeFileSync(planFile,"{}");

const env={...process.env,TREBELL_HOME:home,TEMP:temp,TMP:temp};
const threadStore=new AgentThreadStore(env),state=new TrebellStateStore(env);
const instance={id:"grok-default",kind:"grok",displayName:"Grok Build",enabled:true};
const runtimeManager={
  instances:()=>[{...instance}],activeInstance:()=>({...instance}),activeRuntime:()=>"grok",compatibleInstanceIds:()=>[instance.id],
  probe:async()=>({id:instance.id,name:"Grok Build",available:true,authenticated:true,version:"fixture"}),
  runtimeCwd:value=>value,processSpawner:()=>null,remoteIo:()=>null,childEnv:()=>({...env}),executable:()=>process.execPath,acpArgs:()=>[fixture,planFile],
};
const server=createServer((_request,response)=>{response.writeHead(404);response.end()});
const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,version:"perf"});
await new Promise((done,fail)=>server.listen(0,"127.0.0.1",done).once("error",fail));
const ws=new WebSocket("ws://127.0.0.1:"+server.address().port+"/api/agent/ws");await new Promise((done,fail)=>{ws.once("open",done);ws.once("error",fail)});

// One parse per message, so the client's own JSON work can be taken out of the tap's counts.
let nextId=0,clientParseChars=0;const pending=new Map(),listeners=new Set(),received={};
ws.on("message",raw=>{
  const text=String(raw);clientParseChars+=text.length;const message=JSON.parse(text);
  if(message.method)received[message.method]=(received[message.method]||0)+1;
  if(message.id!=null&&pending.has(message.id)){const {resolve:done,reject:fail}=pending.get(message.id);pending.delete(message.id);message.error?fail(new Error(message.error.message)):done(message.result)}
  for(const listener of listeners)listener(message);
});
const rpc=(method,params={})=>new Promise((done,fail)=>{const id=++nextId;pending.set(id,{resolve:done,reject:fail});ws.send(JSON.stringify({id,method,params}))});
const nextCompleted=(timeoutMs)=>new Promise((done,fail)=>{const timer=setTimeout(()=>{listeners.delete(listener);fail(new Error("turn did not complete in "+timeoutMs+" ms"))},timeoutMs);const listener=message=>{if(message.method==="turn/completed"){clearTimeout(timer);listeners.delete(listener);done(message.params)}};listeners.add(listener)});

// This process's disk writes (Windows I/O transfer counters; the relay, the stores and sqlite all run here).
async function ownIo(){try{const row=(await processTable()).find(item=>item.pid===process.pid);return row?{writeBytes:row.writeBytes,writeOps:row.writeOps,readBytes:row.readBytes}:null}catch{return null}}
const agentRows=async()=>{const table=await processTable();return {table,rows:descendants(table,[process.pid]).filter(row=>row.pid!==process.pid&&row.commandLine.includes("perf-acp-agent.mjs"))}};

async function turn(threadId,plan,{timeoutMs=600_000,io=false}={}){
  writeFileSync(planFile,JSON.stringify(plan));
  const io0=io?await ownIo():null;
  for(const key of Object.keys(received))delete received[key];
  tap.snapshot(true);clientParseChars=0;const at=Date.now(),started=performance.now();
  const completed=nextCompleted(timeoutMs);
  await rpc("turn/start",{threadId,input:[{type:"text",text:"Perf turn: stream the scripted plan."}]});
  const params=await completed;const ms=performance.now()-started;
  const snap=tap.snapshot(true),io1=io?await ownIo():null;
  const steps=(plan.chunks||0)+(plan.toolUpdates?plan.toolUpdates+2:0),plannedMs=1000*steps/(plan.ratePerSecond||50);
  const cpuMs=snap.cpu.userMs+snap.cpu.systemMs,parseChars=Math.max(0,snap.json.parseChars-clientParseChars);
  return {status:params?.turn?.status||null,machineLoad:meter.loadBetween(at,Date.now()),steps,plannedMs:Math.round(plannedMs),ms:Math.round(ms),lagMs:Math.round(ms-plannedMs),cpuMs:Math.round(cpuMs),corePercent:Number((100*cpuMs/ms).toFixed(1)),
    sqliteOpens:snap.sqlite.opens,beginImmediate:snap.sqlite.beginImmediate,sqliteReadKB:Math.round(snap.sqlite.bytesRead/1024),sqliteBoundWriteKB:Math.round(snap.sqlite.bytesWritten/1024),jsonParseKB:Math.round(parseChars/1024),jsonStringifyKB:Math.round(snap.json.stringifyChars/1024),
    eventLoopP99Ms:snap.eventLoop.delayMs.p99,eventLoopMaxMs:snap.eventLoop.delayMs.max,eventLoopUtilization:snap.eventLoop.utilization,
    perStep:{cpuMs:Number((cpuMs/Math.max(1,steps)).toFixed(3)),sqliteOpens:Number((snap.sqlite.opens/Math.max(1,steps)).toFixed(2)),jsonParseKB:Number((parseChars/1024/Math.max(1,steps)).toFixed(1))},
    diskWriteKB:io0&&io1?Math.round((io1.writeBytes-io0.writeBytes)/1024):null,diskWriteOps:io0&&io1?io1.writeOps-io0.writeOps:null,received:{...received}};
}

const now=Math.floor(Date.now()/1000),threads=[];
try{
  // Threads whose stored history is about each size, as earlier turns of the harness (coding turns of ~3 KB each).
  for(const targetMB of sizes){
    const turns=[];let bytes=0,index=0;
    do{const item=codingTurn("s"+targetMB+"-"+index,index,now-200000+index*60);turns.push(item);bytes+=JSON.stringify(item).length;index++}while(bytes<targetMB*1048576);
    const thread=threadStore.importHistory({runtime:"grok",cwd,providerSessionId:"perf-history-"+targetMB,model:"fixture-model",name:"Perf ACP "+targetMB+" MB",turns:targetMB>0?turns:[],createdAt:now-200000,updatedAt:now-1000});
    threads.push({targetMB,id:thread.id,turns:targetMB>0?turns.length:0,historyMB:Number(((targetMB>0?bytes:0)/1048576).toFixed(2))});
  }
  // 1: streamed text.
  for(const thread of threads){
    await rpc("thread/resume",{threadId:thread.id});
    const warm=await turn(thread.id,{chunks:5,ratePerSecond:rate});
    const rows=[];
    for(let rep=0;rep<reps;rep++){const row=await turn(thread.id,{chunks,ratePerSecond:rate});rows.push(row);console.log(JSON.stringify({phase:"text",historyMB:thread.historyMB,rep,ms:row.ms,lagMs:row.lagMs,corePercent:row.corePercent,opens:row.sqliteOpens,parseKB:row.jsonParseKB,load:row.machineLoad}))}
    result.text.push({historyMB:thread.historyMB,turns:thread.turns,warmUp:{ms:warm.ms,status:warm.status},reps:rows,
      summary:{ms:summarize(rows.map(row=>row.ms),0),lagMs:summarize(rows.map(row=>row.lagMs),0),corePercent:summarize(rows.map(row=>row.corePercent),1),cpuMsPerChunk:summarize(rows.map(row=>row.perStep.cpuMs),3),sqliteOpensPerChunk:summarize(rows.map(row=>row.perStep.sqliteOpens),2),jsonParseKBPerChunk:summarize(rows.map(row=>row.perStep.jsonParseKB),1),eventLoopP99Ms:summarize(rows.map(row=>row.eventLoopP99Ms),1),eventLoopMaxMs:summarize(rows.map(row=>row.eventLoopMaxMs),1),machineLoad:summarize(rows.map(row=>row.machineLoad),1)}});
  }
  // 1b: a command's streamed output, on the empty and the 2 MB thread (or the largest below it).
  const toolThreads=[threads[0],threads.filter(thread=>thread.targetMB<=2).at(-1)].filter((thread,index,list)=>thread&&list.indexOf(thread)===index);
  for(const thread of toolThreads){
    const rows=[];
    for(let rep=0;rep<reps;rep++){const row=await turn(thread.id,{toolUpdates,toolBytesPerUpdate:200,chunks:20,ratePerSecond:20},{io:true});rows.push(row);console.log(JSON.stringify({phase:"tools",historyMB:thread.historyMB,rep,ms:row.ms,lagMs:row.lagMs,corePercent:row.corePercent,begins:row.beginImmediate,boundWriteKB:row.sqliteBoundWriteKB,diskWriteKB:row.diskWriteKB,load:row.machineLoad}))}
    result.tools.push({historyMB:thread.historyMB,reps:rows,summary:{ms:summarize(rows.map(row=>row.ms),0),lagMs:summarize(rows.map(row=>row.lagMs),0),corePercent:summarize(rows.map(row=>row.corePercent),1),cpuMsPerUpdate:summarize(rows.map(row=>row.perStep.cpuMs),3),writeTransactions:summarize(rows.map(row=>row.beginImmediate),0),sqliteBoundWriteKB:summarize(rows.map(row=>row.sqliteBoundWriteKB),0),diskWriteKB:summarize(rows.map(row=>row.diskWriteKB),0),diskWriteOps:summarize(rows.map(row=>row.diskWriteOps),0),eventLoopMaxMs:summarize(rows.map(row=>row.eventLoopMaxMs),1),machineLoad:summarize(rows.map(row=>row.machineLoad),1)}});
  }
  // 8: four more threads started (a new chat starts its session at once), then every thread browsed again, then idle.
  const afterTurns=(await agentRows()).rows.length;
  for(let i=0;i<4;i++){const started=await rpc("thread/start",{cwd,approvalPolicy:"on-request",sandbox:"workspace-write"});threads.push({targetMB:null,id:started.thread.id,started:true})}
  const afterStarts=(await agentRows()).rows.length;
  for(const thread of threads)await rpc("thread/resume",{threadId:thread.id});
  const before=await agentRows();await sleep(idleSeconds*1000);const after=await agentRows();
  const ids=new Set(after.rows.map(row=>row.pid)),footprint=footprintDelta(before.table,after.table,ids,{seconds:idleSeconds});
  result.processes={threadsWithTurns:sizes.length,threadsStartedWithoutTurn:4,agentProcessesAfterTurns:afterTurns,agentProcessesAfterStarts:afterStarts,agentProcessesAfterBrowsingAndIdle:after.rows.length,idleSeconds,
    perProcess:footprint.map(row=>({pid:row.pid,workingSetMB:row.workingSetMB,privateMB:row.privateMB,corePercent:row.corePercent})),totalWorkingSetMB:Number(footprint.reduce((sum,row)=>sum+row.workingSetMB,0).toFixed(1)),totalPrivateMB:Number(footprint.reduce((sum,row)=>sum+row.privateMB,0).toFixed(1))};
  console.log(JSON.stringify({phase:"processes",...result.processes,perProcess:undefined}));
}catch(error){result.errors.push(String(error?.stack||error).slice(0,3000));console.error(error)}
try{ws.close()}catch{}
await relay.close().catch(error=>result.errors.push("relay.close: "+String(error?.message||error)));
await new Promise(done=>server.close(()=>done()));await sleep(1500);
if(result.processes)result.processes.agentProcessesAfterRelayClose=(await agentRows()).rows.length;
meter.stop();result.finishedAt=new Date().toISOString();
writeFileSync(outFile,JSON.stringify(result,null,2));console.log(JSON.stringify({ok:!result.errors.length,out:outFile}));
process.exit(0);
