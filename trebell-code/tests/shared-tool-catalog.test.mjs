import test from "node:test";
import assert from "node:assert/strict";
import {
  SHARED_TOOL_NAMESPACE_CATALOG,
  dynamicToolNamespace,
  sharedDynamicToolNamespaces,
  sharedToolDefinition,
  sharedToolNamespace,
  sharedToolOutputProvenance,
  sharedToolResponseContent,
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
  const back=sharedToolDefinition("trebell_browser","back");assert.equal(back.policy.kind,"read");assert.equal(back.policy.idempotent,false);assert.equal(back.requirements.desktop,true);
  const forward=sharedToolDefinition("trebell_browser","forward");assert.equal(forward.policy.kind,"read");assert.equal(forward.policy.idempotent,false);
  const reload=sharedToolDefinition("trebell_browser","reload");assert.equal(reload.policy.kind,"fetch");assert.equal(reload.policy.idempotent,true);
  const iosBoot=sharedToolDefinition("trebell_device","boot");assert.equal(iosBoot.policy.kind,"execute");assert.equal(iosBoot.policy.idempotent,true);assert.equal(iosBoot.requirements.deviceAccess,true);
  const iosPoweroff=sharedToolDefinition("trebell_device","poweroff");assert.equal(iosPoweroff.policy.reversibility,"full");assert.match(sharedToolDefinition("trebell_device","tap").description,/iOS/i);
  const swipe=sharedToolDefinition("trebell_device","swipe");assert.equal(swipe.policy.kind,"other");assert.equal(swipe.inputSchema.properties.duration.maximum,5000);
  const logs=sharedToolDefinition("trebell_device","logs");assert.equal(logs.policy.kind,"read");assert.equal(logs.policy.idempotent,true);assert.equal(logs.requirements.deviceAccess,true);assert.equal(logs.inputSchema.properties.lines.maximum,2000);
  const packages=sharedToolDefinition("trebell_device","packages");assert.equal(packages.policy.kind,"read");assert.equal(packages.policy.idempotent,true);
  const launch=sharedToolDefinition("trebell_device","launch");assert.equal(launch.policy.kind,"execute");assert.equal(launch.policy.reversibility,"partial");
  const stop=sharedToolDefinition("trebell_device","stop");assert.equal(stop.policy.idempotent,true);assert.equal(stop.policy.reversibility,"full");
  const terminal=sharedToolDefinition("trebell_terminal","run");assert.equal(terminal.policy.kind,"execute");assert.equal(terminal.policy.classifyFromInput,true);assert.equal(terminal.requirements.workspace,true);
  const background=sharedToolDefinition("trebell_terminal","start_background");assert.equal(background.policy.kind,"execute");assert.equal(background.policy.classifyFromInput,true);
  assert.equal(sharedToolDefinition("trebell_terminal","background_status").policy.kind,"read");assert.equal(sharedToolDefinition("trebell_terminal","stop_background").policy.kind,"execute");
  assert.equal(sharedToolDefinition("trebell_source_control","status").policy.kind,"read");
  const push=sharedToolDefinition("trebell_source_control","push");assert.equal(push.policy.riskLevel,"high");assert.equal(push.policy.externalSideEffect,true);assert.equal(push.policy.reversibility,"none");
  assert.equal(sharedToolDefinition("trebell_browser","click").policy.externalSideEffect,true);assert.equal(sharedToolDefinition("trebell_browser","type").policy.externalSideEffect,true);
  assert.equal(sharedToolOutputProvenance("trebell_browser"),"untrusted");assert.equal(sharedToolOutputProvenance("trebell_computer"),"untrusted");assert.equal(sharedToolOutputProvenance("trebell_device"),"untrusted");assert.equal(sharedToolOutputProvenance("trebell_workspace"),"trusted");
});

test("untrusted desktop tool output carries a compact provenance marker without dropping images",()=>{
  const content=sharedToolResponseContent("trebell_browser",[{type:"inputImage",imageUrl:"data:image/png;base64,abc"},{type:"inputText",text:"page metadata"}]);
  assert.match(content[0].text,/untrusted external tool data/i);assert.equal(content[1].type,"inputImage");assert.equal(content[2].text,"page metadata");
  assert.deepEqual(sharedToolResponseContent("trebell_workspace",[{type:"inputText",text:"workspace"}]),[{type:"inputText",text:"workspace"}]);
});

test("dynamic tool serialization strips harness-only metadata",()=>{
  const browser=dynamicToolNamespace(sharedToolNamespace("trebell_browser"));
  assert.equal(browser.type,"namespace");assert.equal(browser.name,"trebell_browser");for(const name of ["snapshot","back","forward","reload"])assert.ok(browser.tools.some(item=>item.name===name),name);
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
