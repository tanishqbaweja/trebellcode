import test from "node:test";
import assert from "node:assert/strict";
import {
  SHARED_TOOL_NAMESPACE_CATALOG,
  dynamicToolNamespace,
  sharedDynamicToolNamespaces,
  sharedToolDefinition,
  sharedToolNamespace,
} from "../src/shared-tool-catalog.mjs";

test("shared Trebell tool catalog owns unique schemas and policy metadata",()=>{
  const namespaceNames=SHARED_TOOL_NAMESPACE_CATALOG.map(item=>item.name);
  assert.equal(new Set(namespaceNames).size,namespaceNames.length);
  assert.deepEqual(namespaceNames,["trebell_workspace","trebell_terminal","trebell_browser","trebell_computer","trebell_device","trebell_source_control","trebell_delegate"]);
  for(const namespace of SHARED_TOOL_NAMESPACE_CATALOG){
    assert.ok(namespace.description);assert.ok(namespace.tools.length);
    const names=namespace.tools.map(item=>item.name);assert.equal(new Set(names).size,names.length);
    for(const item of namespace.tools){
      assert.equal(item.inputSchema.type,"object");
      assert.ok(["read","edit","execute","fetch","network","other"].includes(item.policy.kind));
      assert.ok(["low","medium","high","critical"].includes(item.policy.riskLevel));
      assert.ok(["not-applicable","full","partial","none"].includes(item.policy.reversibility));
      assert.equal(typeof item.policy.idempotent,"boolean");assert.equal(typeof item.policy.externalSideEffect,"boolean");assert.equal(typeof item.policy.asyncSafe,"boolean");assert.equal(typeof item.policy.classifyFromInput,"boolean");
      assert.equal(typeof item.requirements.desktop,"boolean");assert.equal(typeof item.requirements.workspace,"boolean");assert.equal(typeof item.requirements.project,"boolean");
    }
  }
  const click=sharedToolDefinition("trebell_computer","click");assert.equal(click.policy.riskLevel,"high");assert.equal(click.policy.externalSideEffect,true);assert.equal(click.requirements.fullAccess,true);
  const snapshot=sharedToolDefinition("trebell_browser","snapshot");assert.equal(snapshot.policy.kind,"read");assert.equal(snapshot.policy.idempotent,true);
  const terminal=sharedToolDefinition("trebell_terminal","run");assert.equal(terminal.policy.kind,"execute");assert.equal(terminal.policy.classifyFromInput,true);assert.equal(terminal.requirements.workspace,true);
});

test("dynamic tool serialization strips harness-only metadata",()=>{
  const browser=dynamicToolNamespace(sharedToolNamespace("trebell_browser"));
  assert.equal(browser.type,"namespace");assert.equal(browser.name,"trebell_browser");assert.ok(browser.tools.some(item=>item.name==="snapshot"));
  assert.equal(Object.prototype.hasOwnProperty.call(browser,"requirements"),false);
  assert.equal(Object.prototype.hasOwnProperty.call(browser.tools[0],"policy"),false);
  assert.equal(Object.prototype.hasOwnProperty.call(browser.tools[0],"requirements"),false);
  assert.doesNotThrow(()=>JSON.stringify(browser));
});

test("dynamic tool exposure is capability-driven",()=>{
  const minimal=sharedDynamicToolNamespaces({sourceControl:false});assert.deepEqual(minimal,[]);
  const enabled=sharedDynamicToolNamespaces({workspaceTools:true,terminal:true,browser:true,computer:true,device:true,sourceControl:true,delegation:true});
  assert.deepEqual(enabled.map(item=>item.name),["trebell_workspace","trebell_terminal","trebell_browser","trebell_computer","trebell_device","trebell_source_control","trebell_delegate"]);
  const projectOnly=sharedDynamicToolNamespaces({sourceControl:true,delegation:true});assert.deepEqual(projectOnly.map(item=>item.name),["trebell_source_control","trebell_delegate"]);
});
