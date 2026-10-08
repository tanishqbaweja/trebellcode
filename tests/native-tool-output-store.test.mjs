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
    const modelText=JSON.stringify(shaped.value);assert.ok(shaped.value.preview.length<=2200);assert.ok(modelText.length<6500);assert.doesNotMatch(modelText,new RegExp(secret));assert.match(modelText,/\[redacted\]/);
    assert.match(modelText,/TARGET failure stack/,"signal-aware preview should retain important middle failure evidence");
    const read=await store.read({handle:shaped.handle,start_line:1,max_chars:48_000});
    assert.doesNotMatch(read.content,new RegExp(secret));assert.match(read.content,/\[redacted\]/);
    const searched=await store.search({handle:shaped.handle,query:"TARGET",context_lines:1});
    assert.equal(searched.matches.length,1);assert.match(searched.matches[0].excerpt,/TARGET failure stack/);
    const inspectedSearch=await store.execute({name:"inspect",arguments:{handle:shaped.handle,query:"TARGET",context_lines:1}});
    assert.equal(inspectedSearch.matches.length,1);assert.match(inspectedSearch.matches[0].excerpt,/TARGET failure stack/);
    const inspectedRead=await store.execute({name:"inspect",arguments:{handle:shaped.handle,start_line:1,max_chars:48000}});
    assert.match(inspectedRead.content,/line ok/);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("Native tool output store never replaces model-visible image content with a text preview",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-output-image-")),secret="multimodal-secret-value";
  try{
    const store=new NativeToolOutputStore({directory:root,maxHotBytes:4096,environment:{IMAGE_TEST_SECRET:secret}});
    const imageUrl="data:image/png;base64,"+"A".repeat(12000);
    const value={success:true,contentItems:[{type:"inputText",text:"Preview "+secret},{type:"inputImage",imageUrl}]};
    const shaped=await store.virtualize(value,{namespace:"trebell_workspace",name:"read_file"});
    assert.equal(shaped.virtualized,false);assert.equal(shaped.value.contentItems[1].imageUrl,imageUrl);
    assert.doesNotMatch(shaped.value.contentItems[0].text,new RegExp(secret));
  }finally{await rm(root,{recursive:true,force:true})}
});

test("Native tool output store keeps the wider hot preview when large output has no failure signal",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-output-no-signal-"));
  try{
    const store=new NativeToolOutputStore({directory:root,maxHotBytes:4096});
    const shaped=await store.virtualize({exitCode:0,stdout:"ordinary progress line\n".repeat(1600)},{namespace:"trebell_terminal",name:"run"});
    assert.equal(shaped.virtualized,true);assert.ok(shaped.value.preview.length>2200);assert.ok(shaped.value.preview.length<=3600);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("Native tool output store keeps the wider hot preview for successful output with failure-like vocabulary",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-output-success-signal-"));
  try{
    const store=new NativeToolOutputStore({directory:root,maxHotBytes:4096});
    const stdout=("expected 42 tests and received 42 tests successfully\n").repeat(1200);
    const shaped=await store.virtualize({exitCode:0,stdout},{namespace:"trebell_terminal",name:"run"});
    assert.equal(shaped.virtualized,true);assert.ok(shaped.value.preview.length>2200);assert.ok(shaped.value.preview.length<=3600);
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

test("Native tool output store can archive small hot output without forcing immediate virtualization",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-output-archive-")),secret="archive-secret-value";
  try{
    const store=new NativeToolOutputStore({directory:root,maxHotBytes:16*1024,environment:{ARCHIVE_SECRET:secret}});
    const value={success:true,exitCode:0,stdout:"row=42\n".repeat(300)+"token="+secret};
    const shaped=await store.virtualize(value,{namespace:"trebell_terminal",name:"run"});
    assert.equal(shaped.virtualized,false);assert.equal(shaped.handle,undefined);
    const archived=await store.archive(value,{namespace:"trebell_terminal",name:"run",minBytes:1200});
    assert.equal(archived.archived,true);assert.ok(archived.handle);assert.ok(archived.totalBytes>=1200);
    const read=await store.read({handle:archived.handle,start_line:1,max_chars:48_000});
    assert.match(read.content,/row=42/);assert.doesNotMatch(read.content,new RegExp(secret));assert.match(read.content,/\[redacted\]/);
    const skipped=await store.archive({stdout:"tiny"},{namespace:"trebell_terminal",name:"run",minBytes:1200});
    assert.equal(skipped.archived,false);assert.equal(skipped.handle,undefined);
  }finally{await rm(root,{recursive:true,force:true})}
});
