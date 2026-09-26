import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { AgentRuntimeManager } from "../src/agent-runtime-manager.mjs";
import { AgentThreadStore } from "../src/agent-thread-store.mjs";
import { attachAgentRelay } from "../src/agent-relay.mjs";
import { createLiveSmokeGuard } from "../src/live-smoke-policy.mjs";
import { trebellHome } from "../src/paths.mjs";
import { probeCompatibleRuntimeProfiles,publicRuntimeProfileSmokeResult } from "../src/runtime-profile-live-smoke.mjs";

function clone(value){return JSON.parse(JSON.stringify(value))}
async function settingsSnapshot(env){
  const path=join(trebellHome(env),"ui-state.json");
  try{const parsed=JSON.parse(await readFile(path,"utf8"));return {...(parsed.settings||{}),activeEnvironmentId:null}}
  catch{return {agentRuntime:"claude",agentRuntimeInstanceId:"claude-default",agentRuntimeInstances:[],activeEnvironmentId:null}}
}
async function listen(server){await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));return server.address().port}
function rpcClient(ws){
  let id=0;const pending=new Map();
  ws.on("message",raw=>{const message=JSON.parse(String(raw));if(message.id==null||!pending.has(message.id))return;const target=pending.get(message.id);pending.delete(message.id);message.error?target.reject(new Error(message.error.message)):target.resolve(message.result)});
  return (method,params={})=>new Promise((resolve,reject)=>{const requestId=++id;pending.set(requestId,{resolve,reject});ws.send(JSON.stringify({id:requestId,method,params}))});
}
async function proveIdleSwitch({runtimeManager,settings,pair,guard}){
  if(!pair)return {switched:false,skipReason:"No compatible profile pair was available."};
  const root=await mkdtemp(join(tmpdir(),"trebell-runtime-profile-smoke-")),threadStore=new AgentThreadStore({...process.env,TREBELL_HOME:root});
  const source=runtimeManager.instances().find(item=>item.id===pair.sourceId),state={settings:()=>clone(settings)};
  const thread=threadStore.create({runtime:"claude",cwd:root,providerSessionId:"runtime-profile-live-smoke",model:null,runtimeInstanceId:source.id,providerMeta:{runtimeInstanceId:source.id,environmentId:null}});
  const server=createServer((_req,res)=>{res.writeHead(404);res.end()});const relay=attachAgentRelay(server,{runtimeManager,threadStore,terminals:{},state,version:"live-runtime-profile-smoke"});let ws=null;
  try{
    const port=await listen(server);ws=new WebSocket(`ws://127.0.0.1:${port}/api/agent/ws`);await guard.withTimeout(new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)}),"connect runtime-profile smoke relay");const rpc=rpcClient(ws);
    const listed=await guard.withTimeout(rpc("thread/runtimeInstances/list",{threadId:thread.id}),"list compatible runtime profiles");
    if(!listed?.items?.some(item=>item.id===pair.targetId&&item.available&&item.authenticated!==false))throw new Error("Compatible target profile disappeared or became unavailable before the switch check.");
    const switched=await guard.withTimeout(rpc("thread/runtimeInstance/set",{threadId:thread.id,instanceId:pair.targetId}),"switch idle runtime profile");
    if(switched?.thread?.runtimeInstanceId!==pair.targetId)throw new Error("Runtime profile switch did not persist the target instance id.");
    if(switched?.thread?.providerSessionId!==thread.providerSessionId)throw new Error("Runtime profile switch changed continuation session identity.");
    return {switched:true,fromInstanceId:pair.sourceId,toInstanceId:pair.targetId};
  }finally{try{ws?.close()}catch{}await relay.close();await new Promise(resolve=>server.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
}

const guard=createLiveSmokeGuard({provider:"none",model:"none",runtime:"claude-profile-switch",maxTurns:1,timeoutMs:120_000});
const settings=await settingsSnapshot(process.env),readonlyState={settings:()=>clone(settings)},runtimeManager=new AgentRuntimeManager({state:readonlyState,env:process.env});
const result=await probeCompatibleRuntimeProfiles({runtimeManager,runtime:"claude",environmentId:null,withTimeout:(promise,label)=>guard.withTimeout(promise,label)});
const switchResult=result.compatiblePair?await proveIdleSwitch({runtimeManager,settings,pair:result.compatiblePair,guard}):null;
process.stdout.write(JSON.stringify({fingerprint:guard.fingerprint({purpose:"runtime-profile-compatibility",inferenceTurns:0}),result:publicRuntimeProfileSmokeResult(result,switchResult)},null,2)+"\n");
