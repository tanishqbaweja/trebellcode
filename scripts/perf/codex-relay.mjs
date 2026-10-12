#!/usr/bin/env node
// The Codex relay's server work per upstream message (audit suspect 2), end to end through the real GUI server in mock mode: a fake
// Codex app-server on the app port streams item/agentMessage/delta notifications, then tool item/started ones, for a thread whose
// meta is small or 50 KB (1,500 tool-call ids and 20 pull-request links, as micro.mjs seeds it), and a WebSocket client on
// /api/codex/ws receives them as the renderer does. Run with the server tap preloaded: per message it reports the tap's sqlite
// connections, statements, write transactions and JSON parsed, and the process CPU, which also holds the fake's and the client's
// share of the WebSocket work. No Codex process starts and nothing leaves the machine.
//
//   node --expose-gc --import ./scripts/perf/lib/server-tap.mjs scripts/perf/codex-relay.mjs --home <dir> --out <file.json> [--messages 300] [--reps 5]
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { createGuiServer } from "../../src/gui-server.mjs";
import { freePort } from "./lib/server.mjs";
import { summarize } from "./lib/stats.mjs";
import { startLoadMeter } from "./lib/system.mjs";

const argv=process.argv.slice(2),flag=(name,fallback)=>{const index=argv.indexOf("--"+name);return index>=0?argv[index+1]:fallback};
const home=flag("home"),out=flag("out"),count=Math.max(10,Number(flag("messages",300))||300),reps=Math.max(1,Number(flag("reps",5))||5);
const tap=globalThis.__perfTap;if(!tap)throw new Error("run with --import scripts/perf/lib/server-tap.mjs");
rmSync(home,{recursive:true,force:true,maxRetries:10,retryDelay:200});mkdirSync(home,{recursive:true});
const meter=startLoadMeter(),sleep=ms=>new Promise(done=>setTimeout(done,ms));
const [port,appPort]=await Promise.all([freePort(),freePort()]);

// The fake app-server answers every request with an empty result and pushes what it is given to every relay connection.
const upstreamHttp=createServer(),wss=new WebSocketServer({noServer:true});
upstreamHttp.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
wss.on("connection",ws=>ws.on("message",raw=>{const message=JSON.parse(String(raw));if(message.id!=null&&message.method)ws.send(JSON.stringify({id:message.id,result:{}}))}));
await new Promise((resolve,reject)=>upstreamHttp.listen(appPort,"127.0.0.1",resolve).once("error",reject));
const push=text=>{for(const socket of wss.clients)socket.send(text)};

const gui=await createGuiServer({port,appPort,mock:true,env:{...process.env,TREBELL_HOME:home}});
const post=(path,body)=>fetch(gui.url+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}).then(response=>response.json());
const threads={small:"codex-perf-small",large:"codex-perf-large"};
await post("/api/thread-meta",{threadId:threads.small,patch:{runtime:"codex",runtimeInstanceId:"codex-default",cwd:home,environmentId:null}});
await post("/api/thread-meta",{threadId:threads.large,patch:{runtime:"codex",runtimeInstanceId:"codex-default",cwd:home,environmentId:null,codexToolCallIds:Array.from({length:1500},(_,i)=>"call_"+i.toString(36).padStart(24,"0")),attachments:Array.from({length:20},(_,i)=>({attachmentType:"pull_request",payload:{url:"https://example.invalid/pr/"+i,state:"OPEN",title:"PR "+i}}))}});
const metaBytes=Object.fromEntries(await Promise.all(Object.entries(threads).map(async([key,id])=>[key,(await fetch(gui.url+"/api/thread-meta?threadId="+id).then(response=>response.text())).length])));

// The renderer's socket: counts what arrives by method without parsing it, so the client adds no JSON work to the tap's count.
const client=new WebSocket(gui.url.replace(/^http/,"ws")+"/api/codex/ws");await new Promise((resolve,reject)=>{client.once("open",resolve);client.once("error",reject)});
const arrived={};client.on("message",raw=>{const method=/"method":"([^"]+)"/.exec(String(raw).slice(0,120))?.[1]||"(reply)";arrived[method]=(arrived[method]||0)+1});
// A forwarded request opens the relay's upstream connection.
client.send(JSON.stringify({id:1,method:"model/list",params:{}}));
for(let i=0;i<500&&!arrived["(reply)"];i++)await sleep(10);
if(!arrived["(reply)"])throw new Error("the relay did not open its upstream connection");

const delta=threadId=>JSON.stringify({method:"item/agentMessage/delta",params:{threadId,turnId:"perf-turn",itemId:"perf-item",delta:"tok "}});
let toolSequence=0;const toolStarted=threadId=>JSON.stringify({method:"item/started",params:{threadId,turnId:"perf-turn",item:{type:"commandExecution",id:"perf-tool-"+(++toolSequence),command:["npm","test"],status:"inProgress"}}});
async function stream(label,method,make){
  const rows=[];
  for(let rep=0;rep<reps;rep++){
    const before=arrived[method]||0,messages=Array.from({length:count},make);
    await sleep(50);tap.snapshot(true);const at=Date.now(),started=performance.now();
    for(const text of messages)push(text);
    for(let i=0;i<6000&&(arrived[method]||0)-before<count;i++)await sleep(2);
    const wall=performance.now()-started,snap=tap.snapshot(true);
    if((arrived[method]||0)-before<count)throw new Error(label+": only "+((arrived[method]||0)-before)+" of "+count+" arrived");
    const per=value=>Number((value/count).toFixed(3));
    rows.push({rep,machineLoad:meter.loadBetween(at,Date.now()),wallMsPerMessage:per(wall),cpuMsPerMessage:per(snap.cpu.userMs+snap.cpu.systemMs),sqliteOpensPerMessage:per(snap.sqlite.opens),sqliteStatementsPerMessage:per(snap.sqlite.prepares),writeTransactionsPerMessage:per(snap.sqlite.beginImmediate),jsonParseKBPerMessage:per(snap.json.parseChars/1024),jsonStringifyKBPerMessage:per(snap.json.stringifyChars/1024)});
  }
  const keys=Object.keys(rows[0]).filter(key=>key!=="rep");
  return {label,messages:count,reps,summary:Object.fromEntries(keys.map(key=>[key,summarize(rows.map(row=>row[key]),3)])),rows};
}
const result={startedAt:new Date().toISOString(),node:process.version,metaBytes,runs:[]};
for(const [key,id] of Object.entries(threads))result.runs.push(await stream("item/agentMessage/delta, "+key+" meta","item/agentMessage/delta",()=>delta(id)));
for(const [key,id] of Object.entries(threads))result.runs.push(await stream("tool item/started, "+key+" meta","item/started",()=>toolStarted(id)));
for(const run of result.runs)console.log(run.label,JSON.stringify(Object.fromEntries(Object.entries(run.summary).map(([key,value])=>[key,value.median]))));
client.close();await gui.close();for(const socket of wss.clients)socket.terminate();wss.close();await new Promise(resolve=>upstreamHttp.close(resolve));
meter.stop();result.finishedAt=new Date().toISOString();
writeFileSync(out,JSON.stringify(result,null,2));
console.log(JSON.stringify({ok:true,out}));
process.exit(0);
