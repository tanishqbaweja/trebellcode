import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dirname } from "node:path";
import { TrebellStateStore } from "../src/trebell-state.mjs";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";
import { AcpAgentSession } from "../src/acp-agent-session.mjs";
import { OpenCodeAgentSession } from "../src/opencode-agent-session.mjs";
import { TerminalManager } from "../src/terminal-manager.mjs";

if(!process.argv.includes("--live"))throw new Error("Refusing to contact real external harnesses without --live");

const root=await mkdtemp(join(tmpdir(),"trebell-external-harness-smoke-"));
const state=new TrebellStateStore(process.env),manager=new AgentRuntimeManager({state,env:process.env});
const snapshot=await manager.snapshot(),byKind=new Map(snapshot.statuses.map(status=>[status.kind,status]));
const results=[];
const requested=new Set(String(process.env.TREBELL_EXTERNAL_HARNESS_SMOKE_ONLY||"").split(",").map(value=>value.trim().toLowerCase()).filter(Boolean));
const wants=kind=>!requested.size||requested.has(kind);

async function within(promise,ms,label){
  let timer;try{return await Promise.race([Promise.resolve(promise),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(`${label} timed out after ${ms}ms`)),ms)})])}
  finally{if(timer)clearTimeout(timer)}
}

function captureText(target){
  return payload=>{
    const update=payload?.update||payload;
    if(update?.sessionUpdate==="agent_message_chunk"&&update?.content?.text)target.push(String(update.content.text));
  };
}

async function runAcp(kind,expected){
  const status=byKind.get(kind);if(!status?.available)return {kind,skipped:true,reason:status?.message||"runtime unavailable"};
  const instance=manager.instances().find(item=>item.kind===kind),terminals=new TerminalManager({persist:false}),chunks=[];
  const command=manager.executable(instance);
  const proofName=`${kind}-proof.txt`,session=new AcpAgentSession({runtime:kind,command,args:manager.acpArgs(instance,"full",root),cwd:root,processCwd:kind==="antigravity"?dirname(command):null,env:manager.childEnv(instance),terminals,permissionMode:"full",onPermission:async()=>"acceptForSession",onElicitation:async()=>({action:"cancel"}),onUpdate:captureText(chunks)});
  try{
    const started=await within(session.start(),kind==="antigravity"?90_000:45_000,kind+" start");
    const response=await within(session.prompt([{type:"text",text:`Create ${proofName} in the current workspace containing exactly ${expected} and nothing else. Use your coding tools, verify the file, then reply with exactly ${expected} and no other text.`}]),120_000,kind+" prompt");
    const reply=chunks.join("").trim();
    if(!reply.endsWith(expected))throw new Error(`${kind} returned an unexpected reply: ${reply.slice(-300)}`);
    const proof=(await readFile(join(root,proofName),"utf8")).trim();if(proof!==expected)throw new Error(`${kind} did not create the expected proof file`);
    return {kind,ok:true,toolProof:true,version:started.initialize?.agentInfo?.version||status.version||null,currentModel:started.session?.models?.currentModelId||null,modelCount:started.session?.models?.availableModels?.length||0,stopReason:response?.stopReason||null};
  }finally{await session.close().catch(()=>{});await terminals.shutdown().catch(()=>{})}
}

async function runOpenCode(){
  const kind="opencode",status=byKind.get(kind);if(!status?.available)return {kind,skipped:true,reason:status?.message||"runtime unavailable"};
  const instance=manager.instances().find(item=>item.kind===kind),catalog=await within(manager.models(instance),30_000,"OpenCode model discovery");
  const requestedModel=String(process.env.TREBELL_OPENCODE_SMOKE_MODEL||"").trim();
  if(requestedModel&&!catalog.models.includes(requestedModel))throw new Error(`Requested OpenCode smoke model is not connected: ${requestedModel}`);
  const preferredFreeModel="opencode/muse-spark-1.3-contributor-free";
  const freeOpenCodeModel=catalog.models.find(candidate=>candidate.startsWith("opencode/")&&candidate.endsWith("-free"));
  const model=requestedModel||(catalog.models.includes(preferredFreeModel)?preferredFreeModel:null)||freeOpenCodeModel||catalog.preferred||catalog.models[0];
  if(!model)throw new Error("OpenCode did not expose a model for live validation");
  const chunks=[],proofName="opencode-proof.txt",session=new OpenCodeAgentSession({command:manager.executable(instance),cwd:root,env:manager.childEnv(instance),permissionMode:"full",onPermission:async()=>"acceptForSession",onUpdate:captureText(chunks)});
  try{
    const started=await within(session.start({model}),30_000,"OpenCode start");
    const response=await within(session.prompt([{type:"text",text:`Create ${proofName} in the current workspace containing exactly TREBELL_OPENCODE_OK and nothing else. Use your coding tools, verify the file, then reply with exactly TREBELL_OPENCODE_OK and no other text.`}]),120_000,"OpenCode prompt");
    const reply=chunks.join("").trim();if(!reply.endsWith("TREBELL_OPENCODE_OK"))throw new Error(`OpenCode returned an unexpected reply: ${reply.slice(-300)}`);
    const proof=(await readFile(join(root,proofName),"utf8")).trim();if(proof!=="TREBELL_OPENCODE_OK")throw new Error("OpenCode did not create the expected proof file");
    return {kind,ok:true,toolProof:true,version:status.version||null,currentModel:started.session?.models?.currentModelId||model,modelCount:started.session?.models?.availableModels?.length||0,stopReason:response?.stopReason||null};
  }finally{await session.close().catch(()=>{})}
}

try{
  for(const [kind,expected] of [["grok","TREBELL_GROK_OK"],["antigravity","TREBELL_ANTIGRAVITY_OK"]]){
    if(wants(kind)){try{results.push(await runAcp(kind,expected))}catch(error){results.push({kind,ok:false,error:error?.message||String(error)})}}
  }
  if(wants("opencode")){try{results.push(await runOpenCode())}catch(error){results.push({kind:"opencode",ok:false,error:error?.message||String(error)})}}
  for(const kind of ["claude","cursor"])if(wants(kind)){const status=byKind.get(kind);results.push({kind,skipped:true,reason:status?.message||"runtime unavailable"})}
  console.log(JSON.stringify({ok:results.filter(item=>!item.skipped).every(item=>item.ok),results},null,2));
  if(results.some(item=>!item.skipped&&!item.ok))process.exitCode=1;
}finally{await rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100}).catch(()=>{})}
