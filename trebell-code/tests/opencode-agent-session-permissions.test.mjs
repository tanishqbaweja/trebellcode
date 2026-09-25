import test from "node:test";
import assert from "node:assert/strict";
import { openCodePermissionDisposition } from "../src/opencode-agent-session.mjs";

test("OpenCode permission events follow Trebell shared policy using provider permission types",()=>{
  assert.equal(openCodePermissionDisposition("full","bash"),"allow");
  assert.equal(openCodePermissionDisposition("auto","webfetch"),"allow");
  assert.equal(openCodePermissionDisposition("edits","edit"),"allow");
  assert.equal(openCodePermissionDisposition("edits","write"),"allow");
  assert.equal(openCodePermissionDisposition("edits","bash"),"ask");
  assert.equal(openCodePermissionDisposition("edits","webfetch"),"ask");
  assert.equal(openCodePermissionDisposition("edits","unknown-provider-permission"),"ask");
  assert.equal(openCodePermissionDisposition("supervised","edit"),"ask");
});

test("OpenCode read-only keeps its conservative deny-on-permission behavior",()=>{
  assert.equal(openCodePermissionDisposition("read-only","read"),"deny");
  assert.equal(openCodePermissionDisposition("read-only","edit"),"deny");
  assert.equal(openCodePermissionDisposition("read-only","bash"),"deny");
});
