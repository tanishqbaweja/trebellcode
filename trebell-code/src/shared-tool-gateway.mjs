import { performance } from "node:perf_hooks";
import { evaluatePolicy, normalizePolicyProfile, POLICY_ALLOW, POLICY_CONFIRM, POLICY_REJECT } from "./policy-engine.mjs";
import { redactSecretValue } from "./secret-redactor.mjs";
import { platformToolDefinition } from "./platform-tool-catalog.mjs";

function callName(call={}){return {namespace:String(call.namespace||""),name:String(call.name||call.tool||"")}}
function objectArguments(value){return value&&typeof value==="object"&&!Array.isArray(value)?value:{}}

function normalizedToolAllowlist(value){
  if(!Array.isArray(value))return null;
  const items=[...new Set(value.map(item=>String(item||"").trim().toLowerCase()).filter(Boolean))].slice(0,100);
  return items.length?items:null;
}

const TOOL_ALLOWLIST_ALIASES=Object.freeze({
  repo:"trebell_repo",repository:"trebell_repo",workspace:"trebell_workspace",terminal:"trebell_terminal",browser:"trebell_browser",computer:"trebell_computer",device:"trebell_device",
  source_control:"trebell_source_control","source-control":"trebell_source_control",git:"trebell_source_control",delegate:"trebell_delegate",delegation:"trebell_delegate",
});
function canonicalToolPattern(value){
  const raw=String(value||"").trim().toLowerCase();if(!raw||raw==="*")return raw;
  const separator=raw.includes("/")?"/":raw.includes(".*")?".*":null;
  if(separator){const index=raw.indexOf(separator),head=raw.slice(0,index),tail=raw.slice(index+separator.length),namespace=TOOL_ALLOWLIST_ALIASES[head]||head;return separator===".*"?namespace+".*":namespace+"/"+tail}
  return TOOL_ALLOWLIST_ALIASES[raw]||raw;
}
function toolAllowedByAllowlist(namespace,name,value){
  const allowlist=normalizedToolAllowlist(value);if(!allowlist)return true;
  const ns=String(namespace||"").toLowerCase(),tool=String(name||"").toLowerCase(),qualified=ns+"/"+tool;
  return allowlist.some(raw=>{const item=canonicalToolPattern(raw);if(item==="mcp")return ns==="trebell_mcp"||ns.startsWith("mcp_");return item==="*"||item===ns||item===qualified||item===ns+"/*"||item===ns+".*"});
}

function rejection(reason,definition=null){
  return {decision:POLICY_REJECT,reason,definition,action:null,profile:null,requirementFailed:true};
}

function requirementDecision(definition,context={}){
  if(!definition)return rejection("Unknown Trebell tool.");
  const requirements=definition.requirements||{};
  const profile=normalizePolicyProfile(context.permissionProfile||context.profile||"supervised");
  if(requirements.desktop&&!context.desktopAvailable)return rejection("This Trebell tool requires the desktop app.",definition);
  if(requirements.workspace&&!context.workspace)return rejection("This Trebell tool requires an active workspace.",definition);
  if(requirements.project&&context.projectAvailable!==true)return rejection("This Trebell tool requires an active project.",definition);
  if(requirements.deviceAccess&&!context.deviceAccess)return rejection("Agent device access is disabled for this project.",definition);
  if(requirements.delegation&&!context.delegationAvailable)return rejection("Trebell delegation is unavailable in this runtime.",definition);
  if(requirements.fullAccess&&profile!=="full")return rejection("This Trebell tool requires Full Access mode.",definition);
  return null;
}

export function authorizePlatformToolCall(call={},context={},resolveDefinition=platformToolDefinition){
  const {namespace,name}=callName(call),definition=(typeof resolveDefinition==="function"?resolveDefinition(namespace,name):null)||null;
  if(!namespace||!name||!definition)return rejection(`Unknown Trebell tool: ${namespace||"default"}/${name||"unknown"}.`,definition);
  if(!toolAllowedByAllowlist(namespace,name,context.toolAllowlist))return rejection(`Tool ${namespace}/${name} is not allowed by the active recipe.`,definition);
  const requirement=requirementDecision(definition,{...context,namespace});if(requirement)return requirement;
  const args=objectArguments(call.arguments),policy=definition.policy||{};
  const policyMetadata=policy.classifyFromInput?{}:{
    externalSideEffect:policy.externalSideEffect,
    riskLevel:policy.riskLevel,
    reversibility:policy.reversibility,
    idempotent:policy.idempotent,
  };
  return {
    ...evaluatePolicy({
      profile:context.permissionProfile||context.profile||"supervised",
      runtime:context.runtime||null,
      kind:policy.kind,
      action:namespace+"."+name,
      rawInput:args,
      workspace:context.workspace||null,
      requestedPath:context.requestedPath||null,
      networkTarget:context.networkTarget||args.url||null,
      ...policyMetadata,
      provenance:context.provenance||"model",
      environmentType:context.environmentType||null,
      environmentIsolated:Boolean(context.environmentIsolated),
      requestedPermissionEscalation:false,
      rules:context.rules||[],
    }),
    definition,
    requirementFailed:false,
  };
}

