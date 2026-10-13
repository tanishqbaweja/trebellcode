import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeToolOutputStore, collapseRepeatedLines } from "../src/native-tool-output-store.mjs";

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

test("consecutive identical output lines collapse to the first line and a harness note only when the note is shorter",()=>{
  const warning="Warning: grid volume is not an integer number of pixels; cell size will be rounded.";
  const collapsed=collapseRepeatedLines("start\n"+(warning+"\n").repeat(38)+"done\n");
  assert.equal(collapsed.text,"start\n"+warning+"\n[Trebell: previous line repeated 37 more times]\ndone\n");
  assert.equal(collapsed.runs,1);assert.equal(collapsed.removedLines,37);
  assert.equal(collapseRepeatedLines(warning+"\n"+warning).text,warning+"\n[Trebell: previous line repeated 1 more time]","a final line without a newline still collapses");
  const short="ok\nok\nok\nok\n";assert.deepEqual(collapseRepeatedLines(short),{text:short,runs:0,removedLines:0},"a note longer than the repeats it replaces is not used");
  assert.equal(collapseRepeatedLines("a\r\n"+(warning+"\r\n").repeat(3)+"b\r\n").text,"a\r\n"+warning+"\r\n[Trebell: previous line repeated 2 more times]\r\nb\r\n","CRLF output keeps its line endings");
  assert.equal(collapseRepeatedLines("x\ny\n"+warning+"\nz\n"+warning+"\n").text,"x\ny\n"+warning+"\nz\n"+warning+"\n","only consecutive repeats collapse");
  assert.equal(collapseRepeatedLines("\n".repeat(80)).text,"\n[Trebell: previous line repeated 79 more times]\n","a long run of blank lines collapses and the trailing newline stays");
});

test("collapsing command output keeps the raw output retrievable and the user-facing value unchanged",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-output-collapse-"));
  try{
    const store=new NativeToolOutputStore({directory:root,maxHotBytes:16*1024});
    const warning="Warning: grid volume is not an integer number of pixels; cell size will be rounded.";
    const value={exitCode:0,stdout:"result 0.7888\n",stderr:(warning+"\n").repeat(120)};
    const plain=await store.virtualize(value,{namespace:"trebell_terminal",name:"run"});
    assert.equal(plain.value.stderr,value.stderr,"collapse is opt-in");assert.equal(plain.handle,undefined);
    const shaped=await store.virtualize(value,{namespace:"trebell_terminal",name:"run",collapseRepeatedLines:true});
    assert.equal(shaped.virtualized,false);assert.ok(shaped.handle);
    assert.equal(shaped.value.stderr,warning+"\n[Trebell: previous line repeated 119 more times]\n");assert.equal(shaped.value.stdout,"result 0.7888\n");
    assert.equal(shaped.value._trebell_output.handle,shaped.handle);assert.equal(shaped.value._trebell_output.archived,true);assert.match(shaped.value._trebell_output.note,/trebell_output\/inspect/);
    assert.deepEqual(shaped.uiValue,value,"the person's view of the tool result is not collapsed");
    const read=await store.read({handle:shaped.handle,start_line:1,max_chars:48_000});
    assert.equal(read.content.split("\n").filter(line=>line===warning).length,120,"the raw output keeps every repeated line");
    const unchanged=await store.virtualize({exitCode:0,stdout:"one\ntwo\n"},{namespace:"trebell_terminal",name:"run",collapseRepeatedLines:true});
    assert.equal(unchanged.handle,undefined);assert.equal(unchanged.uiValue,undefined);assert.deepEqual(unchanged.value,{exitCode:0,stdout:"one\ntwo\n"});
  }finally{await rm(root,{recursive:true,force:true})}
});

