import { createServer } from "node:http";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { createGuiServer } from "../src/gui-server.mjs";
import { TrebellStateStore } from "../src/trebell-state.mjs";
import { git, gitInfo } from "../src/git-service.mjs";
import { trebellHome } from "../src/paths.mjs";
import { createLiveSmokeGuard } from "../src/live-smoke-policy.mjs";

async function freePort(){const s=createServer();await new Promise((resolve,reject)=>{s.once("error",reject);s.listen(0,"127.0.0.1",resolve)});const p=s.address().port;await new Promise(resolve=>s.close(resolve));return p}
function rpc(ws,id,method,params={}){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{ws.off("message",onMessage);reject(new Error(method+" timed out"))},30000);const onMessage=data=>{let msg;try{msg=JSON.parse(String(data))}catch{return}if(msg.id!==id)return;clearTimeout(timer);ws.off("message",onMessage);if(msg.error)reject(Object.assign(new Error(msg.error.message||JSON.stringify(msg.error)),{rpcError:msg.error}));else resolve(msg.result)};ws.on("message",onMessage);ws.send(JSON.stringify({id,method,params}))})}
function waitCompleted(ws,threadId){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{ws.off("message",onMessage);reject(new Error("turn/completed timed out for "+threadId))},90000);const onMessage=data=>{let msg;try{msg=JSON.parse(String(data))}catch{return}if(msg.method!=="turn/completed"||msg.params?.threadId!==threadId)return;clearTimeout(timer);ws.off("message",onMessage);resolve(msg.params)};ws.on("message",onMessage)})}
function assistantText(thread){return (thread?.turns||[]).flatMap(turn=>turn.items||[]).filter(item=>item?.type==="agentMessage").map(item=>String(item.text||"")).join("\n")}

