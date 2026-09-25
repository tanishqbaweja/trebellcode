import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildRuntimeEnvironment, runtimeEnvironmentKeys } from "./runtime-environment.mjs";
import { sourceControlGitAction, sourceControlGitInfo, withSourceControlExecutor } from "./source-control-service.mjs";
import { boundDiagnosticValue } from "./diagnostic-bounds.mjs";
import { redactSecretValue } from "./secret-redactor.mjs";

const execFileAsync=promisify(execFile);

function boundedTimeout(value){const number=Math.trunc(Number(value));return Number.isFinite(number)?Math.max(1000,Math.min(120000,number)):120000}
function boundedOutput(value){const number=Math.trunc(Number(value));return Number.isFinite(number)?Math.max(64*1024,Math.min(8*1024*1024,number)):8*1024*1024}

export function createNativeSourceControlExecutor({environments=null,environmentId=null,environment=process.env,platform=process.platform,environmentNames=null}={}){
  const profile=environmentId&&environments?environments.get(environmentId):null,safeNames=Array.isArray(environmentNames)&&environmentNames.length?environmentNames:runtimeEnvironmentKeys("native");
  return {
    async run(command,args,{cwd,timeout=120000,maxBuffer=8*1024*1024}={}){
      const executable=String(command||"").trim(),argv=Array.isArray(args)?args.map(String):[],limit=boundedOutput(maxBuffer),timeoutMs=boundedTimeout(timeout);
      if(profile&&profile.type!=="local"){
        const result=await environments.executeArgv(profile.id,{command:executable,args:argv,cwd,timeoutMs,maxOutput:limit,environmentNames:safeNames});
        return {ok:Number(result.exitCode??1)===0,code:Number(result.exitCode??1),stdout:String(result.stdout||""),stderr:String(result.stderr||"")};
      }
      try{
        const result=await execFileAsync(executable,argv,{cwd,env:buildRuntimeEnvironment("native",{parent:environment,platform}),windowsHide:true,timeout:timeoutMs,maxBuffer:limit,encoding:"utf8"});
        return {ok:true,code:0,stdout:String(result.stdout||""),stderr:String(result.stderr||"")};
      }catch(error){
        return {ok:false,code:Number.isFinite(Number(error?.code))?Number(error.code):1,stdout:String(error?.stdout||""),stderr:String(error?.stderr||error?.message||"")};
      }
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
