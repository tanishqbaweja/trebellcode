// Headless Chromium for the perf run (Playwright, no window) and the page-side instruments: React commits through the DevTools
// hook, long tasks, event timing, paint timings, rAF frame times, timers created and fired, key-to-frame latency. CDP gives
// Performance.getMetrics, DOM counters, heap use, per-process CPU (SystemInfo.getProcessInfo), traces and CPU profiles.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { SourceMapConsumer } from "source-map-js";

export async function launchBrowser(){
  // Playwright's headless Chromium shell: it ticks frames at 60 Hz as a display does. (The full build's new headless mode runs rAF
  // unthrottled here, 220+ frames a second, which inflates every CPU and frame number.) The shell composites with SwiftShader, so its
  // GPU-process CPU is a software-rendering upper bound; frame counts are the load-independent GPU signal. External network is off.
  return chromium.launch({headless:true,proxy:{server:"http://127.0.0.1:9",bypass:"127.0.0.1,localhost"},args:["--disable-features=Translate,MediaRouter","--no-first-run"]});
}

// Runs in the page before the app: every counter lives on window.__perf.
export function pageInstruments(){
  const perf=window.__perf={commits:0,commitAt:[],longTasks:[],events:[],paints:{},lcp:null,frames:null,timers:{created:{},fired:{}},keyLatency:[],marks:{}};
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__={renderers:new Map(),supportsFiber:true,isDisabled:false,checkDCE(){},inject(renderer){const id=this.renderers.size+1;this.renderers.set(id,renderer);return id},onScheduleFiberRoot(){},onCommitFiberRoot(){perf.commits++;if(perf.commitAt.length<200000)perf.commitAt.push(performance.now())},onCommitFiberUnmount(){},onPostCommitFiberRoot(){}};
  try{new PerformanceObserver(list=>{for(const entry of list.getEntries())perf.longTasks.push({start:entry.startTime,duration:entry.duration})}).observe({type:"longtask",buffered:true})}catch{}
  try{new PerformanceObserver(list=>{for(const entry of list.getEntries())perf.events.push({name:entry.name,start:entry.startTime,duration:entry.duration,processingStart:entry.processingStart,processingEnd:entry.processingEnd,interactionId:entry.interactionId||0})}).observe({type:"event",buffered:true,durationThreshold:16})}catch{}
  try{new PerformanceObserver(list=>{for(const entry of list.getEntries())perf.paints[entry.name]=entry.startTime}).observe({type:"paint",buffered:true})}catch{}
  try{new PerformanceObserver(list=>{for(const entry of list.getEntries())perf.lcp=entry.startTime}).observe({type:"largest-contentful-paint",buffered:true})}catch{}
  const realTimeout=window.setTimeout,realInterval=window.setInterval;
  const bump=(map,key)=>{map[key]=(map[key]||0)+1};
  window.setTimeout=function(callback,delay,...args){const key="timeout:"+(Number(delay)||0);bump(perf.timers.created,key);if(typeof callback!=="function")return realTimeout(callback,delay,...args);return realTimeout(function(...inner){bump(perf.timers.fired,key);return callback.apply(this,inner)},delay,...args)};
  window.setInterval=function(callback,delay,...args){const key="interval:"+(Number(delay)||0);bump(perf.timers.created,key);if(typeof callback!=="function")return realInterval(callback,delay,...args);return realInterval(function(...inner){bump(perf.timers.fired,key);return callback.apply(this,inner)},delay,...args)};
  // Frame times: rAF deltas while recording.
  perf.startFrames=()=>{perf.frames=[];let last=performance.now();const tick=now=>{if(!perf.frames)return;perf.frames.push(now-last);last=now;requestAnimationFrame(tick)};requestAnimationFrame(tick)};
  perf.stopFrames=()=>{const frames=perf.frames||[];perf.frames=null;return frames};
  // Key-to-frame latency: from the keydown's timestamp to the end of the first frame after it (rAF, then a task after the paint).
  window.addEventListener("keydown",event=>{if(!perf.recordKeys)return;const start=event.timeStamp;requestAnimationFrame(()=>{const channel=new MessageChannel();channel.port1.onmessage=()=>perf.keyLatency.push(performance.now()-start);channel.port2.postMessage(0)})},true);
}

