import { nextVerificationAction } from "./verification-loop.mjs";

export const MAX_AUTOMATIC_VERIFICATION_REPAIRS=3;

function array(value){return Array.isArray(value)?value:[]}
function text(value,max=1200){return String(value??"").trim().slice(0,max)}
function scalar(value){return value==null?null:(typeof value==="string"?text(value,800):typeof value==="number"||typeof value==="boolean"?value:null)}

function evidenceSummary(entry={}){
  const summary={stepId:text(entry.stepId||entry.id,200)||null};
  for(const key of ["status","exitCode","errorCount","errors","reason","passed","screenshots","viewports"]){
    const value=scalar(entry[key]);if(value!=null)summary[key]=value;
  }
  const consoleErrors=array(entry.consoleErrors).slice(0,10).map(item=>text(typeof item==="string"?item:item?.message||item?.text||item?.error,600)).filter(Boolean);
  const networkFailures=array(entry.networkFailures??entry.networkErrors).slice(0,10).map(item=>text(typeof item==="string"?item:item?.url||item?.message||item?.error,600)).filter(Boolean);
  if(consoleErrors.length)summary.consoleErrors=consoleErrors;
  if(networkFailures.length)summary.networkFailures=networkFailures;
  return summary;
}

export function verificationRepairState(records=[],recordId=null){
  const list=array(records),id=recordId?String(recordId):null;
  const record=(id?list.find(item=>String(item?.id||"")===id):list[0])||null;
  if(!record)throw new Error("No persisted verification record is available for this thread.");
  const nextAction=nextVerificationAction({plan:record.plan,evidence:record.evidence});
  return {record,nextAction};
}

export function verificationRepairContext({record,nextAction}={}){
  if(!record||nextAction?.action!=="repair")return "";
  const failedIds=new Set(array(nextAction.failedSteps).map(String));
  const steps=array(record.plan?.steps).filter(step=>failedIds.has(String(step?.id||""))).map(step=>({
    id:text(step.id,200),kind:text(step.kind,120),scope:text(step.scope,300),reason:text(step.reason,800),required:step.required!==false,
  }));
  const evidence=array(record.evidence).filter(entry=>failedIds.has(String(entry?.stepId||entry?.id||""))).map(evidenceSummary);
  const failures=array(nextAction.assessment?.failures).map(item=>({id:text(item.id,200),reason:text(item.reason,1000)}));
  const payload={recordId:String(record.id||""),risk:record.assessment?.risk||record.plan?.risk||"unknown",failedSteps:steps,failures,evidence};
  return [
    "Trebell verification repair evidence",
    "Required verification failed. Repair the same work in this thread before spending more verification effort. Treat this as Trebell-provided application context; do not broaden scope beyond the failed verification unless required for the fix.",
    JSON.stringify(payload,null,2).slice(0,12_000),
  ].join("\n\n");
}

export function verificationRepairPrompt(){
  return "Repair the failed verification for this task. Use the Trebell verification evidence attached to this turn, make only the changes needed to address the failed checks, then rerun the relevant verification.";
}

export function verificationRepairAttempt(previous,record,{automatic=false,limit=MAX_AUTOMATIC_VERIFICATION_REPAIRS}={}){
  if(!record?.id)throw new Error("A persisted verification record is required before starting repair.");
  const prior=previous&&typeof previous==="object"?previous:{},continuation=Boolean(prior.lastRepairTurnId&&String(record.turnId||"")===String(prior.lastRepairTurnId));
  const attempts=continuation?Math.max(0,Number(prior.attempts)||0)+1:1,cap=Math.max(1,Math.trunc(Number(limit)||MAX_AUTOMATIC_VERIFICATION_REPAIRS));
  return {
    allowed:!automatic||attempts<=cap,automatic:Boolean(automatic),attempts,limit:cap,
    rootRecordId:continuation?(prior.rootRecordId||prior.sourceRecordId||String(record.id)):String(record.id),sourceRecordId:String(record.id),
  };
}

export function verificationRepairChainState(attempt,turnId){
  return {rootRecordId:attempt.rootRecordId,sourceRecordId:attempt.sourceRecordId,lastRepairTurnId:String(turnId||""),attempts:attempt.attempts,lastAutomatic:Boolean(attempt.automatic),updatedAt:Date.now()};
}
