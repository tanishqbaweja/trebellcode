#!/usr/bin/env node
// The Electron shell's own footprint, with no window on screen: desktop/main.mjs runs as shipped, with TREBELL_TEST_HIDDEN=1 (the main
// window is never shown) and an isolated home, under Playwright's Electron driver. It measures startup (launch to window loaded and
// composer ready), Electron's per-process CPU and memory (app.getAppMetrics) and every child process, and the main process's event
// loop (where the GUI server runs) at idle and while the hidden window opens the 1000-turn thread.
//
//   node scripts/perf/electron.mjs --home <seeded Trebell home> --out <file.json> [--idle-seconds 60] [--reps 5]
//
// run.mjs seeds the home (<out>/work/home-base); copy it first, since the app writes to it. No model is called: nothing is sent.
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { freePort, isolatedEnv } from "./lib/server.mjs";
import { processTable, descendants, footprintDelta, groupByRole } from "./lib/system.mjs";
import { summarize } from "./lib/stats.mjs";
import { startLoadMeter } from "./lib/system.mjs";
import { marker, PERF_THREADS } from "./lib/seed.mjs";

const repoRoot=fileURLToPath(new URL("../../",import.meta.url));
const argv=process.argv.slice(2),flag=(name,fallback)=>{const index=argv.indexOf("--"+name);return index>=0?argv[index+1]:fallback};
const baseHome=resolve(flag("home")),outFile=resolve(flag("out")),idleSeconds=Number(flag("idle-seconds",60))||60,reps=Number(flag("reps",5))||5;
const runDir=join(outFile,"..","electron-run");mkdirSync(runDir,{recursive:true});
const meter=startLoadMeter();const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const result={startedAt:new Date().toISOString(),startup:[],errors:[]};

async function launch(home){
  const port=await freePort(),appPort=await freePort();
  const env=isolatedEnv({home,runDir,extra:{TREBELL_TEST_HIDDEN:"1",TREBELL_GUI_PORT:String(port),TREBELL_APP_SERVER_PORT:String(appPort),ELECTRON_ENABLE_LOGGING:"",TREBELL_UI_DIST:flag("ui-dist",join(repoRoot,"ui","dist"))}});
  const started=performance.now(),at=Date.now();
  const app=await electron.launch({args:[repoRoot],cwd:repoRoot,env,timeout:90_000});
  const page=await app.firstWindow({timeout:90_000});
  await page.waitForLoadState("domcontentloaded");
  const windowMs=performance.now()-started;
  await page.locator('[data-testid="composer"]:not([disabled])').first().waitFor({timeout:60_000});
  const readyMs=performance.now()-started;
  return {app,page,port,windowMs,readyMs,at};
}
// The main process's event loop (it hosts the GUI server): a delay histogram the test reads back.
const startLoopMonitor=app=>app.evaluate(()=>{const {monitorEventLoopDelay}=process.getBuiltinModule("node:perf_hooks");globalThis.__perfLoop?.disable();globalThis.__perfLoop=monitorEventLoopDelay({resolution:10});globalThis.__perfLoop.enable();globalThis.__perfElu=performance.eventLoopUtilization();return true});
const readLoopMonitor=app=>app.evaluate(()=>{const h=globalThis.__perfLoop,ms=v=>Number((v/1e6).toFixed(1));const elu=performance.eventLoopUtilization(globalThis.__perfElu);return {p50:ms(h.percentile(50)),p90:ms(h.percentile(90)),p99:ms(h.percentile(99)),max:ms(h.max),utilization:Number(elu.utilization.toFixed(3))}});
const appMetrics=app=>app.evaluate(({app})=>app.getAppMetrics().map(metric=>({pid:metric.pid,type:metric.type,serviceName:metric.serviceName||null,cpuPercent:Number((metric.cpu?.percentCPUUsage||0).toFixed(2)),workingSetMB:Number(((metric.memory?.workingSetSize||0)/1024).toFixed(1)),privateMB:Number(((metric.memory?.privateBytes||0)/1024).toFixed(1))})));

