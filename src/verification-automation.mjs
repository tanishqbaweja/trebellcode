export const MAX_AUTOMATIC_VERIFICATION_ACTIONS=6;

export function verificationAutomationAttempt(previous,record,{automatic=false,action="verify",limit=MAX_AUTOMATIC_VERIFICATION_ACTIONS}={}){
  if(!record?.id)throw new Error("A persisted verification record is required before continuing verification automation.");
  const prior=previous&&typeof previous==="object"?previous:{},continued=Boolean(prior.lastAutomaticTurnId&&String(record.turnId||"")===String(prior.lastAutomaticTurnId));
  const attempts=continued?Math.max(0,Number(prior.attempts)||0)+1:1,cap=Math.max(1,Math.trunc(Number(limit)||MAX_AUTOMATIC_VERIFICATION_ACTIONS));
  return {allowed:!automatic||attempts<=cap,automatic:Boolean(automatic),action:String(action||"verify"),attempts,limit:cap,rootRecordId:continued?(prior.rootRecordId||String(record.id)):String(record.id),sourceRecordId:String(record.id)};
}

export function verificationAutomationChainState(attempt,turnId){
  return {rootRecordId:attempt.rootRecordId,sourceRecordId:attempt.sourceRecordId,lastAutomaticTurnId:String(turnId||""),lastAction:attempt.action,attempts:attempt.attempts,updatedAt:Date.now()};
}
