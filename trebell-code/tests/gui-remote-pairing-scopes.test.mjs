import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGuiServer } from "../src/gui-server.mjs";
import { REMOTE_SCOPES } from "../src/remote-scopes.mjs";

async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

test("GUI remote pairing issues explicit least-privilege scopes and exposes them on paired devices",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-gui-remote-scopes-")),env={...process.env,TREBELL_HOME:home},[port,appPort,remotePort]=await Promise.all([freePort(),freePort(),freePort()]);
  const gui=await createGuiServer({port,appPort,mock:true,env});
  try{
    const enabled=await fetch(gui.url+"/api/remote-access",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({enabled:true,port:remotePort})});assert.equal(enabled.status,200);const remote=await enabled.json();assert.equal(remote.enabled,true);assert.equal(remote.running,true);assert.deepEqual(remote.availableScopes,[...REMOTE_SCOPES]);
    const paired=await fetch(gui.url+"/api/remote-access/pair",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({scopes:["status","threads:read","unknown:future","threads:read"]})});assert.equal(paired.status,200);const grant=await paired.json();assert.deepEqual(grant.scopes,["status","threads:read"]);assert.ok(grant.token);
    const exchange=await fetch(`http://127.0.0.1:${remotePort}/api/pair`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({token:grant.token,name:"Read only phone"})});assert.equal(exchange.status,200);const session=await exchange.json();assert.deepEqual(session.device.scopes,["status","threads:read"]);
    const info=await fetch(gui.url+"/api/remote-access").then(response=>response.json());const device=info.devices.find(item=>item.id===session.device.id);assert.ok(device);assert.deepEqual(device.scopes,["status","threads:read"]);assert.equal(Object.prototype.hasOwnProperty.call(device,"tokenHash"),false);
    const empty=await fetch(gui.url+"/api/remote-access/pair",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({scopes:[]})});assert.equal(empty.status,400);assert.match((await empty.json()).error,/at least one remote access scope/i);
  }finally{await gui.close();await rm(home,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
});
