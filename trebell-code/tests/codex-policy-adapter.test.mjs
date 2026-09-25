import test from "node:test";
import assert from "node:assert/strict";
import { codexApprovalResponse, resolveCodexApprovalByPolicy } from "../src/codex-policy-adapter.mjs";

test("Codex policy adapter keeps supervised approvals interactive",()=>{
  const request={id:1,method:"item/commandExecution/requestApproval",params:{threadId:"t",command:"npm test"}};
  const resolved=resolveCodexApprovalByPolicy(request,{profile:"supervised",workspace:"/repo"});
  assert.equal(resolved.handled,false);assert.equal(resolved.policy.decision,"CONFIRM");
});

test("Codex policy adapter auto-resolves decisive read-only and workspace-write actions with native response shapes",()=>{
  const edit={id:1,method:"item/fileChange/requestApproval",params:{threadId:"t",path:"/repo/src/a.js"}};
  const allowed=resolveCodexApprovalByPolicy(edit,{profile:"edits",workspace:"/repo"});
  assert.equal(allowed.handled,true);assert.equal(allowed.policy.decision,"ALLOW");assert.deepEqual(allowed.result,{decision:"accept"});
  const rejected=resolveCodexApprovalByPolicy(edit,{profile:"read-only",workspace:"/repo"});
  assert.equal(rejected.policy.decision,"REJECT");assert.deepEqual(rejected.result,{decision:"decline"});
});

test("Codex permission escalation stays confirmable unless profile or provenance makes it unsafe",()=>{
  const request={id:2,method:"item/permissions/requestApproval",params:{threadId:"t",permissions:{network:{enabled:true}}}};
  assert.equal(resolveCodexApprovalByPolicy(request,{profile:"supervised",workspace:"/repo",provenance:"trusted"}).handled,false);
  const rejected=resolveCodexApprovalByPolicy({...request,params:{...request.params,provenance:"untrusted"}},{profile:"supervised",workspace:"/repo"});
  assert.equal(rejected.handled,true);assert.deepEqual(rejected.result,{permissions:{},scope:"turn"});
  assert.deepEqual(codexApprovalResponse(request,"ALLOW"),{permissions:{network:{enabled:true}},scope:"turn"});
});

test("Codex legacy approval forms use their native approved or denied payloads",()=>{
  const patch={id:3,method:"applyPatchApproval",params:{threadId:"t",path:"/repo/src/a.js"}};
  assert.deepEqual(codexApprovalResponse(patch,"ALLOW"),{decision:"approved"});
  assert.deepEqual(codexApprovalResponse(patch,"REJECT"),{decision:{denied:{rejection:"rejected by Trebell policy"}}});
});

test("Auto Guarded confirms known external network or deployment actions",()=>{
  const request={id:4,method:"item/commandExecution/requestApproval",params:{threadId:"t",command:"git push origin main",_meta:{externalSideEffect:true,riskLevel:"high",reversibility:"none"}}};
  const resolved=resolveCodexApprovalByPolicy(request,{profile:"auto",workspace:"/repo"});
  assert.equal(resolved.handled,false);assert.equal(resolved.policy.decision,"CONFIRM");
});
