import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
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

async function waitForNonEmptyRollout(root,{timeoutMs=5000}={}){
  const started=Date.now();
  while(Date.now()-started<timeoutMs){
    try{
      const entries=await readdir(root,{recursive:true});
      for(const entry of entries){
        if(!String(entry).endsWith(".jsonl"))continue;
        const info=await stat(join(root,String(entry))).catch(()=>null);if(info?.size>0)return join(root,String(entry));
      }
    }catch{}
    await new Promise(resolve=>setTimeout(resolve,25));
  }
  throw new Error("Codex rollout did not become non-empty before timeout");
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
      if(msg.error) reject(new Error(`${method}: ${msg.error.message||JSON.stringify(msg.error)}`));
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

function waitNotification(ws,method,predicate=()=>true,timeoutMs=15000){
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{ws.off("message",onMessage);reject(new Error(`${method} notification timed out`))},timeoutMs);
    const onMessage=data=>{let message;try{message=JSON.parse(String(data))}catch{return}if(message.method!==method||!predicate(message.params||{}))return;clearTimeout(timer);ws.off("message",onMessage);resolve(message.params||{})};
    ws.on("message",onMessage);
  });
}

test("Trebell owns the Codex repository dynamic-tool namespace", {timeout:45000}, async () => {
  const [port,appPort]=await Promise.all([freePort(),freePort()]);
  const home=await mkdtemp(join(tmpdir(),"trebell-repository-tools-"));
  const env={...process.env,TREBELL_HOME:home};
  const gui=await createGuiServer({port,appPort,mock:false,env});
  let ws;
  try{
    let boot=null;
    for(let i=0;i<80;i++){
      boot=await fetch(gui.url+"/api/bootstrap").then(response=>response.json());
      if(boot.appServerReady)break;
      await new Promise(resolve=>setTimeout(resolve,200));
    }
    assert.equal(boot.appServerReady,true,"Codex app-server never became ready");
    ws=new WebSocket(boot.wsUrl,{origin:gui.url});
    await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});
    await rpc(ws,1,"initialize",{clientInfo:{name:"trebell-repository-tool-test",title:"Trebell Repository Tool Test",version:"1.0.0"},capabilities:{experimentalApi:true}});
    ws.send(JSON.stringify({method:"initialized",params:{}}));

    const started=await rpc(ws,2,"thread/start",{
      cwd:process.cwd(),
      modelProvider:"freebuff",
      approvalPolicy:"never",
      sandbox:"danger-full-access",
      ephemeral:true,
      threadSource:"trebell-repository-tool-test",
      dynamicTools:[{type:"not-a-real-dynamic-tool",name:"trebell_repo"}],
    });
    assert.ok(started.thread?.id,"backend repository-tool replacement should make thread/start valid");
  }finally{
    try{ws?.close()}catch{}
    await gui.close();
    await rm(home,{recursive:true,force:true,maxRetries:30,retryDelay:100});
  }
});

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
    const liveFeatures=await rpc(ws,6,"experimentalFeature/list",{limit:200,threadId:recoveryThread.thread.id});
    const liveSwitch=liveFeatures.data?.find(feature=>feature.name==="step_model_switching");
    if(liveSwitch?.enabled){
      const liveTurnSettings=await rpc(ws,7,"turn/settings/update",{threadId:recoveryThread.thread.id,turnId:recoveryTurn.turn.id,serviceTier:null});
      assert.equal(liveTurnSettings.status,"applied","an enabled running Codex turn should accept native live setting publication");
    }else{
      const liveTurnSettings=await rpcOutcome(ws,7,"turn/settings/update",{threadId:recoveryThread.thread.id,turnId:recoveryTurn.turn.id,serviceTier:null});
      assert.equal(liveTurnSettings.ok,false,"disabled step model switching should remain feature-gated");
      assert.notEqual(liveTurnSettings.error?.code,-32601,"turn/settings/update must still be a real bundled Codex method");
      assert.match(String(liveTurnSettings.error?.message||""),/step_model_switching/i);
    }
    await rpcOutcome(ws,8,"turn/interrupt",{threadId:recoveryThread.thread.id,turnId:recoveryTurn.turn.id});
    const guardianOverride=await rpcOutcome(ws,9,"thread/approveGuardianDeniedAction",{
      threadId:recoveryThread.thread.id,
      event:{
        id:"trebell-integration-guardian-review",
        target_item_id:"trebell-integration-command",
        turn_id:recoveryTurn.turn.id,
        started_at_ms:Date.now()-10,
        completed_at_ms:Date.now(),
        status:"denied",
        risk_level:"low",
        user_authorization:"high",
        rationale:"Integration test denial used to verify native override routing.",
        decision_source:"agent",
        action:{type:"command",source:"shell",command:"echo trebell-guardian-override",cwd:process.cwd()},
      },
    });
    assert.equal(guardianOverride.ok,true,guardianOverride.error?.message||"thread/approveGuardianDeniedAction failed");
    const capabilityCalls=[
      ["account/read",{refreshToken:false}],
      ["account/rateLimits/read",{excludeResetCreditDetails:true}],
      ["account/usage/read",{}],
      ["config/read",{includeLayers:true,cwd:process.cwd()}],
      ["configRequirements/read",{}],
      ["mcpServerStatus/list",{limit:20,detail:"full",threadId:null}],
      ["plugin/list",{cwds:[process.cwd()],forceRefetch:false}],
      ["plugin/search",{searchTerm:"trebell-integration-no-match",scope:"workspace",cwds:[process.cwd()],limit:1}],
      ["plugin/installed",{cwds:[process.cwd()],installSuggestionPluginNames:[]}],
      ["plugin/reconcile",{reason:"trebell-integration"}],
      ["plugin/read",{marketplacePath:join(home,"missing-marketplace"),remoteMarketplaceName:null,pluginName:"trebell-missing-plugin"}],
      ["plugin/share/list",{}],
      ["plugin/share/save",{pluginPath:join(home,"missing-plugin"),discoverability:"PRIVATE",shareTargets:[]}],
      ["plugin/share/checkout",{remotePluginId:"trebell-invalid-plugin-share"}],
      ["plugin/share/delete",{remotePluginId:"trebell-invalid-plugin-share"}],
      ["plugin/share/updateTargets",{remotePluginId:"trebell-invalid-plugin-share",discoverability:"PRIVATE",shareTargets:[]}],
      ["hooks/list",{cwds:[process.cwd()]}],
      ["experimentalFeature/list",{limit:100,threadId:null}],
      ["modelProvider/capabilities/read",{}],
      ["memory/status",{minConsolidatedThreads:1}],
      ["windowsSandbox/readiness",{}],
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
    const sandboxReadiness=await rpc(ws,id++,"windowsSandbox/readiness",{});
    assert.ok(["ready","notConfigured","updateRequired"].includes(sandboxReadiness.status),`unexpected Windows sandbox readiness: ${JSON.stringify(sandboxReadiness)}`);
    const skillDisabled=await rpc(ws,id++,"skills/config/write",{path:null,name:"trebell-integration-skill",enabled:false});
    assert.equal(skillDisabled.effectiveEnabled,false);
    const skillEnabled=await rpc(ws,id++,"skills/config/write",{path:null,name:"trebell-integration-skill",enabled:true});
    assert.equal(skillEnabled.effectiveEnabled,true);
    const runtimeSkillRoot=join(home,"runtime-skills");await mkdir(runtimeSkillRoot,{recursive:true});
    const skillRoots=await rpcOutcome(ws,id++,"skills/extraRoots/set",{extraRoots:[runtimeSkillRoot]});
    assert.equal(skillRoots.ok,true,skillRoots.error?.message||"skills/extraRoots/set failed");
    const memoryReset=await rpcOutcome(ws,id++,"memory/reset");
    assert.equal(memoryReset.ok,true,memoryReset.error?.message||"memory/reset failed in the disposable integration home");
  } finally {
    try{ws?.close();}catch{}
    await gui.close();
    await rm(home,{recursive:true,force:true,maxRetries:30,retryDelay:100});
  }
});

