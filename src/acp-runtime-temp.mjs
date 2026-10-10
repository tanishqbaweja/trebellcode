// Antigravity's agy_acp_server is a PyInstaller one-file bundle: every launch unpacks about
// 330 MB into the temp directory and a killed process leaves that copy behind. Trebell gives
// each launch its own folder inside a Trebell-owned directory on the user's temp drive, removes
// it after the process stops, and sweeps folders left by Trebell processes that died (T3 does the
// same with its runtimeTemp directory). Only run-<pid>-* folders whose owning Trebell process is
// gone are swept, so a second running Trebell keeps its live unpack.
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RUN_PREFIX="run-";
const sweeps=new Map();

export function acpRuntimeTempRoot(env=process.env,name="antigravity"){
  const base=String(env?.TEMP||env?.TMP||env?.TMPDIR||"").trim()||tmpdir();
  return join(base,`trebell-${name}`);
}

function processAlive(pid){
  if(!Number.isInteger(pid)||pid<=0)return false;
  try{process.kill(pid,0);return true}catch(error){return error?.code==="EPERM"}
}

export function removeRunTemp(dir){
  return rm(dir,{recursive:true,force:true,maxRetries:20,retryDelay:250}).catch(()=>{});
}

// Removes run folders whose Trebell process no longer runs. Runs before this process creates any
// folder of its own, so a run-<own pid>-* folder can only be a leftover from a reused process id.
export async function sweepRunTemps(root,{isAlive=processAlive,ownPid=process.pid}={}){
  let entries=[];try{entries=await readdir(root,{withFileTypes:true})}catch{return []}
  const removed=[];
  for(const entry of entries){
    if(!entry.isDirectory()||!entry.name.startsWith(RUN_PREFIX))continue;
    const pid=Number(entry.name.slice(RUN_PREFIX.length).split("-")[0]);
    if(Number.isInteger(pid)&&pid!==ownPid&&isAlive(pid))continue;
    await removeRunTemp(join(root,entry.name));removed.push(entry.name);
  }
  return removed;
}

function sweepOnce(root){
  if(!sweeps.has(root))sweeps.set(root,sweepRunTemps(root).catch(()=>[]));
  return sweeps.get(root);
}

export async function createRunTemp(root,{platform=process.platform}={}){
  await sweepOnce(root);
  await mkdir(root,{recursive:true});
  const dir=await mkdtemp(join(root,`${RUN_PREFIX}${process.pid}-`));
  return {dir,env:platform==="win32"?{TEMP:dir,TMP:dir}:{TMPDIR:dir},remove:()=>removeRunTemp(dir)};
}
