import test from "node:test";
import assert from "node:assert/strict";
import { normalizePermissionKind, normalizePermissionMode, permissionDisposition } from "../src/permission-policy.mjs";

test("permission policy normalizes Trebell modes and action kinds",()=>{
  assert.equal(normalizePermissionMode("FULL"),"full");
  assert.equal(normalizePermissionMode("unknown"),"supervised");
  assert.equal(normalizePermissionKind("workspace_write"),"edit");
  assert.equal(normalizePermissionKind("bash"),"execute");
  assert.equal(normalizePermissionKind("web_fetch"),"fetch");
  assert.equal(normalizePermissionKind("mystery"),"other");
});

test("permission policy preserves Trebell's high-level allow deny and ask contract",()=>{
  for(const kind of ["read","edit","execute","fetch","other"]){
    assert.equal(permissionDisposition("full",kind),"allow");
    assert.equal(permissionDisposition("auto",kind),"allow");
  }
  assert.equal(permissionDisposition("edits","edit"),"allow");
  assert.equal(permissionDisposition("edits","execute"),"ask");
  assert.equal(permissionDisposition("supervised","edit"),"ask");
  assert.equal(permissionDisposition("read-only","read"),"allow");
  assert.equal(permissionDisposition("read-only","edit"),"deny");
  assert.equal(permissionDisposition("read-only","read",{readOnlyAllowsRead:false}),"deny");
});
