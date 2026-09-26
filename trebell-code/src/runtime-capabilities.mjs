const BASE_RUNTIME_CAPABILITIES=Object.freeze({
  queue:true,
  fork:false,
  rewind:false,
  compaction:false,
  mcpInjection:false,
  systemPromptInjection:false,
  dynamicTools:false,
  dynamicToolExpansion:false,
  nativeLsp:false,
  languageIntelligence:false,
  nativeSandbox:false,
  permissionInterception:true,
  clientFilesystem:false,
  clientTerminal:false,
  usageReporting:false,
  contextReporting:false,
  detachedTasks:false,
  multiModelFanout:false,
  backgroundProcesses:false,
  delegation:false,
  harnessTools:false,
  collaborationModes:false,
  nativeQueue:false,
  nativeHistoryPagination:false,
  threadSearch:true,
  steering:false,
  runtimeProfileSwitching:false,
  projectOwnership:false,
});

const RUNTIME_CAPABILITY_OVERRIDES=Object.freeze({
  native:Object.freeze({
    fork:true,rewind:true,compaction:true,mcpInjection:true,systemPromptInjection:true,dynamicTools:true,dynamicToolExpansion:true,languageIntelligence:true,clientFilesystem:true,clientTerminal:true,usageReporting:true,contextReporting:true,detachedTasks:true,multiModelFanout:true,backgroundProcesses:true,nativeQueue:true,nativeHistoryPagination:true,steering:true,delegation:true,
  }),
  codex:Object.freeze({
    fork:true,rewind:true,compaction:true,systemPromptInjection:true,dynamicTools:true,languageIntelligence:true,nativeSandbox:true,
    usageReporting:true,detachedTasks:true,multiModelFanout:true,backgroundProcesses:true,delegation:true,harnessTools:true,collaborationModes:true,
    nativeQueue:true,nativeHistoryPagination:true,steering:true,runtimeProfileSwitching:true,projectOwnership:true,
  }),
  claude:Object.freeze({fork:true,rewind:true,compaction:true,mcpInjection:true,languageIntelligence:true,usageReporting:true,runtimeProfileSwitching:true,detachedTasks:true,multiModelFanout:true,delegation:true}),
  opencode:Object.freeze({fork:true,rewind:true,compaction:true,nativeLsp:true,languageIntelligence:true,usageReporting:true,detachedTasks:true,multiModelFanout:true,delegation:true}),
  cursor:Object.freeze({fork:"runtime",mcpInjection:true,clientFilesystem:true,clientTerminal:true,detachedTasks:true,multiModelFanout:true,delegation:true}),
  grok:Object.freeze({fork:"runtime",mcpInjection:true,clientFilesystem:true,clientTerminal:true,detachedTasks:true,multiModelFanout:true,delegation:true}),
  antigravity:Object.freeze({fork:"runtime",mcpInjection:true,clientFilesystem:true,clientTerminal:true,detachedTasks:true,multiModelFanout:true,delegation:true}),
});

export function sharedRuntimeCapabilities(kind){
  const runtime=String(kind||"").trim().toLowerCase();
  return {...BASE_RUNTIME_CAPABILITIES,...(RUNTIME_CAPABILITY_OVERRIDES[runtime]||{})};
}

export const runtimeCapabilityKinds=Object.freeze(Object.keys(RUNTIME_CAPABILITY_OVERRIDES));
