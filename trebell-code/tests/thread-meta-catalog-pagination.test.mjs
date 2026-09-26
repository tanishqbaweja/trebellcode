import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteStateCollections } from "../src/sqlite-state-collections.mjs";
import { TrebellStateStore } from "../src/trebell-state.mjs";

test("thread metadata catalog pages use stable bounded cursors and permanent deletion removes the row",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-thread-page-")),env={...process.env,TREBELL_HOME:home};
  try{
    const collections=new SqliteStateCollections(env),threadMeta={};
    for(let index=0;index<260;index++){
      const id="thread-"+String(index).padStart(3,"0"),updatedAt=10_000-index;
      threadMeta[id]={runtime:index%2?"claude":"native",updatedAt,threadSnapshot:{id,name:"Thread "+index,preview:"Page fixture "+index,updatedAt,createdAt:updatedAt-1,status:{type:"idle"},runtime:index%2?"claude":"native"}};
    }
    collections.importLegacy({threadMeta});
    const first=collections.threadMetaCatalogPage({limit:100});
    const second=collections.threadMetaCatalogPage({limit:100,cursor:first.nextCursor});
    const third=collections.threadMetaCatalogPage({limit:100,cursor:second.nextCursor});
    assert.equal(Object.keys(first.threadMeta).length,100);assert.equal(Object.keys(second.threadMeta).length,100);assert.equal(Object.keys(third.threadMeta).length,60);
    assert.ok(first.nextCursor);assert.ok(second.nextCursor);assert.equal(third.nextCursor,null);
    const ids=[...Object.keys(first.threadMeta),...Object.keys(second.threadMeta),...Object.keys(third.threadMeta)];
    assert.equal(new Set(ids).size,260);assert.equal(ids[0],"thread-000");assert.equal(ids.at(-1),"thread-259");
    assert.ok(Object.values(first.threadMeta).every(item=>item.__catalogOnly===true));

    const state=new TrebellStateStore(env),snapshot=state.snapshot({includeCollections:false,threadMetaView:"catalog",threadMetaLimit:25});
    assert.equal(Object.keys(snapshot.threadMeta).length,25);assert.ok(snapshot.threadMetaNextCursor);
    assert.equal(state.removeThreadMeta("thread-000"),true);assert.deepEqual(state.threadMeta("thread-000"),{});
    const after=state.threadMetaCatalogPage({limit:260});assert.equal(Object.keys(after.threadMeta).length,259);assert.equal(Object.prototype.hasOwnProperty.call(after.threadMeta,"thread-000"),false);
  }finally{await rm(home,{recursive:true,force:true})}
});
