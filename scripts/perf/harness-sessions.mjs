#!/usr/bin/env node
// What Trebell starts for each installed external harness, and what stays resident (audit suspect 8), with the real harnesses and
// no prompt. The real GUI server runs with the server tap on an isolated home; for each runtime it is switched to that harness (as
// Settings does) and two threads are started over the agent WebSocket, in an empty scratch folder. thread/start opens the harness
// session a new chat sends its first message to (initialize and session/new for ACP harnesses, `opencode serve` and a session for
// OpenCode); no session/prompt is ever sent. It records the spawns, the processes left under the server, their CPU and memory
// over an idle window, what is still running after switching away, and that the server's shutdown leaves nothing behind. Runtimes
// the server refuses (not installed or not signed in here) are reported as refused.
//
//   node scripts/perf/harness-sessions.mjs --home <empty dir> --out <file.json> [--ui-dist <dir>] [--runtimes grok,cursor,opencode,claude]
//        [--idle-seconds 60]
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { startServer, freePort } from "./lib/server.mjs";
import { processTable, descendants, footprintDelta, groupByRole, processRole, startLoadMeter } from "./lib/system.mjs";

const repoRoot=resolve(fileURLToPath(new URL("../../",import.meta.url)));
const argv=process.argv.slice(2),flag=(name,fallback)=>{const index=argv.indexOf("--"+name);return index>=0?argv[index+1]:fallback};
const home=resolve(flag("home")),outFile=resolve(flag("out")),runDir=join(dirname(outFile),"harness-sessions-run");
const runtimes=String(flag("runtimes","grok,cursor,opencode,claude")).split(",").map(value=>value.trim()).filter(Boolean);
const idleSeconds=Math.max(15,Number(flag("idle-seconds",60))||60);
rmSync(home,{recursive:true,force:true,maxRetries:10,retryDelay:200});mkdirSync(home,{recursive:true});
rmSync(runDir,{recursive:true,force:true,maxRetries:10,retryDelay:200});mkdirSync(runDir,{recursive:true});
const cwd=join(runDir,"empty-project");mkdirSync(cwd,{recursive:true});writeFileSync(join(cwd,"README.md"),"Scratch folder for a Trebell performance measurement. Nothing here is sent anywhere.\n");
const meter=startLoadMeter(),sleep=ms=>new Promise(done=>setTimeout(done,ms));
const result={startedAt:new Date().toISOString(),idleSeconds,runtimes:{},errors:[]};
const summary=rows=>rows.map(row=>({pid:row.pid,ppid:row.ppid,role:processRole(row),name:row.name,workingSetMB:Number((row.workingSet/1048576).toFixed(1)),privateMB:Number((row.privateBytes/1048576).toFixed(1)),commandLine:row.commandLine.slice(0,200)}));

const server=await startServer({repoRoot,home,runDir,uiDist:resolve(flag("ui-dist",join(repoRoot,"ui","dist"))),port:await freePort(),appPort:await freePort()});
const tree=async()=>{const table=await processTable();return {table,rows:descendants(table,[server.pid]).filter(row=>row.pid!==server.pid)}};
async function socket(){
  const ws=new WebSocket(server.url.replace("http","ws")+"/api/agent/ws");await new Promise((done,fail)=>{ws.once("open",done);ws.once("error",fail)});
  let id=0;const pending=new Map();
  ws.on("message",raw=>{const message=JSON.parse(String(raw));if(message.id!=null&&pending.has(message.id)){const {done,fail}=pending.get(message.id);pending.delete(message.id);message.error?fail(new Error(message.error.message)):done(message.result)}});
  return {ws,rpc:(method,params={},timeoutMs=120_000)=>new Promise((done,fail)=>{const requestId=++id;const timer=setTimeout(()=>{pending.delete(requestId);fail(new Error(method+" timed out"))},timeoutMs);pending.set(requestId,{done:value=>{clearTimeout(timer);done(value)},fail:error=>{clearTimeout(timer);fail(error)}});ws.send(JSON.stringify({id:requestId,method,params}))})};
}
const setRuntime=async runtime=>{const response=await fetch(server.url+"/api/settings",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({agentRuntime:runtime,agentRuntimeInstanceId:runtime+"-default"})});return {status:response.status,body:(await response.text()).slice(0,240)}};