const scratch=await mkdtemp(join(tmpdir(),"trebell-live-fanout-"));
const home=join(scratch,"home"),repo=join(scratch,"repo");
const liveGuard=createLiveSmokeGuard({provider:"vyceai",model:"multi-model-fanout",runtime:"codex",maxTurns:2,timeoutMs:180_000});
const apiKey=String(process.env.VYCEAI_API_KEY||process.env.VYCE_API_KEY||"").trim();
const env={...process.env,...(apiKey?{VYCEAI_API_KEY:apiKey}:{}),TREBELL_HOME:home};
let gui=null,ws=null;let nextId=1;
try{
  await mkdir(home,{recursive:true});
  if(!apiKey){
    try{await copyFile(join(trebellHome(process.env),"provider-secrets.json"),join(home,"provider-secrets.json"))}
    catch{throw new Error("Vyce credentials are unavailable. Configure Vyce in Trebell or set VYCEAI_API_KEY / VYCE_API_KEY.")}
  }
  new TrebellStateStore(env).updateSettings({modelProvider:"vyceai",agentRuntime:"codex",worktreeSubmodules:"none",onboardingComplete:true});
  await mkdir(repo,{recursive:true});await git(repo,["init"]);await git(repo,["config","user.email","trebell-smoke@example.test"]);await git(repo,["config","user.name","Trebell Smoke"]);await writeFile(join(repo,"README.md"),"# Trebell live fanout smoke\n");await git(repo,["add","README.md"]);await git(repo,["commit","-m","base"]);
  const base=(await gitInfo(repo)).branch;if(!base)throw new Error("temporary repo has no base branch");
  gui=await createGuiServer({port:await freePort(),appPort:await freePort(),mock:false,env});
  let boot=null;for(let i=0;i<100;i++){boot=await fetch(gui.url+"/api/bootstrap").then(r=>r.json());if(boot.appServerReady&&boot.providerReady)break;await new Promise(resolve=>setTimeout(resolve,200))}
  if(!boot?.appServerReady||!boot?.providerReady)throw new Error("Trebell/Vyce runtime did not become ready: "+JSON.stringify({appServerReady:boot?.appServerReady,providerReady:boot?.providerReady,provider:boot?.provider}));
  const catalog=await fetch(gui.url+"/api/models").then(r=>r.json());const preferred=["agnes-3.0-flash","gpt-astra","deepseek-v4-flash"];const second=preferred.find(model=>catalog.models?.includes(model));const models=["deepseek-v4.1",second].filter(Boolean);if(models.length<2)throw new Error("Vyce live catalog did not expose a second model for fanout validation");for(const model of models)if(!catalog.models?.includes(model))throw new Error("Vyce model missing from live catalog: "+model);
  ws=new WebSocket(boot.wsUrl,{origin:gui.url});await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error("relay open timed out")),10000);ws.once("open",()=>{clearTimeout(timer);resolve()});ws.once("error",error=>{clearTimeout(timer);reject(error)})});
  await rpc(ws,nextId++,"initialize",{clientInfo:{name:"trebell-live-fanout-smoke",title:"Trebell Live Fanout Smoke",version:"1.2.0"},capabilities:{experimentalApi:true}});ws.send(JSON.stringify({method:"initialized",params:{}}));
  const launches=models.map(async(model,index)=>{
    const suffix=`${Date.now().toString(36)}-${index}`;const branch=`trebell/live-${model.replace(/[^a-z0-9]+/gi,"-")}-${suffix}`;const worktree=repo+`-wt-${index}-${suffix}`;
    const create=await fetch(gui.url+"/api/git/action",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"worktree-create",cwd:repo,branch,path:worktree,baseBranch:base})}).then(r=>r.json());if(!create.ok)throw new Error("worktree create failed: "+create.error);
    const started=await rpc(ws,nextId++,"thread/start",{model,modelProvider:"vyceai",cwd:worktree,approvalPolicy:"never",sandbox:"read-only",ephemeral:false,threadSource:"trebell-code",developerInstructions:"This is a smoke test. Do not use tools. Reply exactly with the requested marker."});
    if(!started.thread?.id)throw new Error(model+" did not return a thread id");const threadId=started.thread.id;const completed=waitCompleted(ws,threadId);
    liveGuard.consumeTurn("fanout turn for "+model);
    const turn=await liveGuard.withTimeout(rpc(ws,nextId++,"turn/start",{threadId,model,cwd:worktree,approvalPolicy:"never",sandboxPolicy:{type:"readOnly",networkAccess:false},input:[{type:"text",text:"Reply with exactly TREBELL_FANOUT_OK and nothing else. Do not use tools.",text_elements:[]}]}),"fanout turn for "+model);if(!turn.turn?.id)throw new Error(model+" did not return a turn id");
    const done=await completed;if(done.turn?.status&&done.turn.status!=="completed")throw new Error(model+" turn completed with status "+done.turn.status);
    const resumed=await rpc(ws,nextId++,"thread/resume",{threadId,model,modelProvider:"vyceai",cwd:worktree,excludeTurns:false});const text=assistantText(resumed.thread);if(!text.includes("TREBELL_FANOUT_OK"))throw new Error(model+" completed without expected assistant marker: "+text.slice(0,300));
    return {model,threadId,worktree,reply:text.trim().slice(0,120)};
  });
  const results=await Promise.all(launches);if(results[0].threadId===results[1].threadId||results[0].worktree===results[1].worktree)throw new Error("fanout did not isolate threads/worktrees");
  console.log(JSON.stringify({ok:true,provider:"vyceai",results:results.map(({model,threadId,worktree,reply})=>({model,threadId,isolatedWorktree:worktree!==repo,reply})),fingerprint:liveGuard.fingerprint({models:results.map(item=>item.model)})},null,2));
  for(const item of results){await rpc(ws,nextId++,"thread/delete",{threadId:item.threadId}).catch(()=>{});await fetch(gui.url+"/api/git/action",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({action:"worktree-remove",cwd:repo,path:item.worktree,force:false})}).catch(()=>{})}
}finally{
  try{ws?.close()}catch{};if(gui)await gui.close().catch(()=>{});await rm(scratch,{recursive:true,force:true,maxRetries:30,retryDelay:100}).catch(()=>{});
}