test("real Codex app-server exposes native project ownership and collaboration modes without starting a turn",{timeout:30000},async()=>{
  const [port,appPort]=await Promise.all([freePort(),freePort()]);
  const home=await mkdtemp(join(tmpdir(),"trebell-codex-project-integration-"));
  const env={...process.env,TREBELL_HOME:home};
  const gui=await createGuiServer({port,appPort,mock:false,env});
  let ws;
  try{
    let boot=null;
    for(let i=0;i<80;i++){
      boot=await fetch(gui.url+"/api/bootstrap").then(r=>r.json());
      if(boot.appServerReady)break;
      await new Promise(resolve=>setTimeout(resolve,200));
    }
    assert.equal(boot.appServerReady,true,"Codex app-server never became ready");
    ws=new WebSocket(boot.wsUrl,{origin:gui.url});
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error("relay websocket did not open")),10000);
      ws.once("open",()=>{clearTimeout(timer);resolve()});
      ws.once("error",error=>{clearTimeout(timer);reject(error)});
    });
    await rpc(ws,1,"initialize",{clientInfo:{name:"trebell-project-test",title:"Trebell Project Test",version:"0.5.0"},capabilities:{experimentalApi:true}});
    ws.send(JSON.stringify({method:"initialized",params:{}}));

    const modes=await rpc(ws,2,"collaborationMode/list",{});
    assert.ok(Array.isArray(modes.data),"collaborationMode/list should return a data array");
    assert.ok(modes.data.some(item=>item?.mode),"Codex should expose at least one native collaboration mode");

    const nativeProject=await rpc(ws,3,"project/create",{
      name:"Trebell integration project",
      roots:[{path:process.cwd()}],
      metadata:{trebellManaged:"true",trebellProjectId:"trebell-integration-project"},
      idempotencyKey:"trebell-code:trebell-integration-project",
    });
    assert.ok(nativeProject.project?.id,"project/create should return a native project id");
    const projectedThread=await rpc(ws,4,"thread/start",{
      cwd:process.cwd(),
      modelProvider:"freebuff",
      approvalPolicy:"never",
      sandbox:"danger-full-access",
      ephemeral:false,
      threadSource:"trebell-code",
      projectId:nativeProject.project.id,
    });
    assert.equal(projectedThread.thread?.projectId,nativeProject.project.id,"thread/start should persist native project ownership");
    const projectList=await rpc(ws,5,"project/list",{limit:100});
    assert.ok(projectList.data?.some(project=>project.id===nativeProject.project.id),"project/list should include the Trebell-owned native project");
  }finally{
    try{ws?.close()}catch{}
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
    const firstStartedNotification=waitNotification(ws,"turn/started",params=>params.threadId===threadId);
    const firstCompletedNotification=waitNotification(ws,"turn/completed",params=>params.threadId===threadId);
    const firstTurn=await rpc(ws,3,"turn/start",{threadId,input:[],turnTrigger:"trebell-profile-persistence"});
    assert.ok(firstTurn.turn?.id);await firstStartedNotification;await rpcOutcome(ws,4,"turn/interrupt",{threadId,turnId:firstTurn.turn.id});await firstCompletedNotification;
    const profiles=await rpc(ws,5,"thread/runtimeInstances/list",{threadId});
    assert.equal(profiles.supported,true);assert.equal(profiles.currentInstanceId,"codex-work");assert.equal(profiles.label,"Codex profile");
    assert.deepEqual(profiles.items.map(item=>item.id).sort(),["codex-personal","codex-work"]);
    const background=await rpc(ws,20,"thread/start",{cwd:process.cwd(),modelProvider:"freebuff",approvalPolicy:"never",sandbox:"danger-full-access",ephemeral:false,threadSource:"trebell-code"});
    const backgroundStartedNotification=waitNotification(ws,"turn/started",params=>params.threadId===background.thread.id);
    const backgroundCompletedNotification=waitNotification(ws,"turn/completed",params=>params.threadId===background.thread.id);
    const backgroundTurn=await rpc(ws,21,"turn/start",{threadId:background.thread.id,input:[],turnTrigger:"trebell-concurrent-thread"});
    assert.equal(backgroundTurn.turn?.status,"inProgress","a second Codex thread should keep its own writer while another thread changes profiles");
    await backgroundStartedNotification;
    const backgroundInterrupted=await rpcOutcome(ws,32,"turn/interrupt",{threadId:background.thread.id,turnId:backgroundTurn.turn.id});
    assert.equal(backgroundInterrupted.ok,true,backgroundInterrupted.error?.message||"background turn interrupt failed");
    await backgroundCompletedNotification;
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

test("native Codex queue persists, edits, reorders, deletes and starts follow-ups",{timeout:60000},async()=>{
  const [port,appPort]=await Promise.all([freePort(),freePort()]);
  const home=await mkdtemp(join(tmpdir(),"trebell-codex-queue-"));
  const env={...process.env,TREBELL_HOME:home};const gui=await createGuiServer({port,appPort,mock:false,env});let ws;
  try{
    let boot=null;for(let i=0;i<80;i++){boot=await fetch(gui.url+"/api/bootstrap").then(response=>response.json());if(boot.appServerReady)break;await new Promise(resolve=>setTimeout(resolve,200))}
    assert.equal(boot.appServerReady,true,"Codex app-server did not become ready for queue test");
    ws=new WebSocket(boot.wsUrl,{origin:gui.url});await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});
    await rpc(ws,1,"initialize",{clientInfo:{name:"trebell-queue-test",title:"Trebell Queue Test",version:"1.0.0"},capabilities:{experimentalApi:true}});ws.send(JSON.stringify({method:"initialized",params:{}}));
    const started=await rpc(ws,2,"thread/start",{cwd:process.cwd(),modelProvider:"freebuff",approvalPolicy:"never",sandbox:"danger-full-access",ephemeral:false,threadSource:"trebell-code"});
    const threadId=started.thread.id;assert.ok(threadId);
    const seedTurn=await rpc(ws,3,"turn/start",{threadId,input:[],turnTrigger:"trebell-queue-persistence"});
    assert.ok(seedTurn.turn?.id);await waitForNonEmptyRollout(join(home,"codex","sessions"));await rpcOutcome(ws,4,"turn/interrupt",{threadId,turnId:seedTurn.turn.id});
    for(let i=0;i<60;i++){
      const current=await fetch(gui.url+"/api/thread-meta?threadId="+encodeURIComponent(threadId)).then(response=>response.json());if(current.active===false)break;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    await rpc(ws,5,"thread/unsubscribe",{threadId});await new Promise(resolve=>setTimeout(resolve,150));
    const first=await rpc(ws,6,"thread/queue/add",{threadId,input:[{type:"text",text:"first queued follow-up",textElements:[]}],clientUserMessageId:"queue-first"});
    const second=await rpc(ws,7,"thread/queue/add",{threadId,input:[{type:"text",text:"second queued follow-up",textElements:[]}],clientUserMessageId:"queue-second"});
    assert.ok(first.queuedSubmission?.id);assert.ok(second.queuedSubmission?.id);
    let listed=await rpc(ws,8,"thread/queue/list",{threadId,limit:20});
    assert.deepEqual(listed.data.map(item=>item.clientUserMessageId),["queue-first","queue-second"]);
    const updated=await rpc(ws,9,"thread/queue/update",{threadId,queuedSubmissionId:second.queuedSubmission.id,input:[{type:"text",text:"second queued follow-up edited",textElements:[]}]});
    assert.equal(updated.queuedSubmission.input?.[0]?.text,"second queued follow-up edited");
    await rpc(ws,10,"thread/queue/reorder",{threadId,queuedSubmissionIds:[second.queuedSubmission.id,first.queuedSubmission.id]});
    listed=await rpc(ws,11,"thread/queue/list",{threadId,limit:20});assert.deepEqual(listed.data.map(item=>item.id),[second.queuedSubmission.id,first.queuedSubmission.id]);
    const deleted=await rpc(ws,12,"thread/queue/delete",{threadId,queuedSubmissionId:first.queuedSubmission.id});assert.equal(deleted.deleted,true);
    listed=await rpc(ws,13,"thread/queue/list",{threadId,limit:20});assert.deepEqual(listed.data.map(item=>item.id),[second.queuedSubmission.id]);
    const third=await rpc(ws,14,"thread/queue/add",{threadId,input:[{type:"text",text:"third queued follow-up",textElements:[]}],clientUserMessageId:"queue-third"});assert.ok(third.queuedSubmission?.id);
    const autoStarted=waitNotification(ws,"turn/started",params=>params.threadId===threadId);
    await rpc(ws,15,"thread/resume",{threadId,modelProvider:"freebuff",excludeTurns:false});
    const autoTurn=await autoStarted;const autoTurnId=autoTurn.turn?.id||autoTurn.turnId;assert.ok(autoTurnId,"resume should auto-dispatch the first queued submission");
    const interrupted=waitNotification(ws,"turn/completed",params=>params.threadId===threadId&&(params.turn?.id||params.turnId)===autoTurnId);
    await rpcOutcome(ws,16,"turn/interrupt",{threadId,turnId:autoTurnId});await interrupted;
    listed=await rpc(ws,17,"thread/queue/list",{threadId,limit:20});assert.deepEqual(listed.data.map(item=>item.id),[third.queuedSubmission.id]);
    const launched=await rpc(ws,18,"thread/queue/start",{threadId,queuedSubmissionId:third.queuedSubmission.id});assert.equal(launched.turn?.status,"inProgress");
    const afterStart=await rpc(ws,19,"thread/queue/list",{threadId,limit:20});assert.equal(afterStart.data.length,0);
    await rpcOutcome(ws,20,"turn/interrupt",{threadId,turnId:launched.turn.id});
  }finally{try{ws?.close()}catch{}await gui.close();await rm(home,{recursive:true,force:true,maxRetries:30,retryDelay:100})}
});

