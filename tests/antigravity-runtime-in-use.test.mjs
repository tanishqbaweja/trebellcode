// On Windows, a folder a running process has open cannot be renamed, and every Antigravity chat's process runs from the runtime's
// folder (agent-runtimes/antigravity/current). Stop ends a chat's turn, not its process, which stays until the chat is archived or
// deleted (most chats keep it so, for what their terminal commands left running) or Trebell Code quits. So an update refused because
// a chat holds the runtime says to do one of those, and doing it lets the next install through. Here the relay runs an Antigravity
// chat whose process is a stand-in for Antigravity's server started from that folder, as the relay starts it, and the update's
// registry, download and new runtime's start are the test's.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";
import { WebSocket } from "ws";
import { attachAgentRelay } from "../src/agent-relay.mjs";
import { AgentThreadStore } from "../src/agent-thread-store.mjs";
import { ACP_REGISTRY_URL, installAntigravityRuntime, readAntigravityInstall } from "../src/antigravity-runtime-installer.mjs";

const AGENT=fileURLToPath(new URL("./fixtures/antigravity-acp-agent.mjs",import.meta.url));
const ARCHIVE="https://dl.google.com/agy-extensions/releases/windows/agy-acp-server-fixture-windows-x86_64.zip";
const KEY="AIzaSyTrebellFixtureKey0123456789abcdef";
const until=async(check,what,ms=20_000)=>{for(const end=Date.now()+ms;!await check();){if(Date.now()>end)throw new Error("Timed out waiting until "+what);await new Promise(resolve=>setTimeout(resolve,50))}};

// A zip of the files given, stored, as extract-zip reads one.
function zipOf(files){
  const parts=[],directory=[];let offset=0;
  for(const [name,text] of Object.entries(files)){
    const data=Buffer.from(text),fileName=Buffer.from(name),crc=crc32(data);
    const local=Buffer.alloc(30);local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(fileName.length,26);
    const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt32LE(crc,16);central.writeUInt32LE(data.length,20);central.writeUInt32LE(data.length,24);central.writeUInt16LE(fileName.length,28);central.writeUInt32LE(offset,42);
    parts.push(local,fileName,data);directory.push(central,fileName);offset+=30+fileName.length+data.length;
  }
  const centralBytes=Buffer.concat(directory),end=Buffer.alloc(22),count=Object.keys(files).length;
  end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(count,8);end.writeUInt16LE(count,10);end.writeUInt32LE(centralBytes.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...parts,centralBytes,end]);
}

