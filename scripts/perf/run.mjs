#!/usr/bin/env node
// Trebell performance baseline: one command, no window, no paid model call.
//
//   node scripts/perf/run.mjs [--out <dir>] [--only bundle,micro,startup,open,typing,scroll,stream,idle,memory,harness]
//                             [--reps 5] [--idle-seconds 180] [--threads 500] [--long-turns 1000] [--big-items 600]
//
// It builds the UI (with source maps) into <out>/ui-dist, seeds an isolated Trebell home under <out>/work (a small real git repo
// as the project; a sidebar of --threads Native threads, one of --long-turns turns, one turn of --big-items items; one thread per
// installed external harness), then runs the real GUI server (src/gui-server.mjs, not mock) with scripts/perf/lib/server-tap.mjs
// preloaded and drives headless Chromium through Playwright. OpenAI is answered in-process by the scripted fake
// (lib/fake-openai.mjs); every other external fetch is refused. Results: <out>/results.json (all raw samples and summaries) plus
// traces and CPU profiles beside it. The default <out> is <os tmpdir>/trebell-perf/<timestamp>. Each timing sample carries the
// machine's CPU load at that moment; timings repeat --reps times and report median and p90.
import { cpSync, existsSync, mkdirSync, rmSync, statSync, readdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { cpus, tmpdir, totalmem, freemem, release } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { summarize } from "./lib/stats.mjs";
import { startLoadMeter, processTable, descendants, footprintDelta, groupByRole, gpuUtilization, processRole } from "./lib/system.mjs";
import { startServer, freePort } from "./lib/server.mjs";
import { seedHome, seedRepository, PERF_THREADS, marker } from "./lib/seed.mjs";
import { launchBrowser, pageInstruments, pageCounters, longTasksSince, eventsSince, commitsBetween, cdpMetrics, metricDelta, heapAndDom, browserProcesses, processCpuDelta, TRACE_CATEGORIES, analyzeTrace, attributeProfile } from "./lib/browser.mjs";
import { buildUi, bundleReport } from "./lib/bundle.mjs";

const repoRoot=fileURLToPath(new URL("../../",import.meta.url));
const argv=process.argv.slice(2),flag=(name,fallback)=>{const index=argv.indexOf("--"+name);return index>=0?argv[index+1]:fallback};
const stamp=new Date().toISOString().replace(/[:.]/g,"-");
const out=resolve(flag("out",join(tmpdir(),"trebell-perf",stamp)));
const ALL=["bundle","micro","startup","open","typing","scroll","stream","idle","memory","harness"];
const only=new Set(String(flag("only",ALL.join(","))).split(",").map(value=>value.trim()).filter(Boolean));
const reps=Math.max(1,Number(flag("reps",5))||5),idleSeconds=Math.max(30,Number(flag("idle-seconds",180))||180);
const sizes={threads:Number(flag("threads",500))||500,longTurns:Number(flag("long-turns",1000))||1000,bigTurnItems:Number(flag("big-items",600))||600};
mkdirSync(out,{recursive:true});
const work=join(out,"work"),uiDist=join(out,"ui-dist");mkdirSync(work,{recursive:true});
const meter=startLoadMeter();
const results={startedAt:new Date().toISOString(),out,host:{platform:process.platform,release:release(),cpus:cpus().length,cpuModel:cpus()[0]?.model,totalMemGB:Number((totalmem()/2**30).toFixed(1)),freeMemGBAtStart:Number((freemem()/2**30).toFixed(1)),node:process.version},sizes,reps,idleSeconds,scenarios:{},errors:[]};
const save=()=>writeFileSync(join(out,"results.json"),JSON.stringify(results,null,2));
const log=(...parts)=>console.log(new Date().toISOString().slice(11,19),...parts);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const loadNow=(windowMs=2000)=>meter.loadBetween(Date.now()-windowMs,Date.now());

async function scenario(name,fn){
  if(!only.has(name))return;
  log("scenario",name);const started=Date.now();
  try{results.scenarios[name]={...(await fn()),durationS:Math.round((Date.now()-started)/1000),machineLoadDuring:meter.loadBetween(started,Date.now())}}
  catch(error){results.errors.push({scenario:name,error:String(error?.stack||error).slice(0,4000)});log("scenario",name,"failed:",error?.message)}
  save();
}

// ---------- setup: UI build, seeded home ----------
let bundleModules=null;
if(!existsSync(join(uiDist,"index.html"))||only.has("bundle")){log("building ui");const built=await buildUi({repoRoot,outDir:uiDist});bundleModules=built.modules;results.uiBuildMs=built.buildMs}
const repo=seedRepository(repoRoot,join(work,"repo"));
const externalRuntimes=[];
for(const [runtime,command] of [["claude","claude"],["opencode","opencode"],["cursor","cursor-agent"],["grok","grok"]]){
  const found=await new Promise(resolve=>{const child=spawn(process.platform==="win32"?"where":"which",[command],{windowsHide:true,stdio:"ignore"});child.on("exit",code=>resolve(code===0));child.on("error",()=>resolve(false))});
  if(found)externalRuntimes.push(runtime);
}
const baseHome=join(work,"home-base");
log("seeding home",JSON.stringify(sizes),"external:",externalRuntimes.join(","));
const seedStarted=Date.now();
const seeded=seedHome({home:baseHome,repo,...sizes,externalRuntimes});
results.seed={...seeded,externalRuntimes,seedMs:Date.now()-seedStarted,homeBytes:dirBytes(baseHome)};save();
// Filler thread names that exist for the chosen sizes ("Perf filler 0000" is the oldest).
const fillerCount=Math.max(1,Object.keys(seeded.byName).filter(name=>name.startsWith("Perf filler ")).length);
const filler=index=>"Perf filler "+String(((index%fillerCount)+fillerCount)%fillerCount).padStart(4,"0");
function dirBytes(dir){let total=0;if(!existsSync(dir))return 0;for(const entry of readdirSync(dir,{withFileTypes:true})){const path=join(dir,entry.name);try{total+=entry.isDirectory()?dirBytes(path):statSync(path).size}catch{}}return total}
function freshHome(name){const home=join(work,name);rmSync(home,{recursive:true,force:true,maxRetries:10,retryDelay:200});cpSync(baseHome,home,{recursive:true});return home}

await scenario("bundle",async()=>bundleReport({outDir:uiDist,modules:bundleModules||{}}));

await scenario("micro",async()=>{
  const file=join(out,"micro.json"),tap=pathToFileURL(join(repoRoot,"scripts","perf","lib","server-tap.mjs")).href;
  await new Promise((resolve,reject)=>{const child=spawn(process.execPath,["--expose-gc","--import",tap,join(repoRoot,"scripts","perf","micro.mjs"),"--home",join(work,"micro-home"),"--repo",repo,"--out",file],{cwd:repoRoot,env:{...process.env,NODE_NO_WARNINGS:"1",CODEX_HOME:join(work,"codex-home-micro"),TEMP:join(work,"tmp"),TMP:join(work,"tmp")},windowsHide:true,stdio:["ignore","pipe","pipe"]});let err="";child.stderr.on("data",chunk=>err+=chunk);child.on("exit",code=>code===0?resolve():reject(new Error("micro exited "+code+": "+err.slice(-2000))));child.on("error",reject)});
  const { readFileSync }=await import("node:fs");return JSON.parse(readFileSync(file,"utf8"));
});

// ---------- browser helpers ----------
const browser=["startup","open","typing","scroll","stream","idle","memory","harness"].some(name=>only.has(name))?await launchBrowser():null;
const browserCdp=browser?await browser.newBrowserCDPSession():null;
if(browser){const probe=await browser.newPage();results.browser={version:browser.version(),gpu:await probe.evaluate(()=>{const gl=document.createElement("canvas").getContext("webgl");const ext=gl?.getExtension("WEBGL_debug_renderer_info");return gl?(ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):"webgl"):"none"})};await probe.close()}
async function newPage(url){
  const context=await browser.newContext({viewport:{width:1600,height:980}});
  await context.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
  await context.addInitScript(pageInstruments);
  const page=await context.newPage(),cdp=await context.newCDPSession(page);await cdp.send("Performance.enable");
  const traffic={requests:[],frames:[],finished:[]};
  page.on("request",request=>traffic.requests.push({at:Date.now(),method:request.method(),url:request.url(),type:request.resourceType()}));
  page.on("requestfinished",async request=>{try{const sizes=await request.sizes(),timing=request.timing();traffic.finished.push({at:Date.now(),method:request.method(),url:request.url(),type:request.resourceType(),bytes:sizes.responseBodySize+sizes.responseHeadersSize,body:sizes.responseBodySize,startedAt:Math.round(timing.startTime),ms:timing.responseEnd>=0?Math.round(timing.responseEnd):null})}catch{}});
  page.on("websocket",socket=>{socket.on("framesent",frame=>traffic.frames.push({at:Date.now(),dir:"sent",bytes:String(frame.payload).length}));socket.on("framereceived",frame=>traffic.frames.push({at:Date.now(),dir:"received",bytes:String(frame.payload).length,method:/"method":"([^"]+)"/.exec(String(frame.payload).slice(0,200))?.[1]||null}))});
  if(url)await page.goto(url,{waitUntil:"domcontentloaded"});
  return {context,page,cdp,traffic};
}
const pathOf=url=>{try{const value=new URL(url);return value.pathname.startsWith("/assets/")?"/assets/*":value.pathname}catch{return url}};
function countBy(rows,key){const out={};for(const row of rows){const value=key(row);out[value]=(out[value]||0)+1}return Object.fromEntries(Object.entries(out).sort((a,b)=>b[1]-a[1]))}
async function pageNow(page){return page.evaluate(()=>performance.now())}
// Resolves with the page time at the first animation frame where every check holds (text in .conversation-scroll, selectors).
async function frameWhen(page,{text=null,selectors=[],hidden=[],timeoutMs=30_000}={}){
  return page.evaluate(({text,selectors,hidden,timeoutMs})=>new Promise((resolve,reject)=>{
    const started=performance.now();
    const check=()=>{
      const root=document.querySelector(".conversation-scroll");
      const textOk=!text||Boolean(root&&root.textContent.includes(text));
      const selectorsOk=selectors.every(selector=>document.querySelector(selector));
      const hiddenOk=hidden.every(selector=>!document.querySelector(selector));
      if(textOk&&selectorsOk&&hiddenOk)return resolve(performance.now());
      if(performance.now()-started>timeoutMs)return reject(new Error("timeout waiting for "+JSON.stringify({text,selectors,hidden})));
      requestAnimationFrame(check);
    };
    check();
  }),{text,selectors,hidden,timeoutMs});
}
const COMPOSER_READY='[data-testid="composer"]:not([disabled])';
async function openThread(page,name,{timeoutMs=60_000}={}){
  let row=page.locator(`.thread-row .thread-main[title="${name}"]`).first();
  if(!(await row.isVisible().catch(()=>false))){
    const search=page.locator(".search-box input");await search.fill(name);
    row=page.locator(`.thread-row .thread-main[title="${name}"]`).first();await row.waitFor({state:"visible",timeout:15_000});
  }
  const t0=await pageNow(page);await row.click();
  const ready=await frameWhen(page,{text:marker(name),selectors:[COMPOSER_READY],hidden:['[data-testid="thread-opening"]'],timeoutMs});
  const search=page.locator(".search-box input");if(await search.inputValue().catch(()=>"")) await search.fill("");
  return ready-t0;
}
async function serverTree(server){const table=await processTable();return {table,rows:descendants(table,[server.pid])}}
function treeSummary(rows){return rows.map(row=>({pid:row.pid,ppid:row.ppid,depth:row.depth,name:row.name,role:processRole(row),workingSetMB:Number((row.workingSet/1048576).toFixed(1)),privateMB:Number((row.privateBytes/1048576).toFixed(1)),commandLine:row.commandLine.slice(0,160)}))}
function compactSnapshot(snap){
  if(!snap)return null;
  return {wallMs:snap.wallMs,cpu:snap.cpu,eventLoop:snap.eventLoop,memory:snap.memory,spawns:{total:snap.spawns.total,byCommand:snap.spawns.byCommand},
    sqlite:{opens:snap.sqlite.opens,prepares:snap.sqlite.prepares,beginImmediate:snap.sqlite.beginImmediate,rowsRead:snap.sqlite.rowsRead,bytesReadKB:Number((snap.sqlite.bytesRead/1024).toFixed(1)),bytesWrittenKB:Number((snap.sqlite.bytesWritten/1024).toFixed(1)),topStatements:Object.entries(snap.sqlite.byStatement).sort((a,b)=>b[1].bytesRead+b[1].bytesWritten-(a[1].bytesRead+a[1].bytesWritten)).slice(0,6).map(([kind,row])=>({kind,...row}))},
    json:{parseCalls:snap.json.parseCalls,parseKB:Number((snap.json.parseChars/1024).toFixed(1)),stringifyCalls:snap.json.stringifyCalls,stringifyKB:Number((snap.json.stringifyChars/1024).toFixed(1))},
    fs:{writeCalls:snap.fs.writeCalls,writeKB:Number((snap.fs.writeBytes/1024).toFixed(1)),readFileCalls:snap.fs.readFileCalls,readFileKB:Number((snap.fs.readFileBytes/1024).toFixed(1)),readdirCalls:snap.fs.readdirCalls,statCalls:snap.fs.statCalls,byWriteTarget:snap.fs.byWriteTarget},
    http:{requests:snap.http.requests,byPath:snap.http.byPath},ws:{sends:snap.ws.sends,sendKB:Number((snap.ws.sendBytes/1024).toFixed(1))},
    timersFired:snap.timers.fired,intervals:snap.timers.intervals,fetch:{total:snap.fetch.total,blocked:snap.fetch.blocked,byOrigin:snap.fetch.byOrigin,fakeCalls:snap.fetch.fake.length,fake:snap.fetch.fake.slice(-6)}};
}

// ---------- 1. startup ----------
await scenario("startup",async()=>{
  const home=freshHome("home-startup"),samples=[];
  for(let rep=0;rep<reps;rep++){
    const port=await freePort(),appPort=await freePort(),startedAt=Date.now();
    const server=await startServer({repoRoot,home,runDir:join(work,"run-startup"),uiDist,port,appPort});
    const listenSnap=await server.snapshot(true);
    const {page,context,cdp,traffic}=await newPage(null);
    const navStarted=Date.now();
    await page.goto(server.url,{waitUntil:"domcontentloaded"});
    const marks=await page.evaluate(()=>new Promise(resolve=>{
      const found={};const started=performance.now();
      const check=()=>{
        if(found.sidebar==null&&document.querySelector(".thread-row"))found.sidebar=performance.now();
        if(found.composer==null&&document.querySelector('[data-testid="composer"]:not([disabled])'))found.composer=performance.now();
        if((found.sidebar!=null&&found.composer!=null)||performance.now()-started>30000){const paint=name=>performance.getEntriesByName(name)[0]?.startTime??window.__perf.paints[name]??null;return resolve({...found,fcp:paint("first-contentful-paint"),fp:paint("first-paint"),nav:performance.getEntriesByType("navigation")[0]?.toJSON?.()||null})}
        requestAnimationFrame(check);
      };check();
    }));
    await sleep(4000);
    const loadSnap=await server.snapshot(true);
    const tree=await serverTree(server);
    const heap=await heapAndDom(cdp);
    const finished=traffic.finished.filter(row=>row.at>=navStarted),requests=traffic.requests.filter(row=>row.at>=navStarted);
    const api=requests.filter(row=>pathOf(row.url).startsWith("/api/"));
    const sample={rep,machineLoad:meter.loadBetween(startedAt,Date.now()),serverListenMs:Math.round(server.listeningMs),
      fcpMs:marks.fcp!=null?Math.round(marks.fcp):null,sidebarReadyMs:marks.sidebar!=null?Math.round(marks.sidebar):null,composerReadyMs:marks.composer!=null?Math.round(marks.composer):null,
      domContentLoadedMs:marks.nav?Math.round(marks.nav.domContentLoadedEventEnd):null,loadEventMs:marks.nav?Math.round(marks.nav.loadEventEnd):null,
      requestsIn4s:requests.length,apiRequestsIn4s:api.length,bytesIn4sKB:Number((finished.reduce((sum,row)=>sum+row.bytes,0)/1024).toFixed(1)),
      bytesByTypeKB:Object.fromEntries(Object.entries(finished.reduce((acc,row)=>{acc[row.type]=(acc[row.type]||0)+row.bytes;return acc},{})).map(([key,value])=>[key,Number((value/1024).toFixed(1))])),
      wsFramesIn4s:traffic.frames.filter(row=>row.at>=navStarted).length,heapAfterLoadMB:heap.heapUsedMB,domNodesAfterLoad:heap.domNodes,
      serverStartupCpuMs:Number((listenSnap.cpu.userMs+listenSnap.cpu.systemMs).toFixed(0)),serverRssAtListenMB:listenSnap.memory.rssMB,serverRssAfterLoadMB:loadSnap.memory.rssMB,
      serverChildren:treeSummary(tree.rows.filter(row=>row.pid!==server.pid)),serverWorkingSetMB:Number(((tree.rows.find(row=>row.pid===server.pid)?.workingSet||0)/1048576).toFixed(1))};
    if(rep===0){sample.apiCalls=countBy(api,row=>row.method+" "+pathOf(row.url));sample.startupServerWork=compactSnapshot(listenSnap);sample.pageLoadServerWork=compactSnapshot(loadSnap);sample.wsMethodsReceived=countBy(traffic.frames.filter(row=>row.dir==="received"),row=>row.method||"(reply)")}
    samples.push(sample);log("startup rep",rep,JSON.stringify({listen:sample.serverListenMs,fcp:sample.fcpMs,composer:sample.composerReadyMs,load:sample.machineLoad}));
    await context.close();await server.stop();
  }
  const pick=key=>summarize(samples.map(sample=>sample[key]),0);
  return {samples,summary:{serverListenMs:pick("serverListenMs"),fcpMs:pick("fcpMs"),sidebarReadyMs:pick("sidebarReadyMs"),composerReadyMs:pick("composerReadyMs"),domContentLoadedMs:pick("domContentLoadedMs"),requestsIn4s:pick("requestsIn4s"),apiRequestsIn4s:pick("apiRequestsIn4s"),bytesIn4sKB:pick("bytesIn4sKB"),serverStartupCpuMs:pick("serverStartupCpuMs"),serverRssAfterLoadMB:pick("serverRssAfterLoadMB"),machineLoad:pick("machineLoad")}};
});

// ---------- the main session: one server for the UI scenarios ----------
let main=null;
async function mainSession(){
  if(main)return main;
  const home=freshHome("home-main"),port=await freePort(),appPort=await freePort();
  const server=await startServer({repoRoot,home,runDir:join(work,"run-main"),uiDist,port,appPort});
  const view=await newPage(server.url);
  await view.page.locator(".thread-row").first().waitFor({state:"visible",timeout:60_000});
  await sleep(3000);
  // The frame rate this headless browser gives rAF with nothing changing (the frame budget the frame-time numbers are read against).
  results.rafBaseline=await view.page.evaluate(()=>new Promise(resolve=>{const gaps=[];let last=performance.now();const start=last;const tick=now=>{gaps.push(now-last);last=now;if(now-start<3000)requestAnimationFrame(tick);else{gaps.sort((a,b)=>a-b);resolve({framesPerSecond:Number((gaps.length/3).toFixed(1)),medianGapMs:Number(gaps[Math.floor(gaps.length/2)].toFixed(2))})}};requestAnimationFrame(tick)}));
  main={server,home,...view};return main;
}

// ---------- 2. opening threads, switching, settings, palette, search ----------
await scenario("open",async()=>{
  const {page,cdp,server}=await mainSession();
  const measureOpen=async(label,name)=>{
    const before=await pageCounters(page),metrics=await cdpMetrics(cdp);await server.snapshot(true);const at=Date.now();
    const ms=await openThread(page,name);await sleep(300);
    const after=await pageCounters(page),metricsAfter=await cdpMetrics(cdp),snap=await server.snapshot(true);
    return {label,ms:Math.round(ms),machineLoad:meter.loadBetween(at,Date.now()),commits:after.commits-before.commits,longTasks:after.longTaskCount-before.longTaskCount,longTaskMs:Math.round(after.longTaskMs-before.longTaskMs),domNodes:after.domNodes,cdp:metricDelta(metrics,metricsAfter),server:{cpuMs:Math.round(snap.cpu.userMs+snap.cpu.systemMs),sqliteOpens:snap.sqlite.opens,sqliteReadKB:Math.round(snap.sqlite.bytesRead/1024),jsonParseKB:Math.round(snap.json.parseChars/1024),wsSendKB:Math.round(snap.ws.sendBytes/1024),eventLoopMaxMs:snap.eventLoop.delayMs.max,spawns:snap.spawns.byCommand,http:snap.http.byPath}};
  };
  const opens={short:[],long:[],big:[]},switches=[];
  for(let rep=0;rep<reps;rep++){
    for(const [key,name] of [["short",PERF_THREADS.short],["long",PERF_THREADS.long],["big",PERF_THREADS.big]]){
      // Open from another thread each time (the stream target is small), so every open is a real switch.
      await openThread(page,PERF_THREADS.stream).catch(()=>{});await sleep(500);
      const row=await measureOpen("open "+key,name);opens[key].push(row);log("open",key,rep,row.ms,"ms load",row.machineLoad);
    }
    // Switching back and forth between the short and the long thread, after both were open once.
    for(const name of [PERF_THREADS.short,PERF_THREADS.long]){await sleep(400);const row=await measureOpen("switch to "+name,name);switches.push(row)}
  }
  // Settings: from a chat to the Settings page (its lazy chunk loads the first time).
  const settings=[];
  for(let rep=0;rep<reps;rep++){
    await openThread(page,PERF_THREADS.short);await sleep(500);
    const t0=await pageNow(page),at=Date.now();
    await page.locator(".sidebar").getByRole("button",{name:"Settings",exact:true}).first().click();
    const ready=await frameWhen(page,{selectors:['input[aria-label="Search settings"]'],timeoutMs:20_000});
    settings.push({ms:Math.round(ready-t0),machineLoad:meter.loadBetween(at,Date.now()),first:rep===0});
    await sleep(600);
  }
  // Command palette: open it, type a thread name, see the match.
  const palette=[];
  await openThread(page,PERF_THREADS.short);await sleep(400);
  for(let rep=0;rep<reps;rep++){
    const t0=await pageNow(page),at=Date.now();
    await page.keyboard.press("Control+K");
    const opened=await frameWhen(page,{selectors:['[data-testid="command-palette"] input'],timeoutMs:10_000});
    const query=filler(Math.floor(fillerCount*0.2)+rep*37);
    const input=page.locator('[data-testid="command-palette"] input').first();
    const typed=await pageNow(page);await input.fill(query);
    const found=await page.evaluate(({query})=>new Promise(resolve=>{const started=performance.now();const check=()=>{const box=document.querySelector('[data-testid="command-palette"]');if(box&&box.textContent.includes(query))return resolve(performance.now());if(performance.now()-started>10000)return resolve(null);requestAnimationFrame(check)};check()}),{query});
    palette.push({openMs:Math.round(opened-t0),queryToResultMs:found!=null?Math.round(found-typed):null,machineLoad:meter.loadBetween(at,Date.now())});
    await page.keyboard.press("Escape");await sleep(400);
  }
  // Sidebar search: a thread name typed into the search box until its row shows.
  const search=[];
  for(let rep=0;rep<reps;rep++){
    const name=filler(Math.floor(fillerCount*0.6)+rep*29),box=page.locator(".search-box input");
    const at=Date.now(),t0=await pageNow(page);await box.fill(name);
    const shown=await page.evaluate(({name})=>new Promise(resolve=>{const started=performance.now();const check=()=>{if(document.querySelector(`.thread-row .thread-main[title="${name}"]`))return resolve(performance.now());if(performance.now()-started>15000)return resolve(null);requestAnimationFrame(check)};check()}),{name});
    search.push({ms:shown!=null?Math.round(shown-t0):null,machineLoad:meter.loadBetween(at,Date.now())});
    await box.fill("");await sleep(400);
  }
  const s=rows=>summarize(rows.map(row=>row.ms),0);
  return {summary:{openShortMs:s(opens.short),openLongMs:s(opens.long),openBigTurnMs:s(opens.big),switchMs:s(switches),settingsMs:summarize(settings.map(row=>row.ms),0),settingsFirstMs:settings[0]?.ms??null,paletteOpenMs:summarize(palette.map(row=>row.openMs),0),paletteQueryMs:summarize(palette.map(row=>row.queryToResultMs),0),sidebarSearchMs:s(search),
    openLongDomNodes:summarize(opens.long.map(row=>row.domNodes),0),openLongServerCpuMs:summarize(opens.long.map(row=>row.server.cpuMs),0),openLongSqliteReadKB:summarize(opens.long.map(row=>row.server.sqliteReadKB),0),openLongWsSendKB:summarize(opens.long.map(row=>row.server.wsSendKB),0),openLongLongTaskMs:summarize(opens.long.map(row=>row.longTaskMs),0),openBigLongTaskMs:summarize(opens.big.map(row=>row.longTaskMs),0)},
    opens,switches,settings,palette,search};
});

// ---------- 3. typing ----------
const TYPED="Please refactor the relay so each streamed chunk updates the live turn in memory, then write the turn once when the call returns; keep the order of items and add a test for it now."
  .padEnd(200,".").slice(0,200);
async function typeRun(page,cdp,server,label){
  const composer=page.getByTestId("composer");await composer.click();await page.keyboard.press("Control+A");await page.keyboard.press("Delete");await sleep(200);
  const before=await pageCounters(page),metrics=await cdpMetrics(cdp);await server.snapshot(true);
  await page.evaluate(()=>{window.__perf.keyLatency=[];window.__perf.recordKeys=true});
  const at=Date.now();const t0=await pageNow(page);
  await page.keyboard.type(TYPED,{delay:20});await sleep(300);
  const latencies=await page.evaluate(()=>{window.__perf.recordKeys=false;return window.__perf.keyLatency.slice()});
  const after=await pageCounters(page),metricsAfter=await cdpMetrics(cdp),snap=await server.snapshot(true);
  const events=(await eventsSince(page,t0)).filter(entry=>/^key|^input|^beforeinput/.test(entry.name));
  const value=await composer.inputValue().catch(()=>"");
  await page.keyboard.press("Control+A");await page.keyboard.press("Delete");
  return {label,machineLoad:meter.loadBetween(at,Date.now()),keys:latencies.length,typedOk:value===TYPED,keyToFrameMs:summarize(latencies,1),slowEvents16:events.length,slowEvents50:events.filter(entry=>entry.duration>=50).length,maxEventMs:events.reduce((max,entry)=>Math.max(max,entry.duration),0),commits:after.commits-before.commits,longTasks:after.longTaskCount-before.longTaskCount,longTaskMs:Math.round(after.longTaskMs-before.longTaskMs),cdp:metricDelta(metrics,metricsAfter),serverHttp:snap.http.byPath,serverCpuMs:Math.round(snap.cpu.userMs+snap.cpu.systemMs)};
}
await scenario("typing",async()=>{
  const {page,cdp,server}=await mainSession();
  await openThread(page,PERF_THREADS.long);await sleep(1500);
  const idle=[];for(let rep=0;rep<reps;rep++){const row=await typeRun(page,cdp,server,"long thread open");idle.push(row);log("typing rep",rep,row.keyToFrameMs.median,row.keyToFrameMs.p90,"load",row.machineLoad)}
  // While a long reply streams in the stream target thread.
  await openThread(page,PERF_THREADS.stream);await sleep(800);
  await server.script([{bytes:60000,chunk:24,intervalMs:20}]);
  const composer=page.getByTestId("composer");await composer.fill("Explain how the composer stays responsive while a reply streams. Do not change any files.");await page.getByTestId("send").click();
  await frameWhen(page,{selectors:[".assistant-answer"],timeoutMs:30_000}).catch(()=>{});await sleep(1500);
  const streaming=[];for(let rep=0;rep<reps;rep++){const stillStreaming=await page.locator('button[aria-label="Stop"]').isVisible().catch(()=>false);const row=await typeRun(page,cdp,server,"while streaming");row.replyStillStreaming=stillStreaming;streaming.push(row);log("typing streaming rep",rep,row.keyToFrameMs.median,row.keyToFrameMs.p90,"streaming",stillStreaming)}
  await page.locator('button[aria-label="Stop"]').waitFor({state:"hidden",timeout:120_000}).catch(()=>{});
  const pool=rows=>summarize(rows.flatMap(row=>row.keyToFrameMs.samples),1);
  return {summary:{idleKeyToFrameMs:pool(idle),streamingKeyToFrameMs:pool(streaming),idleCommitsPerKey:Number((idle.reduce((s,r)=>s+r.commits,0)/idle.reduce((s,r)=>s+r.keys,0)).toFixed(2)),idleLongTaskMs:summarize(idle.map(r=>r.longTaskMs),0),streamingLongTaskMs:summarize(streaming.map(r=>r.longTaskMs),0),idleSlowEvents16:summarize(idle.map(r=>r.slowEvents16),0),streamingSlowEvents16:summarize(streaming.map(r=>r.slowEvents16),0)},idle,streaming};
});

// ---------- 4. scrolling the long thread ----------
await scenario("scroll",async()=>{
  const {page,cdp,server}=await mainSession();
  await openThread(page,PERF_THREADS.long);await sleep(1500);
  const box=await page.locator(".conversation-scroll").boundingBox();
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
  const runs=[];
  for(let rep=0;rep<reps;rep++){
    for(const direction of [-1,1]){
      const tracing=rep===0&&direction===-1;
      if(tracing)await browser.startTracing(page,{categories:TRACE_CATEGORIES});
      const before=await pageCounters(page),metrics=await cdpMetrics(cdp);const at=Date.now();
      await page.evaluate(()=>window.__perf.startFrames());
      for(let step=0;step<60;step++){await page.mouse.wheel(0,direction*400);await sleep(16)}
      await sleep(600);
      const frames=await page.evaluate(()=>window.__perf.stopFrames());
      const after=await pageCounters(page),metricsAfter=await cdpMetrics(cdp);
      let trace=null;if(tracing){const buffer=await browser.stopTracing();if(buffer.length<150*1048576)writeFileSync(join(out,"trace-scroll.json"),buffer);trace=analyzeTrace(buffer)}
      const scrollTop=await page.locator(".conversation-scroll").evaluate(node=>({top:node.scrollTop,height:node.scrollHeight}));
      const row={rep,direction:direction<0?"up":"down",machineLoad:meter.loadBetween(at,Date.now()),frames:frames.length,frameMs:summarize(frames,1),over25ms:frames.filter(ms=>ms>25).length,over50ms:frames.filter(ms=>ms>50).length,droppedFramesEst:frames.reduce((sum,ms)=>sum+Math.max(0,Math.round(ms/16.67)-1),0),longTasks:after.longTaskCount-before.longTaskCount,longTaskMs:Math.round(after.longTaskMs-before.longTaskMs),commits:after.commits-before.commits,domNodesAfter:after.domNodes,cdp:metricDelta(metrics,metricsAfter),scroll:scrollTop,trace};
      runs.push(row);log("scroll",rep,row.direction,"p90 frame",row.frameMs.p90,"over50",row.over50ms,"load",row.machineLoad);
    }
  }
  return {summary:{frameMs:summarize(runs.flatMap(row=>row.frameMs.samples),1),framesOver50msPerRun:summarize(runs.map(row=>row.over50ms),0),droppedFramesPerRun:summarize(runs.map(row=>row.droppedFramesEst),0),longTaskMsPerRun:summarize(runs.map(row=>row.longTaskMs),0),commitsPerRun:summarize(runs.map(row=>row.commits),0)},runs};
});

// ---------- 5. streaming a long reply ----------
await scenario("stream",async()=>{
  const {page,cdp,server}=await mainSession();
  await openThread(page,PERF_THREADS.stream);await sleep(1000);
  // reps 20 KB replies, one 5 KB, one 50 KB, and a last 50 KB one that is CPU-profiled (the renderer's markdown work grows with the reply).
  const plans=[...Array.from({length:reps},()=>({bytes:20000})),{bytes:5000},{bytes:50000},{bytes:50000,profile:true}].map(plan=>({...plan,chunk:24,intervalMs:20}));
  const runs=[];
  for(const [index,plan] of plans.entries()){
    const traceRun=index===0,profileRun=index===1||plan.profile===true,serverProfileRun=index===2;
    await server.script([plan]);
    const before=await pageCounters(page),metrics=await cdpMetrics(cdp),procs=await browserProcesses(browserCdp);await server.snapshot(true);
    if(profileRun){await cdp.send("Profiler.enable");await cdp.send("Profiler.setSamplingInterval",{interval:200});await cdp.send("Profiler.start")}
    if(serverProfileRun)await server.profileStart();
    const at=Date.now();
    if(!profileRun)await page.evaluate(()=>window.__perf.startFrames());
    const t0=await pageNow(page);
    await page.getByTestId("composer").fill("Explain how the relay streams a reply to the app ("+index+", "+plan.bytes+" bytes). Do not change any files.");await page.getByTestId("send").click();
    const first=await frameWhen(page,{selectors:[".assistant-answer"],timeoutMs:60_000}).catch(()=>null);
    let trace=null;
    if(traceRun){await sleep(3000);await browser.startTracing(page,{categories:TRACE_CATEGORIES});await sleep(6000);const buffer=await browser.stopTracing();if(buffer.length<150*1048576)writeFileSync(join(out,"trace-stream.json"),buffer);trace=analyzeTrace(buffer)}
    await page.locator('button[aria-label="Stop"]').waitFor({state:"hidden",timeout:240_000}).catch(()=>{});
    const done=await pageNow(page);await sleep(500);
    const frames=profileRun?[]:await page.evaluate(()=>window.__perf.stopFrames());
    const seconds=(Date.now()-at)/1000;
    const after=await pageCounters(page),metricsAfter=await cdpMetrics(cdp),procsAfter=await browserProcesses(browserCdp),snap=await server.snapshot(true);
    let profile=null,serverProfile=null;
    if(profileRun){const {profile:raw}=await cdp.send("Profiler.stop");writeFileSync(join(out,"renderer-stream-"+plan.bytes+".cpuprofile"),JSON.stringify(raw));profile=attributeProfile(raw,uiDist)}
    if(serverProfileRun)serverProfile=await server.profileStop(join(out,"server-stream.cpuprofile"));
    const sendWindow=main.traffic.finished.filter(row=>row.startedAt>=at-50&&row.startedAt<=at+(first!=null?first-t0:5000)&&pathOf(row.url).startsWith("/api/")).map(row=>({request:row.method+" "+pathOf(row.url),startMs:row.startedAt-at,ms:row.ms}));
    const tasks=await longTasksSince(page,t0),span=Math.max(1,done-t0),third=index=>tasks.filter(task=>task.start>=t0+span*index/3&&task.start<t0+span*(index+1)/3).reduce((sum,task)=>sum+task.duration,0);
    const deltas=snap.fetch.fake.filter(entry=>!entry.gate).reduce((sum,entry)=>sum+Math.ceil(entry.replyBytes/Math.max(1,entry.chunk)),0);
    const row={index,plan,sendToFirstTextRequests:sendWindow,machineLoad:meter.loadBetween(at,Date.now()),firstTextMs:first!=null?Math.round(first-t0):null,totalMs:Math.round(done-t0),deltas,frames:frames.length,fps:Number((frames.length/Math.max(0.001,(done-t0)/1000)).toFixed(1)),frameMs:summarize(frames,1),over50ms:frames.filter(ms=>ms>50).length,droppedFramesEst:frames.reduce((sum,ms)=>sum+Math.max(0,Math.round(ms/16.67)-1),0),
      longTasks:tasks.length,longTaskMs:Math.round(tasks.reduce((sum,task)=>sum+task.duration,0)),longTaskMsByThird:[0,1,2].map(index=>Math.round(third(index))),commits:after.commits-before.commits,commitsPerSecond:Number(((after.commits-before.commits)/seconds).toFixed(1)),domNodesAfter:after.domNodes,cdp:metricDelta(metrics,metricsAfter),
      chromiumCpu:processCpuDelta(procs,procsAfter,seconds),server:compactSnapshot(snap),serverPerDelta:deltas?{sqliteOpens:Number((snap.sqlite.opens/deltas).toFixed(2)),jsonParseChars:Math.round(snap.json.parseChars/deltas),wsSends:Number((snap.ws.sends/deltas).toFixed(2))}:null,trace,rendererProfile:profile,serverProfile};
    runs.push(row);log("stream",index,plan.bytes,"B: frames",row.frames,"fps",row.fps,"longTaskMs",row.longTaskMs,"thirds",row.longTaskMsByThird.join("/"),"server cpu%",snap.cpu.corePercent,"load",row.machineLoad);
    await sleep(1500);
  }
  const main20=runs.filter(row=>row.plan.bytes===20000&&!row.plan.profile&&row.frames>0);
  return {summary:{reply20k:{fps:summarize(main20.map(r=>r.fps),1),longTaskMs:summarize(main20.map(r=>r.longTaskMs),0),commitsPerSecond:summarize(main20.map(r=>r.commitsPerSecond),1),firstTextMs:summarize(main20.map(r=>r.firstTextMs),0),rendererCorePercent:summarize(main20.map(r=>r.chromiumCpu?.renderer?.corePercent),1),gpuCorePercent:summarize(main20.map(r=>r.chromiumCpu?.GPU?.corePercent??r.chromiumCpu?.gpu?.corePercent),1),serverCorePercent:summarize(main20.map(r=>r.server.cpu.corePercent),1),serverEventLoopP99Ms:summarize(main20.map(r=>r.server.eventLoop.delayMs.p99),1),scriptMs:summarize(main20.map(r=>r.cdp.ScriptDuration),0),layoutCount:summarize(main20.map(r=>r.cdp.LayoutCount),0)},bySize:runs.map(r=>({bytes:r.plan.bytes,longTaskMs:r.longTaskMs,longTaskMsByThird:r.longTaskMsByThird,fps:r.fps,scriptMs:r.cdp.ScriptDuration}))},runs};
});

// ---------- 6. idle ----------
async function idleWindow(label,{page,cdp,server},seconds){
  const windows=[],slice=30,count=Math.max(1,Math.round(seconds/slice));
  await page.mouse.move(5,5);await sleep(3000);
  const startTable=await processTable(),procs=await browserProcesses(browserCdp),metrics=await cdpMetrics(cdp),pageBefore=await pageCounters(page);await server.snapshot(true);
  const animations=await page.evaluate(()=>document.getAnimations().filter(animation=>animation.playState==="running").map(animation=>{const target=animation.effect?.target;return {name:animation.animationName||animation.constructor.name,iterations:animation.effect?.getTiming?.().iterations,target:target?((target.className&&String(target.className).slice(0,60))||target.tagName):null}}));
  const homeBefore=dirBytes(main.home),startedAt=Date.now();
  const gpuPids=Array.isArray(procs)?procs.map(item=>item.pid):[];
  let gpu=null;
  for(let i=0;i<count;i++){
    const at=Date.now(),before=await pageCounters(page);
    if(i===1)gpu=await gpuUtilization([...gpuPids,server.pid],{samples:10});
    if(i===2){await browser.startTracing(page,{categories:TRACE_CATEGORIES});await sleep(10_000);const buffer=await browser.stopTracing();if(buffer.length<150*1048576)writeFileSync(join(out,"trace-idle-"+label+".json"),buffer);windows.trace=analyzeTrace(buffer)}
    const remaining=slice*1000-(Date.now()-at);if(remaining>0)await sleep(remaining);
    const after=await pageCounters(page),snap=await server.snapshot(true),end=Date.now();
    const requests=main.traffic.requests.filter(row=>row.at>=at&&row.at<end),frames=main.traffic.frames.filter(row=>row.at>=at&&row.at<end);
    const fired=Object.fromEntries(Object.entries(after.timersFired).map(([key,value])=>[key,value-(before.timersFired[key]||0)]).filter(([,value])=>value>0));
    const perMinute=value=>Number((value*60000/(end-at)).toFixed(1));
    windows.push({window:i,machineLoad:meter.loadBetween(at,end),requestsPerMin:perMinute(requests.length),requestsByPath:countBy(requests,row=>row.method+" "+pathOf(row.url)),wsFramesPerMin:perMinute(frames.length),pageTimersFiredPerMin:perMinute(Object.values(fired).reduce((s,v)=>s+v,0)),pageTimersFired:fired,commits:after.commits-before.commits,longTasks:after.longTaskCount-before.longTaskCount,
      serverSpawnsPerMin:perMinute(snap.spawns.total),serverSpawnsByCommand:snap.spawns.byCommand,serverTimersFiredPerMin:perMinute(Object.values(snap.timers.fired).reduce((s,v)=>s+v,0)),serverTimersFired:snap.timers.fired,serverCpuCorePercent:snap.cpu.corePercent,serverEventLoopUtilization:snap.eventLoop.utilization,serverSqliteOpensPerMin:perMinute(snap.sqlite.opens),serverSqliteWriteKBPerMin:perMinute(snap.sqlite.bytesWritten/1024),serverFsWriteKBPerMin:perMinute(snap.fs.writeBytes/1024),serverFsWriteTargets:snap.fs.byWriteTarget,serverHttpByPath:snap.http.byPath,serverFetchBlocked:snap.fetch.blocked,serverFetchByOrigin:snap.fetch.byOrigin});
    log("idle",label,"window",i,"req/min",windows.at(-1).requestsPerMin,"git spawns/min",windows.at(-1).serverSpawnsPerMin,"server cpu%",snap.cpu.corePercent,"load",windows.at(-1).machineLoad);
  }
  const elapsed=(Date.now()-startedAt)/1000,endTable=await processTable(),procsAfter=await browserProcesses(browserCdp),metricsAfter=await cdpMetrics(cdp),pageAfter=await pageCounters(page);
  const serverRows=descendants(endTable,[server.pid]),pids=new Set(serverRows.map(row=>row.pid));
  const browserRoots=Array.isArray(procsAfter)?procsAfter.map(item=>item.pid):[];for(const pid of browserRoots)pids.add(pid);
  const footprint=footprintDelta(startTable,endTable,pids,{seconds:elapsed});
  const pick=key=>summarize(windows.map(row=>row[key]),1);
  return {label,seconds:Math.round(elapsed),animationsRunning:animations,trace:windows.trace||null,gpuUtilizationPercentByPid:gpu,serverPid:server.pid,
    chromiumCpu:processCpuDelta(procs,procsAfter,elapsed),processes:footprint,processesByRole:groupByRole(footprint),cdp:metricDelta(metrics,metricsAfter),commits:pageAfter.commits-pageBefore.commits,homeBytesDelta:dirBytes(main.home)-homeBefore,
    summary:{requestsPerMin:pick("requestsPerMin"),wsFramesPerMin:pick("wsFramesPerMin"),pageTimersFiredPerMin:pick("pageTimersFiredPerMin"),serverSpawnsPerMin:pick("serverSpawnsPerMin"),serverTimersFiredPerMin:pick("serverTimersFiredPerMin"),serverCpuCorePercent:pick("serverCpuCorePercent"),serverSqliteOpensPerMin:pick("serverSqliteOpensPerMin"),serverSqliteWriteKBPerMin:pick("serverSqliteWriteKBPerMin"),serverFsWriteKBPerMin:pick("serverFsWriteKBPerMin"),machineLoad:pick("machineLoad")},windows};
}
await scenario("idle",async()=>{
  const session=await mainSession();
  await openThread(session.page,PERF_THREADS.short);await sleep(1500);
  const thread=await idleWindow("thread",session,idleSeconds);
  await session.page.locator(".sidebar").getByRole("button",{name:"Settings",exact:true}).first().click();
  await frameWhen(session.page,{selectors:['input[aria-label="Search settings"]'],timeoutMs:20_000});await sleep(1500);
  const settings=await idleWindow("settings",session,idleSeconds);
  await openThread(session.page,PERF_THREADS.short);
  return {thread,settings};
});

// ---------- 7. memory over a session ----------
await scenario("memory",async()=>{
  const {page,cdp,server}=await mainSession();
  await openThread(page,PERF_THREADS.short);await sleep(1500);
  const point=async label=>{await server.gc();const snap=await server.snapshot(false),tree=await serverTree(server),heap=await heapAndDom(cdp);return {label,at:new Date().toISOString(),...heap,serverRssMB:snap.memory.rssMB,serverHeapUsedMB:snap.memory.heapUsedMB,serverProcesses:tree.rows.length,serverTreeWorkingSetMB:Number((tree.rows.reduce((s,r)=>s+r.workingSet,0)/1048576).toFixed(1)),children:countBy(tree.rows.filter(row=>row.pid!==server.pid),row=>processRole(row))}};
  const points=[await point("start (short thread)")];const openMs=[];
  for(let i=0;i<50;i++){
    const name=filler(Math.floor(fillerCount*0.8)-i*7);
    try{openMs.push(Math.round(await openThread(page,name,{timeoutMs:30_000})))}catch(error){openMs.push(null);results.errors.push({scenario:"memory",thread:name,error:String(error.message).slice(0,300)})}
    if((i+1)%10===0){points.push(await point("after "+(i+1)+" threads"));log("memory",points.at(-1).label,"heap",points.at(-1).heapUsedMB,"dom",points.at(-1).domNodes,"server rss",points.at(-1).serverRssMB,"procs",points.at(-1).serverProcesses)}
  }
  await openThread(page,PERF_THREADS.short);await sleep(30_000);
  points.push(await point("back on the short thread, 30 s idle"));
  return {points,openMs:summarize(openMs,0),heapGrowthMB:Number((points.at(-1).heapUsedMB-points[0].heapUsedMB).toFixed(2)),domGrowth:(points.at(-1).domNodes||0)-(points[0].domNodes||0),listenerGrowth:(points.at(-1).jsEventListeners||0)-(points[0].jsEventListeners||0),serverRssGrowthMB:Number((points.at(-1).serverRssMB-points[0].serverRssMB).toFixed(1)),serverProcessGrowth:points.at(-1).serverProcesses-points[0].serverProcesses};
});

// ---------- 8. harness processes ----------
await scenario("harness",async()=>{
  const {page,server}=await mainSession();
  const before=await serverTree(server),report={atStart:treeSummary(before.rows),externals:[]};
  // The relay serves the active harness's threads, so each external harness is made active (as Settings does), the app reloads and
  // its seeded thread opens. Nothing is sent to it.
  const setRuntime=async runtime=>{try{const response=await fetch(server.url+"/api/settings",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({agentRuntime:runtime,agentRuntimeInstanceId:runtime+"-default"})});return {status:response.status,body:(await response.text()).slice(0,200)}}catch(error){return {error:String(error.message)}}};
  for(const runtime of externalRuntimes){
    const name="Perf "+runtime+" thread",prior=new Set((await serverTree(server)).rows.map(row=>row.pid));await server.snapshot(true);
    const switched=await setRuntime(runtime);
    await page.goto(server.url,{waitUntil:"domcontentloaded"});
    let openMs=null,error=null;
    try{
      const row=page.locator(`.thread-row .thread-main[title="${name}"]`).first();await row.waitFor({state:"visible",timeout:30_000});
      const t0=await pageNow(page);await row.click();
      openMs=Math.round((await frameWhen(page,{text:marker(name),timeoutMs:45_000}))-t0);
    }catch(caught){error=String(caught.message).split(String.fromCharCode(10))[0].slice(0,300)}
    await sleep(10_000);
    const tree=await serverTree(server),snap=await server.snapshot(true);
    report.externals.push({runtime,switched,openMs,error,spawned:snap.spawns.byCommand,newProcesses:treeSummary(tree.rows.filter(row=>!prior.has(row.pid)))});
    log("harness",runtime,"switch",switched.status,"open",openMs,"new processes",report.externals.at(-1).newProcesses.length,error||"");
  }
  // Back on Native: what is still running from the external sessions, and what it costs at idle.
  report.switchBack=await setRuntime("native");await page.goto(server.url,{waitUntil:"domcontentloaded"});
  await openThread(page,PERF_THREADS.short).catch(()=>{});
  const t0=await processTable();await sleep(60_000);const t1=await processTable();
  const rows=descendants(t1,[server.pid]);
  report.afterLeavingIdle60s=footprintDelta(t0,t1,new Set(rows.map(row=>row.pid)),{seconds:60}).sort((a,b)=>b.workingSetMB-a.workingSetMB);
  report.afterLeavingByRole=groupByRole(report.afterLeavingIdle60s);
  return report;
});

if(main){await main.context.close().catch(()=>{});await main.server.stop()}
if(browser)await browser.close();
meter.stop();
results.finishedAt=new Date().toISOString();results.freeMemGBAtEnd=Number((freemem()/2**30).toFixed(1));save();
log("done",join(out,"results.json"),results.errors.length?results.errors.length+" errors":"");
process.exit(0);
