import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrebellStateStore } from "../src/trebell-state.mjs";
import { StorageCleanupService } from "../src/storage-cleanup-service.mjs";

const DAY_MS=24*60*60*1000;

test("storage cleanup settings are opt-in and normalized",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-storage-settings-"));
  try{
    const state=new TrebellStateStore({...process.env,TREBELL_HOME:home});
    assert.deepEqual(state.settings().storageCleanup,{attachmentsAfterDays:null,terminalHistoryAfterDays:null});
    state.updateSettings({storageCleanup:{attachmentsAfterDays:7.9,terminalHistoryAfterDays:99999}});
    assert.deepEqual(state.settings().storageCleanup,{attachmentsAfterDays:7,terminalHistoryAfterDays:3650});
    state.updateSettings({storageCleanup:{attachmentsAfterDays:0,terminalHistoryAfterDays:"nope"}});
    assert.deepEqual(state.settings().storageCleanup,{attachmentsAfterDays:null,terminalHistoryAfterDays:null});
  }finally{await rm(home,{recursive:true,force:true})}
});

test("storage cleanup removes only stale unreferenced Trebell attachment blobs",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-storage-attachments-"));const env={...process.env,TREBELL_HOME:home};
  try{
    const state=new TrebellStateStore(env);state.updateSettings({storageCleanup:{attachmentsAfterDays:7,terminalHistoryAfterDays:null}});
    const dir=join(home,"attachments");await mkdir(dir,{recursive:true});
    const old=join(dir,"old.bin"),fresh=join(dir,"fresh.bin"),saved=join(dir,"saved.bin");
    await writeFile(old,"old");await writeFile(fresh,"fresh");await writeFile(saved,"saved");
    const now=Date.now(),stale=new Date(now-10*DAY_MS);
    await utimes(old,stale,stale);await utimes(saved,stale,stale);
    state.addStash({text:"keep",attachments:[saved],contextChips:[]});
    const service=new StorageCleanupService({state,env,terminals:null,worktreeCleanup:null});
    const before=await service.snapshot();assert.equal(before.attachments.count,3);
    const result=await service.sweep({now});
    assert.equal(result.attachments.removed,1);assert.equal(result.attachments.bytes,3);
    await assert.rejects(()=>readFile(old),/ENOENT/);
    assert.equal(await readFile(fresh,"utf8"),"fresh");
    assert.equal(await readFile(saved,"utf8"),"saved");
    const after=await service.snapshot();assert.equal(after.attachments.count,2);
  }finally{await rm(home,{recursive:true,force:true})}
});

test("storage cleanup leaves attachment cache untouched when retention is off",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-storage-off-"));const env={...process.env,TREBELL_HOME:home};
  try{
    const state=new TrebellStateStore(env);const dir=join(home,"attachments");await mkdir(dir,{recursive:true});
    const file=join(dir,"old.bin");await writeFile(file,"old");const stale=new Date(Date.now()-100*DAY_MS);await utimes(file,stale,stale);
    const result=await new StorageCleanupService({state,env}).sweep({now:Date.now()});
    assert.equal(result.attachments.enabled,false);assert.equal(result.attachments.removed,0);
    assert.equal(await readFile(file,"utf8"),"old");
  }finally{await rm(home,{recursive:true,force:true})}
});

test("storage cleanup prunes old stopped terminal history and delegates managed worktrees",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-storage-terminal-"));const env={...process.env,TREBELL_HOME:home};
  try{
    const state=new TrebellStateStore(env);state.updateSettings({storageCleanup:{attachmentsAfterDays:null,terminalHistoryAfterDays:30}});
    const calls=[];const terminals={
      list:()=>[{id:"old",running:false},{id:"live",running:true}],
      pruneStopped:options=>{calls.push({type:"terminal",options});return {removed:2,remaining:1}},
    };
    const worktreeCleanup={sweep:async options=>{calls.push({type:"worktree",options});return {removed:1,results:[{removed:true}]}}};
    const now=Date.now();const result=await new StorageCleanupService({state,env,terminals,worktreeCleanup}).sweep({now,reason:"manual"});
    assert.equal(result.terminalHistory.removed,2);assert.equal(result.worktrees.removed,1);
    assert.equal(calls.find(call=>call.type==="terminal").options.before,now-30*DAY_MS);
    assert.deepEqual(calls.find(call=>call.type==="worktree").options,{now,reason:"manual"});
  }finally{await rm(home,{recursive:true,force:true})}
});