test("native Codex history resumes with bounded item pages and keeps turn pagination compatible",{timeout:60000},async()=>{
  const [port,appPort]=await Promise.all([freePort(),freePort()]);
  const home=await mkdtemp(join(tmpdir(),"trebell-codex-history-page-"));
  const env={...process.env,TREBELL_HOME:home};const gui=await createGuiServer({port,appPort,mock:false,env});let ws;
  try{
    let boot=null;for(let i=0;i<80;i++){boot=await fetch(gui.url+"/api/bootstrap").then(response=>response.json());if(boot.appServerReady)break;await new Promise(resolve=>setTimeout(resolve,200))}
    assert.equal(boot.appServerReady,true,"Codex app-server did not become ready for history pagination test");
    ws=new WebSocket(boot.wsUrl,{origin:gui.url});await new Promise((resolve,reject)=>{ws.once("open",resolve);ws.once("error",reject)});
    await rpc(ws,1,"initialize",{clientInfo:{name:"trebell-history-test",title:"Trebell History Test",version:"1.0.0"},capabilities:{experimentalApi:true}});ws.send(JSON.stringify({method:"initialized",params:{}}));
    const started=await rpc(ws,2,"thread/start",{cwd:process.cwd(),modelProvider:"freebuff",approvalPolicy:"never",sandbox:"danger-full-access",ephemeral:false,threadSource:"trebell-code"});
    const threadId=started.thread.id;assert.ok(threadId);
    for(let index=0;index<3;index++){
      const userPersisted=waitNotification(ws,"item/started",params=>params.threadId===threadId&&params.item?.type==="userMessage");
      const completed=waitNotification(ws,"turn/completed",params=>params.threadId===threadId);
      const turn=await rpc(ws,10+index*2,"turn/start",{threadId,input:[{type:"text",text:`history pagination turn ${index+1}`,textElements:[]}],turnTrigger:`trebell-history-page-${index+1}`});assert.ok(turn.turn?.id);
      await userPersisted;
      if(index===0)await waitForNonEmptyRollout(join(home,"codex","sessions"));
      await rpcOutcome(ws,11+index*2,"turn/interrupt",{threadId,turnId:turn.turn.id});await completed;
      for(let attempt=0;attempt<80;attempt++){
        const current=await fetch(gui.url+"/api/thread-meta?threadId="+encodeURIComponent(threadId)).then(response=>response.json());if(current.active===false)break;
        await new Promise(resolve=>setTimeout(resolve,25));
      }
    }
    await rpc(ws,20,"thread/unsubscribe",{threadId});await new Promise(resolve=>setTimeout(resolve,150));
    const resumed=await rpc(ws,21,"thread/resume",{threadId,modelProvider:"freebuff",excludeTurns:true});
    assert.equal(resumed.thread.id,threadId);assert.equal(resumed.thread.turns.length,0,"excludeTurns should keep the resumed thread payload bounded");
    assert.ok(resumed.itemsBackwardsCursor,"paginated resume should expose the newest item cursor");
    const itemPage=await rpc(ws,25,"thread/items/list",{threadId,cursor:resumed.itemsBackwardsCursor,limit:2,sortDirection:"desc"});
    assert.ok(itemPage.data?.length,"native item pagination should hydrate persisted history");
    assert.ok(itemPage.data.every(entry=>entry.turnId&&entry.item?.id),"item pages should retain turn ownership");
    assert.ok(resumed.turnsBackwardsCursor,"paginated resume should retain a turn cursor for compatibility");
    const latest=await rpc(ws,22,"thread/turns/list",{threadId,cursor:resumed.turnsBackwardsCursor,limit:1,sortDirection:"desc",itemsView:"notLoaded"});
    assert.equal(latest.data?.length,1);assert.equal(latest.data[0].items.length,0,"metadata-only turn pagination should not hydrate full items");
    const searched=await rpc(ws,23,"thread/searchOccurrences",{threadId,searchTerm:"history pagination turn 1",limit:10});
    assert.ok(searched.data?.length,"native occurrence search should find the persisted first user message");
    const occurrence=searched.data.find(item=>item.snippet?.toLowerCase().includes("history pagination turn 1"))||searched.data[0];
    assert.ok(occurrence.turnCursor);assert.ok(occurrence.turnId);assert.ok(occurrence.itemId);
    const jumpedItems=await rpc(ws,24,"thread/items/list",{threadId,turnId:occurrence.turnId,limit:100,sortDirection:"asc"});
    assert.ok(jumpedItems.data?.some(entry=>entry.item?.id===occurrence.itemId),"the occurrence turn id should hydrate the matching item directly");
    const jumpedTurn=await rpc(ws,26,"thread/turns/list",{threadId,cursor:occurrence.turnCursor,limit:1,itemsView:"notLoaded"});
    assert.equal(jumpedTurn.data?.[0]?.id,occurrence.turnId,"the occurrence turn cursor should locate the matching turn without full hydration");
  }finally{try{ws?.close()}catch{}await gui.close();await rm(home,{recursive:true,force:true,maxRetries:30,retryDelay:100})}
});