try{
  // Startup, reps times, each on a fresh copy of the seeded home.
  for(let rep=0;rep<reps;rep++){
    const home=join(runDir,"home-"+rep);rmSync(home,{recursive:true,force:true});cpSync(baseHome,home,{recursive:true});
    const session=await launch(home);
    result.startup.push({rep,windowLoadedMs:Math.round(session.windowMs),composerReadyMs:Math.round(session.readyMs),machineLoad:meter.loadBetween(session.at,Date.now())});
    if(rep<reps-1){await session.app.close();continue}
    // The last one stays up for the footprint measurements.
    const {app,page}=session;
    result.visibility=await page.evaluate(()=>({visibilityState:document.visibilityState,hidden:document.hidden}));
    await sleep(5000);
    await appMetrics(app);await startLoopMonitor(app);
    const table0=await processTable();const at=Date.now();
    await sleep(idleSeconds*1000);
    const table1=await processTable();const metrics=await appMetrics(app);const loop=await readLoopMonitor(app);
    const electronPid=metrics.find(row=>row.type==="Browser")?.pid;
    const rows=descendants(table1,[electronPid]),footprint=footprintDelta(table0,table1,new Set(rows.map(row=>row.pid)),{seconds:(Date.now()-at)/1000});
    result.idleHome={seconds:idleSeconds,machineLoad:meter.loadBetween(at,Date.now()),appMetrics:metrics,mainEventLoopMs:loop,processes:footprint,byRole:groupByRole(footprint),totalWorkingSetMB:Number(footprint.reduce((s,r)=>s+r.workingSetMB,0).toFixed(1)),totalPrivateMB:Number(footprint.reduce((s,r)=>s+r.privateMB,0).toFixed(1))};
    // Opening the long thread in the hidden window: the main process's event loop while the server reads and sends its history.
    const opens=[];
    for(let i=0;i<reps;i++){
      for(const name of [PERF_THREADS.stream,PERF_THREADS.long]){
        const row=page.locator(`.thread-row .thread-main[title="${name}"]`).first();
        await startLoopMonitor(app);const started=performance.now();
        await row.click();await page.getByText(marker(name),{exact:false}).first().waitFor({timeout:60_000});
        const ms=performance.now()-started;await sleep(300);const loop2=await readLoopMonitor(app);
        if(name===PERF_THREADS.long)opens.push({ms:Math.round(ms),mainLoopMaxMs:loop2.max,mainLoopP99Ms:loop2.p99,mainLoopUtilization:loop2.utilization});
      }
    }
    result.openLong={opens,ms:summarize(opens.map(row=>row.ms),0),mainLoopMaxMs:summarize(opens.map(row=>row.mainLoopMaxMs),1)};
    // Idle with the project thread open (the UI's git poll runs if the hidden window counts as visible).
    await page.locator(`.thread-row .thread-main[title="${PERF_THREADS.short}"]`).first().click();await sleep(3000);
    await appMetrics(app);await startLoopMonitor(app);const t0=await processTable(),at2=Date.now();
    await sleep(idleSeconds*1000);
    const t1=await processTable(),metrics2=await appMetrics(app),loop3=await readLoopMonitor(app);
    const rows2=descendants(t1,[electronPid]),footprint2=footprintDelta(t0,t1,new Set(rows2.map(row=>row.pid)),{seconds:(Date.now()-at2)/1000});
    result.idleThread={seconds:idleSeconds,machineLoad:meter.loadBetween(at2,Date.now()),appMetrics:metrics2,mainEventLoopMs:loop3,processes:footprint2,byRole:groupByRole(footprint2),totalWorkingSetMB:Number(footprint2.reduce((s,r)=>s+r.workingSetMB,0).toFixed(1)),totalPrivateMB:Number(footprint2.reduce((s,r)=>s+r.privateMB,0).toFixed(1))};
    await app.close();
  }
}catch(error){result.errors.push(String(error?.stack||error).slice(0,3000))}
result.startupSummary={windowLoadedMs:summarize(result.startup.map(row=>row.windowLoadedMs),0),composerReadyMs:summarize(result.startup.map(row=>row.composerReadyMs),0)};
result.finishedAt=new Date().toISOString();meter.stop();
writeFileSync(outFile,JSON.stringify(result,null,2));console.log(JSON.stringify({ok:!result.errors.length,out:outFile}));
process.exit(0);