try{
  result.atStart=summary((await tree()).rows);
  // Caching headers on the page and its first script (audit 21): a reload refetches whatever carries none.
  try{
    const page=await fetch(server.url+"/"),html=await page.text(),asset=/src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1]||null;
    const headers=response=>({status:response.status,cacheControl:response.headers.get("cache-control"),etag:response.headers.get("etag"),lastModified:response.headers.get("last-modified"),contentEncoding:response.headers.get("content-encoding")});
    result.staticCaching={page:headers(page),asset,assetHeaders:asset?headers(await fetch(server.url+asset)):null};
  }catch(error){result.staticCaching={error:String(error?.message||error)}}
  const external=new Set();
  for(const runtime of runtimes){
    const entry=result.runtimes[runtime]={};
    entry.switched=await setRuntime(runtime);
    if(entry.switched.status!==200){entry.refused=true;console.log(JSON.stringify({runtime,refused:entry.switched}));continue}
    const {ws,rpc}=await socket();
    entry.threads=[];
    for(let i=0;i<2;i++){
      const before=new Set((await tree()).rows.map(row=>row.pid));await server.snapshot(true);
      const at=Date.now(),started=performance.now();let error=null,threadId=null;
      try{const reply=await rpc("thread/start",{cwd,approvalPolicy:"on-request",sandbox:"workspace-write"});threadId=reply?.thread?.id||null}catch(caught){error=String(caught.message).slice(0,300)}
      const ms=Math.round(performance.now()-started);await sleep(5000);
      const snap=await server.snapshot(true),now=await tree(),fresh=now.rows.filter(row=>!before.has(row.pid));
      for(const row of fresh)external.add(row.pid);
      entry.threads.push({threadId,error,threadStartMs:ms,machineLoad:meter.loadBetween(at,Date.now()),spawns:snap.spawns.byCommand,newProcesses:summary(fresh)});
      console.log(JSON.stringify({runtime,thread:i,ms,error,newProcesses:fresh.length,spawns:snap.spawns.total}));
    }
    // The harness's sessions at idle: CPU and memory of everything started for them.
    const t0=await processTable(),at=Date.now();await sleep(idleSeconds*1000);const t1=await processTable();
    const ids=new Set(descendants(t1,[server.pid]).filter(row=>external.has(row.pid)||entry.threads.some(thread=>thread.newProcesses.some(item=>item.pid===row.pid))).map(row=>row.pid));
    const footprint=footprintDelta(t0,t1,ids,{seconds:(Date.now()-at)/1000});
    entry.idle={seconds:idleSeconds,machineLoad:meter.loadBetween(at,Date.now()),processes:footprint,byRole:groupByRole(footprint),totalWorkingSetMB:Number(footprint.reduce((sum,row)=>sum+row.workingSetMB,0).toFixed(1)),totalPrivateMB:Number(footprint.reduce((sum,row)=>sum+row.privateMB,0).toFixed(1)),totalCorePercent:Number(footprint.reduce((sum,row)=>sum+row.corePercent,0).toFixed(2))};
    console.log(JSON.stringify({runtime,idleProcesses:footprint.length,workingSetMB:entry.idle.totalWorkingSetMB,privateMB:entry.idle.totalPrivateMB,corePercent:entry.idle.totalCorePercent}));
    ws.close();
  }
  // Switched back to Native: which harness processes are still alive a minute later.
  result.switchBack=await setRuntime("native");await sleep(idleSeconds*1000);
  const left=(await tree()).rows.filter(row=>external.has(row.pid));
  result.afterSwitchBack={seconds:idleSeconds,stillRunning:summary(left),count:left.length,workingSetMB:Number((left.reduce((sum,row)=>sum+row.workingSet,0)/1048576).toFixed(1))};
  console.log(JSON.stringify({afterSwitchBack:left.length}));
}catch(error){result.errors.push(String(error?.stack||error).slice(0,3000));console.error(error)}
const lastTree=await tree().catch(()=>null);
await server.stop();await sleep(3000);
// Nothing the server started should outlive it.
const table=await processTable(),orphans=lastTree?table.filter(row=>lastTree.rows.some(item=>item.pid===row.pid&&item.created===row.created)):[];
result.afterServerStop={orphans:summary(orphans)};
meter.stop();result.finishedAt=new Date().toISOString();
writeFileSync(outFile,JSON.stringify(result,null,2));console.log(JSON.stringify({ok:!result.errors.length,orphans:orphans.length,out:outFile}));
process.exit(0);
