export function createNativeStrategyMetrics(){
  return {
    firstEditAtMs:null,
    editCount:0,
    convergenceCheckpoints:0,
    implementationPressureEvents:0,
    convergenceCallsBlocked:0,
    postEditProbeBatchCheckpoints:0,
    postEditProbeCallsBlocked:0,
    assumptionAuditCheckpoints:0,
    abstractionBoundaryEscalations:0,
    residualStructureCheckpoints:0,
    completionGateChecks:0,
    completionGateRecoveries:0,
    completionRecoveryEvidenceUses:0,
    completionRecoveryEvidenceCallsBlocked:0,
    completionRecoveryEditUses:0,
    completionRecoveryExhaustions:0,
    completionRecoveryEditsBlocked:0,
    completionRecoveryNonEditCallsBlocked:0,
    postEditEvidenceCheckpoints:0,
    postEditEvidenceEscalations:0,
    postEditEvidenceCallsBlocked:0,
    revisionChurnEscalations:0,
    revisionChurnEditsBlocked:0,
    selfAdmittedVerificationGaps:0,
    selfAdmittedCompletionGaps:0,
  };
}

export function observeNativeStrategyEvent(metrics,event,atMs=null){
  const target=metrics&&typeof metrics==="object"?metrics:createNativeStrategyMetrics(),name=String(event?.name||""),data=event?.data||{};
  if(name==="native.tool.completed"&&event?.status==="completed"&&data?.namespace==="trebell_workspace"&&["write_file","replace_text"].includes(data?.name)){
    target.editCount=Number(target.editCount||0)+1;
    if(target.firstEditAtMs==null&&Number.isFinite(Number(atMs)))target.firstEditAtMs=Math.max(0,Math.round(Number(atMs)));
  }else if(name==="native.progress.convergence_checkpoint")target.convergenceCheckpoints=Number(target.convergenceCheckpoints||0)+1;
  else if(name==="native.progress.implementation_pressure")target.implementationPressureEvents=Number(target.implementationPressureEvents||0)+1;
  else if(name==="native.progress.convergence_call_blocked")target.convergenceCallsBlocked=Number(target.convergenceCallsBlocked||0)+1;
  else if(name==="native.progress.post_edit_probe_batch_checkpoint")target.postEditProbeBatchCheckpoints=Number(target.postEditProbeBatchCheckpoints||0)+1;
  else if(name==="native.progress.post_edit_probe_call_blocked")target.postEditProbeCallsBlocked=Number(target.postEditProbeCallsBlocked||0)+1;
  else if(name==="native.progress.assumption_audit_checkpoint")target.assumptionAuditCheckpoints=Number(target.assumptionAuditCheckpoints||0)+1;
  else if(name==="native.progress.abstraction_boundary_escalation")target.abstractionBoundaryEscalations=Number(target.abstractionBoundaryEscalations||0)+1;
  else if(name==="native.progress.residual_structure_checkpoint")target.residualStructureCheckpoints=Number(target.residualStructureCheckpoints||0)+1;
  else if(name==="native.completion.gate")target.completionGateChecks=Number(target.completionGateChecks||0)+1;
  else if(name==="native.completion.gate_recovery")target.completionGateRecoveries=Number(target.completionGateRecoveries||0)+1;
  else if(name==="native.completion.recovery_allowance_used"&&data?.kind==="evidence")target.completionRecoveryEvidenceUses=Number(target.completionRecoveryEvidenceUses||0)+1;
  else if(name==="native.completion.recovery_evidence_call_blocked")target.completionRecoveryEvidenceCallsBlocked=Number(target.completionRecoveryEvidenceCallsBlocked||0)+1;
  else if(name==="native.completion.recovery_allowance_used"&&data?.kind==="edit")target.completionRecoveryEditUses=Number(target.completionRecoveryEditUses||0)+1;
  else if(name==="native.completion.recovery_exhausted")target.completionRecoveryExhaustions=Number(target.completionRecoveryExhaustions||0)+1;
  else if(name==="native.completion.recovery_edit_call_blocked")target.completionRecoveryEditsBlocked=Number(target.completionRecoveryEditsBlocked||0)+1;
  else if(name==="native.completion.recovery_non_edit_call_blocked")target.completionRecoveryNonEditCallsBlocked=Number(target.completionRecoveryNonEditCallsBlocked||0)+1;
  else if(name==="native.progress.post_edit_evidence_checkpoint")target.postEditEvidenceCheckpoints=Number(target.postEditEvidenceCheckpoints||0)+1;
  else if(name==="native.progress.post_edit_evidence_escalation")target.postEditEvidenceEscalations=Number(target.postEditEvidenceEscalations||0)+1;
  else if(name==="native.progress.post_edit_evidence_call_blocked")target.postEditEvidenceCallsBlocked=Number(target.postEditEvidenceCallsBlocked||0)+1;
  else if(name==="native.progress.revision_churn_escalation")target.revisionChurnEscalations=Number(target.revisionChurnEscalations||0)+1;
  else if(name==="native.progress.revision_churn_edit_blocked")target.revisionChurnEditsBlocked=Number(target.revisionChurnEditsBlocked||0)+1;
  else if(name==="native.verification.self_admitted_gap")target.selfAdmittedVerificationGaps=Number(target.selfAdmittedVerificationGaps||0)+1;
  else if(name==="native.completion.self_admitted_gap")target.selfAdmittedCompletionGaps=Number(target.selfAdmittedCompletionGaps||0)+1;
  return target;
}