// Counters a scenario reads before and after a step.
export async function pageCounters(page){
  return page.evaluate(()=>{const perf=window.__perf;return {commits:perf.commits,longTaskCount:perf.longTasks.length,longTaskMs:perf.longTasks.reduce((sum,task)=>sum+task.duration,0),events:perf.events.length,timersCreated:{...perf.timers.created},timersFired:{...perf.timers.fired},now:performance.now(),domNodes:document.getElementsByTagName("*").length}});
}
export async function longTasksSince(page,since){return page.evaluate(start=>window.__perf.longTasks.filter(task=>task.start>=start),since)}
export async function eventsSince(page,since){return page.evaluate(start=>window.__perf.events.filter(entry=>entry.start>=start),since)}
export async function commitsBetween(page,from,to){return page.evaluate(([a,b])=>window.__perf.commitAt.filter(at=>at>=a&&at<=b).length,[from,to])}

export async function cdpMetrics(cdp){
  const {metrics}=await cdp.send("Performance.getMetrics");return Object.fromEntries(metrics.map(metric=>[metric.name,metric.value]));
}
export function metricDelta(before,after,keys=["TaskDuration","ScriptDuration","LayoutDuration","RecalcStyleDuration","LayoutCount","RecalcStyleCount","JSHeapUsedSize","Nodes","JSEventListeners","Documents","Frames"]){
  const out={};for(const key of keys)if(key in after)out[key]=key.endsWith("Duration")?Number(((after[key]-(before[key]||0))*1000).toFixed(1)):Number((after[key]-(before[key]||0)).toFixed(0));return out;
}
export async function heapAndDom(cdp,{gc=true}={}){
  if(gc)await cdp.send("HeapProfiler.collectGarbage").catch(()=>{});
  const heap=await cdp.send("Runtime.getHeapUsage"),dom=await cdp.send("Memory.getDOMCounters").catch(()=>({}));
  return {heapUsedMB:Number((heap.usedSize/1048576).toFixed(2)),heapTotalMB:Number((heap.totalSize/1048576).toFixed(2)),domNodes:dom.nodes??null,documents:dom.documents??null,jsEventListeners:dom.jsEventListeners??null};
}
// CPU seconds per Chromium process from the browser target (type, pid, cumulative cpuTime).
export async function browserProcesses(browserCdp){
  try{const {processInfo}=await browserCdp.send("SystemInfo.getProcessInfo");return processInfo.map(item=>({type:item.type,pid:item.id,cpuTime:item.cpuTime}))}catch(error){return {error:String(error.message||error)}}
}
export function processCpuDelta(before,after,seconds){
  if(!Array.isArray(before)||!Array.isArray(after))return null;const prior=new Map(before.map(item=>[item.pid,item.cpuTime])),out={};
  for(const item of after){const used=item.cpuTime-(prior.get(item.pid)??0);out[item.type]=(out[item.type]||0)+used}
  return Object.fromEntries(Object.entries(out).map(([type,used])=>[type,{cpuSeconds:Number(used.toFixed(3)),corePercent:Number((100*used/Math.max(0.001,seconds)).toFixed(2))}]));
}

