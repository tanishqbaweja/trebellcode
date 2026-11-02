import { collectVerificationEvidence } from "./verification-evidence-collector.mjs";
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
    // A behavioral step has no command of its own: the check turn's last command is read as its check (collectVerificationEvidence).
    ...(step.kind==="behavioral"?["This step has no command of its own, so Trebell keeps the last command you run in this turn as its check: exit code 0 passes it and any other exit code fails it. Run that check last."]:[]),
    JSON.stringify(payload,null,2).slice(0,12_000),
  ].join("\n\n");
}

export function verificationContinuationPrompt(){return "Continue verification for this task. Run the single next required verification step from the attached Trebell verification context, record real tool evidence, and stop after that step. If it fails, report the failure without repairing it in this turn; Trebell will route the same thread into repair."}

// stepId: the step this check turn is to run. An automatic check follows the chain's last one only while checking can go on: never
// after a check the person did not allow (the chain's stopped, set once that check turn was read), and never for a step the chain
// has already had a check turn for (each check turn's reading is a new record, so the step, not the record, says it was tried),
// which bounds the chain by the plan's steps. A check the person asks for (automatic false) always starts.
export function verificationContinuationAttempt(previous,record,{automatic=false,limit=MAX_AUTOMATIC_VERIFICATION_CONTINUATIONS,stepId=null}={}){
  if(!record?.id)throw new Error("A persisted verification record is required before continuing verification.");
  const prior=previous&&typeof previous==="object"?previous:{},continued=Boolean(prior.lastContinuationTurnId&&String(record.turnId||"")===String(prior.lastContinuationTurnId));
  const attempts=continued?Math.max(0,Number(prior.attempts)||0)+1:1,cap=Math.max(1,Math.trunc(Number(limit)||MAX_AUTOMATIC_VERIFICATION_CONTINUATIONS));
  const step=text(stepId,200),tried=continued?array(prior.stepIds).map(String):[],stopped=automatic&&continued?(prior.stopped?"not-approved":step&&tried.includes(step)?"repeated":null):null;
  return {allowed:!automatic||(attempts<=cap&&!stopped),automatic:Boolean(automatic),attempts,limit:cap,stopped,stepIds:[...new Set([...tried,...(step?[step]:[])])],rootRecordId:continued?(prior.rootRecordId||prior.sourceRecordId||String(record.id)):String(record.id),sourceRecordId:String(record.id)};
}

// Why an automatic check was refused, in the words its row shows.
export function verificationContinuationRefusal(attempt){
  return attempt.stopped==="not-approved"?"The last check was not allowed to run."
    :attempt.stopped==="repeated"?"That check already had a turn of its own."
    :`Automatic verification continuation stopped after ${attempt.limit} attempts. Review the remaining verification state before continuing.`;
}

export function verificationContinuationChainState(attempt,turnId){return {rootRecordId:attempt.rootRecordId,sourceRecordId:attempt.sourceRecordId,lastContinuationTurnId:String(turnId||""),attempts:attempt.attempts,stepIds:array(attempt.stepIds),lastAutomatic:Boolean(attempt.automatic),updatedAt:Date.now()}}

function notApproved(output){return Boolean(output&&typeof output==="object"&&output.success===false&&String(output.decision||"").toUpperCase()==="CONFIRM")}
function parsed(value){try{return JSON.parse(String(value||""))}catch{return null}}
// A check turn whose check the person did not allow: asked, and denied or never answered before the ask expired. Checking cannot go
// on without them, so no automatic check follows it. Native's call says so in its output (the policy's CONFIRM with no run), Codex's in
// a declined item, an ACP harness's in its permission's resolution.
export function verificationCheckNotApproved({turnItems=[],traces=[]}={}){
  for(const item of array(turnItems)){
    if(String(item?.status||"").toLowerCase()==="declined")return true;
    if(["dynamicToolCall","mcpToolCall"].includes(item?.type)&&(notApproved(item.rawOutput)||array(item.contentItems).some(part=>notApproved(parsed(part?.text)))))return true;
  }
  return array(traces).some(trace=>trace?.name==="permission.resolved"?/^(?:decline|cancel|reject|deny|error)/i.test(String(trace.status||"")):trace?.name==="item/completed"&&String(trace?.data?.item?.status||"").toLowerCase()==="declined");
}

// The server's reading of a check turn (plan-turn), started from the record whose plan and evidence it is given: the evidence the turn
// observed, and stopped when its check was not allowed. The step it ran is that record's next step (as thread/verification/continue
// chose it); a check that was allowed and ran is read for that step too, so a behavioral step's check is kept. A check that was not
// allowed is read for nothing of its own: an earlier command of the turn is not its check.
export function verificationCheckTurnReading({plan,evidence=[],turnItems=[],traces=[]}={}){
  const stopped=verificationCheckNotApproved({turnItems,traces})?"not-approved":null,step=stopped?null:nextVerificationAction({plan,evidence}).nextStep;
  return {stopped,observed:collectVerificationEvidence({plan,turnItems,traces,checkedStepId:step?.id||null})};
}
