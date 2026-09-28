import { closeSync, openSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { spawn } from "node:child_process";

const descriptorPath=process.argv[2];
if(!descriptorPath)throw new Error("Detached process descriptor path is required.");
const descriptor=JSON.parse(await readFile(descriptorPath,"utf8"));
const {command,args=[],cwd,stdoutPath,stderrPath,statusPath,envOverrides={}}=descriptor;
if(!command||!cwd||!stdoutPath||!stderrPath||!statusPath)throw new Error("Detached process descriptor is incomplete.");

await Promise.all([stdoutPath,stderrPath,statusPath].map(path=>mkdir(dirname(path),{recursive:true})));
const stdoutFd=openSync(stdoutPath,"a"),stderrFd=openSync(stderrPath,"a");
const startedAt=new Date().toISOString();
let child=null;
try{
  child=spawn(command,args,{cwd,env:{...process.env,...envOverrides},stdio:["ignore",stdoutFd,stderrFd],windowsHide:true});
  await writeFile(statusPath,JSON.stringify({state:"running",wrapperPid:process.pid,pid:child.pid,startedAt},null,2)+"\n","utf8");
  const outcome=await new Promise((resolve,reject)=>{
    child.once("error",reject);
    child.once("exit",(code,signal)=>resolve({code,signal}));
  });
  const finishedAt=new Date().toISOString();
  await writeFile(statusPath,JSON.stringify({state:"finished",wrapperPid:process.pid,pid:child.pid,startedAt,finishedAt,code:outcome.code,signal:outcome.signal},null,2)+"\n","utf8");
  process.exitCode=Number.isInteger(outcome.code)?outcome.code:1;
}catch(error){
  const finishedAt=new Date().toISOString();
  await writeFile(statusPath,JSON.stringify({state:"failed",wrapperPid:process.pid,pid:child?.pid??null,startedAt,finishedAt,error:error?.message||String(error)},null,2)+"\n","utf8").catch(()=>{});
  process.exitCode=1;
}finally{
  closeSync(stdoutFd);closeSync(stderrFd);
}
