import test from "node:test";
import assert from "node:assert/strict";
import {
  REPOSITORY_TOOL_ANNOTATIONS,
  REPOSITORY_TOOL_DEFINITIONS,
  invokeRepositoryTool,
  repositoryDynamicToolNamespace,
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

test("repository tool catalog serializes into one Codex dynamic-tool namespace",()=>{
  const [namespace]=repositoryDynamicToolNamespace();
  assert.equal(namespace.type,"namespace");assert.equal(namespace.name,"trebell_repo");
  assert.equal(namespace.tools.length,REPOSITORY_TOOL_DEFINITIONS.length);
  const search=namespace.tools.find(item=>item.name==="search_code"),knowledge=namespace.tools.find(item=>item.name==="knowledge_context");
  assert.equal(search.inputSchema.type,"object");assert.equal(search.inputSchema.properties.query.type,"string");
  assert.ok(search.inputSchema.required.includes("query"));
  assert.equal(knowledge.inputSchema.type,"object");assert.equal(knowledge.inputSchema.properties.refresh.type,"boolean");
  assert.doesNotThrow(()=>JSON.stringify(namespace));
});

test("repository knowledge tools stay scoped to the active project and environment",async()=>{
  const calls=[],knowledgeService={
    list(args){calls.push(["list",args]);return [{id:"fact-1",fact:"Use npm test"}]},
    async context(args){calls.push(["context",args]);return {entries:[{id:"fact-1"}],context:"Durable Trebell repository knowledge"}}
  };
  const handlers=repositoryToolHandlers({contextEngine:{},root:"/repo",knowledgeService,environmentId:"ssh-prod"});
  assert.deepEqual(handlers.knowledgeList({query:"test",limit:5,includeUnverified:false}),{supported:true,entries:[{id:"fact-1",fact:"Use npm test"}]});
  assert.deepEqual(await handlers.knowledgeContext({query:"release",limit:7,refresh:true}),{supported:true,entries:[{id:"fact-1"}],context:"Durable Trebell repository knowledge"});
  assert.deepEqual(calls,[
    ["list",{projectPath:"/repo",environmentId:"ssh-prod",query:"test",limit:5,includeUnverified:false}],
    ["context",{projectPath:"/repo",environmentId:"ssh-prod",query:"release",limit:7,refresh:true}],
  ]);
});
