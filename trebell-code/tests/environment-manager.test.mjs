import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { EnvironmentManager, remoteEnvironmentCommand } from "../src/environment-manager.mjs";

function stateFor(profiles){
  return {
    environments:()=>profiles,
    upsertEnvironment:value=>value,
    setEnvironmentEnabled:(id,enabled)=>{
      const profile=profiles.find(item=>item.id===id);if(!profile)return null;
      profile.enabled=enabled!==false;return {...profile};
    },
    removeEnvironment:()=>true,
  };
}

test("disabled environments remain listed but cannot be used until re-enabled",()=>{
  const profiles=[{id:"ssh",name:"SSH",type:"ssh",cwd:"/srv/app",host:"example.invalid",port:22,enabled:false}];
  const manager=new EnvironmentManager({state:stateFor(profiles)});
  assert.equal(manager.list()[0].enabled,false);
  assert.equal(manager.get("ssh"),null);
  assert.equal(manager.get("ssh",{includeDisabled:true}).name,"SSH");
  assert.equal(manager.setEnabled("ssh",true).enabled,true);
  assert.equal(manager.get("ssh").id,"ssh");
});

test("local environment capabilities report the actual host platform",async()=>{
  const manager=new EnvironmentManager({state:stateFor([]),platform:"linux"});
  const capabilities=await manager.capabilities();
  assert.equal(capabilities.local.available,true);
  assert.equal(capabilities.local.platform,"linux");
});

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

test("terminal specs keep interactive shells inside local, WSL and SSH environments",()=>{
  const profiles=[
    {id:"local-profile",name:"Named local",type:"local",cwd:"C:\\code\\app"},
    {id:"wsl",name:"Ubuntu dev",type:"wsl",cwd:"/home/me/app",distro:"Ubuntu"},
    {id:"ssh",name:"Build box",type:"ssh",cwd:"/srv/app",host:"build.example",user:"dev",port:2222,identityFile:"C:\\keys\\build"},
  ];
  const manager=new EnvironmentManager({state:stateFor(profiles),platform:"win32"});
  const local=manager.terminalSpec("local-profile",{cwd:"C:\\code\\other"});
  assert.equal(local.environmentType,"local");
  assert.equal(local.environmentId,"local-profile");
  assert.equal(local.shell,null);
  assert.equal(local.cwd,"C:\\code\\other");

  const wsl=manager.terminalSpec("wsl",{cwd:"/work/repo"});
  assert.equal(wsl.shell,"wsl.exe");
  assert.deepEqual(wsl.args.slice(0,4),["-d","Ubuntu","--","bash"]);
  assert.equal(wsl.args.at(-1).includes("cd '/work/repo'"),true);
  assert.equal(wsl.args.at(-1).includes("/bin/bash"),true);

  const ssh=manager.terminalSpec("ssh",{cwd:"/srv/app"});
  assert.equal(ssh.shell,"ssh.exe");
  assert.equal(ssh.args.includes("-tt"),true);
  assert.equal(ssh.args.includes("2222"),true);
  assert.equal(ssh.args.includes("C:\\keys\\build"),true);
  assert.equal(ssh.args.at(-2),"dev@build.example");
  assert.equal(ssh.args.at(-1).includes("cd '/srv/app'"),true);
});

test("terminal argv specs launch provider auth commands directly and quote remote arguments",()=>{
  const profiles=[
    {id:"local-profile",name:"Named local",type:"local",cwd:"C:\\code\\app"},
    {id:"wsl",name:"Ubuntu dev",type:"wsl",cwd:"/home/me/app",distro:"Ubuntu"},
    {id:"ssh",name:"Build box",type:"ssh",cwd:"/srv/app",host:"build.example",user:"dev",port:2222},
  ];
  const manager=new EnvironmentManager({state:stateFor(profiles),platform:"win32"});
  const local=manager.terminalArgvSpec("local-profile",{command:"C:\\Program Files\\Claude\\claude.exe",args:["auth","login"],cwd:"C:\\code\\app"});
  assert.equal(local.shell,"C:\\Program Files\\Claude\\claude.exe");
  assert.deepEqual(local.args,["auth","login"]);
  assert.equal(local.cwd,"C:\\code\\app");

  const wsl=manager.terminalArgvSpec("wsl",{command:"claude",args:["auth","login"],cwd:"/work/repo"});
  assert.equal(wsl.shell,"wsl.exe");
  assert.match(wsl.args.at(-1),/exec 'claude' 'auth' 'login'/);
  assert.match(wsl.args.at(-1),/linuxbrew/);

  const ssh=manager.terminalArgvSpec("ssh",{command:"opencode",args:["auth","login"],cwd:"/srv/app"});
  assert.equal(ssh.shell,"ssh.exe");
  assert.equal(ssh.args.includes("-tt"),true);
  assert.equal(ssh.args.at(-2),"dev@build.example");
  assert.match(ssh.args.at(-1),/exec 'opencode' 'auth' 'login'/);
});

test("remote runtime argv can clear the login environment and re-expose only approved names",()=>{
  const profile={id:"ssh",name:"Build box",type:"ssh",cwd:"/srv/app",host:"build.example",user:"dev",port:22};
  const manager=new EnvironmentManager({state:stateFor([profile]),platform:"linux"});
  let launch=null;
  manager.spawnSession=(_id,options)=>{launch=options;return {pid:123}};
  manager.spawnArgv("ssh",{command:"claude",args:["--version"],cwd:"/srv/app",environmentNames:["PATH","HOME","ANTHROPIC_API_KEY","bad-name?"]});
  assert.match(launch.command,/^env -i /);
  assert.match(launch.command,/PATH="\$\{PATH-\}"/);
  assert.match(launch.command,/ANTHROPIC_API_KEY="\$\{ANTHROPIC_API_KEY-\}"/);
  assert.doesNotMatch(launch.command,/bad-name/);
  assert.match(launch.command,/'claude' '--version'/);
  assert.equal(remoteEnvironmentCommand("'tool'",[]),"'tool'");
});
