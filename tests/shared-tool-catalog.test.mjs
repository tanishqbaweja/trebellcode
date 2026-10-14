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
import { authorizeSharedToolCall } from "../src/shared-tool-gateway.mjs";

test("shared Trebell tool catalog owns unique schemas and policy metadata",()=>{
  const namespaceNames=SHARED_TOOL_NAMESPACE_CATALOG.map(item=>item.name);
  assert.equal(new Set(namespaceNames).size,namespaceNames.length);
  assert.deepEqual(namespaceNames,["trebell_output","trebell_workspace","trebell_terminal","trebell_process","trebell_browser","trebell_computer","trebell_source_control","trebell_delegate"]);
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
  assert.equal(sharedToolNamespace("trebell_device"),null,"mobile simulator tooling is outside the desktop harness product surface");
  const terminal=sharedToolDefinition("trebell_terminal","run");assert.equal(terminal.policy.kind,"execute");assert.equal(terminal.policy.classifyFromInput,true);assert.equal(terminal.requirements.workspace,true);
  assert.match(sharedToolNamespace("trebell_terminal").description,/argv/i);assert.match(sharedToolNamespace("trebell_terminal").description,/shell executable/i);
  assert.match(terminal.inputSchema.properties.command.description,/executable only/i);assert.match(terminal.inputSchema.properties.args.description,/argument vector/i);
  const compactCodingSurface=sharedDynamicToolNamespaces({workspaceTools:true,terminal:true,sourceControl:false});
  // 2240 (was 2200) leaves room for the timeout_ms default note, so a slow whole-file test run is not cut off at 30 s.
  // 2580 (was 2240) adds replace_text's edits list, which puts several hunks for one file into one call.
  assert.ok(JSON.stringify(compactCodingSurface).length<=2580,"workspace + terminal schema (including image inspection) should stay compact without dropping argv guardrails");
  assert.match(terminal.inputSchema.properties.timeout_ms.description,/Default 30000; raise for slow runs/);
  assert.deepEqual(sharedToolNamespace("trebell_output").tools.map(item=>item.name),["inspect"]);
  assert.ok(JSON.stringify(sharedDynamicToolNamespaces({output:true,sourceControl:false})).length<=725,"virtualized-output manifest grew past its recurring wire budget");
  assert.equal(sharedToolDefinition("trebell_output","read").policy.kind,"read","legacy output read remains resolvable but is not advertised");
  assert.equal(sharedToolDefinition("trebell_output","search").policy.kind,"read","legacy output search remains resolvable but is not advertised");
  const background=sharedToolDefinition("trebell_process","start");assert.equal(background.policy.kind,"execute");assert.equal(background.policy.classifyFromInput,true);
  assert.equal(sharedToolDefinition("trebell_process","status").policy.kind,"read");assert.equal(sharedToolDefinition("trebell_process","stop").policy.kind,"execute");
  assert.equal(sharedToolDefinition("trebell_terminal","start_background").policy.kind,"execute","legacy process aliases remain resolvable but are not advertised");
  assert.equal(sharedToolDefinition("trebell_source_control","status").policy.kind,"read");
  const push=sharedToolDefinition("trebell_source_control","push");assert.equal(push.policy.riskLevel,"high");assert.equal(push.policy.externalSideEffect,true);assert.equal(push.policy.reversibility,"none");
  assert.equal(sharedToolDefinition("trebell_browser","click").policy.externalSideEffect,true);assert.equal(sharedToolDefinition("trebell_browser","type").policy.externalSideEffect,true);
  assert.equal(sharedToolOutputProvenance("trebell_browser"),"untrusted");assert.equal(sharedToolOutputProvenance("trebell_computer"),"untrusted");assert.equal(sharedToolOutputProvenance("trebell_workspace"),"trusted");
});

test("process status takes an optional bounded wait and a since:start read the way the catalog's other optional parameters are written",()=>{
  const status=sharedToolDefinition("trebell_process","status"),schema=status.inputSchema;
  assert.match(status.description,/ Pass wait_ms to wait for progress instead of re-polling\.$/);
  assert.deepEqual(schema.required,["process_id"],"both new parameters are optional");assert.equal(schema.additionalProperties,false);
  assert.deepEqual({type:schema.properties.wait_ms.type,minimum:schema.properties.wait_ms.minimum,maximum:schema.properties.wait_ms.maximum},{type:"integer",minimum:0,maximum:60000});
  // A model fills every optional field it is offered, so the enum names the default too: offered only "start", gpt-6-luna
  // passed since:"start" on every status call of the 2026-10-14 smoke run, and every read was a full one.
  assert.deepEqual(schema.properties.since.enum,["new","start"]);assert.equal(schema.properties.since.type,"string");
  assert.match(schema.properties.since.description,/^new \(the default\): /);
  for(const property of Object.values(schema.properties))assert.deepEqual(Object.keys(property).filter(key=>!["type","minimum","maximum","enum","description"].includes(key)),[],"only keywords the catalog already sends");
  assert.deepEqual(sharedToolDefinition("trebell_terminal","background_status").inputSchema,schema,"the legacy name shares the schema");
  const context={permissionProfile:"full",workspace:"/repo"},check=args=>authorizeSharedToolCall({namespace:"trebell_process",name:"status",arguments:{process_id:"p1",...args}},context);
  assert.notEqual(check({wait_ms:30_000,since:"start"}).decision,"REJECT");assert.notEqual(check({wait_ms:60_000,since:"new"}).decision,"REJECT");assert.notEqual(check({wait_ms:0}).decision,"REJECT");
  assert.match(check({wait_ms:60_001}).reason,/wait_ms must be <= 60000/);assert.match(check({wait_ms:-1}).reason,/wait_ms must be >= 0/);
  assert.match(check({wait_ms:1.5}).reason,/wait_ms must be an integer/);assert.match(check({since:"end"}).reason,/since must be one of: new, start/);
  assert.equal(sharedToolDefinition("trebell_process","stop").inputSchema.properties.wait_ms,undefined,"stop does not wait");
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
  const enabled=sharedDynamicToolNamespaces({workspaceTools:true,terminal:true,process:true,browser:true,computer:true,sourceControl:true,delegation:true});
  assert.deepEqual(enabled.map(item=>item.name),["trebell_workspace","trebell_terminal","trebell_process","trebell_browser","trebell_computer","trebell_source_control","trebell_delegate"]);
  const projectOnly=sharedDynamicToolNamespaces({sourceControl:true,delegation:true});assert.deepEqual(projectOnly.map(item=>item.name),["trebell_source_control","trebell_delegate"]);
});