export const authorizeSharedToolCall=authorizePlatformToolCall;

function confirmationAllowed(value){
  if(value===true||value===POLICY_ALLOW)return true;
  if(typeof value==="string")return ["allow","allowed","accept","accepted","approve","approved"].includes(value.toLowerCase());
  if(value&&typeof value==="object")return confirmationAllowed(value.decision??value.allowed??value.approved);
  return false;
}

function event(onEvent,event){try{onEvent?.({...event,at:Date.now()})}catch{}}

export function createSharedToolGateway({execute,confirm=null,environment=process.env,onEvent=null,contextForCall=null,resolveDefinition=platformToolDefinition}={}){
  if(typeof execute!=="function")throw new Error("Shared tool gateway requires an execute function.");
  return {
    authorize(call,context={}){
      const resolvedContext=typeof contextForCall==="function"?contextForCall(call,context)||context:context;
      return authorizePlatformToolCall(call,resolvedContext,resolveDefinition);
    },
    async invoke(call={},context={}){
      const names=callName(call),resolvedContext=typeof contextForCall==="function"?contextForCall(call,context)||context:context;
      const authorization=authorizePlatformToolCall(call,resolvedContext,resolveDefinition),trace={namespace:names.namespace,name:names.name,decision:authorization.decision,reason:authorization.reason||null,riskLevel:authorization.action?.riskLevel||authorization.definition?.policy?.riskLevel||null};
      event(onEvent,{name:"shared_tool.policy",status:authorization.decision.toLowerCase(),data:trace});
      if(authorization.decision===POLICY_REJECT)return {success:false,decision:POLICY_REJECT,error:authorization.reason,authorization};
      if(authorization.decision===POLICY_CONFIRM){
        if(typeof confirm!=="function")return {success:false,decision:POLICY_CONFIRM,confirmationRequired:true,error:authorization.reason,authorization};
        event(onEvent,{name:"shared_tool.confirmation_requested",status:"pending",data:trace});
        let confirmed=false;
        try{confirmed=confirmationAllowed(await confirm({call,context:resolvedContext,authorization}))}catch(error){
          event(onEvent,{name:"shared_tool.confirmation_resolved",status:"error",data:{...trace,error:error?.message||String(error)}});
          return {success:false,decision:POLICY_CONFIRM,error:error?.message||String(error),authorization};
        }
        event(onEvent,{name:"shared_tool.confirmation_resolved",status:confirmed?"accepted":"declined",data:trace});
        if(!confirmed)return {success:false,decision:POLICY_CONFIRM,confirmationRequired:true,error:"Tool execution was not approved.",authorization};
      }
      event(onEvent,{name:"shared_tool.started",status:"running",data:trace});
      const started=performance.now();
      try{
        const raw=await execute({
          ...call,namespace:names.namespace,name:names.name,arguments:objectArguments(call.arguments),definition:authorization.definition,authorization,context:resolvedContext,
        });
        const result=redactSecretValue(raw,{environment,maxDepth:12,maxArray:500,maxFields:1000});
        const success=result?.success!==false;
        event(onEvent,{name:"shared_tool.completed",status:success?"completed":"failed",data:{...trace,durationMs:Number((performance.now()-started).toFixed(3)),success}});
        return {success,decision:authorization.decision,authorization,result,...(!success?{error:String(result?.error||result?.message||"Tool execution failed.")}:{})};
      }catch(error){
        const message=String(error?.message||error),safeMessage=redactSecretValue(message,{environment});
        event(onEvent,{name:"shared_tool.completed",status:"failed",data:{...trace,durationMs:Number((performance.now()-started).toFixed(3)),success:false,error:safeMessage}});
        return {success:false,decision:authorization.decision,authorization,error:safeMessage};
      }
    },
  };
}
