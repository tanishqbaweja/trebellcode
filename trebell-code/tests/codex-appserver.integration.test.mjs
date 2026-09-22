import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { createGuiServer } from "../src/gui-server.mjs";

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
  } finally {
    try{ws?.close();}catch{}
    await gui.close();
    await rm(home,{recursive:true,force:true,maxRetries:30,retryDelay:100});
  }
});