// Few categories, short windows: frame events and the main-thread timeline (a 20 s trace with cc/viz/gpu/toplevel ran past 1 GB).
export const TRACE_CATEGORIES=["disabled-by-default-devtools.timeline.frame","devtools.timeline"];
// Frames and busy time from a Chromium trace: frame reporter states (presented, dropped, no update), draw counts, main thread and GPU
// thread task time, paint and layout counts.
export function analyzeTrace(buffer){
  let data;try{data=JSON.parse(buffer.toString("utf8"))}catch{return {error:"trace is not JSON"}}
  const events=Array.isArray(data)?data:data.traceEvents||[];
  const threadNames=new Map(),processNames=new Map();
  for(const event of events)if(event.ph==="M"){if(event.name==="thread_name")threadNames.set(event.pid+":"+event.tid,event.args?.name);if(event.name==="process_name")processNames.set(event.pid,event.args?.name)}
  let start=Infinity,end=-Infinity;for(const event of events)if(event.ts>0){if(event.ts<start)start=event.ts;if(event.ts>end)end=event.ts}
  const seconds=Math.max(0.001,(end-start)/1e6);
  const states={};let draws=0,beginFrames=0,paints=0,layouts=0,styles=0;const busy={};
  for(const event of events){
    const thread=threadNames.get(event.pid+":"+event.tid)||"";
    if(event.name==="PipelineReporter"&&event.ph==="b"){const state=event.args?.chrome_frame_reporter?.state||"unknown";states[state]=(states[state]||0)+1}
    else if(event.name==="DrawFrame"||event.name==="Display::DrawAndSwap")draws++;
    else if(event.name==="DroppedFrame"){states.dropped=(states.dropped||0)+1}
    else if(event.name==="BeginFrame"||event.name==="Scheduler::BeginFrame")beginFrames++;
    else if(event.name==="Paint"&&thread==="CrRendererMain")paints++;
    else if(event.name==="Layout"&&thread==="CrRendererMain")layouts++;
    else if((event.name==="UpdateLayoutTree"||event.name==="RecalculateStyles")&&thread==="CrRendererMain")styles++;
    if((event.name==="ThreadControllerImpl::RunTask"||event.name==="RunTask")&&event.ph==="X"&&event.dur){const key=(processNames.get(event.pid)||event.pid)+"/"+(thread||event.tid);busy[key]=(busy[key]||0)+event.dur/1000}
  }
  const busyRows=Object.entries(busy).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([thread,ms])=>({thread,ms:Number(ms.toFixed(1)),percent:Number((100*ms/1000/seconds).toFixed(2))}));
  return {seconds:Number(seconds.toFixed(2)),frameReporterStates:states,drawsPerSecond:Number((draws/seconds).toFixed(2)),beginFramesPerSecond:Number((beginFrames/seconds).toFixed(2)),paintsPerSecond:Number((paints/seconds).toFixed(2)),layoutsPerSecond:Number((layouts/seconds).toFixed(2)),styleRecalcsPerSecond:Number((styles/seconds).toFixed(2)),busiestThreads:busyRows};
}

// A renderer CPU profile's self time, attributed through the bundle's source maps to the original package or ui/src file.
export function attributeProfile(profile,distDir){
  const consumers=new Map();
  const consumerFor=url=>{
    const name=String(url||"").split("/").pop()?.split("?")[0];if(!name||!name.endsWith(".js"))return null;
    if(consumers.has(name))return consumers.get(name);
    const mapFile=join(distDir,"assets",name+".map");let consumer=null;
    if(existsSync(mapFile))try{consumer=new SourceMapConsumer(JSON.parse(readFileSync(mapFile,"utf8")))}catch{}
    consumers.set(name,consumer);return consumer;
  };
  const nodes=new Map(profile.nodes.map(node=>[node.id,node])),self=new Map();
  const samples=profile.samples||[],deltas=profile.timeDeltas||[];
  for(let i=0;i<samples.length;i++)self.set(samples[i],(self.get(samples[i])||0)+(deltas[i]||0));
  const total=[...self.values()].reduce((sum,value)=>sum+value,0)||1,bySource=new Map(),byFunction=new Map();
  for(const [id,micros] of self){
    const frame=nodes.get(id)?.callFrame||{};let source="("+(frame.functionName||"program")+")",fn=frame.functionName||"(anonymous)";
    if(frame.url){
      const consumer=consumerFor(frame.url);
      if(consumer){const position=consumer.originalPositionFor({line:(frame.lineNumber||0)+1,column:frame.columnNumber||0});if(position?.source){const path=position.source.replace(/\\/g,"/");const pkg=/node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(path)?.[1];source=pkg?"npm:"+pkg:path.replace(/^.*?(ui\/src\/|src\/)/,"$1");fn=(position.name||frame.functionName||"(anonymous)")+" "+source+":"+position.line}}
      else source=String(frame.url).split("/").pop();
    }
    bySource.set(source,(bySource.get(source)||0)+micros);byFunction.set(fn,(byFunction.get(fn)||0)+micros);
  }
  const rows=(map,top)=>[...map].sort((a,b)=>b[1]-a[1]).slice(0,top).map(([name,micros])=>({name,ms:Number((micros/1000).toFixed(1)),percent:Number((100*micros/total).toFixed(1))}));
  return {totalMs:Number((total/1000).toFixed(1)),bySource:rows(bySource,25),byFunction:rows(byFunction,25)};
}
