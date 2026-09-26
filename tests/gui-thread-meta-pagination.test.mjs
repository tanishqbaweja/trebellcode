import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGuiServer } from "../src/gui-server.mjs";

async function freePort(){
  const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}

test("GUI bootstrap bounds thread catalog and exposes older catalog pages",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-gui-thread-page-")),env={...process.env,TREBELL_HOME:home},threadMeta={};
  let gui;
  try{
    for(let index=0;index<275;index++){
      const id="catalog-"+String(index).padStart(3,"0"),updatedAt=20_000-index;
      threadMeta[id]={runtime:index%2?"claude":"native",updatedAt,threadSnapshot:{id,name:"Catalog "+index,preview:"Paged row",updatedAt,createdAt:updatedAt-1,status:{type:"idle"},runtime:index%2?"claude":"native"}};
    }
    await writeFile(join(home,"ui-state.json"),JSON.stringify({version:2,projects:[],settings:{onboardingComplete:true},threadMeta,environments:[],stashes:[]}),"utf8");
    const [port,appPort]=await Promise.all([freePort(),freePort()]);gui=await createGuiServer({port,appPort,mock:true,env});
    const initial=await fetch(gui.url+"/api/state").then(response=>response.json());
    assert.equal(Object.keys(initial.threadMeta).length,250);assert.ok(initial.threadMetaNextCursor);assert.equal(initial.threadMeta["catalog-000"].threadSnapshot.name,"Catalog 0");
    const older=await fetch(gui.url+"/api/thread-meta?"+new URLSearchParams({view:"catalog",limit:"100",cursor:initial.threadMetaNextCursor})).then(response=>response.json());
    assert.equal(Object.keys(older.threadMeta).length,25);assert.equal(older.nextCursor,null);assert.equal(older.threadMeta["catalog-274"].threadSnapshot.name,"Catalog 274");
    const overlap=Object.keys(older.threadMeta).filter(id=>Object.prototype.hasOwnProperty.call(initial.threadMeta,id));assert.deepEqual(overlap,[]);
  }finally{if(gui)await gui.close();await rm(home,{recursive:true,force:true})}
});
