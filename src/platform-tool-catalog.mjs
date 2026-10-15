import { REPOSITORY_DISCOVERY_TOOL, REPOSITORY_INVOKE_TOOL, REPOSITORY_TOOL_DEFINITIONS, repositoryDynamicToolNamespace, searchRepositoryToolDefinitions } from "./repository-tool-catalog.mjs";
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
  if(String(name||"")==="discover"){
    return {
      namespace:"trebell_repo",name:"discover",description:REPOSITORY_DISCOVERY_TOOL.description,inputSchema:REPOSITORY_DISCOVERY_TOOL.inputSchema,source:"repository-discovery",handler:null,
      policy:{kind:"read",riskLevel:"low",reversibility:"not-applicable",idempotent:true,externalSideEffect:false,asyncSafe:true},
      requirements:{desktop:false,workspace:true,project:false,fullAccess:false,delegation:false,environment:"any"},
      rawDefinition:{discovery:true},
    };
  }
  if(String(name||"")==="invoke"){
    return {
      namespace:"trebell_repo",name:"invoke",description:REPOSITORY_INVOKE_TOOL.description,inputSchema:REPOSITORY_INVOKE_TOOL.inputSchema,source:"repository-invoke",handler:null,
      policy:{kind:"read",riskLevel:"low",reversibility:"not-applicable",idempotent:true,externalSideEffect:false,asyncSafe:true},
      requirements:{desktop:false,workspace:true,project:false,fullAccess:false,delegation:false,environment:"any"},
      rawDefinition:{invoke:true},
    };
  }
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

export function platformDynamicToolNamespaces({repository=true,progressiveRepository=false,...sharedOptions}={}){
  return [...(repository?repositoryDynamicToolNamespace({progressive:progressiveRepository}):[]),...sharedDynamicToolNamespaces(sharedOptions)];
}

export function platformToolCatalog({repository=true,progressiveRepository=false,...sharedOptions}={}){
  const namespaces=platformDynamicToolNamespaces({repository,progressiveRepository,...sharedOptions});
  return namespaces.map(namespace=>({
    ...namespace,
    tools:(namespace.tools||[]).map(tool=>({...tool,platform:platformToolDefinition(namespace.name,tool.name)})),
  }));
}

// The tools a session offers directly, outside trebell_repo's progressive namespace. A model sometimes asks trebell_repo/invoke or
// trebell_repo/discover for one of them ("trebell_terminal__run", "terminal"); it is pointed at the tool instead of being told that
// nothing matches, which reads as "this session cannot run commands".
function directTools(namespaces=[]){
  return (Array.isArray(namespaces)?namespaces:[]).filter(entry=>entry?.type==="namespace"&&entry.name&&entry.name!=="trebell_repo").flatMap(entry=>(Array.isArray(entry.tools)?entry.tools:[]).filter(tool=>tool?.name)
    .map(tool=>({id:String(entry.name)+"/"+String(tool.name),namespace:String(entry.name),name:String(tool.name),text:[entry.name,tool.name,tool.description,entry.description].join(" ").toLowerCase()})));
}
// The exposed tool a name means, written as the provider shows it (namespace__name), with a slash or dot, or as a bare name that only
// one namespace has; null when it names none.
export function exposedToolNamed(namespaces=[],requested=""){
  const raw=String(requested||"").trim();if(!raw)return null;
  const tools=directTools(namespaces),split=raw.match(/^(.+?)(?:__|\/|\.)([^/.]+)$/);
  const named=split&&tools.find(tool=>tool.namespace===split[1]&&tool.name===split[2]);if(named)return named.id;
  const bare=tools.filter(tool=>tool.name===raw);return bare.length===1?bare[0].id:null;
}
// What trebell_repo/discover answers: the advanced repository capabilities matching the query that trebell_repo does not offer
// already, or, when none match, the exposed tools that do.
export function discoverRepositoryCapabilities(namespaces=[],{query="",limit=8}={}){
  const requested=String(query||"").trim();if(!requested)throw new Error("Repository discovery query is required.");
  const offered=(namespaces.find?.(item=>item?.name==="trebell_repo")?.tools||[]).map(item=>String(item?.name||""));
  const capabilities=searchRepositoryToolDefinitions({query:requested,limit,exclude:offered}).map(item=>{
    const [namespace]=repositoryDynamicToolNamespace({names:[item.name],includeDiscovery:false}),tool=namespace?.tools?.[0]||null;
    return {name:item.name,description:item.description,inputSchema:tool?.inputSchema||{type:"object",properties:{}}};
  });
  if(capabilities.length)return {success:true,query:requested,capabilities,instruction:"Call trebell_repo/invoke with one returned capability name and matching arguments."};
  const terms=requested.toLowerCase().split(/[^a-z0-9]+/).filter(term=>term.length>2);
  const direct=terms.length?directTools(namespaces).filter(tool=>terms.some(term=>tool.text.includes(term))).slice(0,4).map(tool=>tool.id):[];
  return {success:true,query:requested,capabilities,instruction:direct.length?"No matching advanced repository capability. These tools are already available; call them directly: "+direct.join(", ")+".":"No matching advanced repository capability."};
}
