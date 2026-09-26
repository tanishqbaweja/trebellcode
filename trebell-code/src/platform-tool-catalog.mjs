import { REPOSITORY_TOOL_DEFINITIONS, repositoryDynamicToolNamespace } from "./repository-tool-catalog.mjs";
import { sharedDynamicToolNamespaces, sharedToolDefinition, sharedToolNamespace } from "./shared-tool-catalog.mjs";

function mergedRequirements(namespaceRequirements={},toolRequirements={}){
  const keys=new Set([...Object.keys(namespaceRequirements||{}),...Object.keys(toolRequirements||{})]);
  return Object.fromEntries([...keys].map(key=>[key,Boolean(namespaceRequirements?.[key]||toolRequirements?.[key])]));
}

function sharedPlatformDefinition(namespace,name){
  const definition=sharedToolDefinition(namespace,name);if(!definition)return null;
  return {
    ...definition,namespace,source:"shared",
    requirements:mergedRequirements(sharedToolNamespace(namespace)?.requirements,definition.requirements),
    rawDefinition:definition,
  };
}

function repositoryPlatformDefinition(name){
  const definition=REPOSITORY_TOOL_DEFINITIONS.find(item=>item.name===String(name||""));if(!definition)return null;
  const policy=definition.policy||{};
  return {
    namespace:"trebell_repo",name:definition.name,description:definition.description,inputSchema:definition.inputSchema,source:"repository",handler:definition.handler,
    policy:{
      kind:policy.readOnly?"read":"other",
      riskLevel:policy.risk||"low",
      reversibility:policy.reversibility||"not-applicable",
      idempotent:Boolean(policy.idempotent),
      externalSideEffect:Boolean(policy.externalSideEffects),
      asyncSafe:Boolean(policy.readOnly&&policy.externalSideEffects!==true),
    },
    requirements:{
      desktop:false,workspace:policy.workspace==="required",project:false,fullAccess:false,delegation:false,
      environment:policy.environment||"any",
    },
    rawDefinition:definition,
  };
}

export function platformToolDefinition(namespace,name){
  const namespaceName=String(namespace||"");
  return namespaceName==="trebell_repo"?repositoryPlatformDefinition(name):sharedPlatformDefinition(namespaceName,name);
}

export function platformToolParallelSafe(namespace,name){
  const definition=platformToolDefinition(namespace,name),policy=definition?.policy||{};
  if(policy.asyncSafe!==true||policy.idempotent!==true||policy.kind!=="read")return false;
  // These mutate shared browser session state despite being reversible/idempotent.
  if(String(namespace||"")==="trebell_browser"&&String(name||"")==="set_viewport")return false;
  return true;
}

export function platformDynamicToolNamespaces({repository=true,...sharedOptions}={}){
  return [...(repository?repositoryDynamicToolNamespace():[]),...sharedDynamicToolNamespaces(sharedOptions)];
}

export function platformToolCatalog({repository=true,...sharedOptions}={}){
  const namespaces=platformDynamicToolNamespaces({repository,...sharedOptions});
  return namespaces.map(namespace=>({
    ...namespace,
    tools:(namespace.tools||[]).map(tool=>({...tool,platform:platformToolDefinition(namespace.name,tool.name)})),
  }));
}
