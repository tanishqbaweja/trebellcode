import { createSharedToolGateway } from "./shared-tool-gateway.mjs";
import { platformToolDefinition } from "./platform-tool-catalog.mjs";
import { invokeRepositoryTool, parseRepositoryToolArguments, repositoryToolHandlers } from "./repository-tool-catalog.mjs";

function baseContext(value,call){
  if(typeof value==="function")return value(call)||{};
  return value&&typeof value==="object"?value:{};
}

export function createNativeToolExecutor({
  contextEngine=null,root=null,io=null,knowledgeService=null,environmentId=null,
  repository=true,mcpBroker=null,executeShared=null,confirm=null,environment=process.env,onEvent=null,policyContext={},projectAvailable=null,
}={}){
  const repositoryHandlers=repository&&contextEngine&&root?repositoryToolHandlers({contextEngine,root,io,knowledgeService,environmentId}):null;
  const gateway=createSharedToolGateway({
    confirm,environment,onEvent,
    resolveDefinition:(namespace,name)=>mcpBroker?.toolDefinition?.(namespace,name)||platformToolDefinition(namespace,name),
    contextForCall:(call,override={})=>{
      const base=baseContext(policyContext,call);
      return {...base,workspace:override.workspace??base.workspace??root??null,projectAvailable:override.projectAvailable??base.projectAvailable??(projectAvailable==null?Boolean(root):Boolean(projectAvailable)),...override};
    },
    execute:async call=>{
      if(call.definition?.source==="repository"){
        if(!repositoryHandlers)throw new Error("Repository intelligence is unavailable without an active Context Engine workspace.");
        const args=parseRepositoryToolArguments(call.definition.rawDefinition,call.arguments||{});
        return await invokeRepositoryTool(repositoryHandlers,call.definition.rawDefinition,args);
      }
      if(call.definition?.source==="mcp"){
        if(!mcpBroker)throw new Error("Native MCP broker is unavailable.");
        return await mcpBroker.call({namespace:call.namespace,name:call.name,arguments:call.arguments||{},signal:call.signal||null});
      }
      if(typeof executeShared!=="function")throw new Error(`No Native executor is connected for ${call.namespace}/${call.name}.`);
      return await executeShared(call);
    },
  });
  const executor=async(call,context={})=>{
    const detailed=await gateway.invoke(call,context);
    return detailed.success?detailed.result:{success:false,error:detailed.error||"Tool execution failed.",decision:detailed.decision,confirmationRequired:Boolean(detailed.confirmationRequired)};
  };
  executor.invokeDetailed=(call,context={})=>gateway.invoke(call,context);
  executor.authorize=(call,context={})=>gateway.authorize(call,context);
  executor.gateway=gateway;
  return executor;
}
