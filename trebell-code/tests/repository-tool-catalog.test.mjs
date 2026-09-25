import test from "node:test";
import assert from "node:assert/strict";
import {
  REPOSITORY_TOOL_ANNOTATIONS,
  REPOSITORY_TOOL_DEFINITIONS,
  invokeRepositoryTool,
  repositoryToolHandlers,
} from "../src/repository-tool-catalog.mjs";

test("repository tool catalog is unique, read-only, and includes deterministic verification control",()=>{
  const names=REPOSITORY_TOOL_DEFINITIONS.map(item=>item.name);
  assert.equal(new Set(names).size,names.length);
  assert.ok(names.includes("verification_plan"));
  assert.ok(names.includes("verification_assess"));
  assert.ok(names.includes("verification_next"));
  for(const definition of REPOSITORY_TOOL_DEFINITIONS){
    assert.ok(definition.handler);
    assert.ok(definition.description);
    assert.ok(definition.inputSchema&&typeof definition.inputSchema==="object");
    assert.deepEqual(definition.annotations,REPOSITORY_TOOL_ANNOTATIONS);
    assert.equal(definition.policy.readOnly,true);
  }
});

test("catalog definitions invoke the shared Context Engine handler instead of adapter-specific copies",async()=>{
  const calls=[];
  const contextEngine={
    nextVerificationAction(args){calls.push(args);return {action:"repair",stepId:"tests"}}
  };
  const handlers=repositoryToolHandlers({contextEngine,root:"/repo",io:{kind:"fixture"}});
  const definition=REPOSITORY_TOOL_DEFINITIONS.find(item=>item.name==="verification_next");
  const result=await invokeRepositoryTool(handlers,definition,{plan:{steps:[]},evidence:[{stepId:"tests",exitCode:1}]});
  assert.deepEqual(result,{action:"repair",stepId:"tests"});
  assert.deepEqual(calls,[{plan:{steps:[]},evidence:[{stepId:"tests",exitCode:1}]}]);
});

test("repository tool invocation fails closed when a definition has no handler",()=>{
  assert.throws(()=>invokeRepositoryTool({}, {name:"missing",handler:"missing"},{}),/handler is unavailable/i);
});
