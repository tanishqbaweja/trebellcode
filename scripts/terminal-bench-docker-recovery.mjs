import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

function composeProjectForTrialName(trialName){
  const name=String(trialName||"").trim();
  return name?name.toLowerCase()+"__env":null;
}

export function isNativeAgentExternalTermination(trial){
  if(!trial||typeof trial!=="object")return false;
  const type=String(trial?.exception_info?.exception_type||"");
  const message=String(trial?.exception_info?.exception_message||"");
  if(type!=="NonZeroAgentExitCodeError"||!message)return false;
  return /Command failed \(exit 143\):/i.test(message)
    && /(?:node|bun) \/installed-agent\/trebell-native-agent\.mjs/i.test(message)
    && /stdout:\s*Terminated(?:\r?\n|$)/i.test(message);
}

export function isAgentAuthenticationFailure(trial){
  if(!trial||typeof trial!=="object")return false;
  // Harbor raises this when the agent's provider credentials are rejected
  // (expired/rotated OAuth tokens, revoked keys). The verifier may still grade
  // the untouched workspace, but that reward is not harness-quality evidence.
  return String(trial?.exception_info?.exception_type||"")==="AgentAuthenticationError";
}

export function isPreAgentDockerSubnetExhaustion(trial){
  if(!trial||typeof trial!=="object")return false;
  if(trial.agent_setup||trial.agent_execution||trial.verifier)return false;
  const message=String(trial?.exception_info?.exception_message||"");
  return /all predefined address pools have been fully subnetted/i.test(message);
}

export function isDockerImagePullFailure(trial){
  if(!trial||typeof trial!=="object")return false;
  const message=String(trial?.exception_info?.exception_message||"");
  if(!/Docker compose command failed for environment/i.test(message))return false;
  return /(?:Pulling|Downloading|Extracting)/i.test(message)&&/unexpected EOF/i.test(message);
}

export function isPreAgentDockerImagePullFailure(trial){
  if(!isDockerImagePullFailure(trial))return false;
  return !(trial.agent_setup||trial.agent_execution||trial.verifier);
}

export function isDockerExecTransportFailure(trial){
  if(!trial||typeof trial!=="object")return false;
  const type=String(trial?.exception_info?.exception_type||"");
  const message=String(trial?.exception_info?.exception_message||"");
  if(!message)return false;
  // A Linux command executed through Docker cannot normally return the
  // Windows DWORD sentinel 0xFFFFFFFF (4294967295). Harbor receives that
  // value from the host-side `docker compose exec` process when the Desktop /
  // WSL exec transport is severed. Treat it as infrastructure, not as an
  // agent-selected non-zero exit. Some subprocess layers render the same
  // sentinel as signed -1, so accept both spellings when Harbor classified
  // the failure as a non-zero agent exit.
  if(type==="NonZeroAgentExitCodeError"&&/Command failed \(exit (?:4294967295|-1)\):/i.test(message))return true;
  if(type==="NonZeroAgentExitCodeError"&&/Error response from daemon:\s*No such exec instance:\s*[a-f0-9]+/i.test(message))return true;
  return /request returned 5\d\d Internal Server Error/i.test(message)
    && /dockerDesktopLinuxEngine/i.test(message)
    && /\/exec\/[a-f0-9]+\/json/i.test(message);
}

export async function sealedHarborEnvironmentProjects(outputRoot,{readdirFn=readdir,readFileFn=readFile}={}){
  const projects=new Set();
  let jobs=[];try{jobs=await readdirFn(outputRoot,{withFileTypes:true})}catch{return projects}
  for(const job of jobs){
    if(!job?.isDirectory?.())continue;
    const jobDir=join(outputRoot,job.name);let trials=[];
    try{trials=await readdirFn(jobDir,{withFileTypes:true})}catch{continue}
    for(const trial of trials){
      if(!trial?.isDirectory?.())continue;
      let result=null;try{result=JSON.parse(await readFileFn(join(jobDir,trial.name,"result.json"),"utf8"))}catch{continue}
      if(!result?.finished_at||!result?.verifier_result)continue;
      const project=composeProjectForTrialName(trial.name);if(project)projects.add(project);
    }
  }
  return projects;
}

function ids(text){
  return String(text||"").split(/\r?\n/).map(value=>value.trim()).filter(Boolean);
}

export async function cleanupSealedExitedHarborEnvironments(outputRoot,{captureFn,runFn,readdirFn=readdir,readFileFn=readFile}={}){
  if(typeof captureFn!=="function"||typeof runFn!=="function")throw new Error("Docker cleanup requires captureFn and runFn.");
  const sealed=await sealedHarborEnvironmentProjects(outputRoot,{readdirFn,readFileFn});
  if(!sealed.size)return {eligibleProjects:0,removedContainers:0,removedNetworks:0,projects:[]};
  let containerIds=[];
  try{containerIds=ids(await captureFn("docker",["ps","-aq","--filter","status=exited","--filter","label=org.harborframework.terminal-bench.role=environment"]))}catch{}
  if(!containerIds.length)return {eligibleProjects:sealed.size,removedContainers:0,removedNetworks:0,projects:[]};
  let inspected=[];try{inspected=JSON.parse(await captureFn("docker",["inspect",...containerIds]))}catch{}
  const eligible=[];
  for(const item of Array.isArray(inspected)?inspected:[]){
    const project=String(item?.Config?.Labels?.["com.docker.compose.project"]||"").trim();
    const id=String(item?.Id||"").trim();
    if(id&&project&&item?.State?.Status==="exited"&&sealed.has(project))eligible.push({id,project});
  }
  if(!eligible.length)return {eligibleProjects:sealed.size,removedContainers:0,removedNetworks:0,projects:[]};
  await runFn("docker",["rm","-f",...eligible.map(item=>item.id)]);
  const projects=[...new Set(eligible.map(item=>item.project))],networkIds=new Set();
  for(const project of projects){
    try{
      for(const networkId of ids(await captureFn("docker",["network","ls","-q","--filter","label=com.docker.compose.project="+project])))networkIds.add(networkId);
    }catch{}
  }
  if(networkIds.size)await runFn("docker",["network","rm",...networkIds]);
  return {eligibleProjects:sealed.size,removedContainers:eligible.length,removedNetworks:networkIds.size,projects};
}
