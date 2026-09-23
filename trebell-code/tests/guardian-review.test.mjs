import test from "node:test";
import assert from "node:assert/strict";
import {guardianActionSummary,guardianDeniedEvent} from "../ui/src/guardian-review.js";

test("guardian denial converts native notification payload back to the core event shape",()=>{
  const event=guardianDeniedEvent({
    reviewId:"review-1",targetItemId:"cmd-1",turnId:"turn-1",startedAtMs:10,completedAtMs:20,decisionSource:"agent",
    review:{status:"denied",riskLevel:"high",userAuthorization:"low",rationale:"The command needs explicit user approval."},
    action:{type:"command",source:"unifiedExec",command:"rm generated.tmp",cwd:"C:\\repo"},
  });
  assert.deepEqual(event,{
    id:"review-1",target_item_id:"cmd-1",turn_id:"turn-1",started_at_ms:10,completed_at_ms:20,status:"denied",
    risk_level:"high",user_authorization:"low",rationale:"The command needs explicit user approval.",decision_source:"agent",
    action:{type:"command",source:"unified_exec",command:"rm generated.tmp",cwd:"C:\\repo"},
  });
});

test("guardian permission denial snake-cases nested protocol fields",()=>{
  const event=guardianDeniedEvent({
    reviewId:"review-2",turnId:"turn-2",startedAtMs:30,completedAtMs:40,decisionSource:"agent",
    review:{status:"denied"},
    action:{type:"requestPermissions",reason:"write generated files",permissions:{network:{enabled:true},fileSystem:{globScanMaxDepth:3,entries:[{path:{kind:"project_roots",subpath:null},access:"write"}]}}},
  });
  assert.deepEqual(event.action,{
    type:"request_permissions",reason:"write generated files",
    permissions:{network:{enabled:true},file_system:{glob_scan_max_depth:3,entries:[{path:{kind:"project_roots",subpath:null},access:"write"}]}},
  });
});

test("guardian summary never exposes stdin contents",()=>{
  assert.equal(guardianActionSummary({type:"writeStdin",processId:"42",stdin:"super-secret"}),"input to process 42");
});
