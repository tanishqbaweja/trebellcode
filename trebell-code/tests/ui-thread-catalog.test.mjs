import test from "node:test";
import assert from "node:assert/strict";
import { catalogMetaPatch, mergeThreadCatalog, threadCatalogRuntime, threadsFromCatalogMeta } from "../ui/src/thread-catalog.js";

test("thread catalog preserves rows from other runtimes when the active runtime reloads",()=>{
  const existing=[
    {id:"codex-1",name:"Codex task",updatedAt:30,trebellRuntime:"codex"},
    {id:"claude-1",name:"Claude task",updatedAt:20,trebellRuntime:"claude"},
  ];
  const merged=mergeThreadCatalog(existing,[{id:"codex-2",name:"New Codex task",updatedAt:40}],{runtime:"codex",provider:"vyceai"});
  assert.deepEqual(merged.map(item=>item.id),["codex-2","codex-1","claude-1"]);
  assert.equal(merged.find(item=>item.id==="codex-2").trebellRuntime,"codex");
  assert.equal(merged.find(item=>item.id==="claude-1").trebellRuntime,"claude");
});

test("provider changes inside the same runtime cannot erase the existing conversation catalog",()=>{
  const existing=[{id:"codex-provider-thread",name:"Keep me",updatedAt:25,trebellRuntime:"codex",trebellProvider:"freebuff"}];
  const merged=mergeThreadCatalog(existing,[],{runtime:"codex",provider:"vyceai"});
  assert.equal(merged.length,1);assert.equal(merged[0].id,"codex-provider-thread");assert.equal(merged[0].trebellRuntime,"codex");
});

test("Trebell Native thread identity stays separate from the inference provider",()=>{
  const existing=[{id:"native-thread",name:"Keep Native history",updatedAt:35,trebellRuntime:"native",trebellProvider:"agentrouter"}];
  const merged=mergeThreadCatalog(existing,[],{runtime:"native",provider:"hcnsec"});
  assert.equal(merged.length,1);assert.equal(merged[0].id,"native-thread");assert.equal(merged[0].trebellRuntime,"native");
  const patch=catalogMetaPatch({id:"native-thread",name:"Keep Native history",updatedAt:35},{runtime:"native",provider:"hcnsec",runtimeInstanceId:"native-default"});
  assert.equal(threadCatalogRuntime({id:"native-thread"},patch,"codex"),"native");
});

test("thread catalog reconstructs durable rows from thread metadata and omits archived/deleted rows",()=>{
  const rows=threadsFromCatalogMeta({
    a:{runtime:"claude",cwd:"C:/repo",threadSnapshot:{id:"a",name:"Remembered task",preview:"Fix parser",updatedAt:50,model:"claude-x",runtime:"claude"}},
    b:{runtime:"codex",archived:true,threadSnapshot:{id:"b",name:"Archived",updatedAt:60}},
    c:{runtime:"codex",deletedAt:100,threadSnapshot:{id:"c",name:"Deleted",updatedAt:70}},
  });
  assert.deepEqual(rows.map(item=>item.id),["a"]);assert.equal(rows[0].trebellRuntime,"claude");assert.equal(rows[0].cwd,"C:/repo");
});

test("catalog metadata keeps runtime identity separate from inference provider",()=>{
  const patch=catalogMetaPatch({id:"t1",name:"Provider-independent thread",cwd:"C:/repo",model:"deepseek-v4.1",updatedAt:100,status:{type:"active"}},{runtime:"codex",provider:"vyceai",runtimeInstanceId:"codex-default"});
  assert.equal(patch.runtime,"codex");assert.equal(patch.provider,"vyceai");assert.equal(patch.threadSnapshot.status.type,"idle");
  assert.equal(threadCatalogRuntime({id:"t1"},patch,"claude"),"codex");
});

test("legacy metadata can recover runtime ownership without a modern thread snapshot",()=>{
  const rows=threadsFromCatalogMeta({
    claudeLegacy:{cwd:"C:/repo",runtimeInstanceId:"claude-default",trebellContext:{runtime:"claude"}},
    codexLegacy:{cwd:"C:/repo",runtimeInstanceId:"codex-profile-2"},
    nativeLegacy:{cwd:"C:/repo",runtimeInstanceId:"native-default"},
  });
  assert.equal(rows.find(item=>item.id==="claudeLegacy").trebellRuntime,"claude");
  assert.equal(rows.find(item=>item.id==="codexLegacy").trebellRuntime,"codex");
  assert.equal(rows.find(item=>item.id==="nativeLegacy").trebellRuntime,"native");
});
