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

export function benchmarkRunPrefix(dataset){
  const text=String(dataset||"").trim().toLowerCase(),at=text.lastIndexOf("@"),ref=at>=0?text.slice(at+1):"",pkg=at>=0?text.slice(0,at):text;
  if(pkg==="terminal-bench/terminal-bench")return "tb"+(ref.match(/^(\d+)\./)?.[1]||"");
  if(pkg==="swe-bench/swe-bench-verified")return "swebv";
  return (pkg.split("/").pop()||"").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,20)||"bench";
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

function stripTomlComments(text){
  let out="",inString=false;
  for(let index=0;index<text.length;index++){
    const char=text[index];
    if(inString){out+=char;if(char==="\\"){out+=text[++index]||"";continue}if(char==='"')inString=false;continue}
    if(char==='"'){inString=true;out+=char;continue}
    if(char==="#"){while(index<text.length&&text[index]!=="\n")index++;out+="\n";continue}
    out+=char;
  }
  return out;
}

export function terminalBenchTaskArtifactsFromToml(text){
  const source=stripTomlComments(String(text||"")),header=source.search(/^artifacts\s*=\s*\[/m);if(header<0)return [];
  const open=source.indexOf("[",header);let depth=0,inString=false,close=-1;
  for(let index=open;index<source.length;index++){
    const char=source[index];
    if(inString){if(char==="\\"){index++;continue}if(char==='"')inString=false;continue}
    if(char==='"'){inString=true;continue}
    if(char==="["||char==="{")depth++;
    else if((char==="]"||char==="}")&&--depth===0){close=index;break}
  }
  if(close<0)return [];
  const entries=[];let current="",level=0;inString=false;
  for(let index=open+1;index<close;index++){
    const char=source[index];
    if(inString){current+=char;if(char==="\\"){current+=source[++index]||"";continue}if(char==='"')inString=false;continue}
    if(char==='"'){inString=true;current+=char;continue}
    if(char==="["||char==="{")level++;else if(char==="]"||char==="}")level--;
    if(char===","&&level===0){entries.push(current.trim());current="";continue}
    current+=char;
  }
  if(current.trim())entries.push(current.trim());
  const string=value=>{try{return JSON.parse(value)}catch{return null}};
  return entries.map(entry=>{
    if(entry.startsWith('"'))return {source:string(entry),exclude:[],service:null};
    if(!entry.startsWith("{"))return null;
    const field=name=>{const match=entry.match(new RegExp("\\b"+name+'\\s*=\\s*("(?:[^"\\\\]|\\\\.)*")'));return match?string(match[1]):null};
    const excludeBody=entry.match(/\bexclude\s*=\s*\[([^\]]*)\]/)?.[1]||"";
    return {source:field("source"),exclude:[...excludeBody.matchAll(/"(?:[^"\\]|\\.)*"/g)].map(match=>string(match[0])).filter(value=>typeof value==="string"),service:field("service")};
  }).filter(item=>item&&typeof item.source==="string"&&item.source);
}

export async function terminalBenchCachedTaskArtifacts(options={}){
  const taskToml=await terminalBenchCachedTaskToml(options);if(!taskToml)return [];
  return terminalBenchTaskArtifactsFromToml(await readFile(taskToml,"utf8"));
}

export function terminalBenchTaskNoNetworkSectionsFromToml(text){
  const sections=[];let section="";
  for(const rawLine of String(text||"").split(/\r?\n/)){
    const line=rawLine.trim();if(!line||line.startsWith("#"))continue;
    const header=line.match(/^\[([^\]]+)\]$/);if(header){section=header[1].trim();continue}
    if(section!=="environment"&&section!=="verifier.environment")continue;
    if(/^allow_internet\s*=\s*false\s*$/i.test(line)&&!sections.includes(section))sections.push(section);
  }
  return sections;
}

// Harbor 0.23's Docker environment can only enforce no-network when the engine kernel
// supports nftables fib inet rules; otherwise it rejects that environment at trial time,
// which for a verifier is after paid agent inference. Mirror Harbor's own probe so the
// launch fails before any lane starts.
const HARBOR_EGRESS_KERNEL_PROBE_IMAGE="alpine:3.23.4@sha256:5b10f432ef3da1b8d4c7eb6c487f2f5a8f096bc91145e68878dd4a5019afde11";
const HARBOR_EGRESS_KERNEL_PROBE_SCRIPT="if [ ! -f /proc/config.gz ]; then exit 0; fi; zcat /proc/config.gz 2>/dev/null | grep -qE '^CONFIG_NFT_FIB_INET=[ym]'";

