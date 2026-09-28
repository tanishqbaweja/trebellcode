import { spawn } from "node:child_process";

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

export async function lingeringJobProcesses(jobName,{cwd=process.cwd(),env=process.env,platform=process.platform}={}){
  const needle=String(jobName||"").trim();
  if(!needle)return [];
  if(platform==="win32"){
    // Pass the needle through the environment rather than embedding it in the
    // PowerShell argv. That keeps the scanner's own command line from becoming
    // a false positive for the exact token it is trying to detect.
    const needleEnv="TREBELL_PROCESS_DRAIN_NEEDLE";
    const script=`$needle=$env:${needleEnv}; Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains($needle) } | ForEach-Object { $_.ProcessId }`;
    const {stdout}=await capture("powershell.exe",["-NoProfile","-Command",script],{cwd,env:{...env,[needleEnv]:needle}});
    return [...new Set(stdout.split(/\r?\n/).map(value=>value.trim()).filter(Boolean).map(Number).filter(Number.isInteger))];
  }
  const {stdout}=await capture("ps",["-eo","pid=,args="],{cwd,env});
  return parsePsProcesses(stdout,needle);
}

export function parsePsProcesses(stdout,needle){
  const token=String(needle||"");
  if(!token)return [];
  return [...new Set(String(stdout||"").split(/\r?\n/).map(line=>line.trim()).filter(Boolean).map(line=>{
    const match=line.match(/^(\d+)\s+(.*)$/);
    return match&&match[2].includes(token)?Number(match[1]):null;
  }).filter(Number.isInteger))];
}

export async function waitForJobProcessDrain(jobName,{timeoutMs=300_000,pollMs=1_000,cwd=process.cwd(),env=process.env,platform=process.platform}={}){
  const started=Date.now();
  for(;;){
    const pids=await lingeringJobProcesses(jobName,{cwd,env,platform});
    if(!pids.length)return;
    if(Date.now()-started>=timeoutMs)throw new Error(`Harbor lane ${jobName} left host processes alive after launcher exit (pids ${pids.join(",")}). Refusing to overlap the next benchmark lane.`);
    await new Promise(resolveWait=>setTimeout(resolveWait,Math.max(1,pollMs)));
  }
}
