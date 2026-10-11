import { mkdir,mkdtemp,rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachAgentRelay } from "../../src/agent-relay.mjs";
import { AgentRuntimeManager } from "../../src/agent-runtime-manager.mjs";
import { AgentThreadStore } from "../../src/agent-thread-store.mjs";
import { ContextEngine } from "../../src/context-engine.mjs";
import { TrebellStateStore } from "../../src/trebell-state.mjs";

async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}
const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});

// What the completion gate says of every fixture turn: it did what it was asked, nothing is left.
function gateAnswer(request){
  return {id:"relay-history-gate",provider:request.provider,model:request.model,text:JSON.stringify({status:"complete",progress:"improved",edit_support:"unsupported",mutation_safety:"allowed",recovery_mode:"none",constraint_audit:[],unresolved:[],reason:"The fixture turn did what it was asked."}),toolCalls:[],finishReason:"stop",usage:{}};
}

// Trebell Native's own tools as a provider calls them: a file written in the repository, a Node script run there. Auto mode
// runs both without asking.
export const writeFileCall=(id,path,content)=>({id,namespace:"trebell_workspace",name:"write_file",arguments:JSON.stringify({path,content})});
export const runCall=(id,script)=>({id,namespace:"trebell_terminal",name:"run",arguments:JSON.stringify({command:process.execPath,args:["-e",script],cwd:".",timeout_ms:5000})});

// Items as the relay stores them, for seeding: each has an id and its final status.
export const commandItem=(id,command,{output="ok\n",exitCode=0}={})=>({type:"commandExecution",id,command,cwd:"",processId:null,source:"agent",status:exitCode===0?"completed":"failed",commandActions:[],aggregatedOutput:output,exitCode,durationMs:null});
export const fileChangeItem=(id,path)=>({type:"fileChange",id,status:"completed",changes:[{path,kind:"update",diff:"@@ -1 +1 @@\n-before\n+after\n"}]});
export const replyItem=(id,text)=>({type:"agentMessage",id,text});

// Trebell Native threads on the real relay, with the provider scripted: replies answers the provider's calls in order, each
// {text,toolCalls} or a function of the request returning one (the completion gate is answered apart). seedThread stores a
// thread whose turns ran before the window opened, each {user,items,status,error}, finished as the relay finishes a turn; they
// finish in the same second, so their pills read "done".
export async function startRelayHarness({replies=[]}={}){
  const root=await mkdtemp(join(tmpdir(),"trebell-relay-history-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);
  state.updateSettings({agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",activeEnvironmentId:null});
  const runtimeManager=new AgentRuntimeManager({state,env}),threadStore=new AgentThreadStore(env),threads=[];
  const providerMeta={runtimeInstanceId:"native-default",modelProvider:"agentrouter",permissionProfile:"auto",projectless:false,environmentId:null};
  const seedThread=(name,turns=[])=>{
    const thread=threadStore.create({runtime:"native",cwd:repo,providerSessionId:"relay-history-"+(threads.length+1),model:"gpt-5.6",name,preview:name,providerMeta});
    for(const step of turns){
      const turn=threadStore.addTurn(thread.id,{inputText:step.user||"",items:step.items||[]});
      threadStore.finishTurn(thread.id,turn.id,{status:step.status||"completed",error:step.error||null});
    }
    threads.push(thread);return thread;
  };
  let calls=0;
  const nativeProviderTurn=async request=>{
    if(request.metadata?.completionGate||request.responseJsonSchema?.name==="trebell_completion_gate")return gateAnswer(request);
    const reply=replies[calls++],value=typeof reply==="function"?await reply(request):reply;
    if(!value)throw Object.assign(new Error("The fixture has no provider reply for call "+calls+"."),{retryable:false});
    const toolCalls=value.toolCalls||[];
    return {id:"relay-history-"+calls,provider:request.provider,model:request.model,text:value.text||"",toolCalls,finishReason:toolCalls.length?"tool_calls":"stop",usage:{}};
  };
  const relayServer=createServer((_req,res)=>{res.writeHead(404);res.end()});
  const relay=attachAgentRelay(relayServer,{runtimeManager,threadStore,terminals:{},state,contextEngine:new ContextEngine(),nativeProviderTurn,version:"relay-history-fixture"});
  const relayPort=await freePort();await new Promise((resolve,reject)=>relayServer.listen(relayPort,"127.0.0.1",resolve).once("error",reject));
  return {
    repo,threadStore,threads,seedThread,wsUrl:`ws://127.0.0.1:${relayPort}/api/agent/ws`,providerCalls:()=>calls,
    // The thread's turns as the relay stores them.
    turns:thread=>threadStore.get(thread.id)?.turns||[],
    async close(){await relay.close();await new Promise(resolve=>relayServer.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})},
  };
}

// The app's own API answered for a Native window on the relay, every thread in one project at the harness's repository.
// sent lists the requests the page sends the relay, as {method,params}.
export async function routeRelayApp(page,harness){
  const repo=harness.repo,project={id:"relay-history-project",name:"Relay History Project",path:repo,environmentId:null,effectiveSettings:{}};
  const uiMeta={projectless:false,environmentId:null,cwd:repo,runtime:"native",runtimeInstanceId:"native-default"},sent=[];
  const threadMeta=()=>Object.fromEntries(harness.threads.map(thread=>[thread.id,uiMeta]));
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"agentrouter",providerReady:true,agentRuntime:"native",agentRuntimeReady:true,wsUrl:harness.wsUrl,cwd:repo,platform:process.platform,version:"relay-history-fixture",activeEnvironmentId:null,activeEnvironment:null}));
  await page.route(/\/api\/state$/,route=>json(route,{settings:{onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"native",agentRuntimeInstanceId:"native-default",modelProvider:"agentrouter",defaultPermissionMode:"auto",defaultWorkspaceMode:"current",followUpMode:"queue"},projects:[project],activeProjectId:project.id,threadMeta:threadMeta()}));
  await page.route(/\/api\/models$/,route=>json(route,{models:["gpt-5.6"],metadata:{provider:"agentrouter",models:[{id:"gpt-5.6",name:"GPT-5.6",provider:"agentrouter",agent:"Trebell Native"}]}}));
  await page.route(/\/api\/projects(?:\?.*)?$/,route=>json(route,route.request().method()==="POST"?{project}:{projects:[project]}));
  await page.route(/\/api\/worktree\/ensure$/,route=>json(route,{ok:true}));
  await page.route(/\/api\/git\/info(?:\?.*)?$/,route=>json(route,{isGit:false,cwd:repo,root:null,branch:null,branches:[],status:[],remotes:[],worktrees:[]}));
  await page.route(/\/api\/thread-meta(?:\?.*)?$/,route=>json(route,uiMeta));
  await page.route(/\/api\/checkpoints(?:\?.*)?$/,route=>json(route,route.request().method()==="POST"?{id:"relay-history-checkpoint-"+Date.now(),threadId:harness.threads[0]?.id||null}:{checkpoints:[]}));
  await page.route(/\/api\/checkpoints\/link$/,route=>json(route,{ok:true}));
  await page.route(/\/api\/context\/packet$/,route=>json(route,{id:"relay-history-context",skipped:true,budget:{reserveTokens:1024}}));
  await page.route(/\/api\/verification\/plan-turn$/,route=>json(route,{supported:false}));
  await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  page.on("websocket",socket=>socket.on("framesent",frame=>{try{const message=JSON.parse(String(frame.payload));if(message?.method)sent.push({method:message.method,params:message.params||{}})}catch{}}));
  await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
  return {sent};
}
