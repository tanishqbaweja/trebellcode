import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteAuthStore } from "../src/remote-auth-store.mjs";
import { createRemoteControlServer } from "../src/remote-control.mjs";

test("remote pairing is one-time, hashed at rest, and revocable", async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-remote-auth-"));
  try{
    const store=new RemoteAuthStore({...process.env,TREBELL_HOME:home});
    const pairing=store.createPairing({ttlMs:60_000});
    const paired=store.exchangePairing(pairing.token,{name:"Test phone",userAgent:"test"});
    assert.equal(store.authenticate(paired.token)?.name,"Test phone");
    await assert.rejects(async()=>store.exchangePairing(pairing.token,{name:"Replay"}),/invalid or expired/i);
    const raw=await readFile(join(home,"remote-auth.json"),"utf8");
    assert.doesNotMatch(raw,new RegExp(pairing.token.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")));
    assert.doesNotMatch(raw,new RegExp(paired.token.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")));
    assert.equal(store.revokeDevice(paired.device.id),true);
    assert.equal(store.authenticate(paired.token),null);
  }finally{await rm(home,{recursive:true,force:true})}
});

test("remote control exchanges a pairing link for a device session and honors revocation", async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-remote-http-"));
  const store=new RemoteAuthStore({...process.env,TREBELL_HOME:home});
  const environments={discover:async()=>({profiles:[]}),probe:async()=>({ok:true}),execute:async()=>({ok:true,stdout:""})};
  const remote=await createRemoteControlServer({port:0,token:"admin-recovery-token",version:"test",authStore:store,environments,enabled:()=>false,getStatus:async()=>({providerReady:true})});
  try{
    const pairing=remote.createPairing();
    const base=`http://127.0.0.1:${remote.port}`;
    const exchange=await fetch(base+"/api/pair",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token:pairing.token,name:"Browser"})});
    assert.equal(exchange.status,200);
    const session=await exchange.json();
    const status=await fetch(base+"/api/status",{headers:{authorization:`Bearer ${session.token}`}});
    assert.equal(status.status,200);
    assert.equal((await status.json()).providerReady,true);
    const replay=await fetch(base+"/api/pair",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token:pairing.token,name:"Replay"})});
    assert.equal(replay.status,401);
    assert.equal(remote.revokeDevice(session.device.id),true);
    const revoked=await fetch(base+"/api/status",{headers:{authorization:`Bearer ${session.token}`}});
    assert.equal(revoked.status,401);
  }finally{await remote.close();await rm(home,{recursive:true,force:true})}
});
