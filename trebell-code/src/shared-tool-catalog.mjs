function freeze(value){
  if(value&&typeof value==="object"&&!Object.isFrozen(value)){
    Object.freeze(value);
    for(const child of Object.values(value))freeze(child);
  }
  return value;
}

function tool(name,description,inputSchema,policy={},requirements={}){
  return freeze({
    name,description,inputSchema,
    policy:{
      kind:policy.kind||"other",
      riskLevel:policy.riskLevel||"medium",
      reversibility:policy.reversibility||"partial",
      idempotent:Boolean(policy.idempotent),
      externalSideEffect:Boolean(policy.externalSideEffect),
      asyncSafe:Boolean(policy.asyncSafe),
    },
    requirements:{
      desktop:Boolean(requirements.desktop),
      workspace:Boolean(requirements.workspace),
      project:Boolean(requirements.project),
      fullAccess:Boolean(requirements.fullAccess),
      deviceAccess:Boolean(requirements.deviceAccess),
      delegation:Boolean(requirements.delegation),
    },
  });
}

function namespace(name,description,tools,requirements={}){
  return freeze({name,description,tools,requirements:{...requirements}});
}

const emptyObjectSchema=freeze({type:"object",properties:{},additionalProperties:false});

export const SHARED_TOOL_NAMESPACE_CATALOG=freeze([
  namespace("trebell_browser","Control Trebell Code's isolated desktop browser session for web research and testing.",[
    tool("open","Navigate the Trebell browser to a URL.",{type:"object",properties:{url:{type:"string"}},required:["url"],additionalProperties:false},{kind:"fetch",riskLevel:"low",reversibility:"full"},{desktop:true}),
    tool("snapshot","Inspect current page text and interactive elements. Returns refs for click/type.",emptyObjectSchema,{kind:"read",riskLevel:"low",reversibility:"not-applicable",idempotent:true,asyncSafe:true},{desktop:true}),
    tool("click","Click an element from the latest snapshot by ref.",{type:"object",properties:{ref:{type:"string"}},required:["ref"],additionalProperties:false},{kind:"other",riskLevel:"medium",reversibility:"partial"},{desktop:true}),
    tool("type","Set text in an input or editable element from the latest snapshot.",{type:"object",properties:{ref:{type:"string"},text:{type:"string"}},required:["ref","text"],additionalProperties:false},{kind:"other",riskLevel:"medium",reversibility:"partial"},{desktop:true}),
    tool("screenshot","Capture the current page as an image visible to the model.",emptyObjectSchema,{kind:"read",riskLevel:"low",reversibility:"not-applicable",idempotent:true,asyncSafe:true},{desktop:true}),
  ],{desktop:true}),
  namespace("trebell_computer","Control the primary desktop display. Screenshot is read-only; mouse and keyboard input require Trebell Full access mode.",[
    tool("screenshot","Capture the primary desktop and return it to the model with coordinate metadata.",emptyObjectSchema,{kind:"read",riskLevel:"low",reversibility:"not-applicable",idempotent:true,asyncSafe:true},{desktop:true}),
    tool("move","Move the mouse to screenshot pixel coordinates.",{type:"object",properties:{x:{type:"integer"},y:{type:"integer"}},required:["x","y"],additionalProperties:false},{kind:"other",riskLevel:"low",reversibility:"full"},{desktop:true,fullAccess:true}),
    tool("click","Click at screenshot pixel coordinates.",{type:"object",properties:{x:{type:"integer"},y:{type:"integer"},button:{type:"string",enum:["left","right","middle"]},count:{type:"integer",minimum:1,maximum:3}},required:["x","y"],additionalProperties:false},{kind:"other",riskLevel:"high",reversibility:"partial",externalSideEffect:true},{desktop:true,fullAccess:true}),
    tool("scroll","Scroll at the current pointer position. Positive delta scrolls up; negative scrolls down.",{type:"object",properties:{delta:{type:"integer"}},required:["delta"],additionalProperties:false},{kind:"other",riskLevel:"low",reversibility:"full"},{desktop:true,fullAccess:true}),
    tool("type","Type text into the focused desktop application.",{type:"object",properties:{text:{type:"string"}},required:["text"],additionalProperties:false},{kind:"other",riskLevel:"high",reversibility:"partial",externalSideEffect:true},{desktop:true,fullAccess:true}),
    tool("key","Send a supported key or shortcut such as ENTER, TAB, ESC, CTRL+A, CTRL+C, CTRL+V, ALT+TAB, UP, DOWN, LEFT, RIGHT.",{type:"object",properties:{key:{type:"string"}},required:["key"],additionalProperties:false},{kind:"other",riskLevel:"high",reversibility:"partial",externalSideEffect:true},{desktop:true,fullAccess:true}),
  ],{desktop:true}),
  namespace("trebell_device","Inspect and control local Android emulators or iOS simulators exposed by Trebell Code. Physical phones are never controlled by these tools.",[
    tool("list","List available Android emulators and iOS simulators.",emptyObjectSchema,{kind:"read",riskLevel:"low",reversibility:"not-applicable",idempotent:true,asyncSafe:true},{deviceAccess:true}),
    tool("screenshot","Capture a simulator screen as an image.",{type:"object",properties:{id:{type:"string"}},required:["id"],additionalProperties:false},{kind:"read",riskLevel:"low",reversibility:"not-applicable",idempotent:true,asyncSafe:true},{deviceAccess:true}),
    tool("tap","Tap simulator pixel coordinates from the latest screenshot.",{type:"object",properties:{id:{type:"string"},x:{type:"number"},y:{type:"number"}},required:["id","x","y"],additionalProperties:false},{kind:"other",riskLevel:"medium",reversibility:"partial"},{deviceAccess:true}),
    tool("type","Type text into the focused Android emulator control.",{type:"object",properties:{id:{type:"string"},text:{type:"string"}},required:["id","text"],additionalProperties:false},{kind:"other",riskLevel:"medium",reversibility:"partial"},{deviceAccess:true}),
    tool("key","Send Android emulator Back, Home, Recents, or Enter.",{type:"object",properties:{id:{type:"string"},key:{type:"string",enum:["back","home","recents","enter"]}},required:["id","key"],additionalProperties:false},{kind:"other",riskLevel:"medium",reversibility:"partial"},{deviceAccess:true}),
    tool("foreground","Read the foreground Android emulator app/activity.",{type:"object",properties:{id:{type:"string"}},required:["id"],additionalProperties:false},{kind:"read",riskLevel:"low",reversibility:"not-applicable",idempotent:true,asyncSafe:true},{deviceAccess:true}),
  ],{deviceAccess:true}),
  namespace("trebell_source_control","Link hosted pull requests to the current Trebell thread.",[
    tool("link_pull_request","Link a pull request URL to the current thread so Trebell can track its review state and native stack.",{type:"object",properties:{url:{type:"string"}},required:["url"],additionalProperties:false},{kind:"edit",riskLevel:"low",reversibility:"full",idempotent:true},{workspace:true,project:true}),
  ],{workspace:true,project:true}),
  namespace("trebell_delegate","Delegate a bounded child task through Trebell. Coding delegates use isolated Git worktrees by default so parallel agents do not edit the same checkout.",[
    tool("delegate","Start one bounded child task. Use delegation only when parallel or specialized work is genuinely useful; do not create swarms.",{
      type:"object",additionalProperties:false,required:["task"],properties:{
        task:{type:"string",description:"Concrete child objective."},
        permissions:{type:"string",enum:["inherit","read-only","workspace-write","supervised","full"],description:"Child permission profile. inherit resolves to supervised for delegated workers."},
        isolation:{type:"string",enum:["auto","worktree","inherit","shared"],description:"auto/worktree use an isolated Git worktree; inherit/shared reuse the parent workspace."},
        model:{type:"string",description:"Optional model id; defaults to the parent's selected model."},
        ownership:{type:"array",items:{type:"string"},maxItems:50,description:"Files or areas the child owns."},
        context:{type:"string",description:"Additional bounded context that is not already in repository context."},
        label:{type:"string",description:"Optional short label for the child task."},
        budget:{type:"object",additionalProperties:false,properties:{
          tokenBudget:{type:"integer",minimum:1},timeBudgetMinutes:{type:"integer",minimum:1},turnBudget:{type:"integer",minimum:1,maximum:500},
          toolCallBudget:{type:"integer",minimum:1,maximum:1000},childAgentBudget:{type:"integer",minimum:1,maximum:100},costBudgetUsd:{type:"number",exclusiveMinimum:0},
        }},
      },
    },{kind:"execute",riskLevel:"high",reversibility:"partial",externalSideEffect:false,asyncSafe:true},{workspace:true,project:true,delegation:true}),
  ],{workspace:true,project:true,delegation:true}),
]);

export function sharedToolNamespace(name){
  return SHARED_TOOL_NAMESPACE_CATALOG.find(item=>item.name===String(name||""))||null;
}

export function sharedToolDefinition(namespaceName,toolName){
  return sharedToolNamespace(namespaceName)?.tools.find(item=>item.name===String(toolName||""))||null;
}

export function dynamicToolNamespace(namespaceDefinition){
  if(!namespaceDefinition)return null;
  return {
    type:"namespace",
    name:namespaceDefinition.name,
    description:namespaceDefinition.description,
    tools:namespaceDefinition.tools.map(item=>({type:"function",name:item.name,description:item.description,inputSchema:item.inputSchema})),
  };
}

export function sharedDynamicToolNamespaces({browser=false,computer=false,device=false,sourceControl=true,delegation=false}={}){
  const enabled=new Set([
    ...(browser?["trebell_browser"]:[]),
    ...(computer?["trebell_computer"]:[]),
    ...(device?["trebell_device"]:[]),
    ...(sourceControl?["trebell_source_control"]:[]),
    ...(delegation?["trebell_delegate"]:[]),
  ]);
  return SHARED_TOOL_NAMESPACE_CATALOG.filter(item=>enabled.has(item.name)).map(dynamicToolNamespace);
}
