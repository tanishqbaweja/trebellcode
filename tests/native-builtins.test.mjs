import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,mkdir,readFile,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    const written=await execute({namespace:"trebell_workspace",name:"write_file",arguments:{path:"src/new.js",content:"export const ready = true;\n"}});assert.equal(written.createdOrReplaced,true);assert.equal(await readFile(join(root,"src","new.js"),"utf8"),"export const ready = true;\n");
    const rooted=await execute({namespace:"trebell_workspace",name:"read_file",arguments:{path:"/src/app.js"}});assert.equal(rooted.content,"const value = 2;\n");
    const rootList=await execute({namespace:"trebell_workspace",name:"list",arguments:{path:"/",depth:2,limit:20}});assert.ok(rootList.entries.some(item=>item.name==="src"));
  }finally{await rm(root,{recursive:true,force:true})}
});

test("Native exact replacement fails closed and workspace paths cannot escape",async()=>{
  const root=await workspace(),outside=join(root,"..","trebell-native-outside-"+Date.now()+".txt");
  try{
    const execute=createNativeBuiltins({root});
    await assert.rejects(()=>execute({namespace:"trebell_workspace",name:"replace_text",arguments:{path:"src/app.js",old_text:"missing text",new_text:"oops"}}),/found 0.*No changes were written/i);
    assert.equal(await readFile(join(root,"src","app.js"),"utf8"),"const value = 1;\n");
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
