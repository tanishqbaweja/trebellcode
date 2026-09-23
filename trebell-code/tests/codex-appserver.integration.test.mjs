import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { createGuiServer } from "../src/gui-server.mjs";
import { TrebellStateStore } from "../src/trebell-state.mjs";

async function freePort() {
  const server=createServer();
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  const port=server.address().port;
  await new Promise(resolve=>server.close(resolve));
  return port;
}

function rpc(ws,id,method,params={}) {
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error(`${method} timed out`)),15000);
    const onMessage=(data)=>{
      let msg;
      try{msg=JSON.parse(String(data));}catch{return;}
      if(msg.id!==id) return;
      clearTimeout(timer);
      ws.off("message",onMessage);
      if(msg.error) reject(new Error(msg.error.message||JSON.stringify(msg.error)));
      else resolve(msg.result);
    };
    ws.on("message",onMessage);
    ws.send(JSON.stringify({id,method,params}));
  });
}

function rpcOutcome(ws,id,method,params={}) {
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error(`${method} timed out`)),15000);
    const onMessage=(data)=>{
      let msg;
      try{msg=JSON.parse(String(data));}catch{return;}
      if(msg.id!==id) return;
      clearTimeout(timer);
      ws.off("message",onMessage);
      resolve(msg.error?{ok:false,error:msg.error}:{ok:true,result:msg.result});
    };
    ws.on("message",onMessage);
    ws.send(JSON.stringify({id,method,params}));
  });
}

test("real Codex app-server is reachable through Trebell browser relay", {timeout:45000}, async () => {
  const [port,appPort]=await Promise.all([freePort(),freePort()]);
  const home=await mkdtemp(join(tmpdir(),"trebell-relay-integration-"));
  const env={...process.env,TREBELL_HOME:home};
  const gui=await createGuiServer({port,appPort,mock:false,env});
  let ws;
  try{
    let boot=null;
    for(let i=0;i<80;i++){
      boot=await fetch(gui.url+"/api/bootstrap").then(r=>r.json());
      if(boot.appServerReady) break;
      await new Promise(resolve=>setTimeout(resolve,200));
    }
    assert.equal(boot.appServerReady,true,"Codex app-server never became ready");
    assert.match(boot.wsUrl,/\/api\/codex\/ws$/);

    ws=new WebSocket(boot.wsUrl,{origin:gui.url});
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error("relay websocket did not open")),10000);
      ws.once("open",()=>{clearTimeout(timer);resolve();});
      ws.once("error",error=>{clearTimeout(timer);reject(error);});
    });

    const initialized=await rpc(ws,1,"initialize",{
      clientInfo:{name:"trebell-code-test",title:"Trebell Code Test",version:"0.5.0"},
      capabilities:{experimentalApi:true},
    });
    assert.ok(initialized);
    ws.send(JSON.stringify({method:"initialized",params:{}}));

    const threads=await rpc(ws,2,"thread/list",{
      limit:5,
      modelProviders:["freebuff"],
      sortKey:"updated_at",
      sortDirection:"desc",
    });
    assert.ok(Array.isArray(threads.data));

    const command=process.platform==="win32"
      ? ["cmd.exe","/d","/s","/c","echo trebell-relay-ok"]
      : ["sh","-lc","printf trebell-relay-ok"];
    const executed=await rpc(ws,3,"command/exec",{
      command,
      cwd:process.cwd(),
      timeoutMs:10000,
      sandboxPolicy:{type:"dangerFullAccess"},
    });
    assert.equal(executed.exitCode,0,JSON.stringify(executed));
    assert.match(executed.stdout,/trebell-relay-ok/);

    const recoveryThread=await rpc(ws,4,"thread/start",{
      cwd:process.cwd(),
      modelProvider:"freebuff",
      approvalPolicy:"never",
      sandbox:"danger-full-access",
      ephemeral:true,
      threadSource:"trebell-code",
    });
    const recoveryTurn=await rpc(ws,5,"turn/start",{
      threadId:recoveryThread.thread.id,
      input:[],
      turnTrigger:"trebell-restart-continuation",
    });
    assert.ok(recoveryTurn.turn?.id,"Codex must accept an empty-input promptless continuation turn");
    assert.equal(recoveryTurn.turn.status,"inProgress");
    await rpcOutcome(ws,6,"turn/interrupt",{threadId:recoveryThread.thread.id,turnId:recoveryTurn.turn.id});

    const capabilityCalls=[
      ["account/read",{refreshToken:false}],
      ["account/rateLimits/read",{excludeResetCreditDetails:true}],
      ["account/usage/read",{}],
      ["config/read",{includeLayers:true,cwd:process.cwd()}],
      ["mcpServerStatus/list",{limit:20,detail:"full",threadId:null}],
      ["plugin/list",{cwds:[process.cwd()],forceRefetch:false}],
      ["plugin/share/list",{}],
      ["plugin/share/save",{pluginPath:join(home,"missing-plugin"),discoverability:"PRIVATE",shareTargets:[]}],
      ["plugin/share/checkout",{remotePluginId:"trebell-invalid-plugin-share"}],
      ["plugin/share/delete",{remotePluginId:"trebell-invalid-plugin-share"}],
      ["plugin/share/updateTargets",{remotePluginId:"trebell-invalid-plugin-share",discoverability:"PRIVATE",shareTargets:[]}],
      ["hooks/list",{cwds:[process.cwd()]}],
      ["experimentalFeature/list",{limit:100,threadId:null}],
      ["modelProvider/capabilities/read",{}],
      ["memory/status",{minConsolidatedThreads:1}],
      ["externalAgentConfig/detect",{includeHome:true,cwds:[process.cwd()],maxSessions:10,maxSessionAgeDays:30}],
    ];
    let id=20;
    for(const [method,params] of capabilityCalls){
      const outcome=await rpcOutcome(ws,id++,method,params);
      if(outcome.ok)continue;
      assert.notEqual(outcome.error?.code,-32601,`${method} must exist in the bundled Codex app-server`);
      assert.doesNotMatch(String(outcome.error?.message||""),/method not found|unknown method/i,`${method} must be a real capability`);
    }
    const apps=await rpcOutcome(ws,id++,"app/list",{limit:10,threadId:null,forceRefetch:false});
    if(apps.ok&&apps.result?.data?.length){
      const appId=apps.result.data[0].id;
      const detail=await rpcOutcome(ws,id++,"app/read",{appIds:[appId],threadId:null,includeTools:true});
      assert.equal(detail.ok,true,detail.error?.message||"app/read failed");
      assert.equal(detail.result.apps?.[0]?.id,appId);
      assert.ok(Array.isArray(detail.result.apps?.[0]?.toolSummaries)||detail.result.apps?.[0]?.toolSummaries===null);
    }else if(!apps.ok){
      assert.notEqual(apps.error?.code,-32601,"app/list must exist in the bundled Codex app-server");
      assert.doesNotMatch(String(apps.error?.message||""),/method not found|unknown method/i);
    }
    const memoryStatus=await rpc(ws,id++,"memory/status",{minConsolidatedThreads:1});
    assert.equal(typeof memoryStatus.v2ConsolidatedThreads,"number");
    assert.equal(typeof memoryStatus.v2Ready,"boolean");
    const memoryReset=await rpcOutcome(ws,id++,"memory/reset");
    assert.equal(memoryReset.ok,true,memoryReset.error?.message||"memory/reset failed in the disposable integration home");
  } finally {
    try{ws?.close();}catch{}
    await gui.close();
    await rm(home,{recursive:true,force:true,maxRetries:30,retryDelay:100});
  }
});

