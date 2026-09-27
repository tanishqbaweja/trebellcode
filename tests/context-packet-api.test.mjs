import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGuiServer } from "../src/gui-server.mjs";

async function freePort(){
  const server=createServer();
  await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const port=server.address().port;
  await new Promise(resolve=>server.close(resolve));
  return port;
}

test("context packet API projects Native seed before transport without changing selected items",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-context-api-home-")),root=await mkdtemp(join(tmpdir(),"trebell-context-api-repo-"));
  await mkdir(join(root,"src"),{recursive:true});
  await writeFile(join(root,"src","session.js"),[
    "export function refreshSession(token) {",
    "  const RAW_CONTEXT_MARKER = \"source-evidence-that-native-should-not-transport\";",
    "  return token + RAW_CONTEXT_MARKER.slice(0, 0);",
    "}",
    "",
  ].join("\n"),"utf8");
  const [port,appPort]=await Promise.all([freePort(),freePort()]),gui=await createGuiServer({port,appPort,mock:true,env:{...process.env,TREBELL_HOME:home}});
  try{
    const body={path:root,task:"Inspect refreshSession and the raw context marker",focusPaths:["src/session.js"]};
    const full=await fetch(gui.url+"/api/context/packet",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}).then(response=>response.json());
    const seed=await fetch(gui.url+"/api/context/packet",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...body,deliveryProjection:"seed"})}).then(response=>response.json());
    assert.match(full.untrustedInjection,/RAW_CONTEXT_MARKER/);
    assert.equal(seed.deliveryProjection,"seed");
    assert.doesNotMatch(seed.untrustedInjection,/RAW_CONTEXT_MARKER/);
    assert.deepEqual(seed.items,full.items);
    assert.ok(Buffer.byteLength(JSON.stringify(seed))<Buffer.byteLength(JSON.stringify(full)));
  }finally{
    await gui.close();
    await Promise.all([rm(home,{recursive:true,force:true}),rm(root,{recursive:true,force:true})]);
  }
});
