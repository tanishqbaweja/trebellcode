import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import { basename, join, resolve, posix } from "node:path";
import { trebellHome } from "./paths.mjs";

const MAX_OUTPUT=2*1024*1024;
const MAX_THEME_FILES=32;
const MAX_THEME_FILE_BYTES=32*1024;
const MAX_THEME_TOTAL_BYTES=192*1024;
const RESERVED_THEME_IDS=new Set(["system","light","dark","midnight","black"]);

function cleanText(value=""){
  return String(value).replace(/\u0000/g,"").replace(/\r/g,"").trimEnd();
}

function quotePosix(value){
  return "'" + String(value).replace(/'/g,"'\\''") + "'";
}

function shellCommand(command,args=[]){
  return [command,...args].map(quotePosix).join(" ");
}

const REMOTE_TOOL_PATH_SCRIPT=`trebell_prepend_path() {
  if [ -d "$1" ]; then
    case ":$PATH:" in *":$1:"*) ;; *) PATH="$1:$PATH" ;; esac
  fi
}
trebell_prepend_path "/bin"
trebell_prepend_path "/usr/bin"
trebell_prepend_path "/usr/local/bin"
trebell_prepend_path "/home/linuxbrew/.linuxbrew/bin"
trebell_prepend_path "/opt/homebrew/bin"
trebell_prepend_path "$HOME/bin"
trebell_prepend_path "$HOME/.local/bin"
VOLTA_HOME="\${VOLTA_HOME:-$HOME/.volta}"; export VOLTA_HOME
trebell_prepend_path "$VOLTA_HOME/bin"
trebell_prepend_path "$HOME/.asdf/bin"
trebell_prepend_path "$HOME/.asdf/shims"
trebell_prepend_path "$HOME/.local/share/mise/shims"
trebell_prepend_path "$HOME/.mise/shims"
FNM_DIR="\${FNM_DIR:-$HOME/.local/share/fnm}"; export FNM_DIR
trebell_prepend_path "$FNM_DIR"
trebell_prepend_path "$HOME/.fnm"
trebell_prepend_path "$HOME/.nodenv/bin"
trebell_prepend_path "$HOME/.nodenv/shims"
if [ -d "$HOME/.nvm/versions/node" ]; then
  for trebell_node_bin in "$HOME"/.nvm/versions/node/*/bin; do
    [ -d "$trebell_node_bin" ] && trebell_prepend_path "$trebell_node_bin"
  done
fi
export PATH`;

export function remoteToolPathPrelude(){return REMOTE_TOOL_PATH_SCRIPT}

function remoteShellCommand(command,working=""){
  const run=working?("cd "+quotePosix(working)+" && "+command):command;
  return REMOTE_TOOL_PATH_SCRIPT+"\n"+run;
}

function publishedTheme(filename,raw){
  const id=String(filename||"").replace(/\.json$/i,"");
  if(!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(id)||RESERVED_THEME_IDS.has(id.toLowerCase()))return null;
  let parsed;
  try{parsed=JSON.parse(raw)}catch{return null}
  if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))return null;
  const colors=parsed.colors&&typeof parsed.colors==="object"&&!Array.isArray(parsed.colors)?parsed.colors:{};
  const hasCanvas=/^#[0-9a-f]{3,8}$/i.test(String(parsed.canvas||""));
  const hasEditor=/^#[0-9a-f]{3,8}$/i.test(String(colors["editor.background"]||colors.canvas||""));
  if(!hasCanvas&&!hasEditor)return null;
  return {...parsed,id,name:String(parsed.name||parsed.label||id).trim().slice(0,80)||id,published:true};
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
    enabled:input.enabled!==false,
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
  next.themeDirectory=String(input.themeDirectory||"").trim().slice(0,1024);
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
  get(id,{includeDisabled=false}={}){
    const profile=this.state.environments().find(x=>x.id===id)||null;
    return profile&&(includeDisabled||profile.enabled!==false)?profile:null;
  }

  upsert(profile){
    const existing=profile?.id?this.state.environments().find(x=>x.id===profile.id):null;
    return this.state.upsertEnvironment(validateProfile({...existing,...profile,createdAt:existing?.createdAt||profile?.createdAt}));
  }

  setEnabled(id,enabled){
    const existing=this.get(id,{includeDisabled:true});
    if(!existing)throw new Error("Environment profile was not found");
    return this.state.setEnvironmentEnabled(id,enabled);
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
    return {local:{available:true,platform:this.platform},ssh,wsl};
  }

  async discover(){
    const capabilities=await this.capabilities();
    return {capabilities,profiles:this.list()};
  }

  themeDirectory(id=null){
    const profile=id?this.get(id):null;
    if(id&&!profile)throw new Error("Environment profile was not found");
    if(!profile||profile.type==="local")return profile?.themeDirectory||join(trebellHome(this.env),"themes");
    return profile.themeDirectory||".trebell/themes";
  }

  async themeCatalog(id=null){
    const profile=id?this.get(id):null;
    if(id&&!profile)throw new Error("Environment profile was not found");
    const directory=this.themeDirectory(id);
    const themes=[];
    let totalBytes=0;
    if(!profile||profile.type==="local"){
      const entries=(await readdir(directory).catch(()=>[])).filter(name=>/\.json$/i.test(name)).sort().slice(0,MAX_THEME_FILES);
      for(const name of entries){
        const path=join(directory,name);
        const info=await lstat(path).catch(()=>null);
        if(!info||!info.isFile()||info.isSymbolicLink()||info.size>MAX_THEME_FILE_BYTES)continue;
        totalBytes+=info.size;if(totalBytes>MAX_THEME_TOTAL_BYTES)break;
        const raw=await readFile(path,"utf8").catch(()=>null);if(raw==null)continue;
        const theme=publishedTheme(name,raw);if(theme)themes.push(theme);
      }
    }else{
      const exists=await this.executeArgv(id,{command:"test",args:["-d",directory],timeoutMs:5000});
      if(exists.exitCode!==0)return {
        environmentId:profile.id,
        environmentKey:profile.id,
        environmentName:profile.name,
        environmentType:profile.type,
        directory,
        themes,
        limits:{maxFiles:MAX_THEME_FILES,maxFileBytes:MAX_THEME_FILE_BYTES,maxTotalBytes:MAX_THEME_TOTAL_BYTES},
      };
      const listing=await this.executeArgv(id,{command:"find",args:[directory,"-maxdepth","1","-type","f","-name","*.json"],timeoutMs:12000});
      if(listing.exitCode!==0)throw new Error(listing.stderr||`Could not read themes from ${profile.name}`);
      const paths=String(listing.stdout||"").split("\n").map(value=>value.trim()).filter(Boolean).sort().slice(0,MAX_THEME_FILES);
      for(const path of paths){
        const name=posix.basename(path);
        if(!/^[a-z0-9][a-z0-9._-]{0,79}\.json$/i.test(name))continue;
        const measured=await this.executeArgv(id,{command:"wc",args:["-c",path],timeoutMs:5000});
        const size=Number(String(measured.stdout||"").trim().split(/\s+/)[0]);
        if(measured.exitCode!==0||!Number.isFinite(size)||size<0||size>MAX_THEME_FILE_BYTES)continue;
        totalBytes+=size;if(totalBytes>MAX_THEME_TOTAL_BYTES)break;
        const contents=await this.executeArgv(id,{command:"cat",args:[path],timeoutMs:5000});
        if(contents.exitCode!==0)continue;
        const theme=publishedTheme(name,contents.stdout);if(theme)themes.push(theme);
      }
    }
    return {
      environmentId:profile?.id||null,
      environmentKey:profile?.id||"local",
      environmentName:profile?.name||"Local machine",
      environmentType:profile?.type||"local",
      directory,
      themes,
      limits:{maxFiles:MAX_THEME_FILES,maxFileBytes:MAX_THEME_FILE_BYTES,maxTotalBytes:MAX_THEME_TOTAL_BYTES},
    };
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
      args.push("--","bash","-lc",remoteShellCommand(text,working));
      return spawn(executable,args,{env:this.env,windowsHide:true,stdio});
    }
    if(profile.type==="ssh"){
      executable=this.platform==="win32"?"ssh.exe":"ssh";
      args=["-o","BatchMode=yes","-o","ConnectTimeout=8","-o","ServerAliveInterval=15","-p",String(normalizedPort(profile.port))];
      if(profile.identityFile) args.push("-i",profile.identityFile);
      const target=profile.user?(profile.user+"@"+profile.host):profile.host;
      args.push(target,remoteShellCommand(text,working));
      return spawn(executable,args,{env:this.env,windowsHide:true,stdio});
    }
    throw new Error("Unsupported environment type");
  }

  terminalSpec(id,{cwd=null}={}){
    const profile=id?this.get(id):null;
    if(!profile||profile.type==="local"){
      return {
        environmentId:profile?.id||null,
        environmentName:profile?.name||"Local machine",
        environmentType:"local",
        cwd:String(cwd??profile?.cwd??"").trim()||undefined,
        shell:null,
        args:null,
      };
    }
    const working=String(cwd??profile.cwd??"").trim();
    const remoteShell="\"$"+"{SHELL:-/bin/bash}\"";
    const launch=working
      ?"cd "+quotePosix(working)+" && exec "+remoteShell+" -l"
      :"exec "+remoteShell+" -l";
    if(profile.type==="wsl"){
      if(this.platform!=="win32")throw new Error("WSL environments are available only on Windows");
      const args=[];
      if(profile.distro)args.push("-d",profile.distro);
      args.push("--","bash","-lc",launch);
      return {
        environmentId:profile.id,
        environmentName:profile.name,
        environmentType:"wsl",
        cwd:undefined,
        shell:"wsl.exe",
        args,
      };
    }
    if(profile.type==="ssh"){
      const shell=this.platform==="win32"?"ssh.exe":"ssh";
      const args=["-tt","-o","BatchMode=yes","-o","ConnectTimeout=8","-o","ServerAliveInterval=15","-p",String(normalizedPort(profile.port))];
      if(profile.identityFile)args.push("-i",profile.identityFile);
      const target=profile.user?(profile.user+"@"+profile.host):profile.host;
      args.push(target,launch);
      return {
        environmentId:profile.id,
        environmentName:profile.name,
        environmentType:"ssh",
        cwd:undefined,
        shell,
        args,
      };
    }
    throw new Error("Unsupported environment type");
  }

  terminalArgvSpec(id,{command,args=[],cwd=null}={}){
    const profile=id?this.get(id):null;
    const executable=String(command||"").trim();
    if(!executable)throw new Error("command is required");
    if(!profile||profile.type==="local"){
      return {
        environmentId:profile?.id||null,
        environmentName:profile?.name||"Local machine",
        environmentType:"local",
        cwd:String(cwd??profile?.cwd??"").trim()||undefined,
        shell:executable,
        args:[...args],
      };
    }
    const working=String(cwd??profile.cwd??"").trim();
    const remoteCommand=REMOTE_TOOL_PATH_SCRIPT+"\n"+(working?("cd "+quotePosix(working)+" && "):"")+"exec "+shellCommand(executable,args);
    if(profile.type==="wsl"){
      if(this.platform!=="win32")throw new Error("WSL environments are available only on Windows");
      const launchArgs=[];if(profile.distro)launchArgs.push("-d",profile.distro);
      launchArgs.push("--","bash","-lc",remoteCommand);
      return {environmentId:profile.id,environmentName:profile.name,environmentType:"wsl",cwd:undefined,shell:"wsl.exe",args:launchArgs};
    }
    if(profile.type==="ssh"){
      const shell=this.platform==="win32"?"ssh.exe":"ssh";
      const launchArgs=["-tt","-o","BatchMode=yes","-o","ConnectTimeout=8","-o","ServerAliveInterval=15","-p",String(normalizedPort(profile.port))];
      if(profile.identityFile)launchArgs.push("-i",profile.identityFile);
      const target=profile.user?(profile.user+"@"+profile.host):profile.host;
      launchArgs.push(target,remoteCommand);
      return {environmentId:profile.id,environmentName:profile.name,environmentType:"ssh",cwd:undefined,shell,args:launchArgs};
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

  async execute(id,{command,cwd=null,timeoutMs=30000,maxOutput=MAX_OUTPUT}={}){
    const profile=this.state.environments().find(x=>x.id===id);
    if(!profile) throw new Error("Environment profile was not found");
    const text=String(command||"").trim();
    if(!text) throw new Error("command is required");
    const working=String(cwd??profile.cwd??"").trim();
    let executable,args,options={env:this.env,timeoutMs:Math.min(300000,Math.max(1000,Number(timeoutMs)||30000)),maxOutput:Math.max(1024,Math.min(16*1024*1024,Number(maxOutput)||MAX_OUTPUT))};

    if(profile.type==="local"){
      executable=this.platform==="win32"?"cmd.exe":"/bin/sh";
      args=this.platform==="win32"?["/d","/s","/c",text]:["-lc",text];
      if(working) options.cwd=working;
    }else if(profile.type==="wsl"){
      if(this.platform!=="win32") throw new Error("WSL environments are available only on Windows");
      executable="wsl.exe";
      args=[];
      if(profile.distro) args.push("-d",profile.distro);
      const remoteCommand=remoteShellCommand(text,working);
      args.push("--","bash","-lc",remoteCommand);
    }else if(profile.type==="ssh"){
      executable=this.platform==="win32"?"ssh.exe":"ssh";
      args=["-o","BatchMode=yes","-o","ConnectTimeout=8","-o","ServerAliveInterval=15","-p",String(normalizedPort(profile.port))];
      if(profile.identityFile) args.push("-i",profile.identityFile);
      const target=profile.user?(profile.user+"@"+profile.host):profile.host;
      args.push(target,remoteShellCommand(text,working));
    }else{
      throw new Error("Unsupported environment type");
    }

    const startedAt=Date.now();
    const result=await runProcess(executable,args,options);
    return {...result,profile:{id:profile.id,name:profile.name,type:profile.type},durationMs:Date.now()-startedAt};
  }

  async executeArgv(id,{command,args=[],cwd=null,timeoutMs=30000,maxOutput=MAX_OUTPUT}={}){
    const profile=this.get(id);
    if(!profile)throw new Error("Environment profile was not found");
    if(profile.type==="local"){
      const startedAt=Date.now();
      const result=await runProcess(String(command||""),Array.isArray(args)?args:[],{cwd:String(cwd??profile.cwd??"").trim()||undefined,env:this.env,timeoutMs:Math.min(300000,Math.max(1000,Number(timeoutMs)||30000)),maxOutput:Math.max(1024,Math.min(16*1024*1024,Number(maxOutput)||MAX_OUTPUT))});
      return {...result,profile:{id:profile.id,name:profile.name,type:profile.type},durationMs:Date.now()-startedAt};
    }
    return this.execute(id,{command:shellCommand(String(command||""),Array.isArray(args)?args:[]),cwd,timeoutMs,maxOutput});
  }

  async executeArgvInput(id,{command,args=[],input="",cwd=null,timeoutMs=30000,maxOutput=MAX_OUTPUT}={}){
    const profile=this.get(id);
    if(!profile)throw new Error("Environment profile was not found");
    const child=this.spawnArgv(id,{command:String(command||""),args:Array.isArray(args)?args:[],cwd,stdio:["pipe","pipe","pipe"]});
    const limit=Math.max(1024,Math.min(16*1024*1024,Number(maxOutput)||MAX_OUTPUT));
    const append=(current,chunk)=>{
      if(Buffer.byteLength(current,"utf8")>=limit)return current;
      const next=current+String(chunk);
      return Buffer.byteLength(next,"utf8")>limit?Buffer.from(next,"utf8").subarray(0,limit).toString("utf8"):next;
    };
    return new Promise((resolveInput,reject)=>{
      let stdout="",stderr="",settled=false,timedOut=false;
      child.stdout?.on("data",chunk=>{stdout=append(stdout,chunk)});
      child.stderr?.on("data",chunk=>{stderr=append(stderr,chunk)});
      const timer=setTimeout(()=>{timedOut=true;try{child.kill("SIGKILL")}catch{}},Math.min(300000,Math.max(1000,Number(timeoutMs)||30000)));
      const finish=(error,code=null,signal=null)=>{
        if(settled)return;settled=true;clearTimeout(timer);
        if(error)reject(error);
        else resolveInput({exitCode:code??1,signal,stdout,stderr,timedOut,profile:{id:profile.id,name:profile.name,type:profile.type}});
      };
      child.once("error",error=>finish(error));
      child.once("close",(code,signal)=>finish(null,code,signal));
      child.stdin?.end(Buffer.from(String(input??""),"utf8"));
    });
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

  async prepareAttachment(id,localPath){
    const requested=resolve(String(localPath||""));
    const info=await stat(requested);
    if(!info.isFile())throw new Error("Attachment path is not a file");
    const lower=requested.toLowerCase();
    const image=/\.(png|jpe?g|gif|webp|bmp|svg)$/.test(lower);
    const maxBytes=image?10*1024*1024:50*1024*1024;
    if(info.size>maxBytes)throw new Error(`${image?"Image":"Attachment"} is larger than ${Math.round(maxBytes/1024/1024)} MB`);
    const profile=id?this.get(id):null;
    if(!profile||profile.type==="local")return {path:requested,size:info.size,copied:false,environmentId:profile?.id||null};
    const safe=basename(requested).replace(/[^a-zA-Z0-9._-]/g,"_").slice(-100)||"attachment.bin";
    const root=String(profile.cwd||"/tmp").trim()||"/tmp";
    const dir=posix.join(root,".trebell","attachments");
    const remotePath=posix.join(dir,`${Date.now()}-${randomUUID().slice(0,8)}-${safe}`);
    const child=this.spawnSession(profile.id,{command:`mkdir -p ${quotePosix(dir)} && cat > ${quotePosix(remotePath)}`,cwd:"",stdio:["pipe","pipe","pipe"]});
    await new Promise((resolveCopy,reject)=>{
      let stderr="",settled=false;
      const finish=error=>{if(settled)return;settled=true;error?reject(error):resolveCopy()};
      child.stderr?.on("data",chunk=>{stderr=(stderr+String(chunk)).slice(-128*1024)});
      child.once("error",finish);
      child.once("close",code=>code===0?finish():finish(new Error(stderr.trim()||`Remote attachment copy exited with code ${code}`)));
      const input=createReadStream(requested);input.once("error",finish);input.pipe(child.stdin);
    });
    return {path:remotePath,size:info.size,copied:true,environmentId:profile.id};
  }

  async attachmentInfo(id,path){
    const requested=String(path||"").trim();if(!requested)throw new Error("Attachment path is required");
    const profile=id?this.get(id):null;
    let size;
    if(!profile||profile.type==="local"){
      const resolved=resolve(requested);const info=await stat(resolved);if(!info.isFile())throw new Error("Attachment path is not a file");size=info.size;
      return {path:resolved,size,image:/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(resolved),environmentId:profile?.id||null};
    }
    const result=await this.execute(profile.id,{command:`if [ -f ${quotePosix(requested)} ]; then wc -c < ${quotePosix(requested)}; else exit 44; fi`,cwd:"",timeoutMs:12000});
    if(result.exitCode!==0)throw new Error(result.stderr||`Attachment does not exist in ${profile.name}`);
    size=Number(String(result.stdout||"").trim());if(!Number.isFinite(size)||size<0)throw new Error("Could not determine attachment size");
    return {path:requested,size,image:/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(requested),environmentId:profile.id};
  }

  async writeTextFile(id,path,content){
    const profile=this.get(id);
    if(!profile)throw new Error("Environment profile was not found");
    if(profile.type==="local")throw new Error("writeTextFile is only for remote environments");
    const requested=String(path||"").trim();if(!requested)throw new Error("File path is required");
    const dir=posix.dirname(requested);
    const child=this.spawnSession(profile.id,{
      command:"mkdir -p "+quotePosix(dir)+" && cat > "+quotePosix(requested),
      cwd:"",
      stdio:["pipe","pipe","pipe"],
    });
    const bytes=Buffer.from(String(content??""),"utf8");
    await new Promise((resolveWrite,reject)=>{
      let stderr="",settled=false;
      const finish=error=>{if(settled)return;settled=true;error?reject(error):resolveWrite()};
      child.stderr?.on("data",chunk=>{stderr=(stderr+String(chunk)).slice(-128*1024)});
      child.once("error",finish);
      child.once("close",code=>code===0?finish():finish(new Error(stderr.trim()||("Remote file write exited with code "+code))));
      child.stdin.end(bytes);
    });
    return this.attachmentInfo(profile.id,requested);
  }

  streamFile(id,path,{start=null,length=null}={}){
    const profile=this.get(id);
    if(!profile)throw new Error("Environment profile was not found");
    if(profile.type==="local")throw new Error("streamFile is only for remote environments");
    const requested=String(path||"").trim();if(!requested)throw new Error("File path is required");
    let command="cat "+quotePosix(requested);
    if(start!=null&&length!=null){
      const safeStart=Math.max(0,Math.trunc(Number(start)||0));
      const safeLength=Math.max(0,Math.trunc(Number(length)||0));
      command="tail -c +"+(safeStart+1)+" "+quotePosix(requested)+" | head -c "+safeLength;
    }
    return this.spawnSession(profile.id,{command,cwd:"",stdio:["ignore","pipe","pipe"]});
  }

  async validateAttachments(id,paths,{maxCount=100,maxImageBytes=80*1024*1024}={}){
    const requested=Array.isArray(paths)?paths:[];if(requested.length>maxCount)throw new Error(`A message supports up to ${maxCount} attachments`);
    const files=[];let imageBytes=0;
    for(const path of requested){
      const file=await this.attachmentInfo(id,path);const maxBytes=file.image?10*1024*1024:50*1024*1024;
      if(file.size>maxBytes)throw new Error(`${file.image?"Image":"Attachment"} is larger than ${Math.round(maxBytes/1024/1024)} MB`);
      if(file.image){imageBytes+=file.size;if(imageBytes>maxImageBytes)throw new Error("Images in one message cannot exceed 80 MiB total")}
      files.push(file);
    }
    return {files,count:files.length,imageBytes,maxImageBytes};
  }
}

export { runProcess };
