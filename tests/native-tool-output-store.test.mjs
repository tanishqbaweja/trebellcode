import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeToolOutputStore } from "../src/native-tool-output-store.mjs";

test("Native tool output store virtualizes large output, supports targeted retrieval, and never persists configured secrets",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-output-store-")),secret="trebell-output-secret-value";
  try{
    const virtualized=[];
    const store=new NativeToolOutputStore({
      directory:root,maxHotBytes:4096,environment:{TEST_OUTPUT_SECRET:secret},
      onVirtualized:value=>virtualized.push(value),
    });
    const value={exitCode:1,stdout:("line ok\n".repeat(1200))+secret+"\nTARGET failure stack\n"+("tail\n".repeat(800)),stderr:"failed "+secret};
    const shaped=await store.virtualize(value,{namespace:"trebell_terminal",name:"run"});
    assert.equal(shaped.virtualized,true);assert.ok(shaped.handle);assert.equal(virtualized.length,1);
    const modelText=JSON.stringify(shaped.value);assert.ok(modelText.length<10_000);assert.doesNotMatch(modelText,new RegExp(secret));assert.match(modelText,/\[redacted\]/);
    assert.match(modelText,/TARGET failure stack/,"signal-aware preview should retain important middle failure evidence");
    const read=await store.read({handle:shaped.handle,start_line:1,max_chars:48_000});
    assert.doesNotMatch(read.content,new RegExp(secret));assert.match(read.content,/\[redacted\]/);
    const searched=await store.search({handle:shaped.handle,query:"TARGET",context_lines:1});
    assert.equal(searched.matches.length,1);assert.match(searched.matches[0].excerpt,/TARGET failure stack/);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("Native tool output store leaves small redacted results inline without allocating a handle",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-output-inline-")),secret="small-secret-value";
  try{
    const store=new NativeToolOutputStore({directory:root,maxHotBytes:4096,environment:{SMALL_SECRET:secret}});
    const shaped=await store.virtualize({success:true,content:"token="+secret});
    assert.equal(shaped.virtualized,false);assert.equal(shaped.handle,undefined);
    assert.doesNotMatch(JSON.stringify(shaped.value),new RegExp(secret));assert.match(JSON.stringify(shaped.value),/\[redacted\]/);
  }finally{await rm(root,{recursive:true,force:true})}
});
