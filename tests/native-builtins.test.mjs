import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,mkdir,readFile,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { createNativeBuiltins } from "../src/native-builtins.mjs";

async function workspace(){
  const root=await mkdtemp(join(tmpdir(),"trebell-native-builtins-"));await mkdir(join(root,"src"),{recursive:true});await writeFile(join(root,"src","app.js"),"const value = 1;\n","utf8");return root;
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
  }finally{await rm(root,{recursive:true,force:true})}
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
  }finally{await rm(root,{recursive:true,force:true})}
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
  }finally{await rm(root,{recursive:true,force:true})}
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
  }finally{await rm(root,{recursive:true,force:true});await rm(outside,{force:true}).catch(()=>{})}
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
  }finally{await rm(root,{recursive:true,force:true})}
});

test("Native terminal rejects cwd escapes and cancellation kills the running process",async()=>{
  const root=await workspace();
  try{
    const execute=createNativeBuiltins({root});
    await assert.rejects(()=>execute({namespace:"trebell_terminal",name:"run",arguments:{command:process.execPath,args:["-e","process.exit(0)"],cwd:".."}}),/outside the active workspace/i);
    const controller=new AbortController();const pending=execute({namespace:"trebell_terminal",name:"run",arguments:{command:process.execPath,args:["-e","setTimeout(()=>{},5000)"],timeout_ms:10000},signal:controller.signal});setTimeout(()=>controller.abort(),20);
    await assert.rejects(pending,error=>error?.name==="AbortError");
  }finally{await rm(root,{recursive:true,force:true})}
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
  }finally{await rm(root,{recursive:true,force:true})}
});
