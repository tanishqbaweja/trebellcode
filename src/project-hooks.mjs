const HOOK_EVENTS=new Set(["verification.required","source-control.before","source-control.after"]);
const FAILURE_MODES=new Set(["block","warn"]);

function text(value,max=4000){return String(value??"").trim().slice(0,max)}
function list(value,{limit=40,max=120}={}){return [...new Set((Array.isArray(value)?value:[]).map(item=>text(item,max)).filter(Boolean))].slice(0,limit)}
function timeout(value){const number=Math.trunc(Number(value)||0);return Math.max(1000,Math.min(300000,number||30000))}
function hookName(value,index=0){return text(value,120)||`Hook ${index+1}`}
function hookId(value,index=0){return text(value,300)||null}

export function normalizeProjectHook(hook={},index=0){
  const event=text(hook.event,80);if(!HOOK_EVENTS.has(event))throw new Error("Unsupported project hook event: "+(event||"missing"));
  const command=text(hook.command,8000);if(!command)throw new Error("Project hook command is required.");
  const failureMode=event==="source-control.after"?"warn":event==="verification.required"?"block":(FAILURE_MODES.has(String(hook.failureMode))?String(hook.failureMode):"block");
  return {
    id:hookId(hook.id,index),
    name:hookName(hook.name,index),
    event,
    command,
    enabled:hook.enabled!==false,
    failureMode,
    timeoutMs:timeout(hook.timeoutMs),
    actions:event.startsWith("source-control.")?list(hook.actions):[],
  };
}

export function normalizeProjectHooks(hooks=[]){
  const out=[],ids=new Set();
  for(let index=0;index<(Array.isArray(hooks)?hooks:[]).length&&out.length<50;index++){
    let hook;try{hook=normalizeProjectHook(hooks[index],index)}catch{continue}
    if(hook.id&&ids.has(hook.id))continue;if(hook.id)ids.add(hook.id);out.push(hook);
  }
  return out;
}

export function projectHookMatches(hook,{event,action=null}={}){
  if(!hook?.enabled||hook.event!==event)return false;
  if(!event?.startsWith("source-control."))return true;
  const actions=Array.isArray(hook.actions)?hook.actions:[];
  const canonical=value=>String(value||"")==="git.push"?"push":String(value||"");
  const wanted=canonical(action);return !actions.length||actions.includes("*")||actions.some(item=>canonical(item)===wanted);
}

function stepId(hook,index){
  const raw=String(hook?.id||hook?.name||index+1).toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_+|_+$/g,"").slice(0,52)||String(index+1);
  return "project_hook_"+raw;
}

export function verificationHookSteps(hooks=[]){
  const selected=normalizeProjectHooks(hooks).filter(hook=>projectHookMatches(hook,{event:"verification.required"})),seen=new Set(),steps=[];
  for(let index=0;index<selected.length;index++){
    const hook=selected[index];let id=stepId(hook,index),suffix=1;while(seen.has(id))id=stepId(hook,index)+"_"+(++suffix);seen.add(id);
    steps.push({id,kind:"command",scope:"project",required:true,cost:"medium",command:hook.command,reason:`Required project hook: ${hook.name}`,hookId:hook.id||null,hookName:hook.name});
  }
  return steps;
}

export async function runProjectHooks({hooks=[],event,action=null,execute,onEvent=()=>{}}={}){
  if(typeof execute!=="function")throw new Error("Project hook executor is required.");
  const selected=normalizeProjectHooks(hooks).filter(hook=>projectHookMatches(hook,{event,action})),results=[];
  for(const hook of selected){
    const startedAt=Date.now();onEvent({phase:"started",hook,event,action,startedAt});
    let result,error=null;
    try{result=await execute(hook)}catch(caught){error=caught}
    const exitCode=Number.isFinite(Number(result?.exitCode))?Number(result.exitCode):(error?1:0),timedOut=Boolean(result?.timedOut),durationMs=Math.max(0,Number(result?.durationMs)||Date.now()-startedAt),passed=!error&&!timedOut&&exitCode===0;
    const summary={hookId:hook.id||null,name:hook.name,event,action:action||null,status:passed?"passed":"failed",exitCode,timedOut,durationMs,failureMode:hook.failureMode};results.push(summary);
    onEvent({phase:passed?"completed":"failed",hook,event,action,startedAt,result:summary,error});
    if(!passed&&hook.failureMode==="block"){
      const detail=timedOut?"timed out":`exited with code ${exitCode}`;
      throw Object.assign(new Error(`Project hook ${hook.name} ${detail}.`),{code:"TREBELL_PROJECT_HOOK_FAILED",hookId:hook.id||null,hookResult:summary});
    }
  }
  return results;
}

export const PROJECT_HOOK_EVENTS=Object.freeze([...HOOK_EVENTS]);
