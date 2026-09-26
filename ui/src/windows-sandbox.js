export const WINDOWS_SANDBOX_STATUSES={
  ready:{label:"Ready",detail:"The native Codex Windows sandbox is configured."},
  notConfigured:{label:"Not configured",detail:"Codex sandbox setup has not been completed on this Windows account."},
  updateRequired:{label:"Update required",detail:"Codex reports that the Windows sandbox setup needs to be refreshed."},
};

export function windowsSandboxStatus(value){
  const key=String(value||"");
  return {key,...(WINDOWS_SANDBOX_STATUSES[key]||{label:key||"Unavailable",detail:"Codex did not return a recognized Windows sandbox readiness state."})};
}

export function allowedWindowsSetupModes(requirements){
  const configured=requirements?.allowedWindowsSandboxImplementations;
  if(!Array.isArray(configured)||!configured.length)return ["unelevated","elevated"];
  const allowed=new Set(configured.map(value=>String(value||"").toLowerCase()));
  return ["unelevated","elevated"].filter(mode=>allowed.has(mode));
}

export function worldWritableWarningText(params={}){
  const paths=(params.samplePaths||[]).filter(Boolean);const extra=Math.max(0,Number(params.extraCount)||0);
  if(params.failedScan)return "Codex could not fully scan for world-writable Windows paths, so sandbox protection could not be verified for every location.";
  if(!paths.length&&!extra)return "";
  const listed=paths.slice(0,3).join(", ");
  return `Windows paths writable by everyone cannot be protected by the Codex sandbox${listed?`: ${listed}`:""}${extra?` (+${extra} more)`:""}.`;
}
