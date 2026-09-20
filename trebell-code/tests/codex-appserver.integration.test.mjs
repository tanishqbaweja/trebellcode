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
  } finally {
    try{ws?.close();}catch{}
    await gui.close();
    await rm(home,{recursive:true,force:true,maxRetries:30,retryDelay:100});
  }
});
