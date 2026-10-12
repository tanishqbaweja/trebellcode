#!/usr/bin/env node
// What the git poll costs after a build, a formatter or a copy writes tracked files again with the same content, which changes
// only their times. git status reads and hashes each such file until a status that may take the index lock records the new times.
// A fixture repository of <files> files of about <kb> KB; per rep the index is refreshed, the poll's kept repository part is read
// in full (as the first poll of an open project thread), every file is written again with its own bytes, and <polls> polls run at
// the focused 3.5-s pace on a simulated clock (Date.now moves 3.5 s a poll and stands still otherwise, so nothing waits and the
// 30-s full read comes at the ninth poll whatever the load). Before each poll the index entries whose recorded time is not the
// file's are counted: that poll's status hashes each of them, so files times size is what it read. Each poll also records its git
// processes, whether its status could take the index lock, and its wall time. Then the same polls with nothing written again
// (idle). Machine load is recorded for the run.
//   node scripts/perf/git-rewrite.mjs --dir <folder on H:> --out <file.json> [--files 2000] [--kb 20] [--polls 18] [--reps 3]
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { join, resolve } from "node:path";
import { git, gitInfo } from "../../src/git-service.mjs";
import { summarize } from "./lib/stats.mjs";

const argv=process.argv.slice(2),flag=(name,fallback)=>{const index=argv.indexOf("--"+name);return index>=0?argv[index+1]:fallback};
const dir=resolve(flag("dir")),outFile=resolve(flag("out")),fileCount=Number(flag("files",2000)),kb=Number(flag("kb",20)),polls=Number(flag("polls",18)),reps=Number(flag("reps",3));
const repo=join(dir,"repo"),names=Array.from({length:fileCount},(_,index)=>"gen/f"+index+".js"),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function cpuTotals(){let idle=0,total=0;for(const cpu of cpus()){const t=cpu.times;idle+=t.idle;total+=t.user+t.nice+t.sys+t.idle+t.irq}return {idle,total}}

rmSync(repo,{recursive:true,force:true,maxRetries:10,retryDelay:200});mkdirSync(join(repo,"gen"),{recursive:true});
await git(repo,["init","-q","-b","main"]);
const body="export const value = 1;\n".repeat(Math.ceil(kb*1024/24));
for(const [index,name] of names.entries())writeFileSync(join(repo,name),"// "+index+"\n"+body);
await git(repo,["add","-A"]);await git(repo,["-c","user.email=perf@example.test","-c","user.name=perf","commit","-qm","generated"]);
const fileBytes=statSync(join(repo,names[0])).size;

// Entries whose recorded modification time (seconds) is not the file's; each rewrite comes more than a second after the last record.
async function staleEntries(){
  const lines=(await git(repo,["ls-files","--debug","--","gen"],{maxBuffer:256*1024*1024})).stdout.split(/\r?\n/);let stale=0;
  for(let index=0;index<lines.length;index++)if(lines[index].startsWith("gen/")){
    const recorded=Number(/mtime:\s*(\d+)/.exec(lines[index+2]||"")?.[1]);
    if(recorded!==Math.floor(statSync(join(repo,lines[index].trim())).mtimeMs/1000))stale++;
  }
  return stale;
}
const realNow=Date.now;let clock=realNow();Date.now=()=>clock;
async function poll(){
  const calls=[],gitFn=(cwd,args,options)=>{calls.push({args:args.join(" "),mayLock:options?.env?.GIT_OPTIONAL_LOCKS!=="0"});return git(cwd,args,options)};
  const started=performance.now();await gitInfo(repo,{gitFn});const ms=performance.now()-started;
  return {ms,processes:calls.length,statusMayLock:Boolean(calls.find(call=>call.args.startsWith("status"))?.mayLock)};
}
async function phase(rewrite){
  await git(repo,["update-index","-q","--refresh"],{allowFailure:true});await sleep(1100);
  clock+=31_000;await poll();
  if(rewrite){for(const name of names){const path=join(repo,name);writeFileSync(path,readFileSync(path))}await sleep(1100)}
  const rows=[];for(let index=0;index<polls;index++){clock+=3500;rows.push({stale:await staleEntries(),...await poll()})}
  const filesHashed=rows.reduce((sum,row)=>sum+row.stale,0);
  return {pollsThatHashed:rows.filter(row=>row.stale>0).length,filesHashed,mbHashed:Number((filesHashed*fileBytes/1048576).toFixed(1)),staleAfter:await staleEntries(),
    statusesThatMayLock:rows.filter(row=>row.statusMayLock).length,processes:rows.reduce((sum,row)=>sum+row.processes,0),msPerPoll:summarize(rows.map(row=>row.ms),0),rows};
}
const result={startedAt:new Date().toISOString(),files:fileCount,fileBytes,polls,simulatedSeconds:polls*3.5,reps:[]};
const load0=cpuTotals();
for(let rep=0;rep<reps;rep++)result.reps.push({rewrite:await phase(true),idle:await phase(false)});
const load1=cpuTotals();result.machineLoadPercent=Number((100*(1-(load1.idle-load0.idle)/Math.max(1,load1.total-load0.total))).toFixed(1));
const across=(kind,key)=>summarize(result.reps.map(rep=>rep[kind][key]),1);
result.summary=Object.fromEntries(["rewrite","idle"].map(kind=>[kind,{pollsThatHashed:across(kind,"pollsThatHashed"),mbHashed:across(kind,"mbHashed"),staleAfter:across(kind,"staleAfter"),statusesThatMayLock:across(kind,"statusesThatMayLock"),processes:across(kind,"processes"),
  msPerPoll:summarize(result.reps.flatMap(rep=>rep[kind].rows.map(row=>row.ms)),0)}]));
result.finishedAt=new Date(realNow()).toISOString();
writeFileSync(outFile,JSON.stringify(result,null,2));
for(const [kind,row] of Object.entries(result.summary))console.log(kind,JSON.stringify(Object.fromEntries(Object.entries(row).map(([key,value])=>[key,{median:value.median,p90:value.p90}]))));
console.log(JSON.stringify({machineLoadPercent:result.machineLoadPercent,out:outFile}));
rmSync(repo,{recursive:true,force:true,maxRetries:10,retryDelay:200});
