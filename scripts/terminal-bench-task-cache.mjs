import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export function terminalBenchTaskQualifiedName(dataset,task){
  const datasetText=String(dataset||"").trim(),taskText=String(task||"").trim();
  const at=datasetText.lastIndexOf("@"),slash=datasetText.indexOf("/");
  if(at<=slash+1||slash<=0||at>=datasetText.length-1||!taskText)return null;
  const namespace=datasetText.slice(0,slash);
  if(taskText.includes("@"))return null;
  const packageTask=taskText.includes("/")?taskText:namespace+"/"+taskText;
  if(!packageTask.startsWith(namespace+"/"))return null;
  return packageTask;
}

export function terminalBenchTaskDockerImagesFromToml(text){
  const images=[];let section="";
  for(const rawLine of String(text||"").split(/\r?\n/)){
    const line=rawLine.trim();if(!line||line.startsWith("#"))continue;
    const header=line.match(/^\[([^\]]+)\]$/);if(header){section=header[1].trim();continue}
    if(section!=="environment"&&section!=="verifier.environment")continue;
    const match=line.match(/^docker_image\s*=\s*"([^"]+)"\s*$/);if(!match)continue;
    images.push({role:section==="environment"?"agent":"verifier",image:match[1]});
  }
  return images;
}

export async function terminalBenchCachedTaskToml({dataset,task,home=homedir(),cacheRoot=null}={}){
  const qualified=terminalBenchTaskQualifiedName(dataset,task);if(!qualified)return null;
  const [namespace,...parts]=qualified.split("/"),slug=parts.join("/");if(!namespace||!slug||slug.includes("/"))return null;
  const root=cacheRoot||join(home,".cache","harbor","tasks","packages",namespace,slug);
  const candidates=[];
  for(const entry of await readdir(root,{withFileTypes:true}).catch(()=>[])){
    if(!entry.isDirectory())continue;
    const taskToml=join(root,entry.name,"task.toml");
    try{const info=await stat(taskToml);candidates.push({taskToml,mtimeMs:info.mtimeMs})}catch{}
  }
  candidates.sort((a,b)=>b.mtimeMs-a.mtimeMs||String(a.taskToml).localeCompare(String(b.taskToml)));
  return candidates[0]?.taskToml||null;
}

export async function terminalBenchCachedDockerImages(options={}){
  const taskToml=await terminalBenchCachedTaskToml(options);if(!taskToml)return {taskToml:null,images:[]};
  const images=terminalBenchTaskDockerImagesFromToml(await readFile(taskToml,"utf8"));
  return {taskToml,images};
}

export async function prewarmTerminalBenchDockerImages({dataset,task,env,runFn,captureFn,docker="docker",home=homedir(),cacheRoot=null,maxAttempts=3}={}){
  if(typeof runFn!=="function")throw new TypeError("prewarmTerminalBenchDockerImages requires runFn");
  const {taskToml,images}=await terminalBenchCachedDockerImages({dataset,task,home,cacheRoot});
  if(!taskToml)return {completed:false,taskTomlFound:false,images:[],attempts:[]};
  const unique=[...new Map(images.map(item=>[item.image,item])).values()],attempts=[];
  for(const item of unique){
    let present=false;
    if(typeof captureFn==="function"){
      try{await captureFn(docker,["image","inspect",item.image],{env});present=true}catch{}
    }
    if(present){attempts.push({role:item.role,image:item.image,status:"already-present",attempt:0});continue}
    let lastError=null;
    for(let attempt=1;attempt<=Math.max(1,Number(maxAttempts)||1);attempt++){
      try{await runFn(docker,["pull",item.image],{env});attempts.push({role:item.role,image:item.image,status:"pulled",attempt});lastError=null;break}
      catch(error){lastError=error;attempts.push({role:item.role,image:item.image,status:"failed",attempt,error:String(error?.message||error).slice(0,500)})}
    }
    if(lastError)throw new Error(`Docker image prewarm failed after ${Math.max(1,Number(maxAttempts)||1)} attempts for ${item.role} image ${item.image}: ${lastError?.message||lastError}`);
  }
  return {completed:true,taskTomlFound:true,images:unique,attempts};
}

export function terminalBenchTaskPackageRef(dataset,task){
  const datasetText=String(dataset||"").trim(),packageTask=terminalBenchTaskQualifiedName(dataset,task);
  const at=datasetText.lastIndexOf("@"),ref=at>=0?datasetText.slice(at+1):"";
  return packageTask&&ref?packageTask+"@"+ref:null;
}

export async function prewarmTerminalBenchTaskCache({harbor,dataset,task,env,runFn}){
  if(typeof runFn!=="function")throw new TypeError("prewarmTerminalBenchTaskCache requires runFn");
  const packageRef=terminalBenchTaskPackageRef(dataset,task);
  if(!packageRef)throw new Error(`Cannot derive a registry task package ref for parallel Harbor prewarm: dataset=${dataset} task=${task}`);
  await runFn(harbor,["task","download",packageRef,"--cache"],{env});
  return {packageRef,completed:true};
}
