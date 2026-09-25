import { performance } from "node:perf_hooks";
import { evaluatePolicy, normalizePolicyProfile, POLICY_ALLOW, POLICY_CONFIRM, POLICY_REJECT } from "./policy-engine.mjs";
import { redactSecretValue } from "./secret-redactor.mjs";
import { platformToolDefinition } from "./platform-tool-catalog.mjs";

function callName(call={}){return {namespace:String(call.namespace||""),name:String(call.name||call.tool||"")}}
function objectArguments(value){return value&&typeof value==="object"&&!Array.isArray(value)?value:{}}

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

export function authorizePlatformToolCall(call={},context={}){
  const {namespace,name}=callName(call),definition=platformToolDefinition(namespace,name);
  if(!namespace||!name||!definition)return rejection(`Unknown Trebell tool: ${namespace||"default"}/${name||"unknown"}.`,definition);
  const requirement=requirementDecision(definition,{...context,namespace});if(requirement)return requirement;
  const args=objectArguments(call.arguments),policy=definition.policy||{};
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
      externalSideEffect:policy.externalSideEffect,
      riskLevel:policy.riskLevel,
      reversibility:policy.reversibility,
      idempotent:policy.idempotent,
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

export function createSharedToolGateway({execute,confirm=null,environment=process.env,onEvent=null,contextForCall=null}={}){
  if(typeof execute!=="function")throw new Error("Shared tool gateway requires an execute function.");
  return {
    authorize(call,context={}){
      const resolvedContext=typeof contextForCall==="function"?contextForCall(call,context)||context:context;
      return authorizePlatformToolCall(call,resolvedContext);
    },
    async invoke(call={},context={}){
      const names=callName(call),resolvedContext=typeof contextForCall==="function"?contextForCall(call,context)||context:context;
      const authorization=authorizePlatformToolCall(call,resolvedContext),trace={namespace:names.namespace,name:names.name,decision:authorization.decision,reason:authorization.reason||null,riskLevel:authorization.action?.riskLevel||authorization.definition?.policy?.riskLevel||null};
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
