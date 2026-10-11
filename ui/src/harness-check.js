// Whether the selected harness is ready, as Settings shows it (the Diagnostics chip and the Agents & models runtime card).
// The runtime poll's answer comes first. The harness list probes the same harness and these sections load it themselves, so
// its status stands in while the poll has not answered, or keeps failing (App drops a failed poll without a trace): a
// failing poll can no longer leave the state "checking" for good. With neither answer, it is "pending" while the list
// is still loading and "unknown" (with the list's error, if any) once it has stopped.
export function harnessCheck({runtime,status,listLoaded=false,listLoading=false,listError=""}={}){
  if(runtime&&Object.prototype.hasOwnProperty.call(runtime,"agentRuntimeStatus"))return {state:runtime.agentRuntimeStatus?.available?"ok":"warn",error:""};
  // A list whose last refresh failed is only the last known one, so it does not stand in for a current answer.
  if(status&&!listError)return {state:status.available?"ok":"warn",error:""};
  if(!listLoaded||listLoading)return {state:"pending",error:""};
  return {state:"unknown",error:String(listError||"")};
}

const HARNESS_STATE_TEXT={ok:"ready",warn:"not ready",pending:"checking…",unknown:"unknown"};
export function harnessStateText(check){return HARNESS_STATE_TEXT[check?.state]||"unknown"}
// The chip's tooltip: why it is neutral, or nothing once it shows a real answer.
export function harnessStateTitle(check){
  if(check?.state==="pending")return "Checking the harness";
  if(check?.state==="unknown")return check.error?"Could not check the harness: "+check.error:"The harness has not reported its status";
  return undefined;
}
