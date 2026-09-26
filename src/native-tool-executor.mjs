import { createSharedToolGateway } from "./shared-tool-gateway.mjs";
import { platformToolDefinition } from "./platform-tool-catalog.mjs";
import { advancedRepositoryToolDefinition, invokeRepositoryTool, parseRepositoryToolArguments, repositoryToolHandlers } from "./repository-tool-catalog.mjs";
import { normalizeRepositoryWorkspacePath } from "./native-workspace-path.mjs";

function baseContext(value,call){
  if(typeof value==="function")return value(call)||{};
  return value&&typeof value==="object"?value:{};
}

function repositoryArguments(root,value={}){
  const args=value&&typeof value==="object"&&!Array.isArray(value)?{...value}:{};
  if(typeof args.path==="string")args.path=normalizeRepositoryWorkspacePath(root,args.path);
  return args;
}

export function createNativeToolExecutor({
  contextEngine=null,root=null,io=null,knowledgeService=null,environmentId=null,
  repository=true,discoverRepositoryTools=null,outputStore=null,mcpBroker=null,executeShared=null,confirm=null,environment=process.env,onEvent=null,policyContext={},projectAvailable=null,
}={}){
  const repositoryHandlers=repository&&contextEngine&&root?repositoryToolHandlers({contextEngine,root,io,knowledgeService,environmentId}):null;
  const gateway=createSharedToolGateway({
    confirm,environment,onEvent,
    resolveDefinition:(namespace,name,call)=>mcpBroker?.invocationDefinition?.(namespace,name,call?.arguments||{})||mcpBroker?.toolDefinition?.(namespace,name)||platformToolDefinition(namespace,name),
    contextForCall:(call,override={})=>{
      const base=baseContext(policyContext,call);
      return {...base,workspace:override.workspace??base.workspace??root??null,projectAvailable:override.projectAvailable??base.projectAvailable??(projectAvailable==null?Boolean(root):Boolean(projectAvailable)),...override};
    },
    execute:async call=>{
      if(call.definition?.source==="repository"){
        if(!repositoryHandlers)throw new Error("Repository intelligence is unavailable without an active Context Engine workspace.");
        if(advancedRepositoryToolDefinition(call.name))throw new Error("Advanced Native repository capabilities must be called through trebell_repo/invoke after discovery.");
        const args=parseRepositoryToolArguments(call.definition.rawDefinition,repositoryArguments(root,call.arguments||{}));
        return await invokeRepositoryTool(repositoryHandlers,call.definition.rawDefinition,args);
      }
      if(call.definition?.source==="repository-discovery"){
        if(typeof discoverRepositoryTools!=="function")throw new Error("Repository tool discovery is unavailable.");
        return await discoverRepositoryTools(call.arguments||{});
      }
      if(call.definition?.source==="repository-invoke"){
        if(!repositoryHandlers)throw new Error("Repository intelligence is unavailable without an active Context Engine workspace.");
        const requested=String(call.arguments?.name||"").trim(),definition=advancedRepositoryToolDefinition(requested);
        if(!definition)throw new Error("Unknown or non-advanced repository capability: "+(requested||"missing"));
        const args=parseRepositoryToolArguments(definition,repositoryArguments(root,call.arguments?.arguments||{}));
        return await invokeRepositoryTool(repositoryHandlers,definition,args);
      }
      if(call.namespace==="trebell_output"){
        if(!outputStore)throw new Error("Trebell output store is unavailable.");
        return await outputStore.execute(call);
      }
      if(["mcp","mcp-discovery","mcp-invoke"].includes(call.definition?.source)){
        if(!mcpBroker)throw new Error("Native MCP broker is unavailable.");
        return await mcpBroker.call({namespace:call.namespace,name:call.name,arguments:call.arguments||{},signal:call.signal||null});
      }
      if(typeof executeShared!=="function")throw new Error(`No Native executor is connected for ${call.namespace}/${call.name}.`);
      return await executeShared(call);
    },
  });
  const executor=async(call,context={})=>{
    const detailed=await gateway.invoke(call,context);
    return detailed.success?detailed.result:{success:false,error:detailed.error||"Tool execution failed.",decision:detailed.decision,confirmationRequired:Boolean(detailed.confirmationRequired),uncertain:Boolean(detailed.uncertain),retrySafe:Boolean(detailed.retrySafe)};
  };
  executor.invokeDetailed=(call,context={})=>gateway.invoke(call,context);
  executor.authorize=(call,context={})=>gateway.authorize(call,context);
  executor.gateway=gateway;
  return executor;
}
