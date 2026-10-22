import test from "node:test";
import assert from "node:assert/strict";
import { access,mkdtemp,mkdir,readFile,rm,symlink,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename,join } from "node:path";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { deflateSync } from "node:zlib";
import { createNativeBuiltins } from "../src/native-builtins.mjs";

async function workspace(){
  const root=await mkdtemp(join(tmpdir(),"trebell-native-builtins-"));await mkdir(join(root,"src"),{recursive:true});await writeFile(join(root,"src","app.js"),"const value = 1;\n","utf8");return root;
}

// The spelling of an absolute directory that starts with a path separator: the directory itself on POSIX, and on
// Windows the drive-less form (/dir/...), which resolves on the drive of the workspace root. Before root-aware
// handling, such a spelling of the workspace root was stripped and resolved again under the root (<root>/<root>/...).
function rootedSpelling(directory){
  return process.platform==="win32"?directory.replace(/^[a-zA-Z]:/,"").replace(/\\/g,"/"):directory;
}

async function missing(path){
  try{await access(path);return false}catch(error){if(error?.code==="ENOENT")return true;throw error}
}

test("Native workspace built-ins read, list, write, and replace exact text inside the workspace",async()=>{
  const root=await workspace();
  try{
    const execute=createNativeBuiltins({root,environment:{...process.env,TOP_SECRET_TOKEN:"must-not-matter"}});
    const listed=await execute({namespace:"trebell_workspace",name:"list",arguments:{path:"src",depth:2,limit:20}});assert.ok(listed.entries.some(item=>item.name==="app.js"));
    const read=await execute({namespace:"trebell_workspace",name:"read_file",arguments:{path:"src/app.js"}});assert.equal(read.content,"const value = 1;\n");
    const replaced=await execute({namespace:"trebell_workspace",name:"replace_text",arguments:{path:"src/app.js",old_text:"value = 1",new_text:"value = 2"}});assert.equal(replaced.replacements,1);assert.equal(await readFile(join(root,"src","app.js"),"utf8"),"const value = 2;\n");
    const written=await execute({namespace:"trebell_workspace",name:"write_file",arguments:{path:"src/new.js",content:"export const ready = true;\n"}});assert.equal(written.createdOrReplaced,true);assert.equal(written.existedBefore,false);assert.equal(await readFile(join(root,"src","new.js"),"utf8"),"export const ready = true;\n");
    const overwritten=await execute({namespace:"trebell_workspace",name:"write_file",arguments:{path:"src/new.js",content:"export const ready = false;\n"}});assert.equal(overwritten.existedBefore,true);assert.equal(await readFile(join(root,"src","new.js"),"utf8"),"export const ready = false;\n");
    const rooted=await execute({namespace:"trebell_workspace",name:"read_file",arguments:{path:"/src/app.js"}});assert.equal(rooted.content,"const value = 2;\n");
    const virtualRooted=await execute({namespace:"trebell_workspace",name:"read_file",arguments:{path:"/workspace/src/app.js"}});assert.equal(virtualRooted.content,"const value = 2;\n");
    const appRooted=await execute({namespace:"trebell_workspace",name:"read_file",arguments:{path:"/app/src/app.js"}});assert.equal(appRooted.content,"const value = 2;\n");
    const appReplaced=await execute({namespace:"trebell_workspace",name:"replace_text",arguments:{path:"/app/src/app.js",old_text:"value = 2",new_text:"value = 3"}});assert.equal(appReplaced.replacements,1);assert.equal(await readFile(join(root,"src","app.js"),"utf8"),"const value = 3;\n");
    const appWritten=await execute({namespace:"trebell_workspace",name:"write_file",arguments:{path:"/app/src/app.js",content:"const value = 4;\n"}});assert.equal(appWritten.createdOrReplaced,true);assert.equal(appWritten.existedBefore,true);assert.equal(await readFile(join(root,"src","app.js"),"utf8"),"const value = 4;\n");
    const appCreated=await execute({namespace:"trebell_workspace",name:"write_file",arguments:{path:"/app/src/new-app-root.js",content:"export const appRoot = true;\n"}});assert.equal(appCreated.createdOrReplaced,true);assert.equal(await readFile(join(root,"src","new-app-root.js"),"utf8"),"export const appRoot = true;\n");
    const workspaceCreated=await execute({namespace:"trebell_workspace",name:"write_file",arguments:{path:"workspace/src/new-workspace-root.js",content:"export const workspaceRoot = true;\n"}});assert.equal(workspaceCreated.createdOrReplaced,true);assert.equal(await readFile(join(root,"src","new-workspace-root.js"),"utf8"),"export const workspaceRoot = true;\n");
    const rootList=await execute({namespace:"trebell_workspace",name:"list",arguments:{path:"/",depth:2,limit:20}});assert.ok(rootList.entries.some(item=>item.name==="src"));
    const virtualRootList=await execute({namespace:"trebell_workspace",name:"list",arguments:{path:"/workspace",depth:2,limit:20}});assert.ok(virtualRootList.entries.some(item=>item.name==="src"));
    const appRootList=await execute({namespace:"trebell_workspace",name:"list",arguments:{path:"/app",depth:2,limit:20}});assert.ok(appRootList.entries.some(item=>item.name==="src"));
  }finally{await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("Native internal recovery can snapshot and restore binary workspace bytes without exposing text decoding",async()=>{
  const root=await workspace(),pixel=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+i8XkAAAAASUVORK5CYII=","base64"),replacement=Buffer.from([0,1,2,3,255,254,253,10,13,0,127]);
  try{
    const path=join(root,"src","pixel.png");await writeFile(path,pixel);const execute=createNativeBuiltins({root});
    const guarded=await execute({namespace:"trebell_workspace",name:"read_file",arguments:{path:"src/pixel.png"}});assert.equal(guarded.imageModeRequired,true);assert.equal(Object.hasOwn(guarded,"contentBase64"),false);
    const blocked=await execute({id:"model-call",namespace:"trebell_workspace",name:"read_file",arguments:{path:"src/pixel.png",max_bytes:1024*1024,_trebell_internal_binary:true}});assert.equal(blocked.imageModeRequired,true);assert.equal(Object.hasOwn(blocked,"contentBase64"),false);
    const idOnly=await execute({id:"native-recovery-snapshot-model-like",namespace:"trebell_workspace",name:"read_file",arguments:{path:"src/pixel.png",max_bytes:1024*1024,_trebell_internal_binary:true}});assert.equal(idOnly.imageModeRequired,true);assert.equal(Object.hasOwn(idOnly,"contentBase64"),false);
    const snapshot=await execute({_trebellInternalRecovery:true,id:"native-recovery-snapshot-test",namespace:"trebell_workspace",name:"read_file",arguments:{path:"src/pixel.png",max_bytes:1024*1024,_trebell_internal_binary:true}});
    assert.equal(snapshot.binary,true);assert.equal(Buffer.from(snapshot.contentBase64,"base64").equals(pixel),true);assert.match(snapshot.sha256,/^[a-f0-9]{64}$/);
    const written=await execute({_trebellInternalRecovery:true,id:"native-recovery-restore-test",namespace:"trebell_workspace",name:"write_file",arguments:{path:"src/pixel.png",content_base64:replacement.toString("base64"),_trebell_internal_binary:true}});
    assert.equal(written.binary,true);assert.equal((await readFile(path)).equals(replacement),true);
  }finally{await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("Native internal recovery snapshots cover deliverables beyond the model-facing preview and edit limits",async()=>{
  const root=await workspace(),large=Buffer.alloc(3*1024*1024+17,0x61),replacement=Buffer.alloc(3*1024*1024+5,0x62);
  try{
    const path=join(root,"src","large.json");await writeFile(path,large);const execute=createNativeBuiltins({root});
    await assert.rejects(execute({namespace:"trebell_workspace",name:"read_file",arguments:{path:"src/large.json",max_bytes:1024*1024}}),/too large to preview/i);
    await assert.rejects(execute({namespace:"trebell_workspace",name:"write_file",arguments:{path:"src/large.json",content:replacement.toString("utf8")}}),/2 MB Native edit limit/);
    const snapshot=await execute({_trebellInternalRecovery:true,id:"native-recovery-snapshot-large",namespace:"trebell_workspace",name:"read_file",arguments:{path:"src/large.json",max_bytes:32*1024*1024,_trebell_internal_binary:true}});
    assert.equal(snapshot.binary,true);assert.equal(snapshot.size,large.length);assert.equal(Buffer.from(snapshot.contentBase64,"base64").equals(large),true);
    const restored=await execute({_trebellInternalRecovery:true,id:"native-recovery-restore-large",namespace:"trebell_workspace",name:"write_file",arguments:{path:"src/large.json",content_base64:replacement.toString("base64"),_trebell_internal_binary:true}});
    assert.equal(restored.binary,true);assert.equal((await readFile(path)).equals(replacement),true);
    await writeFile(path,Buffer.alloc(32*1024*1024+1,0x63));
    await assert.rejects(execute({_trebellInternalRecovery:true,id:"native-recovery-snapshot-over",namespace:"trebell_workspace",name:"read_file",arguments:{path:"src/large.json",max_bytes:64*1024*1024,_trebell_internal_binary:true}}),/too large for an internal recovery snapshot/i);
  }finally{await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("Native workspace image reads use remote binary streams without decoding bytes as UTF-8",async()=>{
  const pixel=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+i8XkAAAAASUVORK5CYII=","base64"),calls=[];
  const environments={
    get:()=>({id:"test-remote",type:"docker",cwd:"/workspace"}),
    executeArgv:async(_id,options)=>({exitCode:0,stdout:String(options.args[0])+"\n"}),
    attachmentInfo:async(_id,path)=>{calls.push("info:"+path);return {size:pixel.length}},
    streamFile:(_id,path)=>{
      calls.push("stream:"+path);
      const child=new EventEmitter();child.stdout=Readable.from([pixel.subarray(0,12),pixel.subarray(12)]);
      child.kill=()=>{};process.nextTick(()=>child.emit("close",0));return child;
    },
  };
  const execute=createNativeBuiltins({root:"/workspace",environments,environmentId:"test-remote"});
  const guarded=await execute({namespace:"trebell_workspace",name:"read_file",arguments:{path:"layout.png"}});
  assert.equal(guarded.imageModeRequired,true);assert.equal(guarded.mimeType,"image/png");assert.deepEqual(calls,[]);
  const image=await execute({namespace:"trebell_workspace",name:"read_file",arguments:{path:"layout.png",as_image:true}});
  assert.equal(image.mimeType,"image/png");assert.equal(image.contentItems[1].imageUrl,"data:image/png;base64,"+pixel.toString("base64"));
  assert.deepEqual(calls,["info:/workspace/layout.png","stream:/workspace/layout.png"]);
});

test("Native internal binary recovery preserves remote workspace bytes",async()=>{
  let remoteBytes=Buffer.from([0,255,10,13,1,2,3]),written=null;const calls=[];
  const environments={
    get:()=>({id:"test-remote",type:"docker",cwd:"/workspace"}),
    executeArgv:async(_id,options)=>({exitCode:0,stdout:String(options.args[0])+"\n"}),
    attachmentInfo:async(_id,path)=>({path,size:remoteBytes.length}),
    streamFile:(_id,path)=>{calls.push("stream:"+path);const child=new EventEmitter();child.stdout=Readable.from([remoteBytes]);child.kill=()=>{};process.nextTick(()=>child.emit("close",0));return child},
    writeTextFile:async(_id,path,content)=>{calls.push("write:"+path);written=Buffer.from(content);remoteBytes=Buffer.from(content);return {path,size:remoteBytes.length}},
  };
  const execute=createNativeBuiltins({root:"/workspace",environments,environmentId:"test-remote"}),replacement=Buffer.from([9,8,7,0,255]);
  const snapshot=await execute({_trebellInternalRecovery:true,id:"native-recovery-snapshot-remote",namespace:"trebell_workspace",name:"read_file",arguments:{path:"artifact.bin",_trebell_internal_binary:true,max_bytes:1024}});
  assert.equal(Buffer.from(snapshot.contentBase64,"base64").equals(Buffer.from([0,255,10,13,1,2,3])),true);
  const restored=await execute({_trebellInternalRecovery:true,id:"native-recovery-restore-remote",namespace:"trebell_workspace",name:"write_file",arguments:{path:"artifact.bin",_trebell_internal_binary:true,content_base64:replacement.toString("base64")}});
  assert.equal(restored.binary,true);assert.equal(written.equals(replacement),true);assert.deepEqual(calls,["stream:/workspace/artifact.bin","write:/workspace/artifact.bin"]);
});

test("Native workspace image reads preserve the actual pixels for the model without changing text reads",async()=>{
  const root=await workspace(),pixel=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+i8XkAAAAASUVORK5CYII=","base64");
  try{
    await writeFile(join(root,"src","pixel.png"),pixel);
    const execute=createNativeBuiltins({root});
    const guarded=await execute({namespace:"trebell_workspace",name:"read_file",arguments:{path:"src/pixel.png"}});
    assert.equal(guarded.imageModeRequired,true);assert.equal(guarded.mimeType,"image/png");
    assert.equal(Object.hasOwn(guarded,"content"),false);assert.match(guarded.message,/as_image=true/i);
    const image=await execute({namespace:"trebell_workspace",name:"read_file",arguments:{path:"src/pixel.png",as_image:true}});
    assert.equal(image.success,true);assert.equal(image.mimeType,"image/png");
    assert.equal(image.contentItems[1].type,"inputImage");
    assert.equal(image.contentItems[1].imageUrl,"data:image/png;base64,"+pixel.toString("base64"));
    assert.match(image.contentItems[0].text,/src.*pixel\.png/i);
    const text=await execute({namespace:"trebell_workspace",name:"read_file",arguments:{path:"src/app.js"}});
    assert.equal(text.content,"const value = 1;\n");
    await assert.rejects(()=>execute({namespace:"trebell_workspace",name:"read_file",arguments:{path:"src/app.js",as_image:true}}),/supported image/i);
    await assert.rejects(()=>execute({namespace:"trebell_workspace",name:"read_file",arguments:{path:"..\\outside.png",as_image:true}}),/outside the active workspace/i);
  }finally{await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("Native workspace image reads refuse a PNG whose pixel data cannot decode instead of attaching it",async()=>{
  // The music-harmony crash (2026-10-16): a model-written PNG with a valid signature and chunks whose pixel data was short
  // was attached, and the provider refused the whole request with HTTP 400 "not a valid image".
  const root=await workspace(),pixel=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+i8XkAAAAASUVORK5CYII=","base64");
  const header=Buffer.alloc(13);header.writeUInt32BE(64,0);header.writeUInt32BE(64,4);header[8]=8;header[9]=0;
  const chunk=(type,data)=>{const length=Buffer.alloc(4);length.writeUInt32BE(data.length);return Buffer.concat([length,Buffer.from(type,"latin1"),data,Buffer.alloc(4)])};
  const short=Buffer.concat([pixel.subarray(0,8),chunk("IHDR",header),chunk("IDAT",deflateSync(Buffer.alloc(65*10))),chunk("IEND",Buffer.alloc(0))]);
  try{
    await writeFile(join(root,"src","short.png"),short);
    const execute=createNativeBuiltins({root});
    await assert.rejects(()=>execute({namespace:"trebell_workspace",name:"read_file",arguments:{path:"src/short.png",as_image:true}}),/Image does not decode \(image\/png\): its pixel data is short: 650 of the 4160 bytes its 64x64 header needs/);
  }finally{await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("Native exact replacement fails closed and workspace paths cannot escape",async()=>{
  const root=await workspace(),outside=join(root,"..","trebell-native-outside-"+Date.now()+".txt");
  try{
    const execute=createNativeBuiltins({root});
    await assert.rejects(()=>execute({namespace:"trebell_workspace",name:"replace_text",arguments:{path:"src/app.js",old_text:"missing text",new_text:"oops"}}),/found 0.*No changes were written/i);
    assert.equal(await readFile(join(root,"src","app.js"),"utf8"),"const value = 1;\n");
    const guarded=await execute({namespace:"trebell_workspace",name:"replace_text",arguments:{path:"src/app.js",old_text:"value = 1",new_text:"value = 2"}});
    assert.match(guarded.beforeSha256,/^[a-f0-9]{64}$/);assert.match(guarded.afterSha256,/^[a-f0-9]{64}$/);assert.notEqual(guarded.beforeSha256,guarded.afterSha256);
    await assert.rejects(()=>execute({namespace:"trebell_workspace",name:"replace_text",arguments:{path:"src/app.js",old_text:"value = 2",new_text:"value = 3",expected_sha256:guarded.beforeSha256}}),/Expected current SHA-256.*No changes were written/i);
    assert.equal(await readFile(join(root,"src","app.js"),"utf8"),"const value = 2;\n");
    await assert.rejects(()=>execute({namespace:"trebell_workspace",name:"write_file",arguments:{path:"../"+outside.split(/[\\/]/).pop(),content:"escape"}}),/outside the active workspace/i);
    await assert.rejects(()=>execute({namespace:"trebell_workspace",name:"read_file",arguments:{path:"../does-not-belong.txt"}}),/outside the active workspace/i);
    await writeFile(outside,"outside","utf8");
    await assert.rejects(()=>execute({namespace:"trebell_workspace",name:"read_file",arguments:{path:outside}}),/outside the active workspace/i);
  }finally{await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250});await rm(outside,{force:true}).catch(()=>{})}
});

test("Native replace_text applies an edits list to one file in order, all or nothing, and returns the applied diff",async()=>{
  const root=await workspace(),source="function total(items) {\n  let sum = 0;\n  for (const item of items) sum += item.price;\n  return sum;\n}\n";
  try{
    await writeFile(join(root,"src","total.js"),source,"utf8");
    const execute=createNativeBuiltins({root});
    await assert.rejects(()=>execute({namespace:"trebell_workspace",name:"replace_text",arguments:{path:"src/total.js",edits:[
      {old_text:"let sum = 0;",new_text:"let sum = 0n;"},
      {old_text:"item.cost",new_text:"BigInt(item.cost)"},
    ]}}),error=>/^edits\[1\]: Expected 1 exact replacement in src\/total\.js, found 0\. No changes were written \(edits are all or nothing\)\./.test(error.message));
    assert.equal(await readFile(join(root,"src","total.js"),"utf8"),source,"a failing later hunk leaves the earlier hunks unwritten");
    const result=await execute({namespace:"trebell_workspace",name:"replace_text",arguments:{path:"src/total.js",edits:[
      {old_text:"let sum = 0;",new_text:"let sum = 0n;"},
      {old_text:"sum += item.price;",new_text:"sum += BigInt(item.price);"},
    ]}});
    assert.equal(await readFile(join(root,"src","total.js"),"utf8"),"function total(items) {\n  let sum = 0n;\n  for (const item of items) sum += BigInt(item.price);\n  return sum;\n}\n");
    assert.equal(result.replacements,2);
    assert.equal(result.diff,["@@ -1,5 +1,5 @@"," function total(items) {","-  let sum = 0;","-  for (const item of items) sum += item.price;","+  let sum = 0n;","+  for (const item of items) sum += BigInt(item.price);","   return sum;"," }"].join("\n"));
    assert.match(result.beforeSha256,/^[a-f0-9]{64}$/);assert.match(result.afterSha256,/^[a-f0-9]{64}$/,"the raw result keeps both hashes for audit logs");
    assert.ok(Object.keys(result).indexOf("afterSha256")<Object.keys(result).indexOf("diff"),"the hashes come before the diff, so a capped audit record keeps them");
    const single=await execute({namespace:"trebell_workspace",name:"replace_text",arguments:{path:"src/app.js",old_text:"value = 1",new_text:"value = 2",expected_replacements:1,edits:[]}});
    assert.equal(single.replacements,1,"the model's every-field shape (an empty edits list beside old_text) applies the single edit");assert.equal(single.diff,"@@ -1 +1 @@\n-const value = 1;\n+const value = 2;");
    await assert.rejects(()=>execute({namespace:"trebell_workspace",name:"replace_text",arguments:{path:"src/app.js",old_text:"const  value = 2;",new_text:"x"}}),
      error=>error.message==="Expected 1 exact replacement in src/app.js, found 0. No changes were written.\nold_text matches line 1 when whitespace is ignored. The exact current text there:\n1| const value = 2;");
    assert.equal(await readFile(join(root,"src","app.js"),"utf8"),"const value = 2;\n");
  }finally{await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("Native workspace tools keep absolute paths that name the workspace root or a path inside it",async()=>{
  const root=await workspace(),rooted=rootedSpelling(root),doubled=join(root,rooted.replace(/^[\\/]+/,""));
  try{
    const execute=createNativeBuiltins({root}),cwdScript="process.stdout.write(process.cwd())";
    const listedRoot=await execute({namespace:"trebell_workspace",name:"list",arguments:{path:rooted,depth:1,limit:20}});
    assert.equal(listedRoot.root,root);assert.ok(listedRoot.entries.some(item=>item.name==="src"));
    const listedSrc=await execute({namespace:"trebell_workspace",name:"list",arguments:{path:rooted+"/src",depth:1,limit:20}});
    assert.equal(listedSrc.root,join(root,"src"));assert.ok(listedSrc.entries.some(item=>item.name==="app.js"));
    const read=await execute({namespace:"trebell_workspace",name:"read_file",arguments:{path:rooted+"/src/app.js"}});
    assert.equal(read.path,join(root,"src","app.js"));assert.equal(read.content,"const value = 1;\n");
    const written=await execute({namespace:"trebell_workspace",name:"write_file",arguments:{path:rooted+"/n.txt",content:"new\n"}});
    assert.equal(written.path,join(root,"n.txt"));assert.equal(written.existedBefore,false);assert.equal(await readFile(join(root,"n.txt"),"utf8"),"new\n");
    const nestedWrite=await execute({namespace:"trebell_workspace",name:"write_file",arguments:{path:rooted+"/src/deep/m.txt",content:"deep\n"}});
    assert.equal(nestedWrite.path,join(root,"src","deep","m.txt"));
    assert.equal(await missing(doubled),true,"write_file must never create <root>/<root>/...");
    const rewritten=await execute({namespace:"trebell_workspace",name:"write_file",arguments:{path:rooted+"/n.txt",content:"again\n"}});
    assert.equal(rewritten.existedBefore,true);assert.equal(await readFile(join(root,"n.txt"),"utf8"),"again\n");
    const replaced=await execute({namespace:"trebell_workspace",name:"replace_text",arguments:{path:rooted+"/src/app.js",old_text:"value = 1",new_text:"value = 2"}});
    assert.equal(replaced.replacements,1);assert.equal(await readFile(join(root,"src","app.js"),"utf8"),"const value = 2;\n");
    const atRoot=await execute({namespace:"trebell_terminal",name:"run",arguments:{command:process.execPath,args:["-e",cwdScript],cwd:rooted,timeout_ms:5000,max_output_bytes:65536}});
    assert.equal(atRoot.exitCode,0);assert.equal(atRoot.stdout,root);
    const inSrc=await execute({namespace:"trebell_terminal",name:"run",arguments:{command:process.execPath,args:["-e",cwdScript],cwd:rooted+"/src",timeout_ms:5000,max_output_bytes:65536}});
    assert.equal(inSrc.exitCode,0);assert.equal(inSrc.stdout,join(root,"src"));
    // The conventional /workspace alias still maps to the workspace root when the root is not /workspace.
    const alias=await execute({namespace:"trebell_workspace",name:"read_file",arguments:{path:"/workspace/src/app.js"}});
    assert.equal(alias.path,join(root,"src","app.js"));assert.equal(alias.content,"const value = 2;\n");
    const aliasWritten=await execute({namespace:"trebell_workspace",name:"write_file",arguments:{path:"/workspace/w.txt",content:"w\n"}});
    assert.equal(aliasWritten.path,join(root,"w.txt"));
    const aliasList=await execute({namespace:"trebell_workspace",name:"list",arguments:{path:"/workspace/src",depth:1,limit:20}});
    assert.equal(aliasList.root,join(root,"src"));
    const aliasCwd=await execute({namespace:"trebell_terminal",name:"run",arguments:{command:process.execPath,args:["-e",cwdScript],cwd:"/workspace",timeout_ms:5000,max_output_bytes:65536}});
    assert.equal(aliasCwd.exitCode,0);assert.equal(aliasCwd.stdout,root);
  }finally{await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("Native workspace tools still reject absolute in-root spellings that a link resolves outside the root",async()=>{
  // The workspace and the link target share one temporary parent, so cleanup never reaches beyond it.
  const parent=await mkdtemp(join(tmpdir(),"trebell-native-link-")),root=join(parent,"root"),outside=join(parent,"outside");
  try{
    await mkdir(join(root,"src"),{recursive:true});await mkdir(outside,{recursive:true});await writeFile(join(outside,"secret.txt"),"outside\n","utf8");
    // A junction needs no privilege on Windows; elsewhere a directory symlink behaves the same.
    await symlink(outside,join(root,"linked"),process.platform==="win32"?"junction":"dir");
    const execute=createNativeBuiltins({root}),rooted=rootedSpelling(root);
    await assert.rejects(execute({namespace:"trebell_workspace",name:"read_file",arguments:{path:"linked/secret.txt"}}),/outside the active workspace/i);
    await assert.rejects(execute({namespace:"trebell_workspace",name:"read_file",arguments:{path:rooted+"/linked/secret.txt"}}),/outside the active workspace/i);
    await assert.rejects(execute({namespace:"trebell_workspace",name:"list",arguments:{path:rooted+"/linked",depth:1,limit:20}}),/outside the active workspace/i);
    await assert.rejects(execute({namespace:"trebell_workspace",name:"write_file",arguments:{path:rooted+"/linked/new.txt",content:"escape\n"}}),/outside the active workspace/i);
    await assert.rejects(execute({namespace:"trebell_workspace",name:"replace_text",arguments:{path:rooted+"/linked/secret.txt",old_text:"outside",new_text:"inside"}}),/outside the active workspace/i);
    await assert.rejects(execute({namespace:"trebell_terminal",name:"run",arguments:{command:process.execPath,args:["-e","0"],cwd:rooted+"/linked",timeout_ms:5000}}),/outside the active workspace/i);
    assert.equal(await readFile(join(outside,"secret.txt"),"utf8"),"outside\n");
    assert.equal(await missing(join(outside,"new.txt")),true);
  }finally{await rm(parent,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("Native workspace paths outside the root keep their previous handling",async()=>{
  const root=await workspace(),sibling=await mkdtemp(join(tmpdir(),"trebell-native-sibling-"));
  try{
    await writeFile(join(sibling,"secret.txt"),"sibling\n","utf8");
    const execute=createNativeBuiltins({root}),siblingRooted=rootedSpelling(sibling);
    // Unchanged: a separator-rooted path outside the workspace is still read as root-relative, so it never reaches the sibling.
    const remappedDirectory=join(root,siblingRooted.replace(/^[\\/]+/,""));
    await assert.rejects(execute({namespace:"trebell_workspace",name:"read_file",arguments:{path:siblingRooted+"/secret.txt"}}),error=>error?.code==="ENOENT");
    await assert.rejects(execute({namespace:"trebell_terminal",name:"run",arguments:{command:process.execPath,args:["-e","0"],cwd:siblingRooted}}),error=>error?.code==="ENOENT");
    const remapped=await execute({namespace:"trebell_workspace",name:"write_file",arguments:{path:siblingRooted+"/created.txt",content:"inside\n"}});
    assert.equal(remapped.path,join(remappedDirectory,"created.txt"));
    assert.equal(await missing(join(sibling,"created.txt")),true);
    const remappedCwd=await execute({namespace:"trebell_terminal",name:"run",arguments:{command:process.execPath,args:["-e","process.stdout.write(process.cwd())"],cwd:siblingRooted,timeout_ms:5000,max_output_bytes:65536}});
    assert.equal(remappedCwd.stdout,remappedDirectory);
    await assert.rejects(execute({namespace:"trebell_workspace",name:"read_file",arguments:{path:"../"+basename(sibling)+"/secret.txt"}}),/outside the active workspace/i);
    await assert.rejects(execute({namespace:"trebell_workspace",name:"write_file",arguments:{path:"../"+basename(sibling)+"/escape.txt",content:"escape"}}),/outside the active workspace/i);
    await assert.rejects(execute({namespace:"trebell_terminal",name:"run",arguments:{command:process.execPath,args:["-e","0"],cwd:"../"+basename(sibling)}}),/outside the active workspace/i);
    if(process.platform==="win32")await assert.rejects(execute({namespace:"trebell_workspace",name:"read_file",arguments:{path:join(sibling,"secret.txt")}}),/outside the active workspace/i);
    assert.equal(await missing(join(sibling,"escape.txt")),true);
  }finally{await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250});await rm(sibling,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("Native terminal uses a least-privilege environment and workspace cwd",async()=>{
  const root=await workspace();
  try{
    const execute=createNativeBuiltins({root,environment:{...process.env,NATIVE_TEST_SECRET_TOKEN:"super-secret-native-value"}});
    const script='process.stdout.write(JSON.stringify({cwd:process.cwd(),secret:process.env.NATIVE_TEST_SECRET_TOKEN||null}))';
    const result=await execute({namespace:"trebell_terminal",name:"run",arguments:{command:process.execPath,args:["-e",script],cwd:"src",timeout_ms:5000,max_output_bytes:65536}});
    assert.equal(result.exitCode,0);assert.equal(result.timedOut,false);const parsed=JSON.parse(result.stdout);assert.equal(parsed.cwd,join(root,"src"));assert.equal(parsed.secret,null);
    const virtualRoot=await execute({namespace:"trebell_terminal",name:"run",arguments:{command:process.execPath,args:["-e","process.stdout.write(process.cwd())"],cwd:"/workspace/src",timeout_ms:5000,max_output_bytes:65536}});
    assert.equal(virtualRoot.exitCode,0);assert.equal(virtualRoot.stdout,join(root,"src"));
    const conventionalRoot=await execute({namespace:"trebell_terminal",name:"run",arguments:{command:process.execPath,args:["-e","process.stdout.write(process.cwd())"],cwd:"workspace",timeout_ms:5000,max_output_bytes:65536}});
    assert.equal(conventionalRoot.exitCode,0);assert.equal(conventionalRoot.stdout,root);
    const conventionalSrc=await execute({namespace:"trebell_terminal",name:"run",arguments:{command:process.execPath,args:["-e","process.stdout.write(process.cwd())"],cwd:"workspace/src",timeout_ms:5000,max_output_bytes:65536}});
    assert.equal(conventionalSrc.exitCode,0);assert.equal(conventionalSrc.stdout,join(root,"src"));
    const appSrc=await execute({namespace:"trebell_terminal",name:"run",arguments:{command:process.execPath,args:["-e","process.stdout.write(process.cwd())"],cwd:"/app/src",timeout_ms:5000,max_output_bytes:65536}});
    assert.equal(appSrc.exitCode,0);assert.equal(appSrc.stdout,join(root,"src"));
    await mkdir(join(root,"workspace"),{recursive:true});
    const realWorkspaceDir=await execute({namespace:"trebell_terminal",name:"run",arguments:{command:process.execPath,args:["-e","process.stdout.write(process.cwd())"],cwd:"workspace",timeout_ms:5000,max_output_bytes:65536}});
    assert.equal(realWorkspaceDir.exitCode,0);assert.equal(realWorkspaceDir.stdout,join(root,"workspace"));
    await mkdir(join(root,"app","src"),{recursive:true});await writeFile(join(root,"app","src","literal.js"),"literal\n","utf8");
    const realAppDir=await execute({namespace:"trebell_workspace",name:"read_file",arguments:{path:"/app/src/literal.js"}});assert.equal(realAppDir.content,"literal\n");
  }finally{await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

// What a Node child needs from this machine to start, and nothing else of its environment: no one's real secrets reach these tests.
function hostBaseline(){
  const wanted=new Set(["PATH","SYSTEMROOT","WINDIR","COMSPEC","TEMP","TMP","TMPDIR","HOME","USERPROFILE","PROGRAMFILES"]);
  return Object.fromEntries(Object.keys(process.env).filter(name=>wanted.has(name.toUpperCase())).map(name=>[name,process.env[name]]));
}
const NATIVE_TOOLCHAIN_FIXTURE=Object.freeze({GEM_HOME:"/fixture/bundle",BUNDLE_PATH:"/fixture/bundle",CARGO_HOME:"/fixture/cargo",RUSTUP_HOME:"/fixture/rustup",JAVA_HOME:"/fixture/jdk",GOPATH:"/fixture/go",VIRTUAL_ENV:"/fixture/venv"});
const NATIVE_SECRET_FIXTURE=Object.freeze({
  OPENAI_API_KEY:"sk-fixture-openai",ANTHROPIC_API_KEY:"sk-ant-fixture",GITHUB_TOKEN:"ghp_fixture",AWS_SECRET_ACCESS_KEY:"fixture-aws-secret",
  NATIVE_FIXTURE_TOKEN:"fixture-token",BUNDLE_GEMS__EXAMPLE__COM:"fixture-user:fixture-pass",RUSTUP_DIST_SERVER:"https://fixture-user:fixture-pass@mirror.example/rustup",
});
function environmentEcho(names){return `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(names)}.map(name=>[name,process.env[name]??null]))))`}

test("Native terminal commands keep the project's toolchain variables and never the app's or the person's secrets",async()=>{
  const root=await workspace();
  try{
    const host=hostBaseline(),execute=createNativeBuiltins({root,environment:{...host,...NATIVE_TOOLCHAIN_FIXTURE,...NATIVE_SECRET_FIXTURE}});
    // On Windows the toolchains also look in the program folders (Visual Studio's vswhere, the .NET SDK).
    const windows=process.platform==="win32"?Object.keys(host).filter(name=>/^ProgramFiles$/i.test(name)):[];
    const names=[...Object.keys(NATIVE_TOOLCHAIN_FIXTURE),...Object.keys(NATIVE_SECRET_FIXTURE),...windows];
    const result=await execute({namespace:"trebell_terminal",name:"run",arguments:{command:process.execPath,args:["-e",environmentEcho(names)],timeout_ms:15000,max_output_bytes:65536}});
    assert.equal(result.exitCode,0,result.stderr);
    assert.deepEqual(JSON.parse(result.stdout),{...NATIVE_TOOLCHAIN_FIXTURE,...Object.fromEntries(Object.keys(NATIVE_SECRET_FIXTURE).map(name=>[name,null])),...Object.fromEntries(windows.map(name=>[name,host[name]]))});
  }finally{await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("Native terminal commands on a remote host forward the toolchain names through the guarded list, not the plain one",async()=>{
  let launch=null;
  const environments={
    get:()=>({id:"ssh-1",name:"Build",type:"ssh",cwd:"/workspace"}),
    executeArgv:async(_id,options)=>({exitCode:0,stdout:String(options.args[0])+"\n"}),
    spawnArgv:(id,options)=>{
      launch={id,options};const child=new EventEmitter();child.stdout=Readable.from([]);child.stderr=Readable.from([]);child.pid=4321;
      process.nextTick(()=>child.emit("close",0,null));return child;
    },
  };
  const execute=createNativeBuiltins({root:"/workspace",environments,environmentId:"ssh-1",environment:{...NATIVE_TOOLCHAIN_FIXTURE,...NATIVE_SECRET_FIXTURE}});
  const result=await execute({namespace:"trebell_terminal",name:"run",arguments:{command:"cargo",args:["test"],timeout_ms:5000}});
  assert.equal(result.exitCode,0);assert.equal(launch.id,"ssh-1");assert.equal(launch.options.command,"cargo");
  const guarded=launch.options.guardedEnvironmentNames||[],plain=launch.options.environmentNames||[];
  for(const name of Object.keys(NATIVE_TOOLCHAIN_FIXTURE))assert.ok(guarded.includes(name),name);
  for(const name of Object.keys(NATIVE_TOOLCHAIN_FIXTURE))assert.equal(plain.includes(name),false,name+" is checked on the host, not forwarded as it is");
  for(const name of [...Object.keys(NATIVE_SECRET_FIXTURE).filter(name=>name!=="RUSTUP_DIST_SERVER"),"GOPROXY","PIP_INDEX_URL","UV_INDEX_URL","HTTPS_PROXY"])assert.equal(guarded.includes(name)||plain.includes(name),false,name);
  assert.equal(Object.prototype.hasOwnProperty.call(launch.options,"environment")&&launch.options.environment!=null,false,"the parent's values never travel to the host");
});

test("Native terminal rejects cwd escapes and cancellation kills the running process",async()=>{
  const root=await workspace();
  try{
    const execute=createNativeBuiltins({root});
    await assert.rejects(()=>execute({namespace:"trebell_terminal",name:"run",arguments:{command:process.execPath,args:["-e","process.exit(0)"],cwd:".."}}),/outside the active workspace/i);
    const controller=new AbortController();const pending=execute({namespace:"trebell_terminal",name:"run",arguments:{command:process.execPath,args:["-e","setTimeout(()=>{},5000)"],timeout_ms:10000},signal:controller.signal});setTimeout(()=>controller.abort(),20);
    await assert.rejects(pending,error=>error?.name==="AbortError");
  }finally{await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

test("Native terminal timeout kills descendant processes that inherit stdio",async()=>{
  const root=await workspace();
  try{
    const execute=createNativeBuiltins({root});
    const pidPath=join(root,"descendant.pid");
    const childScript="setInterval(()=>{},1000)";
    const parentScript=[
      "const {spawn}=require('node:child_process');",
      "const fs=require('node:fs');",
      `const child=spawn(process.execPath,['-e',${JSON.stringify(childScript)}],{stdio:'inherit'});`,
      `fs.writeFileSync(${JSON.stringify(pidPath)},String(child.pid));`,
      "setInterval(()=>{},1000);",
    ].join("");
    const started=Date.now();
    const result=await execute({namespace:"trebell_terminal",name:"run",arguments:{command:process.execPath,args:["-e",parentScript],timeout_ms:1000}});
    assert.equal(result.timedOut,true);
    assert.ok(Date.now()-started<5000,`timed-out process tree should settle promptly, took ${Date.now()-started} ms`);
    const descendantPid=Number(await readFile(pidPath,"utf8"));
    let descendantAlive=true;
    for(let attempt=0;attempt<20&&descendantAlive;attempt++){
      try{process.kill(descendantPid,0);await new Promise(resolve=>setTimeout(resolve,50))}
      catch(error){if(error?.code==="ESRCH")descendantAlive=false;else throw error}
    }
    assert.equal(descendantAlive,false,"timed-out terminal command must not leave the descendant process running");
  }finally{await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});

// npm, npx, yarn and pnpm are .cmd launchers on Windows, which child_process.spawn cannot start without a shell ("spawn npm
// ENOENT"). A launcher found on PATH runs, its exit code comes back, and shell metacharacters in arguments stay literal.
test("Native terminal runs Windows .cmd launchers found on PATH with literal arguments",{skip:process.platform!=="win32"},async()=>{
  const root=await workspace(),bin=await mkdtemp(join(tmpdir(),"trebell-native-cmd-"));
  try{
    await writeFile(join(bin,"trebell-echo.cmd"),"@echo off\r\necho ARGS=%*\r\nexit /b 3\r\n","utf8");
    const environment={...process.env,PATH:bin+";"+(process.env.PATH||process.env.Path||"")};delete environment.Path;
    const execute=createNativeBuiltins({root,environment});
    const result=await execute({namespace:"trebell_terminal",name:"run",arguments:{command:"trebell-echo",args:["a&b","x y","50%"],timeout_ms:10000}});
    assert.equal(result.exitCode,3);
    assert.match(result.stdout,/ARGS=.*a&b.*x y.*50%/);
    assert.doesNotMatch(String(result.stdout)+String(result.stderr),/is not recognized/i);
  }finally{await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250});await rm(bin,{recursive:true,force:true,maxRetries:20,retryDelay:250})}
});