test("a large collapsed output previews the collapsed text and indexes raw line numbers without repeated signal lines",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-output-collapse-large-"));
  try{
    const store=new NativeToolOutputStore({directory:root,maxHotBytes:4096});
    const distinct=Array.from({length:400},(_,index)=>"step "+index+" value "+(index*7)).join("\n");
    const failure="ERROR: solver failed to converge at cell 12";
    const stdout=distinct+"\n"+(failure+"\n").repeat(300)+"tail summary line\n";
    const shaped=await store.virtualize({exitCode:1,stdout},{namespace:"trebell_terminal",name:"run",collapseRepeatedLines:true});
    assert.equal(shaped.virtualized,true);assert.ok(shaped.handle);
    const preview=shaped.value.preview;
    assert.equal((preview.match(/solver failed to converge/g)||[]).length<=2,true,"the preview does not repeat the same failure line");
    const raw=await store.read({handle:shaped.handle,start_line:1,max_chars:48_000}),rawLines=raw.content.split("\n");
    const labelled=preview.match(/line (\d+): ERROR: solver failed/);assert.ok(labelled,"the failure is indexed as an important line");
    assert.equal(rawLines[Number(labelled[1])-1],failure,"important-line numbers point into the stored raw output");
    assert.match(shaped.uiValue.preview,/solver failed to converge/);assert.notEqual(shaped.uiValue.preview,preview,"the person's preview is the raw one");
    assert.equal(shaped.uiValue._trebell_output.handle,shaped.handle);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("a collapsed output too large for hot context still gives the person the preview it had without the collapse",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-output-collapse-ui-"));
  try{
    const store=new NativeToolOutputStore({directory:root,maxHotBytes:4096});
    const value={exitCode:0,stdout:"render done\n",stderr:"Warning: texture cache miss; using CPU sampling for this tile.\n".repeat(400)};
    const before=await store.virtualize(value,{namespace:"trebell_terminal",name:"run"});
    const shaped=await store.virtualize(value,{namespace:"trebell_terminal",name:"run",collapseRepeatedLines:true});
    assert.equal(shaped.virtualized,false);assert.match(shaped.value.stderr,/previous line repeated 399 more times/);
    assert.equal(Object.hasOwn(shaped.uiValue,"stderr"),false,"the person is not handed the whole 25 KB output");
    assert.equal(shaped.uiValue.preview,before.value.preview);assert.equal(shaped.uiValue._trebell_output.handle,shaped.handle);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("a model view is what the model is shown and what trebell_output returns, while the person keeps the whole value",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-output-model-view-")),secret="trebell-view-secret-value";
  try{
    const store=new NativeToolOutputStore({directory:root,maxHotBytes:4096,environment:{TEST_VIEW_SECRET:secret}});
    const id="2f1c0e6a-9b7d-4c1e-8a55-0d6f3b2a9c10",view=record=>({process_id:record.handle,running:record.running,stdout:record.stdout});
    const record=stdout=>({processId:id,handle:"p1",threadId:"thread-7",createdAt:1791317470236,osPid:4242,running:true,stdout});
    const small=await store.virtualize(record("listening "+secret+"\n"),{namespace:"trebell_process",name:"status",modelView:view});
    assert.deepEqual(small.value,{process_id:"p1",running:true,stdout:"listening [redacted]\n"},"the view is taken from the redacted value");
    assert.equal(small.uiValue.processId,id);assert.equal(small.handle,undefined);
    const lines=Array.from({length:600},(_,index)=>"frame "+index+" rendered").join("\n")+"\n";
    const big=await store.virtualize(record(lines),{namespace:"trebell_process",name:"status",modelView:view});
    assert.equal(big.virtualized,true);assert.deepEqual(Object.keys(big.value),["process_id","running","preview","_trebell_output"]);
    for(const hidden of [id,"thread-7","1791317470236","osPid","createdAt","threadId","processId"])assert.equal(JSON.stringify(big.value).includes(hidden),false,"the model's preview leaves out "+hidden);
    assert.match(big.value.preview,/frame 0 rendered/);
    const stored=await store.read({handle:big.handle,start_line:1,max_chars:48_000});
    assert.match(stored.content,/frame 599 rendered/);assert.equal(stored.content.includes(id),false,"trebell_output returns the model's view with every output line");
    assert.match(big.uiValue.preview,new RegExp(id),"the person's preview is of the whole record");assert.equal(big.uiValue._trebell_output.handle,big.handle);
    const collapsed=await store.virtualize(record("waiting for port 8000\n".repeat(50)),{namespace:"trebell_process",name:"status",modelView:view,collapseRepeatedLines:true});
    assert.equal(collapsed.value.process_id,"p1");assert.equal(collapsed.value.stdout,"waiting for port 8000\n[Trebell: previous line repeated 49 more times]\n");
    assert.equal(Object.hasOwn(collapsed.value,"processId"),false);assert.equal(collapsed.uiValue.processId,id);
  }finally{await rm(root,{recursive:true,force:true})}
});
