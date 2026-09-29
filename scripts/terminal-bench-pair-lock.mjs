import { mkdir, open, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";

function processAlive(pid){
  try{process.kill(Number(pid),0);return true}catch(error){return error?.code==="EPERM"}
}

function lockIdentity(value){
  if(value?.lockId)return `id:${value.lockId}`;
  if(value&&typeof value==="object")return `legacy:${value.pid||""}:${value.startedAt||""}:${value.task||""}`;
  return "missing";
}

export function sharedTerminalBenchLockPath(root,gitCommonDir){
  const common=resolve(root,String(gitCommonDir||"").trim());
  return join(dirname(common),".harbor-validation","terminal-bench-pair.lock");
}

export async function acquireTerminalBenchPairLock({lockPath,task,model,effort,pid=process.pid,processAliveFn=processAlive}={}){
  if(!lockPath)throw new Error("Terminal-Bench paired-run lock path is required.");
  await mkdir(dirname(lockPath),{recursive:true});
  const lockId=randomUUID(),lockRecord={lockId,pid,task,model,effort,startedAt:new Date().toISOString()};
  const readLock=async()=>{try{return JSON.parse(await readFile(lockPath,"utf8"))}catch{return null}};
  for(let attempt=0;attempt<6;attempt++){
    try{
      const handle=await open(lockPath,"wx");
      await handle.writeFile(JSON.stringify(lockRecord)+"\n");
      await handle.close();
      return async()=>{
        try{
          const current=await readLock();
          if(current?.lockId===lockId)await rm(lockPath,{force:true});
        }catch{}
      };
    }catch(error){
      if(error?.code!=="EEXIST")throw error;
      const existing=await readLock();
      if(existing?.pid&&processAliveFn(existing.pid))throw new Error(`Another Terminal-Bench paired run is active (pid ${existing.pid}, task ${existing.task||"unknown"}). Refusing to contaminate benchmark timing.`);
      const current=await readLock();
      if(lockIdentity(current)!==lockIdentity(existing))continue;
      try{await rm(lockPath)}catch(removeError){if(removeError?.code!=="ENOENT")throw removeError}
    }
  }
  throw new Error("Could not acquire the Terminal-Bench paired-run lock.");
}
