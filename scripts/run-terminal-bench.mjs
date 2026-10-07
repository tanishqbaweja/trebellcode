import { createHash } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const here=dirname(fileURLToPath(import.meta.url));
const root=resolve(here,"..");
const NATIVE_PINNED_NODE_VERSION="22.23.3";
const NATIVE_PINNED_NODE_TARBALL_SHA256="1084aa36196bba4c3a5e69a1ee388a6e4ff729dad09445fbcd434b28fe3c24af";
const NATIVE_PINNED_NODE_URL=`https://nodejs.org/download/release/v${NATIVE_PINNED_NODE_VERSION}/node-v${NATIVE_PINNED_NODE_VERSION}-linux-x64.tar.gz`;
const validationDir=join(root,".harbor-validation");
if(!process.argv.includes("--live"))throw new Error("Refusing to run paid/live Terminal-Bench without --live.");
const values=Object.fromEntries(process.argv.slice(2).filter(arg=>arg.startsWith("--")&&arg.includes("=")).map(arg=>{const [key,...rest]=arg.slice(2).split("=");return [key,rest.join("=")]}));
const agent=String(values.agent||"native").trim().toLowerCase();
const dataset=String(values.dataset||"terminal-bench/terminal-bench@4.0.0").trim();
const task=String(values.task||"terminal-bench/session-window-debug").trim();
const model=String(values.model||"gpt-6-luna").trim();
const effort=String(values.effort||"max").trim();
const serviceTier=String(values["service-tier"]||process.env.TREBELL_TERMINAL_BENCH_SERVICE_TIER||"fast").trim().toLowerCase();
if(!new Set(["default","fast"]).has(serviceTier))throw new Error("Terminal-Bench service tier must be default or fast.");
const setupTimeoutMultiplier=Number(values["agent-setup-timeout-multiplier"]||process.env.TREBELL_TERMINAL_BENCH_SETUP_TIMEOUT_MULTIPLIER||3);
if(!Number.isFinite(setupTimeoutMultiplier)||setupTimeoutMultiplier<1)throw new Error("Terminal-Bench setup timeout multiplier must be >= 1.");
const agentTimeoutMultiplier=Number(values["agent-timeout-multiplier"]||process.env.TREBELL_TERMINAL_BENCH_AGENT_TIMEOUT_MULTIPLIER||1);
if(!Number.isFinite(agentTimeoutMultiplier)||agentTimeoutMultiplier<=0)throw new Error("Terminal-Bench agent timeout multiplier must be > 0.");
const output=resolve(root,String(values.output||(".harbor-"+agent)));
const jobName=String(values["job-name"]||(agent+"-"+task.split("/").pop())).trim();

if(!process.env.OPENAI_API_KEY)throw new Error("OPENAI_API_KEY is required. Launch this script with Node --env-file-if-exists=.env.");

async function sha256File(path){return createHash("sha256").update(await readFile(path)).digest("hex")}
async function ensurePinnedNodeTarball(path,{explicit=false}={}){
  try{await access(path);return}catch(error){if(explicit)throw error}
  await mkdir(dirname(path),{recursive:true});
  const response=await fetch(NATIVE_PINNED_NODE_URL,{redirect:"follow"});
  if(!response.ok)throw new Error(`Failed to download pinned Node runtime: HTTP ${response.status}`);
  await writeFile(path,Buffer.from(await response.arrayBuffer()));
  await access(path);
}

async function harborBinary(){
  const configured=String(process.env.TREBELL_HARBOR_BIN||"").trim();
  if(configured){await access(configured);return configured}
  const candidate=process.platform==="win32"?join(homedir(),".local","bin","harbor.exe"):"harbor";
  if(process.platform==="win32")await access(candidate);
  return candidate;
}

let nativePinnedNodeTarballPath=null;
if(agent==="native"){
  const configuredNodeTarball=String(process.env.TREBELL_NODE_PINNED_TARBALL||"").trim();
  nativePinnedNodeTarballPath=resolve(configuredNodeTarball||join(validationDir,"node-stage",`node-v${NATIVE_PINNED_NODE_VERSION}-linux-x64.tar.gz`));
  await ensurePinnedNodeTarball(nativePinnedNodeTarballPath,{explicit:Boolean(configuredNodeTarball)});
  const nativePinnedNodeTarballSha256=await sha256File(nativePinnedNodeTarballPath);
  if(nativePinnedNodeTarballSha256!==NATIVE_PINNED_NODE_TARBALL_SHA256)throw new Error(`Pinned Node tarball SHA-256 mismatch: expected ${NATIVE_PINNED_NODE_TARBALL_SHA256}, got ${nativePinnedNodeTarballSha256}`);
}

const harbor=await harborBinary();
const harborAgent=agent==="native"?"benchmarks.harbor.trebell_native_agent:TrebellNativeAgent":agent;
const args=[
  "run","-d",dataset,"-i",task,"-a",harborAgent,"-m","openai/"+model,
  "--ak","reasoning_effort="+effort,
  ...(serviceTier==="fast"?["--ak","service_tier=fast"]:[]),
];
if(Number.isFinite(setupTimeoutMultiplier)&&setupTimeoutMultiplier>1)args.push("--agent-setup-timeout-multiplier",String(setupTimeoutMultiplier));
if(agentTimeoutMultiplier!==1)args.push("--agent-timeout-multiplier",String(agentTimeoutMultiplier));
if(agent==="native"&&values.probe==="true")args.push("--ak","live_probe=true");
args.push("-n","1","-o",output,"--job-name",jobName,"-y");

const env={
  ...process.env,
  PYTHONPATH:[root,process.env.PYTHONPATH].filter(Boolean).join(process.platform==="win32"?";":":"),
  ...(process.platform==="win32"?{PYTHONUTF8:"1",PYTHONIOENCODING:"utf-8"}:{}),
  ...(nativePinnedNodeTarballPath?{TREBELL_NODE_PINNED_TARBALL:nativePinnedNodeTarballPath}:{}),
};
const child=spawn(harbor,args,{cwd:root,env,stdio:"inherit",windowsHide:true});
child.on("error",error=>{console.error(error);process.exitCode=1});
child.on("exit",(code,signal)=>{if(signal)console.error("Harbor exited via signal "+signal);process.exitCode=code??1});