test("a runtime an Antigravity chat holds is replaced once the chat is archived, as the refusal says, and Stop does not free it",{timeout:180_000},async t=>{
  if(process.platform!=="win32")return t.skip("only Windows keeps a folder a running process holds from being renamed");
  const root=await mkdtemp(join(tmpdir(),"trebell-agy-in-use-")),env={...process.env,TREBELL_HOME:join(root,"trebell"),TEMP:join(root,"tmp"),TMP:join(root,"tmp")};
  const current=join(env.TREBELL_HOME,"agent-runtimes","antigravity","current"),scenarioPath=join(root,"scenario.json"),logPath=join(root,"agent.jsonl");
  await mkdir(env.TEMP,{recursive:true});await mkdir(join(root,"project"),{recursive:true});await writeFile(scenarioPath,JSON.stringify({expectKey:KEY}));
  const agentEnv={...env,TREBELL_AGY_SCENARIO:scenarioPath,TREBELL_AGY_LOG:logPath};
  // The stand-in runs as the runtime's server, from the folder it is started in.
  const spawnProcess=({args,cwd,env:launchEnv,stdio})=>spawn(process.execPath,[AGENT,...(args||[])],{cwd,env:{...launchEnv,TREBELL_AGY_SCENARIO:scenarioPath,TREBELL_AGY_LOG:logPath},stdio,windowsHide:true});
  const bytes=zipOf({"agy_acp_server.exe":"stand-in server","localharness_external.exe":"stand-in helper"}),sha256=createHash("sha256").update(bytes).digest("hex");
  const fetchImpl=async url=>url===ACP_REGISTRY_URL
    ?{ok:true,json:async()=>({agents:[{id:"antigravity-acp",version:"1.4.3-fixture",distribution:{binary:{"windows-x86_64":{archive:ARCHIVE,cmd:"./agy_acp_server.exe",sha256}}}}]})}
    :{ok:true,status:200,headers:new Headers({"content-length":String(bytes.length)}),body:new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(bytes));controller.close()}},{highWaterMark:0})};
  const install=()=>installAntigravityRuntime({env,fetchImpl,platform:"win32",arch:"x64",launchEnv:agentEnv,spawnProcess,freeBytes:()=>64*1024*1048576}).then(()=>null,error=>error);
  // The relay, with a runtime manager whose Antigravity is that install: its chats run from current, as the relay starts them.
  const instance={id:"antigravity-default",kind:"antigravity",displayName:"Antigravity",enabled:true};
  const runtimeManager={
    instances:()=>[{...instance}],activeInstance:()=>({...instance}),activeRuntime:()=>"antigravity",compatibleInstanceIds:()=>[instance.id],
    probe:async()=>({id:instance.id,name:"Antigravity",available:true,authenticated:null,version:"1.4.3-fixture"}),
    runtimeCwd:cwd=>cwd,processSpawner:()=>spawnProcess,remoteIo:()=>null,childEnv:()=>({...agentEnv,GEMINI_API_KEY:KEY}),
    executable:()=>join(current,"agy_acp_server.exe"),acpArgs:()=>[],env,
  };
  const meta=new Map(),state={settings:()=>({activeEnvironmentId:null}),threadMeta:id=>meta.get(id)||{},updateThreadMeta:(id,patch)=>{const next={...(meta.get(id)||{}),...patch};meta.set(id,next);return next}};
  const threadStore=new AgentThreadStore(env),server=createServer((_req,res)=>{res.writeHead(404);res.end()});
  const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,version:"test"});
  await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const ws=new WebSocket("ws://127.0.0.1:"+server.address().port+"/api/agent/ws");
  t.after(async()=>{try{ws.terminate()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));threadStore.close?.();await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})});
  await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});
  let id=0;const seen=[];ws.on("message",raw=>seen.push(JSON.parse(String(raw))));
  const rpc=(method,params={})=>new Promise((resolve,reject)=>{const requestId=++id;const check=raw=>{const message=JSON.parse(String(raw));if(message.id!==requestId||message.method)return;ws.off("message",check);message.error?reject(new Error(message.error.message)):resolve(message.result)};ws.on("message",check);ws.send(JSON.stringify({id:requestId,method,params}))});

  assert.equal(await install(),null,"the first install");
  const before=(await readAntigravityInstall({env})).installedAt;
  // A chat, with one turn answered: its Antigravity runs from current.
  const threadId=(await rpc("thread/start",{cwd:join(root,"project"),approvalPolicy:"on-request",sandbox:"workspace-write"})).thread.id;
  const from=seen.length;await rpc("turn/start",{threadId,input:[{type:"text",text:"hello"}]});
  await until(()=>seen.slice(from).some(message=>message.method==="turn/completed"&&message.params?.threadId===threadId),"the turn ended");
  const held=await install();
  assert.equal(held?.message,"Google Antigravity 1.4.3-fixture was downloaded and checked, but the Antigravity runtime in use could not be replaced: an Antigravity chat used since Trebell Code started still runs it, and Stop does not end that. Archive or delete those Antigravity chats, which also ends what they left running, or quit Trebell Code (from its tray icon too), then try again. Nothing was installed.");
  // Stop does not free it: the chat's process stays.
  await rpc("turn/interrupt",{threadId}).catch(()=>{});
  const stopped=await install();
  assert.match(stopped?.message||"",/could not be replaced/,"Stop leaves the runtime held");
  assert.equal((await readAntigravityInstall({env})).installedAt,before,"the runtime in place is unchanged");
  // Archiving the chat, as the refusal says, ends its process, and the install goes through.
  await rpc("thread/archive",{threadId});
  const retried=await install();
  assert.equal(retried,null,String(retried?.message));
  assert.notEqual((await readAntigravityInstall({env})).installedAt,before,"the new runtime is in place");
});
