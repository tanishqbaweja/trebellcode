function array(value){return Array.isArray(value)?value:[]}
function text(value,max=800){return String(value??"").trim().slice(0,max)}
function number(value){const parsed=Number(value);return Number.isFinite(parsed)?parsed:null}
function status(value,{record=false}={}){const normalized=String(value||"").trim().toLowerCase();if(record&&normalized==="verified")return "verified";if(normalized==="verified")return "passed";return ["passed","failed","blocked","incomplete"].includes(normalized)?normalized:"incomplete"}

export function verificationEvidenceView(result={}){
  const record=result?.record&&typeof result.record==="object"?result.record:null;if(!record)return null;
  const evidenceById=new Map();for(const entry of array(record.evidence)){const id=text(entry?.stepId||entry?.id,200);if(id&&!evidenceById.has(id))evidenceById.set(id,entry)}
  const assessmentById=new Map();for(const entry of array(record.assessment?.results)){const id=text(entry?.id,200);if(id&&!assessmentById.has(id))assessmentById.set(id,entry)}
  const rows=array(record.plan?.steps).map(step=>{
    const id=text(step?.id,200),evidence=evidenceById.get(id)||{},assessment=assessmentById.get(id)||{},coveredPaths=array(evidence.coveredPaths).map(path=>text(path,500)).filter(Boolean),engines=array(evidence.engines).map(engine=>text(engine,120)).filter(Boolean);
    const exitCode=number(evidence.exitCode),errorCount=number(evidence.errorCount??evidence.errors);
    return {
      id,kind:text(step?.kind,120)||"check",scope:text(step?.scope,300)||null,required:step?.required!==false,status:status(assessment.status||evidence.status),
      source:text(evidence.source,160)||null,reason:text(step?.reason,1000)||null,
      exitCode,errorCount,coveredPathCount:coveredPaths.length,engines:engines.slice(0,6),semantic:Boolean(evidence.semantic),
    };
  }).filter(row=>row.id);
  const requiredRows=rows.filter(row=>row.required),passed=requiredRows.filter(row=>row.status==="passed").length,failed=requiredRows.filter(row=>row.status==="failed").length,blocked=requiredRows.filter(row=>row.status==="blocked").length,missing=requiredRows.filter(row=>row.status==="incomplete").length;
  const nextAction=text(result?.nextAction?.action,80)||null,nextStepId=text(result?.nextAction?.nextStep?.id,200)||null;
  return {
    recordId:text(record.id,300)||null,status:status(record.status||record.assessment?.status,{record:true}),risk:text(record.risk||record.assessment?.risk||record.plan?.risk,120)||"unknown",
    required:requiredRows.length,passed,failed,blocked,missing,rows,nextAction,nextStepId,updatedAt:Number(record.updatedAt)||null,
  };
}

export function verificationEvidenceSummary(view){
  if(!view)return "No verification evidence recorded";
  const base=`${view.passed}/${view.required} required check${view.required===1?"":"s"} passed`;
  if(view.failed)return `${base} · ${view.failed} failed`;
  if(view.blocked)return `${base} · ${view.blocked} blocked`;
  if(view.missing)return `${base} · ${view.missing} still required`;
  return `${base} · verified`;
}

export function verificationEvidenceMeta(row={}){
  const parts=[];if(row.source)parts.push(row.source);if(row.exitCode!=null)parts.push(`exit ${row.exitCode}`);if(row.errorCount!=null)parts.push(`${row.errorCount} error${row.errorCount===1?"":"s"}`);if(row.coveredPathCount)parts.push(`${row.coveredPathCount} path${row.coveredPathCount===1?"":"s"}`);if(row.engines?.length)parts.push(row.engines.join(", "));return parts.join(" · ");
}
