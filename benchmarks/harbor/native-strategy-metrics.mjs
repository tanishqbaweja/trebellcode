export function createNativeStrategyMetrics(){
  return {
    firstEditAtMs:null,
    editCount:0,
    convergenceCheckpoints:0,
    deliverableCheckpoints:0,
    deliverableEscalations:0,
    persistentArtifactSemanticAudits:0,
    globalConstraintPlanningCheckpoints:0,
    globalConstraintCommitBlocks:0,
    globalConstraintCommitAudits:0,
    implementationPressureEvents:0,
    actionOutputCaps:0,
    actionOutputCapRelaxations:0,
    convergenceCallsBlocked:0,
    postEditProbeBatchCheckpoints:0,
    postEditProbeCallsBlocked:0,
    assumptionAuditCheckpoints:0,
    abstractionBoundaryEscalations:0,
    abstractionRepairVerificationCheckpoints:0,
    abstractionRepairVerificationEvidence:0,
    abstractionRepairVerificationGates:0,
    abstractionRepairVerified:0,
    abstractionRepairVerificationRejected:0,
    residualStructureCheckpoints:0,
    completionGateChecks:0,
    completionGateInvalidFailClosed:0,
    completionArtifactConstraintAuditBlocks:0,
    completionGateRecoveries:0,
    completionRecoveryEvidenceUses:0,
    completionRecoveryEvidenceCallsBlocked:0,
    completionRecoveryPostEditVerificationUses:0,
    completionRecoveryStrategyResets:0,
    completionRecoveryResidualFactorizations:0,
    completionRecoveryEditUses:0,
    completionRecoveryUnsupportedEditsSkipped:0,
    completionRecoveryCandidateSnapshots:0,
    completionRecoveryIncumbentRestores:0,
    completionRecoveryIncumbentRestoreFailures:0,
    completionRecoveryExhaustions:0,
    completionRecoveryTerminalRepairGraces:0,
    completionRecoveryEvidenceThenEditWindows:0,
    completionRecoveryDependentEditVerificationBlocks:0,
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
  else if(name==="native.progress.deliverable_checkpoint")target.deliverableCheckpoints=Number(target.deliverableCheckpoints||0)+1;
  else if(name==="native.progress.deliverable_escalation")target.deliverableEscalations=Number(target.deliverableEscalations||0)+1;
  else if(name==="native.progress.persistent_artifact_semantic_audit")target.persistentArtifactSemanticAudits=Number(target.persistentArtifactSemanticAudits||0)+1;
  else if(name==="native.progress.global_constraint_planning_checkpoint")target.globalConstraintPlanningCheckpoints=Number(target.globalConstraintPlanningCheckpoints||0)+1;
  else if(name==="native.progress.global_constraint_commit_blocked")target.globalConstraintCommitBlocks=Number(target.globalConstraintCommitBlocks||0)+1;
  else if(name==="native.progress.global_constraint_commit_audited")target.globalConstraintCommitAudits=Number(target.globalConstraintCommitAudits||0)+1;
  else if(name==="native.progress.implementation_pressure")target.implementationPressureEvents=Number(target.implementationPressureEvents||0)+1;
  else if(name==="native.model.action_output_cap")target.actionOutputCaps=Number(target.actionOutputCaps||0)+1;
  else if(name==="native.model.action_output_cap_relaxed")target.actionOutputCapRelaxations=Number(target.actionOutputCapRelaxations||0)+1;
  else if(name==="native.progress.convergence_call_blocked")target.convergenceCallsBlocked=Number(target.convergenceCallsBlocked||0)+1;
  else if(name==="native.progress.post_edit_probe_batch_checkpoint")target.postEditProbeBatchCheckpoints=Number(target.postEditProbeBatchCheckpoints||0)+1;
  else if(name==="native.progress.post_edit_probe_call_blocked")target.postEditProbeCallsBlocked=Number(target.postEditProbeCallsBlocked||0)+1;
  else if(name==="native.progress.assumption_audit_checkpoint")target.assumptionAuditCheckpoints=Number(target.assumptionAuditCheckpoints||0)+1;
  else if(name==="native.progress.abstraction_boundary_escalation")target.abstractionBoundaryEscalations=Number(target.abstractionBoundaryEscalations||0)+1;
  else if(name==="native.progress.abstraction_repair_verification_checkpoint")target.abstractionRepairVerificationCheckpoints=Number(target.abstractionRepairVerificationCheckpoints||0)+1;
  else if(name==="native.progress.abstraction_repair_verification_evidence")target.abstractionRepairVerificationEvidence=Number(target.abstractionRepairVerificationEvidence||0)+1;
  else if(name==="native.progress.abstraction_repair_verification_gate"){
    target.abstractionRepairVerificationGates=Number(target.abstractionRepairVerificationGates||0)+1;
    if(String(data?.verdict||"")==="verified")target.abstractionRepairVerified=Number(target.abstractionRepairVerified||0)+1;
    else target.abstractionRepairVerificationRejected=Number(target.abstractionRepairVerificationRejected||0)+1;
  }
  else if(name==="native.progress.residual_structure_checkpoint")target.residualStructureCheckpoints=Number(target.residualStructureCheckpoints||0)+1;
  else if(name==="native.completion.gate")target.completionGateChecks=Number(target.completionGateChecks||0)+1;
  else if(name==="native.completion.gate_invalid_fail_closed")target.completionGateInvalidFailClosed=Number(target.completionGateInvalidFailClosed||0)+1;
  else if(name==="native.completion.constraint_audit_blocked")target.completionArtifactConstraintAuditBlocks=Number(target.completionArtifactConstraintAuditBlocks||0)+1;
  else if(name==="native.completion.gate_recovery"){
    target.completionGateRecoveries=Number(target.completionGateRecoveries||0)+1;
    if(data?.recoveryMode==="evidence_then_edit"&&data?.recoveryModeProvided===true)target.completionRecoveryEvidenceThenEditWindows=Number(target.completionRecoveryEvidenceThenEditWindows||0)+1;
  }
  else if(name==="native.completion.recovery_allowance_used"&&data?.kind==="evidence")target.completionRecoveryEvidenceUses=Number(target.completionRecoveryEvidenceUses||0)+1;
  else if(name==="native.completion.recovery_evidence_call_blocked")target.completionRecoveryEvidenceCallsBlocked=Number(target.completionRecoveryEvidenceCallsBlocked||0)+1;
  else if(name==="native.completion.recovery_allowance_used"&&data?.kind==="post_edit_verification")target.completionRecoveryPostEditVerificationUses=Number(target.completionRecoveryPostEditVerificationUses||0)+1;
  else if(name==="native.completion.recovery_strategy_reset"){
    target.completionRecoveryStrategyResets=Number(target.completionRecoveryStrategyResets||0)+1;
    if(String(data?.strategy||"")==="residual_factorization")target.completionRecoveryResidualFactorizations=Number(target.completionRecoveryResidualFactorizations||0)+1;
  }
  else if(name==="native.completion.recovery_allowance_used"&&data?.kind==="edit")target.completionRecoveryEditUses=Number(target.completionRecoveryEditUses||0)+1;
  else if(name==="native.completion.recovery_edit_skipped"&&data?.reason==="unsupported_by_evidence")target.completionRecoveryUnsupportedEditsSkipped=Number(target.completionRecoveryUnsupportedEditsSkipped||0)+1;
  else if(name==="native.completion.recovery_candidate_snapshot")target.completionRecoveryCandidateSnapshots=Number(target.completionRecoveryCandidateSnapshots||0)+1;
  else if(name==="native.completion.recovery_incumbent_restored")target.completionRecoveryIncumbentRestores=Number(target.completionRecoveryIncumbentRestores||0)+1;
  else if(name==="native.completion.recovery_incumbent_restore_failed")target.completionRecoveryIncumbentRestoreFailures=Number(target.completionRecoveryIncumbentRestoreFailures||0)+1;
  else if(name==="native.completion.recovery_exhausted")target.completionRecoveryExhaustions=Number(target.completionRecoveryExhaustions||0)+1;
  else if(name==="native.completion.recovery_terminal_repair_grace")target.completionRecoveryTerminalRepairGraces=Number(target.completionRecoveryTerminalRepairGraces||0)+1;
  else if(name==="native.completion.recovery_edit_call_blocked"){
    target.completionRecoveryEditsBlocked=Number(target.completionRecoveryEditsBlocked||0)+1;
    if(event?.data?.reason==="recovery_dependent_edit_requires_verification")target.completionRecoveryDependentEditVerificationBlocks=Number(target.completionRecoveryDependentEditVerificationBlocks||0)+1;
  }
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
