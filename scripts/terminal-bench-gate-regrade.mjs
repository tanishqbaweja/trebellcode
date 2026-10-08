import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readTrialVerifierSummary } from "./terminal-bench-verifier-summary.mjs";

// Regrade the deliverable snapshots a Native trial captured at each completion gate with the
// task's official verifier, so recovery value can be measured per gate without new inference.
function normalizedSource(value){return String(value||"").trim().replace(/[\\/]+$/,"")}
function snapshotRelativePath(source){return String(source||"").replace(/^[A-Za-z]:/,"").replace(/^[\\/]+/,"").replace(/[\\/]+$/,"")}

export async function listGateSnapshots(trialDir){
  const root=join(trialDir,"agent","gate-snapshots"),rows=[];
  for(const entry of await readdir(root,{withFileTypes:true}).catch(()=>[])){
    if(!entry.isDirectory()||!/^gate-\d+$/.test(entry.name))continue;
    try{rows.push({dir:join(root,entry.name),manifest:JSON.parse(String(await readFile(join(root,entry.name,"snapshot.json"),"utf8")).replace(/^﻿/,""))})}catch{}
  }
  return rows.sort((a,b)=>Number(a.manifest.index)-Number(b.manifest.index));
}

export function taskPathFromTrialConfig(config,{home=homedir()}={}){
  const name=String(config?.task?.name||"").trim(),ref=String(config?.task?.ref||"").trim().replace(/^sha256:/,"");
  if(!name||!ref||name.split("/").some(part=>!part||part===".."))return null;
  return join(home,".cache","harbor","tasks","packages",...name.split("/"),ref);
}

export async function buildGateSnapshotTrial({trialDir,snapshot,destination}){
  const original=JSON.parse(await readFile(join(trialDir,"artifacts","manifest.json"),"utf8"));
  await rm(destination,{recursive:true,force:true});await mkdir(destination,{recursive:true});
  for(const entry of await readdir(trialDir,{withFileTypes:true})){
    if(entry.name==="artifacts"||entry.name==="verifier")continue;
    await cp(join(trialDir,entry.name),join(destination,entry.name),{recursive:true,filter:path=>!/[\\/]agent[\\/]gate-snapshots(?:[\\/]|$)/.test(path)});
  }
  const captured=new Map((snapshot.manifest.entries||[]).map(item=>[normalizedSource(item.source),item]));
  const manifest=[],gaps=[];
  for(const item of original){
    const capturedItem=captured.get(normalizedSource(item.source));
    const declaredByAgent=item.service==null&&!String(item.source||"").startsWith("/logs/");
    if(!declaredByAgent||item.status!=="ok"){
      if(item.status==="ok")await cp(join(trialDir,item.destination),join(destination,item.destination),{recursive:true});
      manifest.push(item);continue;
    }
    if(capturedItem?.status==="ok"){
      await cp(join(snapshot.dir,"artifacts",snapshotRelativePath(item.source)),join(destination,item.destination),{recursive:true});
      manifest.push(item);
    }else if(capturedItem?.status==="missing"){
      manifest.push({...item,status:"missing"});
    }else{
      gaps.push({source:item.source,status:capturedItem?.status||"not_captured"});
      await cp(join(trialDir,item.destination),join(destination,item.destination),{recursive:true});
      manifest.push(item);
    }
  }
  await mkdir(join(destination,"artifacts"),{recursive:true});
  await writeFile(join(destination,"artifacts","manifest.json"),JSON.stringify(manifest,null,2)+"\n","utf8");
  return {exact:gaps.length===0,gaps};
}

function run(command,args){
  return new Promise((resolveRun,reject)=>{
    const child=spawn(command,args,{stdio:["ignore","pipe","pipe"],windowsHide:true,env:{...process.env,PYTHONUTF8:"1",PYTHONIOENCODING:"utf-8"}});let output="";
    child.stdout.on("data",chunk=>{output+=chunk});child.stderr.on("data",chunk=>{output+=chunk});
    child.once("error",reject);child.once("exit",code=>code===0?resolveRun(output):reject(new Error(`${command} exited with ${code}: ${output.trim().slice(-600)}`)));
  });
}

export async function regradeGateSnapshots({trialDir,outDir,taskPath=null,harbor=join(homedir(),".local","bin",process.platform==="win32"?"harbor.exe":"harbor")}){
  const config=JSON.parse(await readFile(join(trialDir,"config.json"),"utf8")),task=taskPath||taskPathFromTrialConfig(config);
  if(!task)throw new Error("Cannot derive the pinned task directory from the trial config; pass --task-path.");
  const trialName=String(config.trial_name||"trial"),results=[];
  for(const snapshot of await listGateSnapshots(trialDir)){
    const name=`${trialName}-gate-${snapshot.manifest.index}`,synthetic=join(outDir,"synthetic",name);
    const built=await buildGateSnapshotTrial({trialDir,snapshot,destination:synthetic});
    await run(harbor,["trial","regrade",synthetic,"-p",task,"-o",join(outDir,"regraded"),"--trial-name",name]);
    const summary=await readTrialVerifierSummary(join(outDir,"regraded",name)).catch(()=>null);
    results.push({gate:snapshot.manifest.index,modelTurn:snapshot.manifest.modelTurn??null,editRevision:snapshot.manifest.editRevision??null,atMs:snapshot.manifest.atMs??null,exact:built.exact,gaps:built.gaps,officialReward:summary?.officialReward??null,passed:summary?.passed??null,tests:summary?.tests??null});
  }
  const final=await readTrialVerifierSummary(trialDir).catch(()=>null);
  return {trialDir,task,gates:results,final:{officialReward:final?.officialReward??null,passed:final?.passed??null,tests:final?.tests??null}};
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [trialDir,...rest]=process.argv.slice(2);
  if(!trialDir)throw new Error("Usage: node scripts/terminal-bench-gate-regrade.mjs <trialDir> [--out=<dir>] [--task-path=<dir>]");
  const option=name=>rest.find(arg=>arg.startsWith(`--${name}=`))?.slice(name.length+3)||null;
  const outDir=resolve(option("out")||join(trialDir,"..","..","..",".harbor-validation","gate-regrade",String(trialDir).replace(/[\\/]+$/,"").split(/[\\/]/).slice(-2).join("__")));
  console.log(JSON.stringify(await regradeGateSnapshots({trialDir:resolve(trialDir),outDir,taskPath:option("task-path")}),null,2));
}
