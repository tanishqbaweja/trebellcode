import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { buildRuntimeEnvironment, runtimeEnvironmentKeys } from "./runtime-environment.mjs";
import { sourceControlGitAction, sourceControlGitInfo, withSourceControlExecutor } from "./source-control-service.mjs";
import { boundDiagnosticValue } from "./diagnostic-bounds.mjs";
import { redactSecretValue } from "./secret-redactor.mjs";
import { ScopedSecretBroker } from "./secret-broker.mjs";

const execFileAsync=promisify(execFile);
const SOURCE_CONTROL_GIT_ENV_KEYS=Object.freeze([
  "EMAIL","GIT_AUTHOR_NAME","GIT_AUTHOR_EMAIL","GIT_COMMITTER_NAME","GIT_COMMITTER_EMAIL",
  "GIT_CONFIG_GLOBAL","GIT_CONFIG_SYSTEM","GIT_CONFIG_NOSYSTEM","GIT_SSH","GIT_SSH_COMMAND","GIT_SSH_VARIANT","GIT_ASKPASS",
  "SSH_AUTH_SOCK","SSH_AGENT_PID","SSH_ASKPASS","SSH_ASKPASS_REQUIRE","DISPLAY",
  "HTTP_PROXY","HTTPS_PROXY","ALL_PROXY","NO_PROXY","http_proxy","https_proxy","all_proxy","no_proxy",
]);
const SOURCE_CONTROL_PROVIDER_ENV_KEYS=Object.freeze({
  gh:Object.freeze(["GH_TOKEN","GITHUB_TOKEN","GH_ENTERPRISE_TOKEN","GITHUB_ENTERPRISE_TOKEN","GH_HOST","GH_CONFIG_DIR"]),
  glab:Object.freeze(["GITLAB_TOKEN","GITLAB_ACCESS_TOKEN","GITLAB_HOST","GLAB_CONFIG_DIR"]),
  az:Object.freeze(["AZURE_DEVOPS_EXT_PAT","AZURE_CONFIG_DIR"]),
});

function boundedTimeout(value){const number=Math.trunc(Number(value));return Number.isFinite(number)?Math.max(1000,Math.min(120000,number)):120000}
function boundedOutput(value){const number=Math.trunc(Number(value));return Number.isFinite(number)?Math.max(64*1024,Math.min(8*1024*1024,number)):8*1024*1024}
function executableName(command){
  const base=String(command||"").trim().replace(/\\/g,"/").split("/").at(-1)?.toLowerCase()||"";
  return base.replace(/\.(?:exe|cmd|bat)$/,"");
}
export function sourceControlEnvironmentKeys(command=null){
  const provider=SOURCE_CONTROL_PROVIDER_ENV_KEYS[executableName(command)]||[];
  return runtimeEnvironmentKeys("native",{approved:[...SOURCE_CONTROL_GIT_ENV_KEYS,...provider]});
}
export function sourceControlEnvironment(environment=process.env,{platform=process.platform,command=null,environmentNames=null}={}){
  const approved=Array.isArray(environmentNames)&&environmentNames.length?environmentNames:[...SOURCE_CONTROL_GIT_ENV_KEYS,...(SOURCE_CONTROL_PROVIDER_ENV_KEYS[executableName(command)]||[])];
  return buildRuntimeEnvironment("native",{parent:environment,approved,platform});
}

async function runLocalStdin(command,args,input,{cwd,environment,platform,environmentNames=null,timeout,maxBuffer}={}){
  return await new Promise(resolve=>{
    let stdout="",stderr="",settled=false,timedOut=false;
    const child=spawn(command,args,{cwd,env:sourceControlEnvironment(environment,{platform,command,environmentNames}),windowsHide:true,stdio:["pipe","pipe","pipe"]});
    const append=(current,chunk)=>{const next=current+String(chunk);return Buffer.byteLength(next,"utf8")>maxBuffer?Buffer.from(next).subarray(0,maxBuffer).toString("utf8"):next};
    child.stdout?.on("data",chunk=>{stdout=append(stdout,chunk)});child.stderr?.on("data",chunk=>{stderr=append(stderr,chunk)});
    const timer=setTimeout(()=>{timedOut=true;try{child.kill("SIGKILL")}catch{}},timeout);
    const finish=(code,error=null)=>{if(settled)return;settled=true;clearTimeout(timer);resolve({ok:!error&&!timedOut&&Number(code)===0,code:Number.isFinite(Number(code))?Number(code):1,stdout,stderr:error?String(error?.message||error):stderr,timedOut})};
    child.once("error",error=>finish(1,error));child.once("close",code=>finish(code));child.stdin?.end(String(input??""));
  });
}

