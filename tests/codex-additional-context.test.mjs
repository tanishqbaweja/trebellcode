import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket,WebSocketServer } from "ws";
import { createGuiServer } from "../src/gui-server.mjs";

// Codex keeps an additionalContext value of up to 4,000 UTF-8 bytes whole and cuts the middle out of a longer one, leaving its
// first and last 2,000 bytes around a marker (codex-rs utils/string truncate.rs, truncate_middle_with_token_budget at 1,000 tokens).
const CODEX_MAX_BYTES=4000;
function codexKeeps(value){
  const bytes=Buffer.from(value,"utf8");if(bytes.length<=CODEX_MAX_BYTES)return value;
  return bytes.subarray(0,CODEX_MAX_BYTES/2).toString("utf8")+`…${Math.ceil((bytes.length-CODEX_MAX_BYTES)/4)} tokens truncated…`+bytes.subarray(bytes.length-CODEX_MAX_BYTES/2).toString("utf8");
}
const contextModule=()=>import("../src/codex-additional-context.mjs");
// A split value's pieces in key order (Codex's order), and what they join to.
const piecesOf=(context,key)=>Object.keys(context).filter(name=>name.startsWith(key+".")).sort().map(name=>context[name]);
const joined=(context,key)=>piecesOf(context,key).map(entry=>entry.value).join("");
const wellFormed=text=>Buffer.from(text,"utf8").toString("utf8")===text;

async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}
async function connect(url){const ws=new WebSocket(url);await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});return ws}
function rpcClient(ws){
  let id=0;
  return (method,params={})=>new Promise((resolve,reject)=>{
    const requestId=++id,onMessage=raw=>{const message=JSON.parse(String(raw));if(message.id!==requestId)return;ws.off("message",onMessage);if(message.error)reject(Object.assign(new Error(message.error.message),{code:message.error.code}));else resolve(message.result)};
    ws.on("message",onMessage);ws.send(JSON.stringify({id:requestId,method,params}));
  });
}
// A Codex app-server that keeps goals (thread/goal/get, set), starts threads and turns, and keeps every request it gets.
async function fakeCodexAppServer(port){
  const http=createServer(),wss=new WebSocketServer({noServer:true}),requests=[],goals=new Map();let threads=0,turns=0;
  http.on("upgrade",(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit("connection",ws,req)));
  wss.on("connection",ws=>ws.on("message",raw=>{
    const message=JSON.parse(String(raw));if(message.id==null||!message.method)return;requests.push(message);
    const params=message.params||{},reply=result=>ws.send(JSON.stringify({id:message.id,result})),now=Math.floor(Date.now()/1000);
    if(message.method==="thread/goal/get")return reply({goal:goals.get(params.threadId)||null});
    if(message.method==="thread/goal/set"){const goal={threadId:params.threadId,objective:params.objective,status:params.status||"active",tokenBudget:params.tokenBudget??null,tokensUsed:0,timeUsedSeconds:0,createdAt:now,updatedAt:now};goals.set(params.threadId,goal);return reply({goal})}
    if(message.method==="thread/start")return reply({thread:{id:"context-child-"+(++threads),cwd:params.cwd||null,model:params.model||null,createdAt:now,updatedAt:now,turns:[]}});
    if(message.method==="turn/start")return reply({turn:{id:"context-turn-"+(++turns),status:"inProgress",items:[]}});
    reply({});
  }));
  await new Promise((resolve,reject)=>http.listen(port,"127.0.0.1",resolve).once("error",reject));
  return {requests,turnStarts:threadId=>requests.filter(item=>item.method==="turn/start"&&item.params?.threadId===threadId),async close(){for(const client of wss.clients)try{client.terminate()}catch{}wss.close();await new Promise(resolve=>http.close(resolve))}};
}
function assertCodexTakesWhole(context,where){
  for(const [key,entry] of Object.entries(context||{})){
    const bytes=Buffer.byteLength(entry.value,"utf8");
    assert.ok(bytes<=CODEX_MAX_BYTES,`${where}: ${key} is ${bytes} UTF-8 bytes, over Codex's ${CODEX_MAX_BYTES}-byte cap, so Codex cuts its middle out`);
  }
}

