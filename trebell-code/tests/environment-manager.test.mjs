import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

test("attachment validation enforces the aggregate 80 MiB image ceiling",async()=>{
  const manager=new EnvironmentManager({state:stateFor([{id:"local",name:"Local",type:"local",cwd:""}])});
  manager.attachmentInfo=async(_id,path)=>({path,size:10*1024*1024,image:true,environmentId:"local"});
  const accepted=await manager.validateAttachments("local",Array.from({length:8},(_,index)=>`image-${index}.png`));
  assert.equal(accepted.imageBytes,80*1024*1024);
  await assert.rejects(()=>manager.validateAttachments("local",Array.from({length:9},(_,index)=>`image-${index}.png`)),/80 MiB total/i);
});

test("attachment metadata is read inside remote environments",async()=>{
  const manager=new EnvironmentManager({state:stateFor([{id:"ssh",name:"SSH",type:"ssh",cwd:"/srv/project",host:"example.invalid",port:22}])});
  let command="";
  manager.execute=async(_id,options)=>{command=options.command;return {exitCode:0,stdout:"1234",stderr:"",timedOut:false}};
  const info=await manager.attachmentInfo("ssh","/srv/project/.trebell/attachments/picture.png");
  assert.equal(info.size,1234);assert.equal(info.image,true);assert.equal(info.environmentId,"ssh");
  assert.match(command,/wc -c/);assert.match(command,/picture\.png/);
});

test("local environments publish bounded theme files without shadowing built-ins",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-env-theme-"));
  try{
    const themes=join(root,"themes");await mkdir(themes,{recursive:true});
    await writeFile(join(themes,"nightfall.json"),JSON.stringify({name:"Nightfall",appearance:"dark",canvas:"#111827",accent:"#8b5cf6"}));
    await writeFile(join(themes,"dark.json"),JSON.stringify({name:"Shadow built-in",canvas:"#000000",accent:"#ffffff"}));
    await writeFile(join(themes,"broken.json"),"{not json");
    const manager=new EnvironmentManager({state:stateFor([]),env:{...process.env,TREBELL_HOME:root}});
    const catalog=await manager.themeCatalog();
    assert.equal(catalog.environmentKey,"local");
    assert.equal(catalog.directory,themes);
    assert.deepEqual(catalog.themes.map(theme=>theme.id),["nightfall"]);
    assert.equal(catalog.themes[0].published,true);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("remote environment themes are read through bounded argv commands",async()=>{
  const profile={id:"ssh",name:"Build box",type:"ssh",cwd:"/srv/project",host:"example.invalid",port:22,themeDirectory:"/srv/themes"};
  const manager=new EnvironmentManager({state:stateFor([profile])});
  const calls=[];
  manager.executeArgv=async(_id,options)=>{
    calls.push(options);
    if(options.command==="test")return {exitCode:0,stdout:"",stderr:""};
    if(options.command==="find")return {exitCode:0,stdout:"/srv/themes/nightfall.json\n/srv/themes/not allowed.json",stderr:""};
    if(options.command==="wc")return {exitCode:0,stdout:"82 /srv/themes/nightfall.json",stderr:""};
    if(options.command==="cat")return {exitCode:0,stdout:JSON.stringify({name:"Remote Nightfall",appearance:"dark",canvas:"#10151f",accent:"#5b8cff"}),stderr:""};
    throw new Error("unexpected command");
  };
  const catalog=await manager.themeCatalog("ssh");
  assert.equal(catalog.directory,"/srv/themes");
  assert.deepEqual(catalog.themes.map(theme=>theme.name),["Remote Nightfall"]);
  assert.deepEqual(calls.map(call=>call.command),["test","find","wc","cat"]);
});

test("remote environments without a published theme directory return an empty catalog",async()=>{
  const profile={id:"wsl",name:"Ubuntu",type:"wsl",cwd:"/home/me/project"};
  const manager=new EnvironmentManager({state:stateFor([profile]),platform:"win32"});
  manager.executeArgv=async()=>({exitCode:1,stdout:"",stderr:""});
  const catalog=await manager.themeCatalog("wsl");
  assert.deepEqual(catalog.themes,[]);
  assert.equal(catalog.directory,".trebell/themes");
});
