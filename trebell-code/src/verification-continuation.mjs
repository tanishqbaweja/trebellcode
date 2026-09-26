import { nextVerificationAction } from "./verification-loop.mjs";

export const MAX_AUTOMATIC_VERIFICATION_CONTINUATIONS=5;

function array(value){return Array.isArray(value)?value:[]}
function text(value,max=1200){return String(value??"").trim().slice(0,max)}
function scalar(value){return value==null?null:(typeof value==="string"?text(value,800):typeof value==="number"||typeof value==="boolean"?value:null)}

function evidenceSummary(entry={}){
  const summary={stepId:text(entry.stepId||entry.id,200)||null};
  for(const key of ["status","exitCode","errorCount","errors","reason","passed","screenshots","viewports"]){const value=scalar(entry[key]);if(value!=null)summary[key]=value}
  return summary;
}

export function verificationContinuationState(records=[],recordId=null){
  const list=array(records),id=recordId?String(recordId):null,record=(id?list.find(item=>String(item?.id||"")===id):list[0])||null;
  if(!record)throw new Error("No persisted verification record is available for this thread.");
  return {record,nextAction:nextVerificationAction({plan:record.plan,evidence:record.evidence})};
}

export function verificationContinuationContext({record,nextAction}={}){
  if(!record||nextAction?.action!=="verify"||!nextAction.nextStep)return "";
  const step=nextAction.nextStep,payload={
    recordId:String(record.id||""),risk:record.assessment?.risk||record.plan?.risk||"unknown",
    nextStep:{id:text(step.id,200),kind:text(step.kind,120),scope:text(step.scope,300),cost:text(step.cost,80),required:step.required!==false,reason:text(step.reason,1000),command:text(step.command,1800)||null,targets:array(step.targets).map(item=>text(item,500)).filter(Boolean).slice(0,40),evidence:array(step.evidence).map(item=>text(item,300)).filter(Boolean).slice(0,20)},
    remainingSteps:array(nextAction.remainingSteps).map(item=>text(item,200)).filter(Boolean).slice(0,50),
    existingEvidence:array(record.evidence).map(evidenceSummary).slice(0,80),
  };
  return [
    "Trebell verification continuation",
    "Run only the next required verification step shown below. Use normal Trebell tools and permission policy. Do not claim the check passed unless the tool actually ran and produced evidence. Do not broaden scope or edit code merely to make verification easier.",
    JSON.stringify(payload,null,2).slice(0,12_000),
  ].join("\n\n");
}

export function verificationContinuationPrompt(){return "Continue verification for this task. Run the single next required verification step from the attached Trebell verification context, record real tool evidence, and stop after that step. If it fails, report the failure without repairing it in this turn; Trebell will route the same thread into repair."}

export function verificationContinuationAttempt(previous,record,{automatic=false,limit=MAX_AUTOMATIC_VERIFICATION_CONTINUATIONS}={}){
  if(!record?.id)throw new Error("A persisted verification record is required before continuing verification.");
  const prior=previous&&typeof previous==="object"?previous:{},continued=Boolean(prior.lastContinuationTurnId&&String(record.turnId||"")===String(prior.lastContinuationTurnId));
  const attempts=continued?Math.max(0,Number(prior.attempts)||0)+1:1,cap=Math.max(1,Math.trunc(Number(limit)||MAX_AUTOMATIC_VERIFICATION_CONTINUATIONS));
  return {allowed:!automatic||attempts<=cap,automatic:Boolean(automatic),attempts,limit:cap,rootRecordId:continued?(prior.rootRecordId||prior.sourceRecordId||String(record.id)):String(record.id),sourceRecordId:String(record.id)};
}

export function verificationContinuationChainState(attempt,turnId){return {rootRecordId:attempt.rootRecordId,sourceRecordId:attempt.sourceRecordId,lastContinuationTurnId:String(turnId||""),attempts:attempt.attempts,lastAutomatic:Boolean(attempt.automatic),updatedAt:Date.now()}}
