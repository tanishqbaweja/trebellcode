// Loaded into the Trebell GUI server with `node --import <this file> src/gui-server.mjs`: it counts what the server does (process
// spawns, sqlite connections, statements and payload bytes, JSON parse/stringify bytes, file writes, HTTP requests, WebSocket
// sends, timers), measures the event loop (delay histogram, utilization) and CPU, profiles on request, and routes fetch: loopback
// passes, https://api.openai.com/* goes to the scripted fake (fake-openai.mjs), anything else is refused and counted. The parent
// talks to it over the IPC channel: {perfTap:"snapshot",reset}, {perfTap:"script",replies:[...]}, {perfTap:"profile-start"},
// {perfTap:"profile-stop",file} and {perfTap:"heap-snapshot",file}. Product code is not changed; every patch wraps a builtin.
import { createRequire, syncBuiltinESMExports } from "node:module";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { Session } from "node:inspector";
import { writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { writeHeapSnapshot } from "node:v8";
import { createFakeOpenAi } from "./fake-openai.mjs";

const require=createRequire(import.meta.url);
const cp=require("node:child_process"),fs=require("node:fs"),sqlite=require("node:sqlite"),http=require("node:http");
let ws=null;try{ws=require("ws")}catch{}

function fresh(){
  return {
    since:Date.now(),
    spawns:{total:0,byCommand:{},recent:[]},
    sqlite:{opens:0,closes:0,prepares:0,execs:0,pragmaExecs:0,beginImmediate:0,stepCalls:{get:0,all:0,run:0,iterate:0},rowsRead:0,bytesRead:0,bytesWritten:0,byStatement:{}},
    json:{parseCalls:0,parseChars:0,stringifyCalls:0,stringifyChars:0},
    fs:{writeCalls:0,writeBytes:0,readFileCalls:0,readFileBytes:0,readdirCalls:0,statCalls:0,byWriteTarget:{}},
    http:{requests:0,byPath:{},upgrades:0},
    ws:{sends:0,sendBytes:0},
    timers:{created:{},fired:{},intervals:{}},
    fetch:{total:0,byOrigin:{},blocked:0,fake:[]},
  };
}
let counters=fresh();
const bump=(map,key,by=1)=>{map[key]=(map[key]||0)+by};
const home=String(process.env.TREBELL_HOME||"").replace(/\\/g,"/").toLowerCase();
function writeTarget(file){
  const text=String(file?.path||file||"").replace(/\\/g,"/");const lower=text.toLowerCase();
  if(home&&lower.startsWith(home))return "home:"+text.slice(home.length).split("/").filter(Boolean).slice(0,2).join("/");
  return text.split("/").slice(-2).join("/")||"(fd)";
}

// Processes: the command's basename and, for git and the harness CLIs, its first argument.
function commandKey(file,args){
  const base=String(file||"").replace(/\\/g,"/").split("/").pop().replace(/\.(exe|cmd|bat)$/i,"");
  const list=Array.isArray(args)?args:[];const first=list.find(value=>typeof value==="string"&&!value.startsWith("-"))||"";
  if(/^(cmd|powershell|pwsh)$/i.test(base)){const inner=list.join(" ").slice(0,80);return base+" "+inner}
  return (base+" "+String(first).slice(0,40)).trim();
}
// exec calls execFile through the module's exports, so a call made inside another counted call is not counted again.
let spawnDepth=0;
const counted=(name,real)=>function(file,args,...rest){
  if(spawnDepth===0){
    const key=name==="exec"||name==="execSync"?commandKey(String(file).split(" ")[0],String(file).split(" ").slice(1)):commandKey(file,args);
    counters.spawns.total++;bump(counters.spawns.byCommand,key);counters.spawns.recent.push({at:Date.now(),via:name,key});if(counters.spawns.recent.length>400)counters.spawns.recent.shift();
  }
  spawnDepth++;try{return real.call(this,file,args,...rest)}finally{spawnDepth--}
};
for(const name of ["spawn","execFile","exec","fork","spawnSync","execFileSync","execSync"]){
  const real=cp[name];if(typeof real!=="function")continue;
  cp[name]=counted(name,real);
  // promisify(execFile) resolves {stdout,stderr} only through the builtin's own promisified form; without it the server's git
  // helpers read an empty stdout (gitInfo answered root "" under the tap), so the wrapper carries that form, counted the same way.
  const custom=real[promisify.custom];if(custom)Object.defineProperty(cp[name],promisify.custom,{value:counted(name,custom)});
}

// sqlite: every connection, statement and the bytes that cross the binding.
const RealDatabase=sqlite.DatabaseSync;
const statementKind=sql=>{const text=String(sql||"").trim().replace(/\s+/g," ");const head=text.slice(0,6).toUpperCase();const table=/(?:FROM|INTO|UPDATE|TABLE(?: IF NOT EXISTS)?)\s+([a-z_]+)/i.exec(text)?.[1]||"";return (head.startsWith("PRAGMA")?"PRAGMA":head.split(" ")[0])+" "+table};
class CountingDatabase extends RealDatabase{
  constructor(...args){super(...args);counters.sqlite.opens++}
  close(){counters.sqlite.closes++;return super.close()}
  exec(sql){counters.sqlite.execs++;const text=String(sql||"");if(/PRAGMA/i.test(text))counters.sqlite.pragmaExecs++;if(/BEGIN IMMEDIATE/i.test(text))counters.sqlite.beginImmediate++;return super.exec(sql)}
  prepare(sql){counters.sqlite.prepares++;const statement=super.prepare(sql);try{Object.defineProperty(statement,"__perfKind",{value:statementKind(sql)})}catch{}return statement}
}
sqlite.DatabaseSync=CountingDatabase;
const rowBytes=row=>{let size=0;if(row&&typeof row==="object")for(const value of Object.values(row))if(typeof value==="string")size+=value.length;return size};
const argBytes=args=>{let size=0;for(const value of args)if(typeof value==="string")size+=value.length;return size};
const statementProto=sqlite.StatementSync.prototype;
for(const method of ["get","all","run","iterate"]){
  const real=statementProto[method];if(typeof real!=="function")continue;
  statementProto[method]=function(...args){
    counters.sqlite.stepCalls[method]++;const kind=this.__perfKind||"?";const entry=counters.sqlite.byStatement[kind]||(counters.sqlite.byStatement[kind]={calls:0,rows:0,bytesRead:0,bytesWritten:0});entry.calls++;
    const written=argBytes(args);entry.bytesWritten+=written;counters.sqlite.bytesWritten+=written;
    const result=real.apply(this,args);
    if(method==="get"&&result){entry.rows++;counters.sqlite.rowsRead++;const size=rowBytes(result);entry.bytesRead+=size;counters.sqlite.bytesRead+=size}
    else if(method==="all"&&Array.isArray(result)){entry.rows+=result.length;counters.sqlite.rowsRead+=result.length;let size=0;for(const row of result)size+=rowBytes(row);entry.bytesRead+=size;counters.sqlite.bytesRead+=size}
    return result;
  };
}

// JSON: how many characters are parsed and produced (the server's clones are JSON round trips).
const realParse=JSON.parse,realStringify=JSON.stringify;
JSON.parse=function(text,reviver){counters.json.parseCalls++;if(typeof text==="string")counters.json.parseChars+=text.length;return realParse(text,reviver)};
JSON.stringify=function(value,replacer,space){const out=realStringify(value,replacer,space);counters.json.stringifyCalls++;if(typeof out==="string")counters.json.stringifyChars+=out.length;return out};

// Files: synchronous and promise writes with their target under the Trebell home; reads and directory listings by count.
const byteLength=data=>typeof data==="string"?Buffer.byteLength(data):data?.byteLength||0;
for(const name of ["writeFileSync","appendFileSync"]){const real=fs[name];fs[name]=function(file,data,...rest){counters.fs.writeCalls++;const size=byteLength(data);counters.fs.writeBytes+=size;bump(counters.fs.byWriteTarget,writeTarget(file),size);return real.call(this,file,data,...rest)}}
{const real=fs.writeSync;fs.writeSync=function(fd,data,...rest){counters.fs.writeCalls++;const size=byteLength(data);counters.fs.writeBytes+=size;bump(counters.fs.byWriteTarget,"(fd)",size);return real.call(this,fd,data,...rest)}}
for(const name of ["writeFile","appendFile"]){const real=fs.promises[name];fs.promises[name]=function(file,data,...rest){counters.fs.writeCalls++;const size=byteLength(data);counters.fs.writeBytes+=size;bump(counters.fs.byWriteTarget,writeTarget(file),size);return real.call(this,file,data,...rest)}}
{const real=fs.readFileSync;fs.readFileSync=function(...args){counters.fs.readFileCalls++;const out=real.apply(this,args);counters.fs.readFileBytes+=byteLength(out);return out}}
{const real=fs.promises.readFile;fs.promises.readFile=async function(...args){counters.fs.readFileCalls++;const out=await real.apply(this,args);counters.fs.readFileBytes+=byteLength(out);return out}}
for(const name of ["readdirSync","statSync","existsSync"]){const real=fs[name];fs[name]=function(...args){if(name==="readdirSync")counters.fs.readdirCalls++;else counters.fs.statCalls++;return real.apply(this,args)}}
syncBuiltinESMExports();

// HTTP requests the server answers, by method and path; WebSocket messages it sends.
const realEmit=http.Server.prototype.emit;
http.Server.prototype.emit=function(event,...args){
  if(event==="request"){const req=args[0];let path=String(req?.url||"");const query=path.indexOf("?");if(query>=0)path=path.slice(0,query);if(!path.startsWith("/api/"))path=path.startsWith("/assets/")?"/assets/*":path;counters.http.requests++;bump(counters.http.byPath,String(req?.method||"GET")+" "+path)}
  else if(event==="upgrade")counters.http.upgrades++;
  return realEmit.call(this,event,...args);
};
if(ws?.WebSocket?.prototype?.send){const real=ws.WebSocket.prototype.send;ws.WebSocket.prototype.send=function(data,...rest){counters.ws.sends++;counters.ws.sendBytes+=byteLength(data);return real.call(this,data,...rest)}}

// Timers: created and fired, keyed by kind and delay; intervals keep the call site that made them.
const realSetTimeout=globalThis.setTimeout,realSetInterval=globalThis.setInterval;
globalThis.setTimeout=function(callback,delay,...args){
  const key="timeout:"+(Number(delay)||0);bump(counters.timers.created,key);
  if(typeof callback!=="function")return realSetTimeout(callback,delay,...args);
  return realSetTimeout(function(...inner){bump(counters.timers.fired,key);return callback.apply(this,inner)},delay,...args);
};
globalThis.setInterval=function(callback,delay,...args){
  const key="interval:"+(Number(delay)||0),site=String(new Error().stack||"").split("\n").slice(2,3).join("").trim().replace(/^at /,"").slice(0,160);
  bump(counters.timers.created,key);counters.timers.intervals[key+" "+site]=(counters.timers.intervals[key+" "+site]||0)+1;
  if(typeof callback!=="function")return realSetInterval(callback,delay,...args);
  return realSetInterval(function(...inner){bump(counters.timers.fired,key);return callback.apply(this,inner)},delay,...args);
};

// fetch: loopback passes, OpenAI goes to the scripted fake, anything else is refused (and counted) so no turn reaches a paid model.
const replies=[];
const fake=createFakeOpenAi({script:()=>replies.length?replies.shift():null,log:entry=>{counters.fetch.fake.push(entry);if(counters.fetch.fake.length>200)counters.fetch.fake.shift()}});
const realFetch=globalThis.fetch;
globalThis.fetch=async function(input,init={}){
  const url=new URL(typeof input==="string"?input:input instanceof URL?input.href:String(input?.url||""));
  counters.fetch.total++;bump(counters.fetch.byOrigin,url.origin);
  if(["127.0.0.1","localhost","[::1]","::1"].includes(url.hostname))return realFetch(input,init);
  if(url.hostname==="api.openai.com")return fake(url.href,init);
  counters.fetch.blocked++;throw new TypeError("fetch failed (perf tap: external network is off for "+url.origin+")");
};

// Event loop and CPU.
const delay=monitorEventLoopDelay({resolution:10});delay.enable();
let eluMark=performance.eventLoopUtilization(),cpuMark=process.cpuUsage(),wallMark=performance.now();
const ms=value=>Number((value/1e6).toFixed(2));
function snapshot(reset){
  const elu=performance.eventLoopUtilization(eluMark),cpu=process.cpuUsage(cpuMark),wall=performance.now()-wallMark,memory=process.memoryUsage();
  const out={
    ...counters,wallMs:Number(wall.toFixed(0)),
    eventLoop:{utilization:Number(elu.utilization.toFixed(4)),activeMs:Number(elu.active.toFixed(1)),delayMs:{min:ms(delay.min),mean:ms(delay.mean),p50:ms(delay.percentile(50)),p90:ms(delay.percentile(90)),p99:ms(delay.percentile(99)),max:ms(delay.max)}},
    cpu:{userMs:Number((cpu.user/1000).toFixed(1)),systemMs:Number((cpu.system/1000).toFixed(1)),corePercent:Number((100*(cpu.user+cpu.system)/1000/Math.max(1,wall)).toFixed(2))},
    memory:{rssMB:Number((memory.rss/1048576).toFixed(1)),heapUsedMB:Number((memory.heapUsed/1048576).toFixed(1)),heapTotalMB:Number((memory.heapTotal/1048576).toFixed(1)),externalMB:Number((memory.external/1048576).toFixed(1)),arrayBuffersMB:Number((memory.arrayBuffers/1048576).toFixed(1))},
    activeHandles:typeof process._getActiveHandles==="function"?process._getActiveHandles().length:null,
  };
  if(reset){counters=fresh();delay.reset();eluMark=performance.eventLoopUtilization();cpuMark=process.cpuUsage();wallMark=performance.now()}
  return out;
}

// In-process use (micro.mjs runs with this tap preloaded).
globalThis.__perfTap={snapshot,script:list=>replies.push(...list)};

// CPU profiles: self time by function and by file.
let session=null;
const post=(method,params={})=>new Promise((resolve,reject)=>session.post(method,params,(error,result)=>error?reject(error):resolve(result)));
export function summarizeProfile(profile,{top=30}={}){
  const nodes=new Map(profile.nodes.map(node=>[node.id,node])),self=new Map();
  const samples=profile.samples||[],deltas=profile.timeDeltas||[];
  for(let i=0;i<samples.length;i++)self.set(samples[i],(self.get(samples[i])||0)+(deltas[i]||0));
  const total=[...self.values()].reduce((sum,value)=>sum+value,0)||1,byFunction=new Map(),byFile=new Map();
  for(const [id,micros] of self){
    const frame=nodes.get(id)?.callFrame||{},file=String(frame.url||"").replace(/^file:\/\/\//,"").replace(/^.*?(node_modules\/[^/]+|src\/|scripts\/)/,"$1")||"("+(frame.functionName||"native")+")";
    const fn=(frame.functionName||"(anonymous)")+" "+file+":"+((frame.lineNumber??-1)+1);
    byFunction.set(fn,(byFunction.get(fn)||0)+micros);byFile.set(file,(byFile.get(file)||0)+micros);
  }
  const rows=map=>[...map].sort((a,b)=>b[1]-a[1]).slice(0,top).map(([name,micros])=>({name,ms:Number((micros/1000).toFixed(1)),percent:Number((100*micros/total).toFixed(1))}));
  return {totalMs:Number((total/1000).toFixed(1)),byFunction:rows(byFunction),byFile:rows(byFile)};
}

process.on("message",async message=>{
  if(!message||typeof message!=="object"||!message.perfTap)return;
  const reply=data=>process.send?.({perfTap:"reply",id:message.id,data});
  try{
    if(message.perfTap==="snapshot")return reply(snapshot(Boolean(message.reset)));
    if(message.perfTap==="script"){replies.push(...(message.replies||[]));return reply({queued:replies.length})}
    if(message.perfTap==="profile-start"){session=new Session();session.connect();await post("Profiler.enable");await post("Profiler.setSamplingInterval",{interval:Number(message.intervalUs)||250});await post("Profiler.start");return reply({ok:true})}
    if(message.perfTap==="profile-stop"){const {profile}=await post("Profiler.stop");session.disconnect();session=null;if(message.file)writeFileSync(message.file,realStringify(profile));return reply(summarizeProfile(profile))}
    if(message.perfTap==="gc"){globalThis.gc?.();return reply({ok:Boolean(globalThis.gc)})}
    if(message.perfTap==="heap-snapshot"){const started=performance.now(),file=writeHeapSnapshot(message.file);return reply({file,ms:Math.round(performance.now()-started)})}
    // The server's own SIGTERM handler closes it (and stops its Codex app-servers); Windows has no signal to send it from outside.
    if(message.perfTap==="shutdown"){reply({ok:true});if(process.listenerCount("SIGTERM"))process.emit("SIGTERM");else process.exit(0);return}
    reply({error:"unknown command"});
  }catch(error){reply({error:String(error?.stack||error)})}
});
