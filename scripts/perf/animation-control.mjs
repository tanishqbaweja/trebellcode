#!/usr/bin/env node
// The idle cost of the UI's running CSS animations (audit suspect 7): one idle project thread measured twice in headless Chromium,
// first as shipped, then with every animation and transition switched off by an injected style. Each phase records compositor
// frames, paints and style recalcs from a trace, and renderer and GPU-process CPU. The real GUI server runs on a copy of a seeded
// home; nothing is sent to a model.
//
//   node scripts/perf/animation-control.mjs --home <seeded home> --ui-dist <dir> --out <file.json> [--seconds 20] [--reps 3]
//
// run.mjs seeds the home (<out>/work/home-base) and builds the UI (<out>/ui-dist).
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer, freePort } from "./lib/server.mjs";
import { launchBrowser, pageInstruments, browserProcesses, processCpuDelta, TRACE_CATEGORIES, analyzeTrace } from "./lib/browser.mjs";
import { startLoadMeter } from "./lib/system.mjs";
import { summarize } from "./lib/stats.mjs";
import { marker, PERF_THREADS } from "./lib/seed.mjs";

const repoRoot=fileURLToPath(new URL("../../",import.meta.url));
const argv=process.argv.slice(2),flag=(name,fallback)=>{const index=argv.indexOf("--"+name);return index>=0?argv[index+1]:fallback};
const baseHome=resolve(flag("home")),uiDist=resolve(flag("ui-dist")),outFile=resolve(flag("out"));
const seconds=Math.max(10,Number(flag("seconds",20))||20),reps=Math.max(1,Number(flag("reps",3))||3);
const runDir=join(dirname(outFile),"animation-control-run"),home=join(runDir,"home");
rmSync(runDir,{recursive:true,force:true,maxRetries:10,retryDelay:200});mkdirSync(runDir,{recursive:true});cpSync(baseHome,home,{recursive:true});
const meter=startLoadMeter(),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const result={startedAt:new Date().toISOString(),seconds,reps,phases:{},errors:[]};
const OFF="*,*::before,*::after{animation:none!important;transition:none!important}";

const server=await startServer({repoRoot,home,runDir,uiDist,port:await freePort(),appPort:await freePort()});
const browser=await launchBrowser(),browserCdp=await browser.newBrowserCDPSession();
try{
  const context=await browser.newContext({viewport:{width:1600,height:980}});await context.addInitScript(pageInstruments);
  const page=await context.newPage();await page.goto(server.url,{waitUntil:"domcontentloaded"});
  const row=page.locator(`.thread-row .thread-main[title="${PERF_THREADS.short}"]`).first();await row.waitFor({state:"visible",timeout:60_000});
  await row.click();await page.getByText(marker(PERF_THREADS.short),{exact:false}).first().waitFor({timeout:60_000});
  await page.mouse.move(5,5);await sleep(3000);
  // One idle window: a trace for frame counts over the first 10 s, CPU per Chromium process over the whole window.
  const idleWindow=async()=>{
    const running=await page.evaluate(()=>document.getAnimations().filter(animation=>animation.playState==="running").map(animation=>animation.animationName||animation.constructor.name));
    const before=await browserProcesses(browserCdp),at=Date.now(),t0=performance.now();
    await browser.startTracing(page,{categories:TRACE_CATEGORIES});await sleep(10_000);const trace=analyzeTrace(await browser.stopTracing());
    await sleep(Math.max(0,seconds*1000-(performance.now()-t0)));
    const elapsed=(performance.now()-t0)/1000,cpu=processCpuDelta(before,await browserProcesses(browserCdp),elapsed);
    return {runningAnimations:running,machineLoad:meter.loadBetween(at,Date.now()),drawsPerSecond:trace.drawsPerSecond,beginFramesPerSecond:trace.beginFramesPerSecond,paintsPerSecond:trace.paintsPerSecond,styleRecalcsPerSecond:trace.styleRecalcsPerSecond,rendererCorePercent:cpu?.renderer?.corePercent??null,gpuCorePercent:cpu?.GPU?.corePercent??cpu?.gpu?.corePercent??null,browserCorePercent:cpu?.browser?.corePercent??null};
  };
  const shipped=[],off=[];
  for(let rep=0;rep<reps;rep++){
    await page.evaluate(()=>document.getElementById("perf-animations-off")?.remove());await sleep(1500);
    shipped.push(await idleWindow());
    await page.evaluate(css=>{const style=document.createElement("style");style.id="perf-animations-off";style.textContent=css;document.head.append(style)},OFF);await sleep(1500);
    off.push(await idleWindow());
    console.log(JSON.stringify({rep,shipped:shipped.at(-1),off:off.at(-1)}));
  }
  const pick=(rows,key)=>summarize(rows.map(row=>row[key]),2);
  for(const [name,rows] of [["shipped",shipped],["animationsOff",off]])result.phases[name]={windows:rows,drawsPerSecond:pick(rows,"drawsPerSecond"),paintsPerSecond:pick(rows,"paintsPerSecond"),rendererCorePercent:pick(rows,"rendererCorePercent"),gpuCorePercent:pick(rows,"gpuCorePercent"),machineLoad:pick(rows,"machineLoad")};
  await context.close();
}catch(error){result.errors.push(String(error?.stack||error).slice(0,3000))}
await browser.close();await server.stop();meter.stop();
result.finishedAt=new Date().toISOString();writeFileSync(outFile,JSON.stringify(result,null,2));
console.log(JSON.stringify({ok:!result.errors.length,out:outFile}));
process.exit(0);
