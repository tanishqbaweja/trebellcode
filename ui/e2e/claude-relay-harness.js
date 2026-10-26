import { randomUUID } from "node:crypto";
import { mkdir,mkdtemp,rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachAgentRelay } from "../../src/agent-relay.mjs";
import { AgentThreadStore } from "../../src/agent-thread-store.mjs";
import { TrebellStateStore } from "../../src/trebell-state.mjs";

async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}
const json=(route,value)=>route.fulfill({status:200,contentType:"application/json",body:JSON.stringify(value)});
const CLAUDE={id:"claude-default",kind:"claude",displayName:"Claude Code",enabled:true};
const MODELS={agentRuntime:"claude",ready:true,models:["default"],defaultModel:"default",metadata:{models:[{id:"default",name:"Claude Fixture",provider:"claude",agent:"Claude Code"}]},error:null};

// The Claude Agent SDK as the relay's Claude Code sessions drive it, scripted: query() returns the Query, an async iterator of the
// CLI's messages fed by the streaming-input prompt. Claude Code reports its session (init) as it takes the first message in, and
// turn({message,index,options,emit,signal}) runs for each user message in turn, a steer ("now") at once into the running turn; signal
// aborts once the query closes. control.backgroundTasks(toolUseId,{emit}) answers a move of a foreground task to the background.
function scriptedClaudeSdk(turn,control={}){
  const query=({prompt,options})=>{
    const items=[],waiters=[],stop=new AbortController();let done=false;
    const emit=value=>{if(done)return;const waiter=waiters.shift();if(waiter)waiter({value,done:false});else items.push(value)};
    const end=()=>{if(done)return;done=true;stop.abort();for(const waiter of waiters.splice(0))waiter({value:undefined,done:true})};
    void (async()=>{
      let index=0,chain=Promise.resolve();
      for await(const message of prompt){
        if(index===0)emit({type:"system",subtype:"init",session_id:options.sessionId||options.resume,model:"claude-fixture",permissionMode:options.permissionMode,tools:[],mcp_servers:[],slash_commands:[],agents:[],capabilities:[]});
        const position=index++,run=()=>turn({message,index:position,options,emit,signal:stop.signal});
        (message.priority==="now"?Promise.resolve().then(run):(chain=chain.then(run))).catch(()=>end());
      }
      await chain.catch(()=>{});
      end();
    })();
    return {
      next:()=>items.length?Promise.resolve({value:items.shift(),done:false}):done?Promise.resolve({value:undefined,done:true}):new Promise(resolve=>waiters.push(resolve)),
      return:()=>{end();return Promise.resolve({value:undefined,done:true})},[Symbol.asyncIterator](){return this},
      async interrupt(){},close(){end()},async setPermissionMode(){},initializationResult:async()=>({commands:[],agents:[],models:[]}),
      async setMcpServers(servers){return {added:Object.keys(servers),removed:[],errors:{}}},
      async backgroundTasks(toolUseId){return control.backgroundTasks?control.backgroundTasks(toolUseId,{emit}):true},
    };
  };
  return {query,getSessionInfo:async()=>undefined,forkSession:async()=>({}),renameSession:async()=>{},getSessionMessages:async()=>[],deleteSession:async()=>{}};
}
// Claude Code's reply and the result that ends the turn, as a scripted turn emits them.
export const claudeReply=(message,text)=>[
  {type:"assistant",uuid:randomUUID(),parent_tool_use_id:null,message:{id:"msg-"+randomUUID(),content:[{type:"text",text}]}},
  {type:"result",subtype:"success",is_error:false,result:text,user_message_uuid:message.uuid,total_cost_usd:0,usage:{input_tokens:3,output_tokens:1}},
];

// Claude Code threads on the real relay, Claude Code itself answered as installed and signed in and its SDK scripted by turn.
// seedThread stores a Claude thread with no turns yet, in the harness's repository and the given permission mode.
export async function startClaudeRelay({turn,control={}}){
  const root=await mkdtemp(join(tmpdir(),"trebell-claude-relay-")),home=join(root,"home"),repo=join(root,"repo");await mkdir(repo,{recursive:true});
  const env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);
  state.updateSettings({agentRuntime:"claude",agentRuntimeInstanceId:CLAUDE.id,activeEnvironmentId:null});
  const runtimeManager={
    instances:()=>[{...CLAUDE}],activeInstance:()=>({...CLAUDE}),activeRuntime:()=>"claude",compatibleInstanceIds:()=>[CLAUDE.id],
    probe:async()=>({id:CLAUDE.id,name:"Claude Code",available:true,authenticated:true,version:"fixture"}),
    runtimeCwd:cwd=>cwd,processSpawner:()=>null,remoteIo:()=>null,childEnv:()=>({...process.env}),executable:()=>"claude",
  };
  const threadStore=new AgentThreadStore(env),threads=[];
  const seedThread=(name,{permissionProfile="full"}={})=>{
    const thread=threadStore.create({runtime:"claude",cwd:repo,providerSessionId:randomUUID(),model:"default",name,preview:name,providerMeta:{runtimeInstanceId:CLAUDE.id,permissionProfile,projectless:false,environmentId:null}});
    threads.push(thread);return thread;
  };
  const relayServer=createServer((_req,res)=>{res.writeHead(404);res.end()});
  const relay=attachAgentRelay(relayServer,{runtimeManager,threadStore,terminals:{},state,version:"claude-relay-fixture",claudeSdk:scriptedClaudeSdk(turn,control)});
  const port=await freePort();await new Promise((resolve,reject)=>relayServer.listen(port,"127.0.0.1",resolve).once("error",reject));
  return {
    repo,threadStore,threads,seedThread,wsUrl:`ws://127.0.0.1:${port}/api/agent/ws`,
    async close(){await relay.close();await new Promise(resolve=>relayServer.close(()=>resolve()));await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})},
  };
}

