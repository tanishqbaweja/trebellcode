import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_REMOTE_SCOPES, normalizeRemoteScopes, remoteDeniedServerResult, remoteRpcScope, remoteServerRequestScope } from "../src/remote-scopes.mjs";

test("remote scopes are explicit, deduplicated, and future capabilities are not silently granted",()=>{
  assert.deepEqual(normalizeRemoteScopes(["status","status","future:magic","threads:read"]),["status","threads:read"]);
  assert.ok(DEFAULT_REMOTE_SCOPES.includes("environments:execute"));assert.equal(DEFAULT_REMOTE_SCOPES.includes("future:magic"),false);
});

test("remote RPC scope mapping separates reads, writes, handshakes and unknown future methods",()=>{
  assert.equal(remoteRpcScope("initialize"),null);assert.equal(remoteRpcScope("thread/list"),"threads:read");assert.equal(remoteRpcScope("turn/start"),"threads:write");
  assert.equal(remoteRpcScope("future/launchNukes"),false);
});

test("remote server requests require approvals or write scope and have safe denial results",()=>{
  assert.equal(remoteServerRequestScope("item/tool/requestApproval"),"approvals");assert.equal(remoteServerRequestScope("item/tool/requestUserInput"),"threads:write");
  assert.deepEqual(remoteDeniedServerResult("mcpServer/elicitation/request"),{action:"cancel",content:null,_meta:null});
  assert.deepEqual(remoteDeniedServerResult("item/permissions/requestApproval"),{permissions:{},scope:"turn"});
});
