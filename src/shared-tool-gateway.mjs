import { performance } from "node:perf_hooks";
import { evaluatePolicy, normalizePolicyProfile, POLICY_ALLOW, POLICY_CONFIRM, POLICY_REJECT } from "./policy-engine.mjs";
import { redactSecretValue } from "./secret-redactor.mjs";
import { platformToolDefinition } from "./platform-tool-catalog.mjs";
import { nativeCommandSemanticError, normalizeNativeCommandArguments } from "./native-command-argv.mjs";
import { normalizeRepositoryWorkspacePath } from "./native-workspace-path.mjs";

function callName(call={}){return {namespace:String(call.namespace||""),name:String(call.name||call.tool||"")}}
function objectArguments(value){return value&&typeof value==="object"&&!Array.isArray(value)?value:{}}
function normalizedPlatformArguments(namespace,name,value){
  const args=objectArguments(value);
  if((namespace==="trebell_terminal"&&["run","start_background"].includes(name))||(namespace==="trebell_process"&&name==="start"))return normalizeNativeCommandArguments(args);
  return args;
}

function normalizedWorkspaceArguments(namespace,name,value,context={}){
  const args={...normalizedPlatformArguments(namespace,name,value)},workspace=context?.workspace;
  if(!workspace)return args;
  if(["trebell_workspace","trebell_repo"].includes(namespace)&&typeof args.path==="string")args.path=normalizeRepositoryWorkspacePath(workspace,args.path);
  if(namespace==="trebell_repo"&&name==="invoke"&&args.arguments&&typeof args.arguments==="object"&&!Array.isArray(args.arguments)&&typeof args.arguments.path==="string"){
    args.arguments={...args.arguments,path:normalizeRepositoryWorkspacePath(workspace,args.arguments.path)};
  }
  if((namespace==="trebell_terminal"||namespace==="trebell_process")&&typeof args.cwd==="string")args.cwd=normalizeRepositoryWorkspacePath(workspace,args.cwd);
  return args;
}

function schemaType(value){
  if(Array.isArray(value))return "array";
  if(value===null)return "null";
  if(Number.isInteger(value))return "integer";
  if(typeof value==="number")return "number";
  return typeof value;
}

function validateSchemaValue(schema,value,path="$"){
  if(!schema||typeof schema!=="object")return null;
  const expected=schema.type;
  if(expected==="object"){
    if(!value||typeof value!=="object"||Array.isArray(value))return path+" must be an object";
    const properties=schema.properties&&typeof schema.properties==="object"?schema.properties:{};
    for(const required of Array.isArray(schema.required)?schema.required:[])if(!Object.prototype.hasOwnProperty.call(value,required))return path+"."+required+" is required";
    if(schema.additionalProperties===false){
      const unknown=Object.keys(value).find(key=>!Object.prototype.hasOwnProperty.call(properties,key));
      if(unknown)return path+"."+unknown+" is not allowed";
    }
    for(const [key,child] of Object.entries(properties)){
      if(!Object.prototype.hasOwnProperty.call(value,key))continue;
      const error=validateSchemaValue(child,value[key],path+"."+key);if(error)return error;
    }
    return null;
  }
  if(expected==="array"){
    if(!Array.isArray(value))return path+" must be an array";
    if(Number.isFinite(Number(schema.minItems))&&value.length<Number(schema.minItems))return path+" must contain at least "+schema.minItems+" items";
    if(Number.isFinite(Number(schema.maxItems))&&value.length>Number(schema.maxItems))return path+" must contain at most "+schema.maxItems+" items";
    for(let index=0;index<value.length;index++){const error=validateSchemaValue(schema.items,value[index],path+"["+index+"]");if(error)return error}
    return null;
  }
  if(expected==="string"&&typeof value!=="string")return path+" must be a string";
  if(expected==="boolean"&&typeof value!=="boolean")return path+" must be a boolean";
  if(expected==="integer"&&!Number.isInteger(value))return path+" must be an integer";
  if(expected==="number"&&(typeof value!=="number"||!Number.isFinite(value)))return path+" must be a number";
  if(Array.isArray(schema.enum)&&!schema.enum.some(item=>Object.is(item,value)))return path+" must be one of: "+schema.enum.join(", ");
  if(typeof value==="string"){
    if(Number.isFinite(Number(schema.minLength))&&value.length<Number(schema.minLength))return path+" must be at least "+schema.minLength+" characters";
    if(Number.isFinite(Number(schema.maxLength))&&value.length>Number(schema.maxLength))return path+" must be at most "+schema.maxLength+" characters";
  }
  if(typeof value==="number"&&Number.isFinite(value)){
    if(Number.isFinite(Number(schema.minimum))&&value<Number(schema.minimum))return path+" must be >= "+schema.minimum;
    if(Number.isFinite(Number(schema.maximum))&&value>Number(schema.maximum))return path+" must be <= "+schema.maximum;
    if(Number.isFinite(Number(schema.exclusiveMinimum))&&value<=Number(schema.exclusiveMinimum))return path+" must be > "+schema.exclusiveMinimum;
  }
  return null;
}

