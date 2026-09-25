const BASE_RUNTIME_CAPABILITIES=Object.freeze({
  queue:true,
  fork:false,
  rewind:false,
  compaction:false,
  mcpInjection:false,
  systemPromptInjection:false,
  dynamicTools:false,
  nativeLsp:false,
  nativeSandbox:false,
  permissionInterception:true,
  clientFilesystem:false,
  clientTerminal:false,
  usageReporting:false,
  contextReporting:false,
  backgroundProcesses:false,
  delegation:false,
  harnessTools:false,
  collaborationModes:false,
  nativeQueue:false,
  nativeHistoryPagination:false,
  steering:false,
  runtimeProfileSwitching:false,
});

const RUNTIME_CAPABILITY_OVERRIDES=Object.freeze({
  codex:Object.freeze({
    fork:true,rewind:true,compaction:true,systemPromptInjection:true,dynamicTools:true,nativeSandbox:true,
    usageReporting:true,backgroundProcesses:true,delegation:true,harnessTools:true,collaborationModes:true,
    nativeQueue:true,nativeHistoryPagination:true,steering:true,runtimeProfileSwitching:true,
  }),
  claude:Object.freeze({fork:true,rewind:true,compaction:true,usageReporting:true}),
  opencode:Object.freeze({fork:true,rewind:true,compaction:true,nativeLsp:true,usageReporting:true}),
  cursor:Object.freeze({fork:"runtime",clientFilesystem:true,clientTerminal:true}),
  grok:Object.freeze({fork:"runtime",clientFilesystem:true,clientTerminal:true}),
  antigravity:Object.freeze({fork:"runtime",clientFilesystem:true,clientTerminal:true}),
});

export function sharedRuntimeCapabilities(kind){
  const runtime=String(kind||"").trim().toLowerCase();
  return {...BASE_RUNTIME_CAPABILITIES,...(RUNTIME_CAPABILITY_OVERRIDES[runtime]||{})};
}

export const runtimeCapabilityKinds=Object.freeze(Object.keys(RUNTIME_CAPABILITY_OVERRIDES));
