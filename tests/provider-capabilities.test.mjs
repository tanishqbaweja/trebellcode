import test from "node:test";
import assert from "node:assert/strict";
import { providerCapabilities, providerFeatureEnabled } from "../src/provider-capabilities.mjs";
import { ProviderManager } from "../src/provider-manager.mjs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("managed provider capabilities distinguish protocol compatibility from verified stateful features",()=>{
  const vyce=providerCapabilities("vyceai");
  assert.equal(vyce.promptCaching.status,"unverified");
  assert.equal(vyce.previousResponseContinuation.status,"unsupported");
  assert.equal(vyce.persistentConnection.status,"unsupported");
  assert.equal(providerFeatureEnabled("vyceai","previousResponseContinuation"),false);
  const agentrouter=providerCapabilities("agentrouter");
  assert.equal(agentrouter.previousResponseContinuation.status,"unverified");
  assert.equal(agentrouter.persistentConnection.status,"unsupported");
  const justworker=providerCapabilities("justworker");
  assert.equal(justworker.explicitCacheControl.status,"unverified");
  assert.equal(justworker.cacheUsageBreakdown.status,"supported");
});

test("ProviderManager surfaces conservative capability metadata without secrets",()=>{
  const root=mkdtempSync(join(tmpdir(),"trebell-provider-cap-"));
  try{
    const manager=new ProviderManager({env:{TREBELL_HOME:root,VYCEAI_API_KEY:"cap-secret"}});
    const definition=manager.definitions().find(item=>item.id==="vyceai"),status=manager.status("vyceai");
    assert.equal(definition.capabilities.promptCaching.status,"unverified");
    assert.equal(status.capabilities.nativeCompaction.status,"unsupported");
    assert.doesNotMatch(JSON.stringify({definition,status}),/cap-secret/);
  }finally{rmSync(root,{recursive:true,force:true})}
});
