#!/usr/bin/env node
// What a page load costs once the browser has been here before (audit suspects 14 and 21): the real GUI server with the server tap
// on a seeded home, headless Chromium with a persistent profile on disk, three loads of the same home per rep: the first visit, a
// reload, then a restart of the server and the browser on the same port and profile (as the desktop shell restarts on port 3210).
// Per load it counts what reached the server (asset and page requests, POST /api/thread-meta, sqlite write transactions and
// connections) and what crossed the network (CDP encodedDataLength by resource type, and how many responses came from the cache).
// The seeded home and the UI build are made under --work on first use and reused after.
//
//   node scripts/perf/reload.mjs --work <dir> --out <file.json> [--reps 3] [--threads 500] [--long-turns 1000] [--big-items 600]
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startServer, freePort } from "./lib/server.mjs";
import { seedHome, seedRepository } from "./lib/seed.mjs";
import { buildUi } from "./lib/bundle.mjs";
import { startLoadMeter } from "./lib/system.mjs";
import { summarize } from "./lib/stats.mjs";

const repoRoot=resolve(fileURLToPath(new URL("../../",import.meta.url)));
const argv=process.argv.slice(2),flag=(name,fallback)=>{const index=argv.indexOf("--"+name);return index>=0?argv[index+1]:fallback};
const work=resolve(flag("work")),outFile=resolve(flag("out")),reps=Math.max(1,Number(flag("reps",3))||3);
const sizes={threads:Number(flag("threads",500))||500,longTurns:Number(flag("long-turns",1000))||1000,bigTurnItems:Number(flag("big-items",600))||600};
mkdirSync(work,{recursive:true});
const meter=startLoadMeter(),sleep=ms=>new Promise(done=>setTimeout(done,ms));
const log=(...parts)=>console.log(new Date().toISOString().slice(11,19),...parts);
const uiDist=join(work,"ui-dist"),baseHome=join(work,"home-base");
const result={startedAt:new Date().toISOString(),sizes,reps,commit:null,loads:[],errors:[]};
try{result.commit=(await import("node:child_process")).execFileSync("git",["rev-parse","--short","HEAD"],{cwd:repoRoot,windowsHide:true,encoding:"utf8"}).trim()}catch{}
if(!existsSync(join(uiDist,"index.html"))){log("building ui");await buildUi({repoRoot,outDir:uiDist})}
if(!existsSync(join(baseHome,"trebell.sqlite"))){log("seeding home",JSON.stringify(sizes));const repo=seedRepository(repoRoot,join(work,"repo"));seedHome({home:baseHome,repo,...sizes,externalRuntimes:[]})}

const READY='[data-testid="composer"]:not([disabled])';
async function openProfile(profile){
  const context=await chromium.launchPersistentContext(profile,{headless:true,viewport:{width:1600,height:980},proxy:{server:"http://127.0.0.1:9",bypass:"127.0.0.1,localhost"},args:["--disable-features=Translate,MediaRouter","--no-first-run"]});
  const page=context.pages()[0]||await context.newPage(),cdp=await context.newCDPSession(page),requests=new Map();
  await cdp.send("Network.enable");
  cdp.on("Network.requestWillBeSent",event=>requests.set(event.requestId,{url:event.request.url,type:event.type||"Other",bytes:0,cached:false,status:null}));
  cdp.on("Network.requestServedFromCache",event=>{const row=requests.get(event.requestId);if(row)row.cached=true});
  cdp.on("Network.responseReceived",event=>{const row=requests.get(event.requestId);if(row){row.status=event.response.status;if(event.response.fromDiskCache||event.response.fromPrefetchCache)row.cached=true}});
  cdp.on("Network.loadingFinished",event=>{const row=requests.get(event.requestId);if(row)row.bytes=event.encodedDataLength||0});
  return {context,page,requests};
}
// One load: navigate (or reload), wait for the sidebar and the composer, then 4 s for the page's follow-up requests, as run.mjs startup.
async function measureLoad(label,rep,server,view,navigate){
  view.requests.clear();await server.snapshot(true);const at=Date.now();
  await navigate();
  await view.page.locator(".thread-row").first().waitFor({state:"visible",timeout:60_000});await view.page.locator(READY).waitFor({timeout:60_000});
  const readyMs=Date.now()-at;await sleep(4000);
  const snap=await server.snapshot(true),rows=[...view.requests.values()],staticRows=rows.filter(row=>!new URL(row.url).pathname.startsWith("/api/"));
  const byType={};for(const row of staticRows){const entry=byType[row.type]||(byType[row.type]={requests:0,fromCache:0,networkKB:0});entry.requests++;if(row.cached)entry.fromCache++;entry.networkKB+=row.bytes/1024}
  for(const entry of Object.values(byType))entry.networkKB=Number(entry.networkKB.toFixed(1));
  const http=snap.http.byPath;
  return {label,rep,machineLoad:meter.loadBetween(at,Date.now()),readyMs,
    documentStatus:staticRows.find(row=>row.type==="Document")?.status??null,
    staticNetworkKB:Number((staticRows.reduce((sum,row)=>sum+row.bytes,0)/1024).toFixed(1)),staticFromCache:staticRows.filter(row=>row.cached).length,staticRequests:staticRows.length,byType,
    server:{assetRequests:http["GET /assets/*"]||0,pageRequests:http["GET /"]||0,threadMetaPosts:http["POST /api/thread-meta"]||0,requests:snap.http.requests,
      sqliteOpens:snap.sqlite.opens,writeTransactions:snap.sqlite.beginImmediate,sqliteBytesWrittenKB:Number((snap.sqlite.bytesWritten/1024).toFixed(1)),cpuMs:Math.round(snap.cpu.userMs+snap.cpu.systemMs)}};
}

