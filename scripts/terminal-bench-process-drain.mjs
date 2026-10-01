import { spawn } from "node:child_process";

function processNeedles(primaryNeedle,additionalNeedles=[]){
  return [...new Set([primaryNeedle,...additionalNeedles].map(value=>String(value||"").trim()).filter(Boolean))];
}

export function harborLaneProcessCommand(command,jobName,{additionalNeedles=[]}={}){
  const text=String(command||""),lower=text.toLowerCase(),job=String(jobName||"").trim().toLowerCase(),trials=processNeedles("",additionalNeedles).map(value=>value.toLowerCase());
  const harborRun=/harbor(?:\.exe)?["']?\s+run\b/i.test(text)&&/--job-name\b/i.test(text);
  if(job&&harborRun&&lower.includes(job))return true;
  const dockerComposeProject=/(?:docker(?:\.exe)?["']?\s+compose|docker-compose(?:\.exe)?["']?\s+compose)\s+--project-name\b/i.test(text);
  return dockerComposeProject&&trials.some(token=>lower.includes(token));
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
    // Collect command lines without embedding benchmark tokens into the
    // scanner's argv, then apply the same signature-aware matcher as Unix.
    // Merely mentioning a job in a watcher/log-tail command must not keep the
    // benchmark lane alive.
    const script="$rows=Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine } | Select-Object ProcessId,CommandLine; @($rows) | ConvertTo-Json -Compress";
    const {stdout}=await capture("powershell.exe",["-NoProfile","-Command",script],{cwd,env});
    let rows=[];try{const parsed=JSON.parse(stdout.trim()||"[]");rows=Array.isArray(parsed)?parsed:[parsed]}catch{return []}
    return [...new Set(rows.filter(row=>harborLaneProcessCommand(row?.CommandLine,jobName,{additionalNeedles})).map(row=>Number(row?.ProcessId)).filter(Number.isInteger))];
  }
  const {stdout}=await capture("ps",["-eo","pid=,args="],{cwd,env});
  return parsePsProcesses(stdout,needles);
}

export function parsePsProcesses(stdout,needle,additionalNeedles=[]){
  const [jobName,...nestedNeedles]=Array.isArray(needle)?needle:processNeedles(needle,additionalNeedles);
  const trials=Array.isArray(needle)?nestedNeedles:additionalNeedles;
  if(!String(jobName||"").trim()&&!trials.length)return [];
  return [...new Set(String(stdout||"").split(/\r?\n/).map(line=>line.trim()).filter(Boolean).map(line=>{
    const match=line.match(/^(\d+)\s+(.*)$/);
    return match&&harborLaneProcessCommand(match[2],jobName,{additionalNeedles:trials})?Number(match[1]):null;
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