export async function preflightTerminalBenchNetworkPolicy({dataset,task,env,captureFn,docker="docker",home=homedir(),cacheRoot=null}={}){
  if(typeof captureFn!=="function")throw new TypeError("preflightTerminalBenchNetworkPolicy requires captureFn");
  const taskToml=await terminalBenchCachedTaskToml({dataset,task,home,cacheRoot});
  if(!taskToml)return {completed:false,taskTomlFound:false,noNetworkSections:[]};
  const noNetworkSections=terminalBenchTaskNoNetworkSectionsFromToml(await readFile(taskToml,"utf8"));
  if(!noNetworkSections.length)return {completed:true,taskTomlFound:true,noNetworkSections,egressControlSupported:null};
  try{await captureFn(docker,["container","run","--rm",HARBOR_EGRESS_KERNEL_PROBE_IMAGE,"sh","-c",HARBOR_EGRESS_KERNEL_PROBE_SCRIPT],{env})}
  catch(error){
    throw new Error(`Task ${task} requires allow_internet=false for ${noNetworkSections.join(", ")}, but this Docker engine cannot enforce Harbor no-network policies (its kernel lacks CONFIG_NFT_FIB_INET). Harbor would reject that environment only after paid agent inference, so no lane could be graded. Refusing launch. Probe: ${String(error?.message||error).slice(0,300)}`);
  }
  return {completed:true,taskTomlFound:true,noNetworkSections,egressControlSupported:true};
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

export function terminalBenchDatasetTaskNamesFromVersionMetadata(value,{namespace=null}={}){
  const parsed=typeof value==="string"?JSON.parse(value):value;
  const rows=Array.isArray(parsed?.tasks)?parsed.tasks:[];
  const names=[];
  for(const row of rows){
    if(row?.available===false)continue;
    const pkg=row?.task_version?.package,org=String(pkg?.org?.name||"").trim(),name=String(pkg?.name||"").trim();
    if(!name)continue;
    if(namespace&&org!==namespace)continue;
    names.push(name);
  }
  return [...new Set(names)].sort((a,b)=>a.localeCompare(b));
}

export async function preflightTerminalBenchDatasetTaskMembership({harbor,dataset,task,env,captureFn}={}){
  if(typeof captureFn!=="function")throw new TypeError("preflightTerminalBenchDatasetTaskMembership requires captureFn");
  const qualified=terminalBenchTaskQualifiedName(dataset,task);
  if(!qualified)throw new Error(`Cannot derive a registry task identity for dataset membership preflight: dataset=${dataset} task=${task}`);
  const namespace=qualified.split("/")[0],slug=qualified.slice(namespace.length+1);
  let raw;
  try{raw=await captureFn(harbor,["version","show",dataset,"--tasks","--json"],{env})}
  catch(error){throw new Error(`Cannot verify dataset membership for ${qualified} in ${dataset}: ${error?.message||error}`)}
  let parsed;
  try{parsed=JSON.parse(String(raw||""))}catch(error){throw new Error(`Cannot parse dataset membership metadata for ${dataset}: ${error?.message||error}`)}
  const names=terminalBenchDatasetTaskNamesFromVersionMetadata(parsed,{namespace});
  if(!names.includes(slug))throw new Error(`Task ${qualified} is not a member of dataset ${dataset}. Refusing stale-cache or cross-version benchmark launch.`);
  return {
    completed:true,
    qualifiedTask:qualified,
    taskCount:names.length,
    datasetVersion:String(parsed?.version||"").trim()||null,
    datasetRevision:String(parsed?.revision||"").trim()||null,
    datasetContentHash:String(parsed?.content_hash||"").trim()||null,
  };
}

export async function prewarmTerminalBenchTaskCache({harbor,dataset,task,env,runFn}){
  if(typeof runFn!=="function")throw new TypeError("prewarmTerminalBenchTaskCache requires runFn");
  const packageRef=terminalBenchTaskPackageRef(dataset,task);
  if(!packageRef)throw new Error(`Cannot derive a registry task package ref for parallel Harbor prewarm: dataset=${dataset} task=${task}`);
  await runFn(harbor,["task","download",packageRef,"--cache"],{env});
  return {packageRef,completed:true};
}