// The app's own API answered for a Claude Code window on the relay, every thread in one project at the harness's repository, the
// composer in permissionMode, and a message sent while a turn runs queued or steered into it (followUpMode).
export async function routeClaudeApp(page,harness,{permissionMode="full",followUpMode="queue"}={}){
  const repo=harness.repo,project={id:"claude-relay-project",name:"Claude Relay Project",path:repo,environmentId:null,effectiveSettings:{}};
  let uiMeta={projectless:false,environmentId:null,cwd:repo,runtime:"claude",runtimeInstanceId:CLAUDE.id,permissionMode};
  const settings={onboardingComplete:true,appearance:"dark",appearanceMode:"dark",panelAnimationMs:0,agentRuntime:"claude",agentRuntimeInstanceId:CLAUDE.id,modelProvider:"openai",defaultPermissionMode:permissionMode,defaultWorkspaceMode:"current",followUpMode};
  const status={id:CLAUDE.id,kind:"claude",name:"Claude Code",available:true,installed:true,authenticated:true,version:"fixture"};
  await page.route(/\/api\/bootstrap$/,route=>json(route,{mock:false,provider:"openai",providerReady:true,agentRuntime:"claude",agentRuntimeInstanceId:CLAUDE.id,agentRuntimeReady:true,appServerReady:true,wsUrl:harness.wsUrl,cwd:repo,platform:process.platform,version:"claude-relay-fixture",activeEnvironmentId:null,activeEnvironment:null}));
  await page.route(/\/api\/state$/,route=>json(route,{settings,projects:[project],activeProjectId:project.id,threadMeta:Object.fromEntries(harness.threads.map(thread=>[thread.id,uiMeta]))}));
  // A setting the page saves (the light and dark toggle) holds for its later reads.
  await page.route(/\/api\/settings$/,route=>{if(route.request().method()==="POST")Object.assign(settings,route.request().postDataJSON()||{});return json(route,settings)});
  await page.route(/\/api\/models(?:\?.*)?$/,route=>json(route,MODELS));
  await page.route(/\/api\/agent-runtimes(?:\?.*)?$/,route=>json(route,{selectedRuntime:"claude",selectedInstanceId:CLAUDE.id,definitions:[{id:"claude",name:"Claude Code",protocol:"claude",multipleInstances:false}],instances:[{...CLAUDE}],statuses:[status]}));
  await page.route(/\/api\/projects(?:\?.*)?$/,route=>json(route,route.request().method()==="POST"?{project}:{projects:[project]}));
  await page.route(/\/api\/worktree\/ensure$/,route=>json(route,{ok:true}));
  await page.route(/\/api\/git\/info(?:\?.*)?$/,route=>json(route,{isGit:false,cwd:repo,root:null,branch:null,branches:[],status:[],remotes:[],worktrees:[]}));
  await page.route(/\/api\/thread-meta(?:\?.*)?$/,async route=>{if(route.request().method()==="POST")uiMeta={...uiMeta,...(route.request().postDataJSON()?.patch||{})};await json(route,uiMeta)});
  await page.route(/\/api\/checkpoints(?:\?.*)?$/,route=>json(route,route.request().method()==="POST"?{id:"claude-relay-checkpoint-"+Date.now(),threadId:harness.threads[0]?.id||null}:{checkpoints:[]}));
  await page.route(/\/api\/checkpoints\/link$/,route=>json(route,{ok:true}));
  await page.route(/\/api\/context\/packet$/,route=>json(route,{id:"claude-relay-context",skipped:true,budget:{reserveTokens:1024}}));
  await page.route(/\/api\/verification\/plan-turn$/,route=>json(route,{supported:false}));
  await page.route(/\/api\/environment\/themes$/,route=>json(route,{environmentKey:"local",environmentName:"Local machine",directory:"",themes:[]}));
  await page.addInitScript(()=>localStorage.setItem("trebell-layout-v1",JSON.stringify({sidebarWidth:258,rightPanelWidth:460,terminalHeight:330})));
}
