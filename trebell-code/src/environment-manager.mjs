import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const MAX_OUTPUT=2*1024*1024;

function cleanText(value=""){
  return String(value).replace(/\u0000/g,"").replace(/\r/g,"").trimEnd();
}

function quotePosix(value){
  return "'" + String(value).replace(/'/g,"'\\''") + "'";
}

function shellCommand(command,args=[]){
  return [command,...args].map(quotePosix).join(" ");
}

async function runProcess(command,args=[],{
  cwd=undefined,
  env=process.env,
  timeoutMs=15000,
  maxOutput=MAX_OUTPUT,
}={}){
  return await new Promise((resolve,reject)=>{
    let settled=false;
    let stdout="";
    let stderr="";
    let timedOut=false;
    const child=spawn(command,args,{cwd,env,windowsHide:true,stdio:["ignore","pipe","pipe"]});
    const append=(current,chunk)=>{
      if(Buffer.byteLength(current,"utf8")>=maxOutput) return current;
      const next=current+String(chunk);
      return Buffer.byteLength(next,"utf8")>maxOutput
        ? Buffer.from(next,"utf8").subarray(0,maxOutput).toString("utf8")
        : next;
    };
    child.stdout?.on("data",chunk=>{stdout=append(stdout,chunk)});
    child.stderr?.on("data",chunk=>{stderr=append(stderr,chunk)});
    const timer=setTimeout(()=>{
      timedOut=true;
      try{child.kill("SIGKILL")}catch{}
    },Math.max(1000,Number(timeoutMs)||15000));
    child.once("error",error=>{
      if(settled)return;
      settled=true;clearTimeout(timer);reject(error);
    });
    child.once("close",(code,signal)=>{
      if(settled)return;
      settled=true;clearTimeout(timer);
      resolve({exitCode:code,signal,timedOut,stdout:cleanText(stdout),stderr:cleanText(stderr)});
    });
  });
}

function normalizedPort(value){
  const n=Number(value||22);
  return Number.isInteger(n)&&n>0&&n<=65535?n:22;
}

function validateProfile(input={}){
  const type=["local","wsl","ssh"].includes(input.type)?input.type:"local";
  const labels={local:"Local machine",wsl:"WSL",ssh:"SSH"};
  const next={
    id:String(input.id||randomUUID()),
    name:String(input.name||labels[type]).trim().slice(0,100),
    type,
    cwd:String(input.cwd||"").trim(),
    createdAt:Number(input.createdAt)||Date.now(),
    updatedAt:Date.now(),
  };
  if(type==="wsl"){
    next.distro=String(input.distro||"").trim().slice(0,120);
  }
  if(type==="ssh"){
    next.host=String(input.host||"").trim().slice(0,255);
    next.user=String(input.user||"").trim().slice(0,120);
    next.port=normalizedPort(input.port);
    next.identityFile=String(input.identityFile||"").trim();
    if(!next.host) throw new Error("SSH host is required");
  }
  return next;
}

export class EnvironmentManager {
  constructor({state,env=process.env,platform=process.platform}={}){
    if(!state) throw new Error("EnvironmentManager requires a TrebellStateStore");
    this.state=state;
    this.env=env;
    this.platform=platform;
  }

  list(){ return this.state.environments(); }
  get(id){ return this.state.environments().find(x=>x.id===id)||null; }

  upsert(profile){
    const existing=profile?.id?this.state.environments().find(x=>x.id===profile.id):null;
    return this.state.upsertEnvironment(validateProfile({...existing,...profile,createdAt:existing?.createdAt||profile?.createdAt}));
  }

  remove(id){ return this.state.removeEnvironment(id); }

  async capabilities(){
    let ssh={available:false,version:null,error:null};
    try{
      const result=await runProcess(this.platform==="win32"?"ssh.exe":"ssh",["-V"],{env:this.env,timeoutMs:5000});
      const version=(result.stderr||result.stdout||"").split("\n")[0]||null;
      ssh={available:result.exitCode===0||Boolean(version),version,error:result.exitCode===0?null:(result.stderr||null)};
    }catch(error){ssh={available:false,version:null,error:error.message};}

    let wsl={available:false,distros:[],error:null};
    if(this.platform==="win32"){
      try{
        const result=await runProcess("wsl.exe",["--list","--quiet"],{env:this.env,timeoutMs:8000});
        const distros=cleanText(result.stdout).split("\n").map(x=>x.trim()).filter(Boolean);
        wsl={available:result.exitCode===0,distros,error:result.exitCode===0?null:(result.stderr||"WSL is unavailable")};
      }catch(error){wsl={available:false,distros:[],error:error.message};}
    }
    return {local:{available:true},ssh,wsl};
  }

  async discover(){
    const capabilities=await this.capabilities();
    return {capabilities,profiles:this.list()};
  }

  spawnSession(id,{command,cwd=null,stdio=["ignore","pipe","pipe"]}={}){
    const profile=this.get(id);
    if(!profile) throw new Error("Environment profile was not found");
    const text=String(command||"").trim();
    if(!text) throw new Error("command is required");
    const working=String(cwd??profile.cwd??"").trim();
    let executable,args;

    if(profile.type==="local"){
      executable=this.platform==="win32"?"cmd.exe":"/bin/sh";
      args=this.platform==="win32"?["/d","/s","/c",text]:["-lc",text];
      return spawn(executable,args,{cwd:working||undefined,env:this.env,windowsHide:true,stdio});
    }
    if(profile.type==="wsl"){
      if(this.platform!=="win32") throw new Error("WSL environments are available only on Windows");
      executable="wsl.exe";
      args=[];
      if(profile.distro) args.push("-d",profile.distro);
      args.push("--","bash","-lc",working?("cd "+quotePosix(working)+" && "+text):text);
      return spawn(executable,args,{env:this.env,windowsHide:true,stdio});
    }
    if(profile.type==="ssh"){
      executable=this.platform==="win32"?"ssh.exe":"ssh";
      args=["-o","BatchMode=yes","-o","ConnectTimeout=8","-o","ServerAliveInterval=15","-p",String(normalizedPort(profile.port))];
      if(profile.identityFile) args.push("-i",profile.identityFile);
      const target=profile.user?(profile.user+"@"+profile.host):profile.host;
      args.push(target,working?("cd "+quotePosix(working)+" && "+text):text);
      return spawn(executable,args,{env:this.env,windowsHide:true,stdio});
    }
    throw new Error("Unsupported environment type");
  }

  spawnArgv(id,{command,args=[],cwd=null,stdio=["pipe","pipe","pipe"]}={}){
    const profile=this.get(id);
    if(!profile) throw new Error("Environment profile was not found");
    const executable=String(command||"").trim();
    if(!executable)throw new Error("command is required");
    const working=String(cwd??profile.cwd??"").trim();
    if(profile.type==="local")return spawn(executable,args,{cwd:working||undefined,env:this.env,windowsHide:true,stdio});
    return this.spawnSession(id,{command:shellCommand(executable,args),cwd:working||null,stdio});
  }

  async execute(id,{command,cwd=null,timeoutMs=30000}={}){
    const profile=this.state.environments().find(x=>x.id===id);
    if(!profile) throw new Error("Environment profile was not found");
    const text=String(command||"").trim();
    if(!text) throw new Error("command is required");
    const working=String(cwd??profile.cwd??"").trim();
    let executable,args,options={env:this.env,timeoutMs:Math.min(300000,Math.max(1000,Number(timeoutMs)||30000))};

    if(profile.type==="local"){
      executable=this.platform==="win32"?"cmd.exe":"/bin/sh";
      args=this.platform==="win32"?["/d","/s","/c",text]:["-lc",text];
      if(working) options.cwd=working;
    }else if(profile.type==="wsl"){
      if(this.platform!=="win32") throw new Error("WSL environments are available only on Windows");
      executable="wsl.exe";
      args=[];
      if(profile.distro) args.push("-d",profile.distro);
      const remoteCommand=working?("cd "+quotePosix(working)+" && "+text):text;
      args.push("--","bash","-lc",remoteCommand);
    }else if(profile.type==="ssh"){
      executable=this.platform==="win32"?"ssh.exe":"ssh";
      args=["-o","BatchMode=yes","-o","ConnectTimeout=8","-o","ServerAliveInterval=15","-p",String(normalizedPort(profile.port))];
      if(profile.identityFile) args.push("-i",profile.identityFile);
      const target=profile.user?(profile.user+"@"+profile.host):profile.host;
      args.push(target,working?("cd "+quotePosix(working)+" && "+text):text);
    }else{
      throw new Error("Unsupported environment type");
    }

    const startedAt=Date.now();
    const result=await runProcess(executable,args,options);
    return {...result,profile:{id:profile.id,name:profile.name,type:profile.type},durationMs:Date.now()-startedAt};
  }

  async executeArgv(id,{command,args=[],cwd=null,timeoutMs=30000}={}){
    const profile=this.get(id);
    if(!profile)throw new Error("Environment profile was not found");
    if(profile.type==="local"){
      const startedAt=Date.now();
      const result=await runProcess(String(command||""),Array.isArray(args)?args:[],{cwd:String(cwd??profile.cwd??"").trim()||undefined,env:this.env,timeoutMs:Math.min(300000,Math.max(1000,Number(timeoutMs)||30000))});
      return {...result,profile:{id:profile.id,name:profile.name,type:profile.type},durationMs:Date.now()-startedAt};
    }
    return this.execute(id,{command:shellCommand(String(command||""),Array.isArray(args)?args:[]),cwd,timeoutMs});
  }

  async probe(id){
    const profile=this.state.environments().find(x=>x.id===id);
    if(!profile) throw new Error("Environment profile was not found");
    const command=profile.type==="local"&&this.platform==="win32"
      ?"echo trebell-environment-ok && cd"
      :"printf 'trebell-environment-ok\\n'; pwd; uname -s";
    const result=await this.execute(id,{command,timeoutMs:12000});
    return {...result,ok:result.exitCode===0&&!result.timedOut&&result.stdout.includes("trebell-environment-ok")};
  }
}

export { runProcess };
