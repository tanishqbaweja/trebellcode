import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

function capture(command,args,{cwd=process.cwd(),env=process.env}={}){
  return new Promise((resolveCapture,reject)=>{
    const child=spawn(command,args,{cwd,env,stdio:["ignore","pipe","pipe"],windowsHide:true});
    let stdout="",stderr="";
    child.stdout?.on("data",chunk=>{stdout+=String(chunk)});
    child.stderr?.on("data",chunk=>{stderr+=String(chunk)});
    child.once("error",reject);
    child.once("exit",(code,signal)=>code===0?resolveCapture({stdout,stderr}):reject(Object.assign(new Error(`${command} exited with ${signal||code}: ${stderr.trim()}`),{code,signal,stdout,stderr})));
  });
}

function quoteWindowsArg(value){
  const text=String(value);
  return `"${text.replace(/(\\*)"/g,"$1$1\\\"").replace(/(\\+)$/,"$1$1")}"`;
}

export async function launchDetachedDescriptor({descriptorPath,cwd=process.cwd(),platform=process.platform}={}){
  if(!descriptorPath)throw new Error("descriptorPath is required");
  if(platform!=="win32"){
    const child=spawn(process.execPath,[new URL("./detached-process-child.mjs",import.meta.url),descriptorPath],{
      cwd,detached:true,stdio:"ignore",windowsHide:true,
    });
    child.unref();
    return {pid:child.pid,method:"spawn-detached"};
  }

  const childScript=fileURLToPath(new URL("./detached-process-child.mjs",import.meta.url));
  const commandLine=[process.execPath,childScript,descriptorPath].map(quoteWindowsArg).join(" ");
  const ps=[
    "$result=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$env:TREBELL_DETACHED_COMMAND;CurrentDirectory=$env:TREBELL_DETACHED_CWD}",
    "$result | Select-Object ReturnValue,ProcessId | ConvertTo-Json -Compress",
  ].join("; ");
  const {stdout}=await capture("powershell.exe",["-NoProfile","-Command",ps],{
    cwd,
    env:{...process.env,TREBELL_DETACHED_COMMAND:commandLine,TREBELL_DETACHED_CWD:cwd},
  });
  const result=JSON.parse(stdout.trim());
  if(Number(result?.ReturnValue)!==0||!Number.isInteger(Number(result?.ProcessId))){
    throw new Error(`Win32_Process.Create failed: ${stdout.trim()||"no result"}`);
  }
  return {pid:Number(result.ProcessId),method:"win32-cim"};
}

export async function readDetachedStatus(statusPath){
  try{return JSON.parse(await readFile(statusPath,"utf8"))}catch{return null}
}

export async function writeDetachedDescriptor(path,value){
  await writeFile(path,JSON.stringify(value,null,2)+"\n","utf8");
}
