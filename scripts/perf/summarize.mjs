#!/usr/bin/env node
// Markdown tables from a perf run: node scripts/perf/summarize.mjs <out>/results.json [<electron.json>] > summary.md
// Every timing row is "median / p90 (n)" with the machine's CPU load beside it.
import { readFileSync, existsSync } from "node:fs";

const [file,electronFile]=process.argv.slice(2);
const r=JSON.parse(readFileSync(file,"utf8")),e=electronFile&&existsSync(electronFile)?JSON.parse(readFileSync(electronFile,"utf8")):null;
const s=r.scenarios||{};
const mp=x=>x&&x.n?`${x.median} / ${x.p90} (n=${x.n})`:"n/a";
const lines=[];const out=(...parts)=>lines.push(parts.join(""));
const table=(head,rows)=>{out("| "+head.join(" | ")+" |");out("|"+head.map(()=>" --- |").join(""));for(const row of rows)out("| "+row.map(cell=>cell==null?"":String(cell)).join(" | ")+" |");out("")};

out(`Run ${r.startedAt} -> ${r.finishedAt||"(unfinished)"}; host ${r.host?.cpuModel} x${r.host?.cpus}, ${r.host?.totalMemGB} GB, Node ${r.host?.node}; browser ${r.browser?.version||"?"} (${r.browser?.gpu||"?"}); rAF baseline ${r.rafBaseline?.framesPerSecond??"?"} fps.`);
out(`Seed: ${r.seed?.threadCount} threads; long thread ${r.seed?.sizes?.["Perf long thread"]?.turns} turns / ${((r.seed?.sizes?.["Perf long thread"]?.historyBytes||0)/1048576).toFixed(2)} MB; big turn ${r.seed?.sizes?.["Perf big turn"]?.items} items / ${((r.seed?.sizes?.["Perf big turn"]?.historyBytes||0)/1048576).toFixed(2)} MB; external harness threads: ${(r.seed?.externalRuntimes||[]).join(", ")||"none"}.`);
if(r.errors?.length)out(`Errors: ${r.errors.length} (${r.errors.map(err=>err.scenario+": "+String(err.error).split("\n")[0].slice(0,120)).join("; ")})`);
out("");

