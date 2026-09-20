import assert from "node:assert/strict";
import { WebSocket } from "ws";

const base=process.argv[2] || "http://127.0.0.1:3210";

async function rpc(ws,id,method,params={}) {
  return await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error(method+" timed out")),15000);
    const handler=(data)=>{
      let msg;
      try{msg=JSON.parse(String(data));}catch{return;}
      if(msg.id!==id) return;
      clearTimeout(timer);
      ws.off("message",handler);
      if(msg.error) reject(new Error(msg.error.message||JSON.stringify(msg.error)));
      else resolve(msg.result);
    };
    ws.on("message",handler);
    ws.send(JSON.stringify({id,method,params}));
  });
}

const boot=await fetch(base+"/api/bootstrap").then(r=>r.json());
assert.equal(boot.version,"0.5.0");
assert.equal(boot.appServerReady,true);
assert.match(boot.wsUrl,/\/api\/codex\/ws$/);

const ws=new WebSocket(boot.wsUrl,{origin:"http://trebell-installed-test.local"});
try{
  await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error("installed relay websocket did not open")),10000);
    ws.once("open",()=>{clearTimeout(timer);resolve();});
    ws.once("error",error=>{clearTimeout(timer);reject(error);});
  });
  await rpc(ws,1,"initialize",{
    clientInfo:{name:"trebell-installed-test",title:"Trebell Installed Test",version:"0.5.0"},
    capabilities:{experimentalApi:true},
  });
  ws.send(JSON.stringify({method:"initialized",params:{}}));
  const threads=await rpc(ws,2,"thread/list",{limit:3,modelProviders:["freebuff"],sortKey:"updated_at",sortDirection:"desc"});
  assert.ok(Array.isArray(threads.data));

  const result=await rpc(ws,3,"command/exec",{
    command:["cmd.exe","/d","/s","/c","echo trebell-installed-relay-ok"],
    timeoutMs:10000,
    sandboxPolicy:{type:"dangerFullAccess"},
  });
  assert.equal(result.exitCode,0,JSON.stringify(result));
  assert.match(result.stdout,/trebell-installed-relay-ok/i);
  console.log("Installed Trebell relay + Codex command execution verified.");
} finally {
  ws.close();
}
