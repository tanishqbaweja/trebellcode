import test from "node:test";
import assert from "node:assert/strict";
import { createNativeStrategyMetrics, observeNativeStrategyEvent } from "../benchmarks/harbor/native-strategy-metrics.mjs";

test("Native benchmark strategy metrics retain bounded decision signals without trajectory content",()=>{
  const metrics=createNativeStrategyMetrics();
  observeNativeStrategyEvent(metrics,{name:"native.progress.implementation_pressure",status:"running",data:{}},25);
  observeNativeStrategyEvent(metrics,{name:"native.tool.completed",status:"completed",data:{namespace:"trebell_workspace",name:"write_file",content:"must not be retained"}},100);
  observeNativeStrategyEvent(metrics,{name:"native.tool.completed",status:"completed",data:{namespace:"trebell_workspace",name:"replace_text"}},150);
  observeNativeStrategyEvent(metrics,{name:"native.progress.convergence_checkpoint",status:"completed",data:{}},200);
  observeNativeStrategyEvent(metrics,{name:"native.progress.convergence_call_blocked",status:"blocked",data:{}},220);
  observeNativeStrategyEvent(metrics,{name:"native.progress.post_edit_probe_batch_checkpoint",status:"completed",data:{}},230);
  observeNativeStrategyEvent(metrics,{name:"native.progress.post_edit_probe_call_blocked",status:"blocked",data:{}},235);
  observeNativeStrategyEvent(metrics,{name:"native.progress.assumption_audit_checkpoint",status:"completed",data:{}},235);
  observeNativeStrategyEvent(metrics,{name:"native.progress.post_edit_evidence_checkpoint",status:"completed",data:{}},236);
  observeNativeStrategyEvent(metrics,{name:"native.progress.post_edit_evidence_escalation",status:"completed",data:{}},237);
  observeNativeStrategyEvent(metrics,{name:"native.progress.post_edit_evidence_call_blocked",status:"blocked",data:{}},238);
  observeNativeStrategyEvent(metrics,{name:"native.progress.revision_churn_escalation",status:"completed",data:{}},239);
  observeNativeStrategyEvent(metrics,{name:"native.progress.revision_churn_edit_blocked",status:"blocked",data:{}},239);
  observeNativeStrategyEvent(metrics,{name:"native.verification.self_admitted_gap",status:"retrying",data:{}},240);
  observeNativeStrategyEvent(metrics,{name:"native.completion.self_admitted_gap",status:"retrying",data:{}},260);
  assert.deepEqual(metrics,{firstEditAtMs:100,editCount:2,convergenceCheckpoints:1,implementationPressureEvents:1,convergenceCallsBlocked:1,postEditProbeBatchCheckpoints:1,postEditProbeCallsBlocked:1,assumptionAuditCheckpoints:1,postEditEvidenceCheckpoints:1,postEditEvidenceEscalations:1,postEditEvidenceCallsBlocked:1,revisionChurnEscalations:1,revisionChurnEditsBlocked:1,selfAdmittedVerificationGaps:1,selfAdmittedCompletionGaps:1});
  assert.doesNotMatch(JSON.stringify(metrics),/must not be retained/);
});
