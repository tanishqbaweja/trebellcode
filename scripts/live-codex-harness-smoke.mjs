import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { createGuiServer } from "../src/gui-server.mjs";
import { TrebellStateStore } from "../src/trebell-state.mjs";

if(!process.argv.includes("--live"))throw new Error("Refusing to contact real Codex without --live");

async function freePort(){
  const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}
function rpc(ws,id,method,params={}){
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{ws.off("message",onMessage);reject(new Error(method+" timed out"))},30_000);
    const onMessage=raw=>{let message;try{message=JSON.parse(String(raw))}catch{return}if(message.id!==id)return;clearTimeout(timer);ws.off("message",onMessage);message.error?reject(new Error(message.error.message||method+" failed")):resolve(message.result)};
    ws.on("message",onMessage);ws.send(JSON.stringify({id,method,params}));
  });
}

const root=await mkdtemp(join(tmpdir(),"trebell-codex-harness-smoke-")),trebellHome=join(root,"trebell"),codexHome=join(root,"codex"),workspace=join(root,"workspace");
let gui=null,ws=null;
try{
  await Promise.all([mkdir(trebellHome,{recursive:true}),mkdir(codexHome,{recursive:true}),mkdir(workspace,{recursive:true})]);
  const sourceHome=String(process.env.CODEX_HOME||"").trim()||join(homedir(),".codex");
  try{await copyFile(join(sourceHome,"auth.json"),join(codexHome,"auth.json"))}
  catch{
    console.log(JSON.stringify({ok:true,skipped:true,reason:"Codex login is not available"},null,2));process.exit(0);
  }
  const env={...process.env,TREBELL_HOME:trebellHome};
  const state=new TrebellStateStore(env);
  state.updateSettings({
    agentRuntime:"codex",agentRuntimeInstanceId:"codex-default",modelProvider:"agentrouter",
    agentRuntimeInstances:[{id:"codex-default",kind:"codex",displayName:"Codex",enabled:true,homePath:codexHome,shadowHomePath:"",environment:{}}],
  });
  const [port,appPort]=await Promise.all([freePort(),freePort()]);
  gui=await createGuiServer({port,appPort,mock:false,env});
  let boot=null;for(let i=0;i<100;i++){boot=await fetch(gui.url+"/api/bootstrap").then(response=>response.json());if(boot.appServerReady&&boot.agentRuntimeReady)break;await new Promise(resolve=>setTimeout(resolve,200))}
  if(!boot?.agentRuntimeReady)throw new Error(boot?.agentRuntimeStatus?.message||boot?.appServerError||"Codex runtime did not become ready");
  const catalog=await fetch(gui.url+"/api/models").then(async response=>{if(!response.ok)throw new Error(await response.text());return response.json()});
  if(catalog.provider!==undefined)throw new Error("Codex model catalog was incorrectly labeled with a Trebell Native provider");
  if(catalog.metadata?.provider!=="codex"||!catalog.models?.length)throw new Error("Codex native model catalog was unavailable");

  ws=new WebSocket(boot.wsUrl,{origin:gui.url});await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});
  await rpc(ws,1,"initialize",{clientInfo:{name:"trebell-live-codex-smoke",title:"Trebell Codex Live Smoke",version:"1.0.0"},capabilities:{experimentalApi:true}});
  ws.send(JSON.stringify({method:"initialized",params:{}}));
  const started=await rpc(ws,2,"thread/start",{cwd:workspace,model:catalog.models[0],approvalPolicy:"never",sandbox:"danger-full-access",ephemeral:true,threadSource:"trebell-live-codex-smoke"});
  const threadId=started.thread?.id;if(!threadId)throw new Error("Codex did not create a thread");
  let reply="";
  const completed=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error("Codex live turn timed out")),120_000);
    const onMessage=raw=>{
      let message;try{message=JSON.parse(String(raw))}catch{return}
      if(message.method==="item/agentMessage/delta"&&message.params?.threadId===threadId)reply+=String(message.params.delta||"");
      if(message.method==="turn/completed"&&message.params?.threadId===threadId){clearTimeout(timer);ws.off("message",onMessage);resolve(message.params)}
    };
    ws.on("message",onMessage);
  });
  const turn=await rpc(ws,3,"turn/start",{threadId,model:catalog.models[0],input:[{type:"text",text:"Do not call tools or inspect files. Based only on the Trebell application context attached to this turn, reply exactly TREBELL_CODEX_CONTEXT_OK if it says you are running in Trebell Code through the Codex harness. Otherwise reply exactly MISSING_TREBELL_CONTEXT.",textElements:[]}],turnTrigger:"trebell-live-runtime-context"});
  if(!turn.turn?.id)throw new Error("Codex did not start the live turn");
  await completed;
  const text=reply.trim();
  if(!text.includes("TREBELL_CODEX_CONTEXT_OK")||text.includes("MISSING_TREBELL_CONTEXT"))throw new Error("Codex did not observe Trebell runtime context: "+text.slice(-500));
  console.log(JSON.stringify({ok:true,runtime:"codex",providerPreference:boot.provider,catalogProvider:catalog.metadata.provider,model:catalog.models[0],modelCount:catalog.models.length,runtimeContextProof:true,reply:text.slice(-200)},null,2));
}finally{
  try{ws?.close()}catch{}
  await gui?.close?.().catch(()=>{});
  await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100}).catch(()=>{});
}