function toolArgumentValidation(definition,args){
  if(!definition||!["shared","repository-discovery","repository-invoke","mcp-invoke"].includes(definition.source))return null;
  if((definition.namespace==="trebell_terminal"&&["run","start_background"].includes(definition.name))||(definition.namespace==="trebell_process"&&definition.name==="start")){
    const semantic=nativeCommandSemanticError(args);if(semantic)return semantic;
  }
  const schema=definition.inputSchema||definition.rawDefinition?.inputSchema;
  const wrapperError=validateSchemaValue(schema,args);if(wrapperError)return wrapperError;
  if(definition.source==="mcp-invoke"&&definition.rawDefinition?.target?.inputSchema){
    const targetError=validateSchemaValue(definition.rawDefinition.target.inputSchema,args?.arguments||{});
    if(targetError)return "$.arguments"+String(targetError).replace(/^\$/,"");
  }
  return null;
}

function normalizedToolAllowlist(value){
  if(!Array.isArray(value))return null;
  const items=[...new Set(value.map(item=>String(item||"").trim().toLowerCase()).filter(Boolean))].slice(0,100);
  return items.length?items:null;
}

const TOOL_ALLOWLIST_ALIASES=Object.freeze({
  repo:"trebell_repo",repository:"trebell_repo",workspace:"trebell_workspace",terminal:"trebell_terminal",browser:"trebell_browser",computer:"trebell_computer",
  process:"trebell_process",background:"trebell_process",source_control:"trebell_source_control","source-control":"trebell_source_control",git:"trebell_source_control",delegate:"trebell_delegate",delegation:"trebell_delegate",
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
  if(requirements.delegation&&!context.delegationAvailable)return rejection("Trebell delegation is unavailable in this runtime.",definition);
  if(requirements.fullAccess&&profile!=="full")return rejection("This Trebell tool requires Full Access mode.",definition);
  return null;
}

export function authorizePlatformToolCall(call={},context={},resolveDefinition=platformToolDefinition){
  const {namespace,name}=callName(call),definition=(typeof resolveDefinition==="function"?resolveDefinition(namespace,name,call):null)||null;
  if(!namespace||!name||!definition)return rejection(`Unknown Trebell tool: ${namespace||"default"}/${name||"unknown"}.`,definition);
  const args=normalizedWorkspaceArguments(namespace,name,call.arguments,context),validationError=toolArgumentValidation(definition,args);
  if(validationError)return rejection(`Invalid arguments for ${namespace}/${name}: ${validationError}.`,definition);
  if(!toolAllowedByAllowlist(namespace,name,context.toolAllowlist))return rejection(`Tool ${namespace}/${name} is not allowed by the active recipe.`,definition);
  const requirement=requirementDecision(definition,{...context,namespace});if(requirement)return requirement;
  const policy=definition.policy||{};
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
    definition,arguments:args,
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

function transportOutcomeUncertain(error){
  if(error?.uncertain===true)return true;
  if(error?.name==="TimeoutError")return true;
  const status=Number(error?.status||error?.statusCode||0);if(status===408||status>=500)return true;
  const code=String(error?.code||error?.cause?.code||"").toUpperCase();
  if(["ETIMEDOUT","ESOCKETTIMEDOUT","ECONNRESET","EPIPE","ENETDOWN","ENETUNREACH","EHOSTUNREACH"].includes(code))return true;
  const message=String(error?.message||error||"").toLowerCase();
  return /(?:timed? out|timeout|connection reset|socket hang up|network error|fetch failed|connection (?:closed|lost)|disconnected|websocket (?:closed|disconnected)|rpc (?:closed|disconnected)|unable to access .*failed to connect)/i.test(message);
}

function uncertainExternalOutcome(authorization,value){
  const action=authorization?.action||authorization?.definition?.policy||{};
  if(!action.externalSideEffect||action.idempotent===true)return false;
  return value?.uncertain===true||transportOutcomeUncertain(value);
}

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
          ...call,namespace:names.namespace,name:names.name,arguments:authorization.arguments||normalizedWorkspaceArguments(names.namespace,names.name,call.arguments,resolvedContext),definition:authorization.definition,authorization,context:resolvedContext,
        });
        const result=redactSecretValue(raw,{environment,maxDepth:12,maxArray:500,maxFields:1000});
        const success=result?.success!==false;
        const uncertain=!success&&uncertainExternalOutcome(authorization,result);
        event(onEvent,{name:"shared_tool.completed",status:success?"completed":uncertain?"uncertain":"failed",data:{...trace,durationMs:Number((performance.now()-started).toFixed(3)),success,uncertain}});
        return {success,decision:authorization.decision,authorization,result,...(!success?{error:String(result?.error||result?.message||"Tool execution failed."),uncertain,retrySafe:!uncertain&&authorization.action?.idempotent===true}:{})};
      }catch(error){
        const message=String(error?.message||error),safeMessage=redactSecretValue(message,{environment});
        const uncertain=uncertainExternalOutcome(authorization,error),errorMessage=uncertain?`Outcome uncertain: ${safeMessage} Inspect the real-world state before repeating this action.`:safeMessage;
        event(onEvent,{name:"shared_tool.completed",status:uncertain?"uncertain":"failed",data:{...trace,durationMs:Number((performance.now()-started).toFixed(3)),success:false,uncertain,error:safeMessage}});
        return {success:false,decision:authorization.decision,authorization,error:errorMessage,uncertain,retrySafe:!uncertain&&authorization.action?.idempotent===true};
      }
    },
  };
}
