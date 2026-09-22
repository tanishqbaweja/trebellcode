import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EnvironmentManager } from "../src/environment-manager.mjs";

function stateFor(profiles){
  return {
    environments:()=>profiles,
    upsertEnvironment:value=>value,
    removeEnvironment:()=>true,
  };
}

test("prepareAttachment keeps local files local",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-env-local-"));
  try{
    const file=join(root,"note.txt");await writeFile(file,"LOCAL_OK","utf8");
    const manager=new EnvironmentManager({state:stateFor([{id:"local",name:"Local",type:"local",cwd:root}])});
    const result=await manager.prepareAttachment("local",file);
    assert.equal(result.path,resolve(file));
    assert.equal(result.copied,false);
    assert.equal(result.size,8);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("prepareAttachment streams remote bytes instead of embedding them in the command",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-env-remote-"));
  try{
    const bytes=Buffer.from(Array.from({length:4096},(_,index)=>index%251));
    const file=join(root,"payload.bin");await writeFile(file,bytes);
    const manager=new EnvironmentManager({state:stateFor([{id:"ssh",name:"SSH",type:"ssh",cwd:"/srv/project",host:"example.invalid",port:22}])});
    const chunks=[];let command="";
    manager.spawnSession=(_id,options)=>{
      command=options.command;
      const child=new EventEmitter();child.stderr=new PassThrough();
      child.stdin=new Writable({write(chunk,_encoding,callback){chunks.push(Buffer.from(chunk));callback()}});
      child.stdin.on("finish",()=>setImmediate(()=>child.emit("close",0,null)));
      return child;
    };
    const result=await manager.prepareAttachment("ssh",file);
    assert.equal(result.copied,true);
    assert.match(result.path,/^\/srv\/project\/\.trebell\/attachments\//);
    assert.deepEqual(Buffer.concat(chunks),bytes);
    assert.equal(command.includes(bytes.toString("base64")),false);
    assert.match(command,/cat > /);
  }finally{await rm(root,{recursive:true,force:true})}
});
