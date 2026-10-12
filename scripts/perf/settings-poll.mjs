#!/usr/bin/env node
// What the Settings page's 5-s poll (GET /api/stats + GET /api/runtime) costs while an external harness is the active runtime
// (audit suspect 6): /api/runtime probes the active harness's CLI on every poll. For each runtime named, the real GUI server on a
// copy of a seeded home is switched to it, headless Chromium opens Settings and stays there, and the server tap counts the process
// spawns; the page records each poll's latency. Runtimes the server refuses (not installed or not signed in) are reported as such.
// Nothing is sent to any harness.
//
//   node scripts/perf/settings-poll.mjs --home <seeded home> --ui-dist <dir> --out <file.json> [--runtimes grok,cursor] [--seconds 60]
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer, freePort } from "./lib/server.mjs";
import { launchBrowser, pageInstruments } from "./lib/browser.mjs";
import { startLoadMeter } from "./lib/system.mjs";
import { summarize } from "./lib/stats.mjs";

const repoRoot=resolve(fileURLToPath(new URL("../../",import.meta.url)));
const argv=process.argv.slice(2),flag=(name,fallback)=>{const index=argv.indexOf("--"+name);return index>=0?argv[index+1]:fallback};
const baseHome=resolve(flag("home")),uiDist=resolve(flag("ui-dist")),outFile=resolve(flag("out"));
const runtimes=String(flag("runtimes","grok,cursor")).split(",").map(value=>value.trim()).filter(Boolean),seconds=Math.max(20,Number(flag("seconds",60))||60);
const meter=startLoadMeter(),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const result={startedAt:new Date().toISOString(),seconds,runtimes:{},errors:[]};
const browser=await launchBrowser();
for(const runtime of runtimes){
  const runDir=join(dirname(outFile),"settings-poll-run-"+runtime),home=join(runDir,"home");
  rmSync(runDir,{recursive:true,force:true,maxRetries:10,retryDelay:200});mkdirSync(runDir,{recursive:true});cpSync(baseHome,home,{recursive:true});
  const server=await startServer({repoRoot,home,runDir,uiDist,port:await freePort(),appPort:await freePort()});
  try{
    const response=await fetch(server.url+"/api/settings",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({agentRuntime:runtime,agentRuntimeInstanceId:runtime+"-default"})});
    const switched={status:response.status,body:(await response.text()).slice(0,200)};
    if(response.status!==200){result.runtimes[runtime]={switched};continue}
    const context=await browser.newContext({viewport:{width:1600,height:980}});await context.addInitScript(pageInstruments);
    const page=await context.newPage(),polls=[];
    page.on("requestfinished",request=>{if(new URL(request.url()).pathname==="/api/runtime"){const timing=request.timing();polls.push({at:Date.now(),ms:Math.round(timing.responseEnd)})}});
    await page.goto(server.url,{waitUntil:"domcontentloaded"});await page.locator(".thread-row").first().waitFor({state:"visible",timeout:60_000});
    await page.locator(".sidebar").getByRole("button",{name:"Settings",exact:true}).first().click();
    await page.locator('input[aria-label="Search settings"]').waitFor({timeout:20_000});await sleep(6000);
    await server.snapshot(true);const at=Date.now(),first=polls.length;
    await sleep(seconds*1000);
    const snap=await server.snapshot(true),minutes=(Date.now()-at)/60000,inWindow=polls.slice(first);
    result.runtimes[runtime]={switched:{status:switched.status},seconds:Math.round(minutes*60),machineLoad:meter.loadBetween(at,Date.now()),runtimePollsPerMin:Number((inWindow.length/minutes).toFixed(1)),runtimeRequestMs:summarize(inWindow.map(row=>row.ms),0),
      spawnsPerMin:Number((snap.spawns.total/minutes).toFixed(1)),spawnsByCommand:snap.spawns.byCommand,serverCpuCorePercent:snap.cpu.corePercent,serverEventLoopMaxMs:snap.eventLoop.delayMs.max};
    console.log(JSON.stringify({runtime,...result.runtimes[runtime],spawnsByCommand:undefined}));
    await context.close();
  }catch(error){result.errors.push(runtime+": "+String(error?.stack||error).slice(0,1500))}
  finally{await server.stop()}
}
await browser.close();meter.stop();
result.finishedAt=new Date().toISOString();writeFileSync(outFile,JSON.stringify(result,null,2));
console.log(JSON.stringify({ok:!result.errors.length,out:outFile}));
process.exit(0);