export function createNativeSourceControlExecutor({environments=null,environmentId=null,environment=process.env,platform=process.platform,environmentNames=null}={}){
  const profile=environmentId&&environments?environments.get(environmentId):null,explicitNames=Array.isArray(environmentNames)&&environmentNames.length?[...environmentNames]:null,secretBroker=new ScopedSecretBroker({environment,environments,environmentId,platform});
  const safeNames=command=>explicitNames||sourceControlEnvironmentKeys(command);
  return {
    secretValues:scope=>secretBroker.values(scope),
    async run(command,args,{cwd,timeout=120000,maxBuffer=8*1024*1024}={}){
      const executable=String(command||"").trim(),argv=Array.isArray(args)?args.map(String):[],limit=boundedOutput(maxBuffer),timeoutMs=boundedTimeout(timeout);
      if(profile&&profile.type!=="local"){
        const result=await environments.executeArgv(profile.id,{command:executable,args:argv,cwd,timeoutMs,maxOutput:limit,environmentNames:safeNames(executable)});
        return {ok:Number(result.exitCode??1)===0,code:Number(result.exitCode??1),stdout:String(result.stdout||""),stderr:String(result.stderr||"")};
      }
      try{
        const result=await execFileAsync(executable,argv,{cwd,env:sourceControlEnvironment(environment,{platform,command:executable,environmentNames:explicitNames}),windowsHide:true,timeout:timeoutMs,maxBuffer:limit,encoding:"utf8"});
        return {ok:true,code:0,stdout:String(result.stdout||""),stderr:String(result.stderr||"")};
      }catch(error){
        return {ok:false,code:Number.isFinite(Number(error?.code))?Number(error.code):1,stdout:String(error?.stdout||""),stderr:String(error?.stderr||error?.message||"")};
      }
    },
    async runStdin(command,args,input,{cwd,timeout=120000,maxBuffer=8*1024*1024}={}){
      const executable=String(command||"").trim(),argv=Array.isArray(args)?args.map(String):[],limit=boundedOutput(maxBuffer),timeoutMs=boundedTimeout(timeout);
      if(profile&&profile.type!=="local"){
        const result=await environments.executeArgvInput(profile.id,{command:executable,args:argv,input:String(input??""),cwd,timeoutMs,maxOutput:limit,environmentNames:safeNames(executable)});
        return {ok:Number(result.exitCode??1)===0&&!result.timedOut,code:Number(result.exitCode??1),stdout:String(result.stdout||""),stderr:String(result.stderr||""),timedOut:Boolean(result.timedOut)};
      }
      return runLocalStdin(executable,argv,input,{cwd,environment,platform,environmentNames:explicitNames,timeout:timeoutMs,maxBuffer:limit});
    },
  };
}

export function createNativeSourceControl({root,environments=null,environmentId=null,environment=process.env,platform=process.platform,environmentNames=null}={}){
  if(!root)throw new Error("Native source control requires an active workspace root");
  const executor=createNativeSourceControlExecutor({environments,environmentId,environment,platform,environmentNames});
  return async function execute(call={}){
    const name=String(call.name||""),args=call.arguments&&typeof call.arguments==="object"?call.arguments:{};
    const result=await withSourceControlExecutor(executor,async()=>{
      if(name==="status")return sourceControlGitInfo(root);
      if(name==="init")return sourceControlGitAction(root,{action:"init"});
      if(name==="branch_create")return sourceControlGitAction(root,{action:"branch-create",name:String(args.name||""),startPoint:args.start_point?String(args.start_point):null});
      if(name==="branch_switch")return sourceControlGitAction(root,{action:"branch-switch",name:String(args.name||"")});
      if(name==="commit_all")return sourceControlGitAction(root,{action:"commit",message:String(args.message||"")});
      if(name==="fetch")return sourceControlGitAction(root,{action:"fetch"});
      if(name==="pull_ff")return sourceControlGitAction(root,{action:"pull"});
      if(name==="push")return sourceControlGitAction(root,{action:"push",setUpstream:Boolean(args.set_upstream)});
      throw new Error(`Unknown Native source-control tool: ${name}`);
    });
    return boundDiagnosticValue(redactSecretValue(result,{environment,maxDepth:12,maxArray:500,maxFields:1200}),{maxChars:256*1024,maxFields:1200,maxDepth:12});
  };
}
