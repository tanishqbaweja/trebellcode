export function contextCompactionSignal(update={}){
  const acpStatus=String(update?.status||"").trim().toLowerCase();
  if(update?.compactionId){
    if(acpStatus==="in_progress"||acpStatus==="running")return {phase:"running",title:"Compacting context"};
    if(acpStatus==="completed"||acpStatus==="complete")return {phase:"done",title:"Context compacted"};
    if(acpStatus==="failed")return {phase:"error",title:"Context compaction failed",detail:update?.error||null};
  }
  const status=String(update?.status||"").trim().toLowerCase();
  const result=String(update?.compactResult??update?.compact_result??"").trim().toLowerCase();
  if(status==="compacting")return {phase:"running",title:"Compacting context"};
  if(result==="success")return {phase:"done",title:"Context compacted"};
  if(result==="failed")return {phase:"error",title:"Context compaction failed",detail:update?.compactError||update?.compact_error||null};
  return null;
}
