function array(value){return Array.isArray(value)?value:[]}
function number(value){const parsed=Number(value);return Number.isFinite(parsed)?parsed:null}
function explicitStatus(value){
  const status=String(value||"").trim().toLowerCase();
  if(["pass","passed","success","successful","ok","verified"].includes(status))return "passed";
  if(["fail","failed","failure","error"].includes(status))return "failed";
  if(["blocked","cancelled","canceled","unavailable"].includes(status))return "blocked";
  if(["skip","skipped","not-run","not_run","pending","running"].includes(status))return "incomplete";
  return null;
}

function evidenceTypes(entry){
  const types=new Set(array(entry?.evidence).map(String));
  for(const artifact of array(entry?.artifacts)){
    const type=typeof artifact==="string"?artifact:artifact?.type;if(type)types.add(String(type));
  }
  if(number(entry?.screenshots)>0)types.add("screenshot");
  if(number(entry?.viewports)>0)types.add("responsive-viewport");
  return types;
}

function assessEntry(step,entry){
  if(!entry)return {status:"incomplete",reason:"No evidence was recorded for this required step."};
  const explicit=explicitStatus(entry.status);
  if(explicit==="blocked")return {status:"blocked",reason:entry.reason||"Verification step was blocked."};
  const exitCode=number(entry.exitCode);
  if(["command","tests"].includes(step.kind)&&exitCode!==null)return exitCode===0?{status:"passed",reason:"Command exited successfully."}:{status:"failed",reason:`Command exited with code ${exitCode}.`};
  if(step.kind==="diagnostics"){
    const errors=number(entry.errorCount??entry.errors);if(errors!==null)return errors===0?{status:"passed",reason:"Diagnostics reported no errors."}:{status:"failed",reason:`Diagnostics reported ${errors} error${errors===1?"":"s"}.`};
  }
  if(step.kind==="browser-runtime"){
    const consoleErrors=array(entry.consoleErrors),networkFailures=array(entry.networkFailures??entry.networkErrors),hasObservations=Array.isArray(entry.consoleErrors)||Array.isArray(entry.networkFailures)||Array.isArray(entry.networkErrors);
    if(hasObservations){const count=consoleErrors.length+networkFailures.length;return count===0?{status:"passed",reason:"Browser console and network checks were clean."}:{status:"failed",reason:`Browser runtime recorded ${count} console/network failure${count===1?"":"s"}.`}}
  }
  if(step.kind==="visual"){
    const types=evidenceTypes(entry),required=array(step.evidence),missing=required.filter(type=>!types.has(type));
    if(missing.length)return {status:"incomplete",reason:`Missing visual evidence: ${missing.join(", ")}.`};
    if(required.length)return explicit==="failed"?{status:"failed",reason:entry.reason||"Visual verification failed."}:{status:"passed",reason:"Required visual evidence was recorded."};
  }
  if(step.kind==="browser"){
    if(typeof entry.passed==="boolean")return entry.passed?{status:"passed",reason:"Browser interaction completed successfully."}:{status:"failed",reason:entry.reason||"Browser interaction failed."};
  }
  if(explicit)return {status:explicit,reason:entry.reason||`Step reported ${explicit}.`};
  return {status:"incomplete",reason:"Evidence exists but does not contain a deterministic pass/fail signal."};
}

export function assessVerification({plan,evidence=[]}={}){
  const steps=array(plan?.steps),records=array(evidence),byStep=new Map();
  for(const record of records){const id=String(record?.stepId||record?.id||"").trim();if(id&&!byStep.has(id))byStep.set(id,record)}
  const results=steps.map(step=>{
    const assessment=assessEntry(step,byStep.get(step.id));
    return {id:step.id,kind:step.kind,required:step.required!==false,status:assessment.status,reason:assessment.reason,evidence:byStep.get(step.id)||null};
  });
  const required=results.filter(item=>item.required),failed=required.filter(item=>item.status==="failed"),blocked=required.filter(item=>item.status==="blocked"),missing=required.filter(item=>item.status==="incomplete"),passed=required.filter(item=>item.status==="passed");
  const status=failed.length?"failed":blocked.length?"blocked":missing.length?"incomplete":"verified";
  return {
    status,
    verified:status==="verified",
    repairNeeded:failed.length>0,
    risk:plan?.risk||"unknown",
    independentReviewRecommended:Boolean(plan?.independentReview),
    summary:{required:required.length,passed:passed.length,failed:failed.length,blocked:blocked.length,missing:missing.length},
    failures:failed.map(item=>({id:item.id,reason:item.reason})),
    blocked:blocked.map(item=>({id:item.id,reason:item.reason})),
    missing:missing.map(item=>({id:item.id,reason:item.reason})),
    results,
  };
}
