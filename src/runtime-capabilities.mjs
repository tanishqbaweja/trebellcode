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
  videoAttachments:true,
  managedInference:false,
});

const RUNTIME_CAPABILITY_OVERRIDES=Object.freeze({
  native:Object.freeze({
    fork:true,rewind:true,compaction:true,mcpInjection:true,systemPromptInjection:true,dynamicTools:true,dynamicToolExpansion:true,languageIntelligence:true,clientFilesystem:true,clientTerminal:true,usageReporting:true,contextReporting:true,detachedTasks:true,multiModelFanout:true,backgroundProcesses:true,nativeQueue:true,nativeHistoryPagination:true,steering:true,delegation:true,managedInference:true,
  }),
  codex:Object.freeze({
    fork:true,rewind:true,compaction:true,systemPromptInjection:true,dynamicTools:true,languageIntelligence:true,nativeSandbox:true,
    usageReporting:true,detachedTasks:true,multiModelFanout:true,delegation:true,harnessTools:true,collaborationModes:true,
    nativeQueue:true,nativeHistoryPagination:true,steering:true,runtimeProfileSwitching:true,projectOwnership:true,
  }),
  claude:Object.freeze({fork:true,rewind:true,compaction:true,mcpInjection:true,languageIntelligence:true,usageReporting:true,runtimeProfileSwitching:true,detachedTasks:true,multiModelFanout:true,delegation:true,steering:true,collaborationModes:true}),
  opencode:Object.freeze({fork:true,rewind:true,compaction:true,nativeLsp:true,languageIntelligence:true,usageReporting:true,detachedTasks:true,multiModelFanout:true,delegation:true}),
  // Cursor's plan mode is the composer's Plan mode (T3's interaction mode: plan or agent); Read only runs in its ask mode.
  // ACP harnesses run their own file and shell tools (T3); only Antigravity reads and writes files through Trebell.
  cursor:Object.freeze({fork:"runtime",mcpInjection:true,detachedTasks:true,multiModelFanout:true,delegation:true,collaborationModes:true}),
  // Grok compacts with its own /compact command (T3 supportsCompaction). Grok and Antigravity have no rewind of their own: a
  // revert cuts the thread and starts a fresh session (T3's ACP rollbackThread, canRollbackThread for both).
  grok:Object.freeze({fork:"runtime",rewind:true,compaction:true,mcpInjection:true,detachedTasks:true,multiModelFanout:true,delegation:true}),
  antigravity:Object.freeze({fork:"runtime",rewind:true,mcpInjection:true,clientFilesystem:true,detachedTasks:true,multiModelFanout:true,delegation:true,videoAttachments:false}),
});

export function sharedRuntimeCapabilities(kind){
  const runtime=String(kind||"").trim().toLowerCase();
  return {...BASE_RUNTIME_CAPABILITIES,...(RUNTIME_CAPABILITY_OVERRIDES[runtime]||{})};
}

export const runtimeCapabilityKinds=Object.freeze(Object.keys(RUNTIME_CAPABILITY_OVERRIDES));
