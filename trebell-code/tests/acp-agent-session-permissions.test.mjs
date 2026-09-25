import test from "node:test";
import assert from "node:assert/strict";
import { acpPermissionChoice } from "../src/acp-agent-session.mjs";

const options=[
  {kind:"allow_always",optionId:"always",name:"Always allow"},
  {kind:"allow_once",optionId:"once",name:"Allow once"},
  {kind:"reject_once",optionId:"reject",name:"Reject"},
];

test("ACP edits mode auto-allows only explicitly classified edit permissions",()=>{
  assert.equal(acpPermissionChoice(options,"edits","edit"),"once");
  assert.equal(acpPermissionChoice(options,"edits","write"),"once");
  assert.equal(acpPermissionChoice(options,"edits","workspace_write"),"once");
  assert.equal(acpPermissionChoice(options,"edits","execute"),null);
  assert.equal(acpPermissionChoice(options,"edits","network"),null);
  assert.equal(acpPermissionChoice(options,"edits","other"),null);
  assert.equal(acpPermissionChoice(options,"edits",null),null);
  assert.equal(acpPermissionChoice(options,"edits","mystery-tool"),null);
});

test("ACP full, auto, supervised and read-only modes preserve their approval contract",()=>{
  assert.equal(acpPermissionChoice(options,"full",null),"always");
  assert.equal(acpPermissionChoice(options,"auto","execute"),"always");
  assert.equal(acpPermissionChoice(options,"supervised","edit"),null);
  assert.equal(acpPermissionChoice(options,"read-only","read"),"reject");
});

test("ACP edits mode never fabricates approval when the provider exposes no allow option",()=>{
  const rejectOnly=[{kind:"reject_once",optionId:"reject",name:"Reject"}];
  assert.equal(acpPermissionChoice(rejectOnly,"edits","edit"),null);
});
