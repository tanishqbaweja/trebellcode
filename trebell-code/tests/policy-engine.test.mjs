import test from "node:test";
import assert from "node:assert/strict";
import { classifyPolicyAction, evaluatePolicy, POLICY_ALLOW, POLICY_CONFIRM, POLICY_REJECT, policyPathInside } from "../src/policy-engine.mjs";

test("policy engine normalizes high-level permission profiles into allow confirm reject",()=>{
  assert.equal(evaluatePolicy({profile:"full",kind:"execute"}).decision,POLICY_ALLOW);
  assert.equal(evaluatePolicy({profile:"supervised",kind:"edit"}).decision,POLICY_CONFIRM);
  assert.equal(evaluatePolicy({profile:"read-only",kind:"edit"}).decision,POLICY_REJECT);
  assert.equal(evaluatePolicy({profile:"workspace-write",kind:"edit",workspace:"/repo",requestedPath:"/repo/src/a.js"}).decision,POLICY_ALLOW);
});

test("policy engine keeps hard workspace and permission boundaries above user allow rules",()=>{
  const outside=evaluatePolicy({profile:"workspace-write",kind:"edit",workspace:"/repo",requestedPath:"/other/a.js",rules:[{effect:"ALLOW",kind:"edit"}]});
  assert.equal(outside.decision,POLICY_REJECT);assert.match(outside.reason,/outside the active workspace/i);
  const relative=evaluatePolicy({profile:"workspace-write",kind:"edit",workspace:"/repo",requestedPath:"src/a.js"});
  assert.equal(relative.decision,POLICY_ALLOW);
  const traversal=evaluatePolicy({profile:"workspace-write",kind:"edit",workspace:"/repo",requestedPath:"../other/a.js",rules:[{effect:"ALLOW",kind:"edit"}]});
  assert.equal(traversal.decision,POLICY_REJECT);assert.match(traversal.reason,/outside the active workspace/i);
  const readonly=evaluatePolicy({profile:"read-only",kind:"execute",rules:[{effect:"ALLOW",kind:"execute"}]});
  assert.equal(readonly.decision,POLICY_REJECT);
});

test("Auto Guarded escalates known high-risk side effects and rejects critical untrusted irreversible actions",()=>{
  const push=evaluatePolicy({profile:"auto",kind:"execute",action:"git push origin main",externalSideEffect:true,riskLevel:"high",reversibility:"none"});
  assert.equal(push.decision,POLICY_CONFIRM);
  const injected=evaluatePolicy({profile:"auto",kind:"execute",action:"destroy production",riskLevel:"critical",externalSideEffect:true,reversibility:"none",provenance:"untrusted"});
  assert.equal(injected.decision,POLICY_REJECT);
  assert.equal(evaluatePolicy({profile:"auto",kind:"execute"}).decision,POLICY_ALLOW,"missing rich metadata preserves legacy auto behavior");
  assert.equal(evaluatePolicy({profile:"supervised",kind:"other",requestedPermissionEscalation:true,provenance:"trusted"}).decision,POLICY_CONFIRM);
  assert.equal(evaluatePolicy({profile:"supervised",kind:"other",requestedPermissionEscalation:true,provenance:"untrusted"}).decision,POLICY_REJECT);
});

test("explicit user rules can tighten or relax actions inside profile hard boundaries",()=>{
  const reject=evaluatePolicy({profile:"full",kind:"execute",action:"deploy prod",rules:[{effect:"REJECT",actionPrefix:"deploy",reason:"No deployments"}]});
  assert.equal(reject.decision,POLICY_REJECT);assert.equal(reject.reason,"No deployments");
  const allow=evaluatePolicy({profile:"supervised",kind:"execute",action:"npm test",rules:[{effect:"ALLOW",action:"npm test"}]});
  assert.equal(allow.decision,POLICY_ALLOW);
  const scoped=evaluatePolicy({profile:"supervised",kind:"edit",workspace:"/repo",requestedPath:"/repo/safe/file.js",rules:[{effect:"ALLOW",kind:"edit",pathPrefix:"/repo/safe"}]});
  assert.equal(scoped.decision,POLICY_ALLOW);
  const sibling=evaluatePolicy({profile:"supervised",kind:"edit",workspace:"/repo",requestedPath:"/repo/safe-evil/file.js",rules:[{effect:"ALLOW",kind:"edit",pathPrefix:"/repo/safe"}]});
  assert.equal(sibling.decision,POLICY_CONFIRM);
  const escaped=evaluatePolicy({profile:"full",kind:"edit",requestedPath:"/repo/safe/../outside/file.js",rules:[{effect:"ALLOW",kind:"edit",pathPrefix:"/repo/safe"}]});
  assert.equal(escaped.decision,POLICY_ALLOW,"Full Access still allows by profile, but not because the scoped rule matched");
  assert.equal(escaped.rule,null);
});

test("policy action classification derives useful side-effect metadata without claiming certainty",()=>{
  const push=classifyPolicyAction({kind:"execute",action:"git push origin main",rawInput:{cwd:"/repo"},workspace:"/repo"});
  assert.equal(push.externalSideEffect,true);assert.equal(push.riskLevel,"high");assert.equal(push.reversibility,"none");assert.equal(push.idempotent,false);
  const read=classifyPolicyAction({kind:"read",action:"Read file",rawInput:{path:"/repo/src/a.js"},workspace:"/repo"});
  assert.equal(read.pathInsideWorkspace,true);assert.equal(read.riskLevel,"low");assert.equal(read.externalSideEffect,false);
  assert.equal(policyPathInside("C:\\repo","c:\\repo\\src\\a.js"),true);
  assert.equal(policyPathInside("C:\\repo","src\\a.js"),true);
  assert.equal(policyPathInside("C:\\repo","..\\outside\\a.js"),false);
});
