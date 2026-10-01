import { spawn } from "node:child_process";

function processNeedles(primaryNeedle,additionalNeedles=[]){
  return [...new Set([primaryNeedle,...additionalNeedles].map(value=>String(value||"").trim()).filter(Boolean))];
}

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

export async function lingeringJobProcesses(jobName,{cwd=process.cwd(),env=process.env,platform=process.platform,additionalNeedles=[]}={}){
  const needles=processNeedles(jobName,additionalNeedles);
  if(!needles.length)return [];
  if(platform==="win32"){
    // Pass the needles through the environment rather than embedding them in
    // the PowerShell argv. That keeps the scanner's own command line from
    // becoming a false positive for the exact tokens it is trying to detect.
    const needleEnv="TREBELL_PROCESS_DRAIN_NEEDLES";
    const script=`$needles=ConvertFrom-Json $env:${needleEnv}; Get-CimInstance Win32_Process | Where-Object { if ($_.ProcessId -eq $PID -or -not $_.CommandLine) { return $false }; foreach ($needle in $needles) { if ($_.CommandLine.IndexOf([string]$needle,[System.StringComparison]::OrdinalIgnoreCase) -ge 0) { return $true } }; return $false } | ForEach-Object { $_.ProcessId }`;
    const {stdout}=await capture("powershell.exe",["-NoProfile","-Command",script],{cwd,env:{...env,[needleEnv]:JSON.stringify(needles)}});
    return [...new Set(stdout.split(/\r?\n/).map(value=>value.trim()).filter(Boolean).map(Number).filter(Number.isInteger))];
  }
  const {stdout}=await capture("ps",["-eo","pid=,args="],{cwd,env});
  return parsePsProcesses(stdout,needles);
}

export function parsePsProcesses(stdout,needle,additionalNeedles=[]){
  const tokens=processNeedles(needle,additionalNeedles).map(token=>token.toLowerCase());
  if(!tokens.length)return [];
  return [...new Set(String(stdout||"").split(/\r?\n/).map(line=>line.trim()).filter(Boolean).map(line=>{
    const match=line.match(/^(\d+)\s+(.*)$/);
    const command=match?.[2]?.toLowerCase()||"";
    return match&&tokens.some(token=>command.includes(token))?Number(match[1]):null;
  }).filter(Number.isInteger))];
}

export async function waitForJobProcessDrain(jobName,{timeoutMs=300_000,pollMs=1_000,cwd=process.cwd(),env=process.env,platform=process.platform,additionalNeedles=[]}={}){
  const started=Date.now();
  for(;;){
    const pids=await lingeringJobProcesses(jobName,{cwd,env,platform,additionalNeedles});
    if(!pids.length)return;
    if(Date.now()-started>=timeoutMs)throw new Error(`Harbor lane ${jobName} left host processes alive after launcher exit (pids ${pids.join(",")}). Refusing to overlap the next benchmark lane.`);
    await new Promise(resolveWait=>setTimeout(resolveWait,Math.max(1,pollMs)));
  }
}