test("Codex additionalContext pieces stay within Codex's per-value cap in any script and join back in key order",async()=>{
  const {CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES,splitCodexAdditionalContext}=await contextModule();
  assert.equal(CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES,CODEX_MAX_BYTES);
  const paragraphs=Array.from({length:12},(_,index)=>`Paragraph ${index+1}: `+"evidence ".repeat(110).trim()).join("\n\n");
  const lines=Array.from({length:300},(_,index)=>`line ${index+1} `+"x".repeat(60)).join("\r\n");
  const cjk="仓库证据与目标说明。".repeat(900),emoji=("🦊🧪 "+"✓".repeat(20)+"\n").repeat(260),oneLine="a".repeat(9001);
  const short={kind:"application",value:"Trebell runtime: Codex"},context={
    "trebell.runtime":short,"trebell.repo_evidence":{kind:"application",value:paragraphs},"trebell.continuity":{kind:"application",value:lines},
    "trebell.repo_instructions":{kind:"untrusted",value:cjk},"trebell.goal":{kind:"application",value:emoji},"trebell.delegation":{kind:"application",value:oneLine},
  };
  const split=splitCodexAdditionalContext(context);
  assertCodexTakesWhole(split,"split context");
  assert.equal(split["trebell.runtime"],short,"an entry that fits stays as it is, under its own key");
  for(const key of Object.keys(context).filter(key=>key!=="trebell.runtime")){
    assert.equal(Object.prototype.hasOwnProperty.call(split,key),false,`${key} goes only as pieces`);
    const pieces=piecesOf(split,key);assert.ok(pieces.length>=2,`${key} is split`);
    assert.equal(joined(split,key),context[key].value,`${key}'s pieces in key order join back into the value`);
    assert.ok(pieces.every(entry=>entry.kind===context[key].kind),`${key}'s pieces keep its kind`);
    assert.ok(pieces.every(entry=>wellFormed(entry.value)),`${key} is cut on code points, never inside one`);
    assert.deepEqual(Object.keys(split).filter(name=>name.startsWith(key+".")),pieces.map((_,index)=>`${key}.${String(index+1).padStart(2,"0")}`));
  }
  assert.ok(piecesOf(split,"trebell.repo_evidence").slice(0,-1).every(entry=>entry.value.endsWith("\n\n")),"paragraphs stay whole when they fit");
  assert.ok(piecesOf(split,"trebell.continuity").slice(0,-1).every(entry=>entry.value.endsWith("\r\n")),"lines stay whole when there is no paragraph break");
  assert.deepEqual(piecesOf(split,"trebell.delegation").map(entry=>Buffer.byteLength(entry.value)),[4000,4000,1001],"a line longer than the cap is cut where the cap falls");
});

test("Codex additionalContext is left alone when every value fits, and long values get wider numbers past 99 pieces",async()=>{
  const {splitCodexAdditionalContext,withCodexContextPieces}=await contextModule();
  const fits={"trebell.runtime":{kind:"application",value:"r"},"trebell.goal":{kind:"application",value:"é".repeat(2000)}};
  assert.equal(splitCodexAdditionalContext(fits),fits,"4,000 bytes is still whole for Codex");
  const over={"trebell.goal":{kind:"application",value:"é".repeat(2000)+"!"}};
  assert.deepEqual(Object.keys(splitCodexAdditionalContext(over)),["trebell.goal.01","trebell.goal.02"],"4,001 bytes is cut by Codex, so it is split");
  const message={id:7,method:"turn/start",params:{threadId:"t",additionalContext:fits}};
  assert.equal(withCodexContextPieces(message),message);
  const read={id:8,method:"thread/read",params:{threadId:"t",additionalContext:over}};
  assert.equal(withCodexContextPieces(read),read,"only a turn's start or steer carries context to Codex");
  const steer=withCodexContextPieces({id:9,method:"turn/steer",params:{threadId:"t",expectedTurnId:"u",additionalContext:over}});
  assert.deepEqual(Object.keys(steer.params.additionalContext),["trebell.goal.01","trebell.goal.02"]);
  const huge=splitCodexAdditionalContext({"trebell.repo_evidence":{kind:"application",value:("z".repeat(99)+"\n").repeat(4100)}});
  const keys=Object.keys(huge);assert.ok(keys.length>99);assert.equal(keys[0],"trebell.repo_evidence.001");
  assert.deepEqual([...keys].sort(),keys,"key order is text order");
  assertCodexTakesWhole(huge,"huge context");
});

