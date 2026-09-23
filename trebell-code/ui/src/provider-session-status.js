export function contextCompactionSignal(update={}){
  const status=String(update?.status||"").trim().toLowerCase();
  const result=String(update?.compactResult??update?.compact_result??"").trim().toLowerCase();
  if(status==="compacting")return {phase:"running",title:"Compacting context"};
  if(result==="success")return {phase:"done",title:"Context compacted"};
  if(result==="failed")return {phase:"error",title:"Context compaction failed",detail:update?.compactError||update?.compact_error||null};
  return null;
}
