import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { ContextEngine } from "../src/context-engine.mjs";

const execFileAsync=promisify(execFile);
const fileCount=Number(process.env.TREBELL_CONTEXT_STRUCTURE_FILES||1200);
const warmRuns=Number(process.env.TREBELL_CONTEXT_STRUCTURE_RUNS||10);

async function git(root,args){
  return execFileAsync("git",["-C",root,...args],{windowsHide:true,timeout:60_000,maxBuffer:8*1024*1024});
}

async function fixture(root){
  const src=join(root,"src");await mkdir(src,{recursive:true});
  for(let index=0;index<fileCount;index++){
    const imports=[],refs=[];
    for(let delta=1;delta<=3;delta++)if(index>=delta){imports.push(`import { value${index-delta} } from "./file${index-delta}.mjs";`);refs.push(`value${index-delta}()`)}
    await writeFile(join(src,`file${index}.mjs`),[...imports,`export function value${index}(){ return ${refs.length?refs.join(" + "):index}; }`,""].join("\n"),"utf8");
  }
  await git(root,["init","-q"]);await git(root,["config","user.email","bench@example.invalid"]);await git(root,["config","user.name","Trebell Bench"]);await git(root,["add","."]);await git(root,["commit","-qm","fixture"]);
}

const root=await mkdtemp(join(tmpdir(),"trebell-context-structure-"));
try{
  await fixture(root);
  const engine=new ContextEngine(),rows=[],hashes=[];
  for(let index=0;index<=warmRuns;index++){
    const target=Math.max(3,fileCount-1-index),task=`Inspect value${target} and related repository structure without editing.`;
    const cpuBefore=process.cpuUsage(),started=performance.now();
    const packet=await engine.buildPacket({root,task,focusPaths:[`src/file${target}.mjs`]});
    const cpu=process.cpuUsage(cpuBefore),wallMs=performance.now()-started;
    rows.push({
      index,wallMs:Number(wallMs.toFixed(3)),cpuMs:Number(((cpu.user+cpu.system)/1000).toFixed(3)),indexMs:Number(packet.stats.durationMs||0),
      graphEdges:packet.stats.graphEdges,graphReused:Boolean(packet.stats.graphReused),graphStructureReused:Boolean(packet.stats.graphStructureReused),pathInventoryReused:Boolean(packet.stats.pathInventoryReused),
    });
    hashes.push(createHash("sha256").update(packet.injection).digest("hex"));
  }
  const warm=rows.slice(1),avg=key=>Number((warm.reduce((sum,row)=>sum+Number(row[key]||0),0)/warm.length).toFixed(3));
  console.log(JSON.stringify({files:fileCount,warmRuns,warmAverage:{wallMs:avg("wallMs"),cpuMs:avg("cpuMs"),indexMs:avg("indexMs")},rows,hashes},null,2));
}finally{await rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100})}