test("A Codex turn's long goal and the server's own delegated turn reach Codex in pieces Codex keeps whole",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-codex-context-")),[port,appPort]=await Promise.all([freePort(),freePort()]),upstream=await fakeCodexAppServer(appPort);
  const gui=await createGuiServer({port,appPort,mock:true,env:{...process.env,TREBELL_HOME:home}});const threadId="codex-context-thread";let ws;
  try{
    await fetch(gui.url+"/api/thread-meta",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({threadId,patch:{runtime:"codex",runtimeInstanceId:"codex-default",environmentId:null,cwd:home,active:false}})});
    ws=await connect(gui.url.replace(/^http/,"ws")+"/api/codex/ws");const rpc=rpcClient(ws);
    const marker="GOAL-MIDDLE-MARKER-41";
    const objective="Rework the parser. "+"Keep every case of the grammar covered. ".repeat(48)+marker+" "+"Report what changed and why. ".repeat(62);
    const completionConditions=Array.from({length:7},(_,index)=>`Condition ${index+1}: `+"the parser accepts every fixture in the suite ".repeat(25).trim());
    await rpc("thread/goal/set",{threadId,objective,completionConditions});
    const evidence=Array.from({length:9},(_,index)=>`File src/part-${index}.mjs\n`+"const value = compute(input);\n".repeat(36)).join("\n");
    await rpc("turn/start",{threadId,input:[{type:"text",text:"Go on with the goal"}],additionalContext:{"trebell.repo_evidence":{kind:"application",value:evidence}}});
    const turn=upstream.turnStarts(threadId).at(-1);assert.ok(turn,"the turn reaches Codex");
    const context=turn.params.additionalContext||{};
    const goalBytes=Buffer.byteLength(joined(context,"trebell.goal")||context["trebell.goal"]?.value||"");assert.ok(goalBytes>12_000,`the goal is a 12 KB value (${goalBytes} bytes)`);
    assertCodexTakesWhole(context,"the window's turn");
    const kept=Object.keys(context).sort().map(key=>codexKeeps(context[key].value)).join("");
    assert.ok(kept.includes(marker),"what Codex keeps of the goal still has the objective's middle");
    assert.ok(kept.includes(evidence),"what Codex keeps still has the window's whole repository evidence");
    assert.ok(joined(context,"trebell.goal").includes("Objective:\n"+objective.trim()),"the goal's pieces join back into the whole goal");
    assert.ok(piecesOf(context,"trebell.goal").every(entry=>entry.kind==="application"));
    assert.ok(context["trebell.runtime"]?.value,"a value that fits keeps its own key");

    const task="Inspect the parser and report. "+"Check the tokenizer, the grammar and the error paths. ".repeat(70);
    const delegated=await rpc("thread/delegate",{threadId,task,context:"Notes from the parent. "+"Keep the fixtures as they are. ".repeat(160),isolation:"shared",permissions:"read-only"});
    const childId=delegated.thread.id,childTurn=upstream.turnStarts(childId).at(-1);assert.ok(childTurn,"the delegated turn reaches Codex through the relay's own request");
    const childContext=childTurn.params.additionalContext||{};
    assert.ok(piecesOf(childContext,"trebell.delegation").length>=2,"the delegation's long context is split");
    assertCodexTakesWhole(childContext,"the delegated turn");
    assert.ok(joined(childContext,"trebell.delegation").includes("Task:\n"+task.trim()),"the delegated task reaches Codex whole");
  }finally{
    try{ws?.close()}catch{}await gui.close();await upstream.close();await rm(home,{recursive:true,force:true,maxRetries:20,retryDelay:250});
  }
});