if(s.bundle){
  const b=s.bundle;out("### Bundle");
  table(["Set","Files","Raw KB","gzip KB","brotli KB"],[["Initial JS",b.initialJs.files,b.initialJs.rawKB,b.initialJs.gzipKB,b.initialJs.brotliKB],["Initial CSS",b.initialCss.files,b.initialCss.rawKB,b.initialCss.gzipKB,b.initialCss.brotliKB],["Lazy JS",b.lazyJs.files,b.lazyJs.rawKB,b.lazyJs.gzipKB,b.lazyJs.brotliKB],["Fonts",b.fonts.files,b.fonts.rawKB,b.fonts.gzipKB,b.fonts.brotliKB]]);
  out("Initial JS by package (rendered KB): "+Object.entries(b.initialByPackageKB).slice(0,14).map(([k,v])=>k+" "+v).join(", "));out("");
}
if(s.micro){
  const m=s.micro;out("### Server micro-benchmarks");
  table(["Call","ms median / p90 (n)","sqlite opens/call","sqlite KB read/call","JSON KB parsed/call","machine load %"],[
    ...m.storeGetPerChunk.map(row=>[row.label+` (${row.turns} turns)`,mp(row.ms),row.perCall.sqliteOpens,Math.round(row.perCall.sqliteBytesRead/1024),Math.round(row.perCall.jsonParseChars/1024),row.machineLoadPercent]),
    [m.addItemPerUpdate.label,mp(m.addItemPerUpdate.ms),m.addItemPerUpdate.perCall.sqliteOpens,Math.round(m.addItemPerUpdate.perCall.sqliteBytesRead/1024),Math.round(m.addItemPerUpdate.perCall.jsonParseChars/1024),m.addItemPerUpdate.machineLoadPercent],
    ...m.codexPerMessage.map(row=>[row.label,mp(row.ms),row.perCall.sqliteOpens,Math.round(row.perCall.sqliteBytesRead/1024),Math.round(row.perCall.jsonParseChars/1024),row.machineLoadPercent]),
    ...m.stateCalls.map(row=>[row.label,mp(row.ms),row.perCall.sqliteOpens,Math.round(row.perCall.sqliteBytesRead/1024),Math.round(row.perCall.jsonParseChars/1024),row.machineLoadPercent]),
    [m.gitInfo.label+` (${m.gitInfo.perCall.spawns.median} git processes)`,mp(m.gitInfo.ms),"","","",m.gitInfo.machineLoadPercent],
    ...(m.probes||[]).map(row=>[row.label+` (${row.perCall.spawns.median} processes: ${row.perCall.spawnKeys.join(", ")})`,mp(row.ms),"","","",row.machineLoadPercent]),
  ]);
  out(`addItem: WAL grew ${m.addItemPerUpdate.walGrowthKB} KB over 30 updates; the turn was ${Math.round(m.addItemPerUpdate.turnBytes/1024)} KB. Meta sizes: ${JSON.stringify(m.metaBytes)}.`);out("");
}
if(s.startup){
  const u=s.startup.summary;out("### Startup (standalone server + headless page)");
  table(["Measure","median / p90 (n)"],[["Server spawn to listening (ms)",mp(u.serverListenMs)],["First contentful paint (ms)",mp(u.fcpMs)],["Sidebar rows shown (ms)",mp(u.sidebarReadyMs)],["Composer usable (ms)",mp(u.composerReadyMs)],["DOMContentLoaded (ms)",mp(u.domContentLoadedMs)],["Requests in first 4 s",mp(u.requestsIn4s)],["/api requests in first 4 s",mp(u.apiRequestsIn4s)],["KB transferred in first 4 s",mp(u.bytesIn4sKB)],["Server CPU ms to listening",mp(u.serverStartupCpuMs)],["Server RSS after load (MB)",mp(u.serverRssAfterLoadMB)],["Machine load %",mp(u.machineLoad)]]);
  const first=s.startup.samples[0];if(first?.apiCalls)out("First load /api calls: "+Object.entries(first.apiCalls).map(([k,v])=>k+" x"+v).join(", "));
  out("Server children at startup: "+(first?.serverChildren||[]).map(row=>`${row.name} ${row.workingSetMB} MB WS`).join(", "));
  out("Later loads /api calls: "+s.startup.samples.slice(1).map(sample=>sample.apiRequestsIn4s).join(", "));out("");
}
if(s.open){
  const o=s.open.summary;out("### Opening and switching");
  table(["Action","ms median / p90 (n)"],[["Open short thread",mp(o.openShortMs)],["Open 1000-turn thread",mp(o.openLongMs)],["Open 600-item turn",mp(o.openBigTurnMs)],["Switch short <-> long",mp(o.switchMs)],["Open Settings (first: "+o.settingsFirstMs+" ms)",mp(o.settingsMs)],["Open palette",mp(o.paletteOpenMs)],["Palette query to result",mp(o.paletteQueryMs)],["Sidebar search to row",mp(o.sidebarSearchMs)]]);
  out(`Long-thread open: DOM nodes ${mp(o.openLongDomNodes)}, server CPU ms ${mp(o.openLongServerCpuMs)}, sqlite KB read ${mp(o.openLongSqliteReadKB)}, WS KB sent ${mp(o.openLongWsSendKB)}, renderer long-task ms ${mp(o.openLongLongTaskMs)}; big-turn long-task ms ${mp(o.openBigLongTaskMs)}.`);out("");
}
if(s.typing){
  const t=s.typing.summary;out("### Typing 200 characters");
  table(["Condition","key-to-frame ms median / p90 (n keys)","long-task ms per 200 keys","event-timing entries >=16 ms per 200 keys"],[["Long thread open",mp(t.idleKeyToFrameMs),mp(t.idleLongTaskMs),mp(t.idleSlowEvents16)],["While a reply streams",mp(t.streamingKeyToFrameMs),mp(t.streamingLongTaskMs),mp(t.streamingSlowEvents16)]]);
  out(`React commits per key (idle): ${t.idleCommitsPerKey}. Loads: ${s.typing.idle.map(row=>row.machineLoad).join(", ")} / ${s.typing.streaming.map(row=>row.machineLoad).join(", ")}.`);out("");
}
if(s.scroll){
  const c=s.scroll.summary;out("### Scrolling the 1000-turn thread (60 wheel steps per run)");
  table(["Measure","median / p90 (n)"],[["Frame time ms (all frames)",mp(c.frameMs)],["Frames >50 ms per run",mp(c.framesOver50msPerRun)],["Dropped frames per run (est.)",mp(c.droppedFramesPerRun)],["Long-task ms per run",mp(c.longTaskMsPerRun)],["React commits per run",mp(c.commitsPerRun)]]);
  if(s.scroll.runs?.[0]?.trace)out("Trace (first run): "+JSON.stringify(s.scroll.runs[0].trace));out("");
}
if(s.stream){
  const st=s.stream.summary.reply20k;out("### Streaming a Native reply (24 chars every 20 ms)");
  table(["Measure (20 KB reply)","median / p90 (n)"],[["UI frames per second",mp(st.fps)],["Renderer long-task ms",mp(st.longTaskMs)],["React commits per second",mp(st.commitsPerSecond)],["Send to first text ms",mp(st.firstTextMs)],["Renderer CPU % of a core",mp(st.rendererCorePercent)],["GPU process CPU % (SwiftShader)",mp(st.gpuCorePercent)],["Server CPU % of a core",mp(st.serverCorePercent)],["Server event-loop p99 ms",mp(st.serverEventLoopP99Ms)],["Renderer script ms",mp(st.scriptMs)],["Layouts",mp(st.layoutCount)]]);
  table(["Reply bytes","long-task ms (thirds)","fps","script ms"],s.stream.summary.bySize.map(row=>[row.bytes,row.longTaskMs+" ("+row.longTaskMsByThird.join(" / ")+")",row.fps,row.scriptMs]));
  const prof=s.stream.runs.find(run=>run.rendererProfile)?.rendererProfile;if(prof)out("Renderer profile (one 20 KB run) self time by source: "+prof.bySource.slice(0,12).map(row=>row.name+" "+row.percent+"%").join(", "));
  const sp=s.stream.runs.find(run=>run.serverProfile)?.serverProfile;if(sp)out("Server profile by file: "+sp.byFile.slice(0,10).map(row=>row.name+" "+row.ms+" ms").join(", "));
  const one=s.stream.runs[0];if(one)out("Server work in one 20 KB turn: "+JSON.stringify({spawns:one.server.spawns,http:one.server.http.byPath,sqliteOpens:one.server.sqlite.opens,jsonParseKB:one.server.json.parseKB,wsSends:one.server.ws}));
  if(one?.trace)out("Trace (6 s mid-stream): "+JSON.stringify(one.trace));out("");
}
if(s.idle){
  out("### Idle");
  for(const key of ["thread","settings"]){
    const i=s.idle[key];if(!i)continue;const u=i.summary;
    out(`**${key==="thread"?"Project thread open":"Settings page"}** (${i.seconds} s; per-30 s windows; machine load ${mp(u.machineLoad)})`);out("");
    table(["Rate","median / p90 (n windows)"],[["Page requests per minute",mp(u.requestsPerMin)],["WebSocket frames per minute",mp(u.wsFramesPerMin)],["Page timers fired per minute",mp(u.pageTimersFiredPerMin)],["Server process spawns per minute",mp(u.serverSpawnsPerMin)],["Server timers fired per minute",mp(u.serverTimersFiredPerMin)],["Server CPU % of a core",mp(u.serverCpuCorePercent)],["Server sqlite opens per minute",mp(u.serverSqliteOpensPerMin)],["Server sqlite KB written per minute",mp(u.serverSqliteWriteKBPerMin)],["Server file KB written per minute",mp(u.serverFsWriteKBPerMin)]]);
    out("Requests by path (one window): "+JSON.stringify(i.windows?.[1]?.requestsByPath||{}));
    out("Spawns by command (one window): "+JSON.stringify(i.windows?.[1]?.serverSpawnsByCommand||{}));
    out("Per process type (CPU % of a core over the window, working set MB): "+Object.entries(i.processesByRole||{}).map(([role,g])=>`${role} x${g.count}: ${g.corePercent}% / ${g.workingSetMB} MB`).join("; "));
    out("Chromium CPU by type: "+JSON.stringify(i.chromiumCpu));
    out("Running animations: "+JSON.stringify(i.animationsRunning));
    if(i.trace)out("Idle trace (10 s): "+JSON.stringify(i.trace));
    out("GPU engine % by pid: "+JSON.stringify(i.gpuUtilizationPercentByPid)+"; Trebell home grew "+i.homeBytesDelta+" bytes.");out("");
  }
}
if(s.memory){
  const m=s.memory;out("### Memory over 50 thread opens");
  table(["Point","JS heap MB","DOM nodes","listeners","server RSS MB","server heap MB","server processes","server tree WS MB"],m.points.map(p=>[p.label,p.heapUsedMB,p.domNodes,p.jsEventListeners,p.serverRssMB,p.serverHeapUsedMB,p.serverProcesses,p.serverTreeWorkingSetMB]));
  out(`Open time over the 50: ${mp(m.openMs)}. Growth start->end: heap ${m.heapGrowthMB} MB, DOM ${m.domGrowth}, listeners ${m.listenerGrowth}, server RSS ${m.serverRssGrowthMB} MB, server processes ${m.serverProcessGrowth}.`);out("");
}
if(s.harness){
  const h=s.harness;out("### Harness processes");
  out("At start under the server: "+h.atStart.map(row=>`${row.name}(${row.role}) ${row.workingSetMB} MB`).join(", "));
  for(const x of h.externals)out(`- ${x.runtime}: open ${x.openMs??"failed"} ms${x.error?" ("+x.error.slice(0,140)+")":""}; spawned ${JSON.stringify(x.spawned)}; new processes: ${x.newProcesses.map(row=>`${row.name} ${row.workingSetMB} MB`).join(", ")||"none"}`);
  out("After leaving them, 60 s idle, by type: "+Object.entries(h.afterLeavingByRole||{}).map(([role,g])=>`${role} x${g.count}: ${g.corePercent}% / ${g.workingSetMB} MB`).join("; "));out("");
}
if(e){
  out("### Electron (hidden window, desktop/main.mjs as shipped)");
  out(`Startup: window loaded ${mp(e.startupSummary?.windowLoadedMs)} ms, composer ready ${mp(e.startupSummary?.composerReadyMs)} ms. Window visibility: ${JSON.stringify(e.visibility)}.`);
  for(const key of ["idleHome","idleThread"]){const i=e[key];if(!i)continue;out(`${key}: total WS ${i.totalWorkingSetMB} MB, private ${i.totalPrivateMB} MB; main event loop ${JSON.stringify(i.mainEventLoopMs)}; by role: `+Object.entries(i.byRole).map(([role,g])=>`${role} x${g.count}: ${g.corePercent}% / ${g.workingSetMB} MB`).join("; "));out("app.getAppMetrics: "+i.appMetrics.map(m=>`${m.type}${m.serviceName?"/"+m.serviceName:""} ${m.cpuPercent}% ${m.workingSetMB} MB`).join(", "))}
  if(e.openLong)out(`Opening the 1000-turn thread: ${mp(e.openLong.ms)} ms; main-process event-loop max delay ${mp(e.openLong.mainLoopMaxMs)} ms.`);
  if(e.errors?.length)out("Electron errors: "+e.errors.map(x=>x.split("\n")[0]).join("; "));
}
console.log(lines.join("\n"));