test("compatible Codex profiles switch an existing thread through a separate app-server",{timeout:60000},async()=>{
  const [port,appPort]=await Promise.all([freePort(),freePort()]);
  const home=await mkdtemp(join(tmpdir(),"trebell-codex-profiles-"));
  const env={...process.env,TREBELL_HOME:home};
  const shared=join(home,"shared-codex"),shadow=join(home,"personal-codex"),isolated=join(home,"isolated-codex");
  const persisted=new TrebellStateStore(env);
  persisted.updateSettings({
    agentRuntime:"codex",
    agentRuntimeInstanceId:"codex-work",
    agentRuntimeInstances:[
      {id:"codex-work",kind:"codex",displayName:"Work",enabled:true,homePath:shared,shadowHomePath:"",environment:{}},
      {id:"codex-personal",kind:"codex",displayName:"Personal",enabled:true,homePath:shared,shadowHomePath:shadow,environment:{}},
      {id:"codex-isolated",kind:"codex",displayName:"Isolated",enabled:true,homePath:isolated,shadowHomePath:"",environment:{}},
    ],
  });
  const gui=await createGuiServer({port,appPort,mock:false,env});let ws;
  try{
    let boot=null;for(let i=0;i<80;i++){boot=await fetch(gui.url+"/api/bootstrap").then(response=>response.json());if(boot.appServerReady)break;await new Promise(resolve=>setTimeout(resolve,200))}
    assert.equal(boot.appServerReady,true,"primary Codex profile did not become ready");
    ws=new WebSocket(boot.wsUrl,{origin:gui.url});await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});
    await rpc(ws,1,"initialize",{clientInfo:{name:"trebell-profile-test",title:"Trebell Profile Test",version:"1.0.0"},capabilities:{experimentalApi:true}});ws.send(JSON.stringify({method:"initialized",params:{}}));
    const started=await rpc(ws,2,"thread/start",{cwd:process.cwd(),modelProvider:"freebuff",approvalPolicy:"never",sandbox:"danger-full-access",ephemeral:false,threadSource:"trebell-code"});
    const threadId=started.thread.id;assert.ok(threadId);
    const memoryDisabled=await rpcOutcome(ws,30,"thread/memoryMode/set",{threadId,mode:"disabled"});
    assert.equal(memoryDisabled.ok,true,memoryDisabled.error?.message||"thread memory disable failed");
    const memoryEnabled=await rpcOutcome(ws,31,"thread/memoryMode/set",{threadId,mode:"enabled"});
    assert.equal(memoryEnabled.ok,true,memoryEnabled.error?.message||"thread memory enable failed");
    const firstTurn=await rpc(ws,3,"turn/start",{threadId,input:[],turnTrigger:"trebell-profile-persistence"});
    assert.ok(firstTurn.turn?.id);await rpcOutcome(ws,4,"turn/interrupt",{threadId,turnId:firstTurn.turn.id});
    for(let i=0;i<60;i++){
      const current=await fetch(gui.url+"/api/thread-meta?threadId="+encodeURIComponent(threadId)).then(response=>response.json());if(current.active===false)break;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    const profiles=await rpc(ws,5,"thread/runtimeInstances/list",{threadId});
    assert.equal(profiles.supported,true);assert.equal(profiles.currentInstanceId,"codex-work");assert.equal(profiles.label,"Codex profile");
    assert.deepEqual(profiles.items.map(item=>item.id).sort(),["codex-personal","codex-work"]);
    const background=await rpc(ws,20,"thread/start",{cwd:process.cwd(),modelProvider:"freebuff",approvalPolicy:"never",sandbox:"danger-full-access",ephemeral:false,threadSource:"trebell-code"});
    const backgroundTurn=await rpc(ws,21,"turn/start",{threadId:background.thread.id,input:[],turnTrigger:"trebell-concurrent-thread"});
    assert.equal(backgroundTurn.turn?.status,"inProgress","a second Codex thread should keep its own writer while another thread changes profiles");
    for(let i=0;i<60;i++){
      const current=await fetch(gui.url+"/api/thread-meta?threadId="+encodeURIComponent(background.thread.id)).then(response=>response.json());if(current.active===false)break;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    const switched=await rpc(ws,6,"thread/runtimeInstance/set",{threadId,instanceId:"codex-personal"});
    assert.equal(switched.runtimeInstanceId,"codex-personal");
    const resumed=await rpc(ws,7,"thread/resume",{threadId,modelProvider:"freebuff",excludeTurns:false});
    assert.equal(resumed.thread.id,threadId);
    const backgroundSecondTurn=await rpcOutcome(ws,22,"turn/start",{threadId:background.thread.id,input:[],turnTrigger:"trebell-concurrent-thread-after-profile-switch"});
    assert.equal(backgroundSecondTurn.ok,true,`switching one thread must not tear down or steal another thread's Codex runtime: ${JSON.stringify(backgroundSecondTurn.error||null)}`);
    assert.ok(backgroundSecondTurn.result?.turn?.id);
    const after=await rpc(ws,8,"thread/runtimeInstances/list",{threadId});assert.equal(after.currentInstanceId,"codex-personal");
    const meta=await fetch(gui.url+"/api/thread-meta?threadId="+encodeURIComponent(threadId)).then(response=>response.json());assert.equal(meta.runtimeInstanceId,"codex-personal");
    const unsubscribed=await rpc(ws,23,"thread/unsubscribe",{threadId});
    assert.match(String(unsubscribed.status||""),/unsubscribed|notSubscribed/i);
    await new Promise(resolve=>setTimeout(resolve,100));
    const resumedAfterUnsubscribe=await rpcOutcome(ws,24,"thread/resume",{threadId,modelProvider:"freebuff",excludeTurns:false});
    assert.equal(resumedAfterUnsubscribe.ok,true,`an idle unsubscribed thread must restart its routed Codex process on demand: ${JSON.stringify(resumedAfterUnsubscribe.error||null)}`);
    assert.equal(resumedAfterUnsubscribe.result?.thread?.id,threadId);
    const incompatible=await rpcOutcome(ws,9,"thread/runtimeInstance/set",{threadId,instanceId:"codex-isolated"});
    assert.equal(incompatible.ok,false);assert.match(incompatible.error?.message||"",/different CODEX_HOME/i);
  }finally{try{ws?.close()}catch{}await gui.close();await rm(home,{recursive:true,force:true,maxRetries:30,retryDelay:100})}
});
