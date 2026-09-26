import test from "node:test";
import assert from "node:assert/strict";
import { approvalResponse } from "../ui/src/approval-utils.js";

test("modern approvals use v2 decisions",()=>{
  assert.deepEqual(approvalResponse({method:"item/commandExecution/requestApproval",params:{}},"acceptForSession"),{decision:"acceptForSession"});
  assert.deepEqual(approvalResponse({method:"item/fileChange/requestApproval",params:{}},"decline"),{decision:"decline"});
});

test("legacy Codex approvals map to ReviewDecision values",()=>{
  assert.deepEqual(approvalResponse({method:"applyPatchApproval",params:{}},"accept"),{decision:"approved"});
  assert.deepEqual(approvalResponse({method:"execCommandApproval",params:{}},"acceptForSession"),{decision:"approved_for_session"});
  assert.deepEqual(approvalResponse({method:"execCommandApproval",params:{}},"decline"),{decision:{denied:{rejection:"rejected by user"}}});
});

test("permission requests grant only requested access and deny with an empty profile",()=>{
  const permissions={network:{enabled:true},fileSystem:null};const request={method:"item/permissions/requestApproval",params:{permissions}};
  assert.deepEqual(approvalResponse(request,"accept"),{permissions,scope:"turn"});
  assert.deepEqual(approvalResponse(request,"acceptForSession"),{permissions,scope:"session"});
  assert.deepEqual(approvalResponse(request,"decline"),{permissions:{},scope:"turn"});
});
