// Interleaved A/B of a send's two requests before turn/start, on the real GUI server with a run.mjs run's seeded home, repo and UI
// build: the file checkpoint and then the context packet (sequential, the send before F4(c)), or both at once (concurrent, after).
// Send to first text in run.mjs `stream` moves by hundreds of ms with the machine's load; alternating the two modes rep by rep
// leaves only the difference. Prints each mode's time until both answered and each request's own time, then the paired saving
// (sequential minus concurrent) with a 95% bootstrap interval.
//   node scripts/perf/send-ab.mjs <reps> <run.mjs --out dir>
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort, startServer } from "./lib/server.mjs";
import { summarize } from "./lib/stats.mjs";

const [reps="40",out]=process.argv.slice(2),repoRoot=fileURLToPath(new URL("../../",import.meta.url));
if(!out)throw new Error("usage: node scripts/perf/send-ab.mjs <reps> <run.mjs --out dir>");
const work=join(out,"work"),repo=join(work,"repo"),home=join(work,"send-ab-home"),runDir=join(work,"send-ab-run");
rmSync(home,{recursive:true,force:true});cpSync(join(work,"home-base"),home,{recursive:true});mkdirSync(runDir,{recursive:true});
const server=await startServer({repoRoot,home,runDir,uiDist:join(out,"ui-dist"),port:await freePort(),appPort:await freePort()});
const task="Explain how the relay streams a long reply. Do not change any files.";
const post=async(path,body)=>{
  const started=performance.now(),response=await fetch(server.url+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  await response.text();if(!response.ok)throw new Error(path+" answered "+response.status);return performance.now()-started;
};
// The bodies App.jsx sends for a Native send in a project thread.
const checkpoint=()=>post("/api/checkpoints",{cwd:repo,threadId:"send-ab-thread",label:task.slice(0,80)});
const packet=()=>post("/api/context/packet",{path:repo,task,focusPaths:[],environmentId:null,tokensUsed:null,contextWindow:null,deliveryProjection:"seed",userTask:task});
const modes={
  sequential:async()=>{const started=performance.now(),checkpointMs=await checkpoint(),packetMs=await packet();return {bothMs:performance.now()-started,checkpointMs,packetMs}},
  concurrent:async()=>{const started=performance.now(),[checkpointMs,packetMs]=await Promise.all([checkpoint(),packet()]);return {bothMs:performance.now()-started,checkpointMs,packetMs}},
};
const results={sequential:[],concurrent:[]};
try{
  // One of each first, so the packet's first index build and the first checkpoint's cold git do not count.
  await modes.sequential();await modes.concurrent();
  for(let rep=0;rep<Number(reps);rep++)for(const mode of rep%2?["concurrent","sequential"]:["sequential","concurrent"]){results[mode].push(await modes[mode]());await new Promise(resolve=>setTimeout(resolve,300))}
}finally{await server.stop()}
for(const [mode,rows] of Object.entries(results)){
  const pick=key=>{const {samples,...rest}=summarize(rows.map(row=>row[key]),0);return rest};
  console.log(mode,JSON.stringify({bothMs:pick("bothMs"),checkpointMs:pick("checkpointMs"),packetMs:pick("packetMs")}));
}
const diffs=results.sequential.map((row,index)=>row.bothMs-results.concurrent[index].bothMs);
const median=list=>{const sorted=[...list].sort((a,b)=>a-b),mid=sorted.length/2;return sorted.length%2?sorted[Math.floor(mid)]:(sorted[mid-1]+sorted[mid])/2};
let seed=7;const random=()=>(seed=(seed*16807)%2147483647)/2147483647,boot=[];
for(let i=0;i<5000;i++)boot.push(median(diffs.map(()=>diffs[Math.floor(random()*diffs.length)])));
boot.sort((a,b)=>a-b);
console.log("saved",JSON.stringify({n:diffs.length,medianMs:Number(median(diffs).toFixed(1)),ci95Ms:[Number(boot[124].toFixed(1)),Number(boot[4874].toFixed(1))],repsFaster:diffs.filter(value=>value>0).length}));