for(let rep=0;rep<reps;rep++){
  const runDir=join(work,"reload-run-"+rep),home=join(runDir,"home"),profile=join(runDir,"profile");
  rmSync(runDir,{recursive:true,force:true,maxRetries:10,retryDelay:200});mkdirSync(runDir,{recursive:true});cpSync(baseHome,home,{recursive:true});
  const port=await freePort(),appPort=await freePort();let server=null,view=null;
  try{
    server=await startServer({repoRoot,home,runDir,uiDist,port,appPort});view=await openProfile(profile);
    result.loads.push(await measureLoad("first visit",rep,server,view,()=>view.page.goto(server.url,{waitUntil:"domcontentloaded"})));
    result.loads.push(await measureLoad("reload",rep,server,view,()=>view.page.reload({waitUntil:"domcontentloaded"})));
    await view.context.close();view=null;await server.stop();
    server=await startServer({repoRoot,home,runDir,uiDist,port,appPort});view=await openProfile(profile);
    result.loads.push(await measureLoad("restart",rep,server,view,()=>view.page.goto(server.url,{waitUntil:"domcontentloaded"})));
    for(const row of result.loads.slice(-3))log(row.label,"rep",rep,JSON.stringify({ready:row.readyMs,doc:row.documentStatus,staticKB:row.staticNetworkKB,assets:row.server.assetRequests,metaPosts:row.server.threadMetaPosts,writeTx:row.server.writeTransactions,opens:row.server.sqliteOpens,load:row.machineLoad}));
  }catch(error){result.errors.push({rep,error:String(error?.stack||error).slice(0,2000)});log("rep",rep,"failed:",error?.message)}
  finally{await view?.context.close().catch(()=>{});await server?.stop().catch(()=>{})}
}
const pick=(label,key)=>summarize(result.loads.filter(row=>row.label===label).map(row=>key(row)),1);
result.summary=Object.fromEntries(["first visit","reload","restart"].map(label=>[label,{readyMs:pick(label,row=>row.readyMs),staticNetworkKB:pick(label,row=>row.staticNetworkKB),assetRequests:pick(label,row=>row.server.assetRequests),threadMetaPosts:pick(label,row=>row.server.threadMetaPosts),writeTransactions:pick(label,row=>row.server.writeTransactions),sqliteOpens:pick(label,row=>row.server.sqliteOpens),machineLoad:pick(label,row=>row.machineLoad)}]));
meter.stop();result.finishedAt=new Date().toISOString();
writeFileSync(outFile,JSON.stringify(result,null,2));
console.log(JSON.stringify({ok:!result.errors.length,out:outFile,errors:result.errors.length}));
process.exit(0);
