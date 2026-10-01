import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const here=dirname(fileURLToPath(import.meta.url));
const root=resolve(here,"..");
if(!process.argv.includes("--live"))throw new Error("Refusing to run paid/live Terminal-Bench without --live.");
const values=Object.fromEntries(process.argv.slice(2).filter(arg=>arg.startsWith("--")&&arg.includes("=")).map(arg=>{const [key,...rest]=arg.slice(2).split("=");return [key,rest.join("=")]}));
const agent=String(values.agent||"native").trim().toLowerCase();
const dataset=String(values.dataset||"terminal-bench/terminal-bench@4.0.0").trim();
const task=String(values.task||"terminal-bench/session-window-debug").trim();
const model=String(values.model||"gpt-6-luna").trim();
const effort=String(values.effort||"max").trim();
const setupTimeoutMultiplier=Number(values["agent-setup-timeout-multiplier"]||process.env.TREBELL_TERMINAL_BENCH_SETUP_TIMEOUT_MULTIPLIER||3);
if(!Number.isFinite(setupTimeoutMultiplier)||setupTimeoutMultiplier<1)throw new Error("Terminal-Bench setup timeout multiplier must be >= 1.");
const agentTimeoutMultiplier=Number(values["agent-timeout-multiplier"]||process.env.TREBELL_TERMINAL_BENCH_AGENT_TIMEOUT_MULTIPLIER||1);
if(!Number.isFinite(agentTimeoutMultiplier)||agentTimeoutMultiplier<=0)throw new Error("Terminal-Bench agent timeout multiplier must be > 0.");
const output=resolve(root,String(values.output||(".harbor-"+agent)));
const jobName=String(values["job-name"]||(agent+"-"+task.split("/").pop())).trim();

if(!process.env.OPENAI_API_KEY)throw new Error("OPENAI_API_KEY is required. Launch this script with Node --env-file-if-exists=.env.");

async function harborBinary(){
  const configured=String(process.env.TREBELL_HARBOR_BIN||"").trim();
  if(configured){await access(configured);return configured}
  const candidate=process.platform==="win32"?join(homedir(),".local","bin","harbor.exe"):"harbor";
  if(process.platform==="win32")await access(candidate);
  return candidate;
}

const harbor=await harborBinary();
const harborAgent=agent==="native"?"benchmarks.harbor.trebell_native_agent:TrebellNativeAgent":agent;
const args=[
  "run","-d",dataset,"-i",task,"-a",harborAgent,"-m","openai/"+model,
  "--ak","reasoning_effort="+effort,
];
if(Number.isFinite(setupTimeoutMultiplier)&&setupTimeoutMultiplier>1)args.push("--agent-setup-timeout-multiplier",String(setupTimeoutMultiplier));
if(agentTimeoutMultiplier!==1)args.push("--agent-timeout-multiplier",String(agentTimeoutMultiplier));
if(agent==="native"&&values.probe==="true")args.push("--ak","live_probe=true");
args.push("-n","1","-o",output,"--job-name",jobName,"-y");

const env={...process.env,PYTHONPATH:[root,process.env.PYTHONPATH].filter(Boolean).join(process.platform==="win32"?";":":")};
const child=spawn(harbor,args,{cwd:root,env,stdio:"inherit",windowsHide:true});
child.on("error",error=>{console.error(error);process.exitCode=1});
child.on("exit",(code,signal)=>{if(signal)console.error("Harbor exited via signal "+signal);process.exitCode=code??1});
