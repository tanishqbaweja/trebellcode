import test from "node:test";
import assert from "node:assert/strict";
import {
  ADVANCED_REPOSITORY_TOOL_NAMES,
  CORE_REPOSITORY_TOOL_NAMES,
  JS_TS_ONLY_REPOSITORY_TOOL_NAMES,
  REPOSITORY_INVOKE_TOOL,
  REPOSITORY_TOOL_ANNOTATIONS,
  REPOSITORY_TOOL_DEFINITIONS,
  advancedRepositoryToolDefinition,
  invokeRepositoryTool,
  parseRepositoryToolArguments,
  repositoryDynamicToolNamespace,
  repositoryToolHandlers,
  repositoryToolInputJsonSchema,
  searchRepositoryToolDefinitions,
} from "../src/repository-tool-catalog.mjs";

// Pinned on purpose: this text sits in every Native request's cached tool prefix, so any change must be deliberate.
const EXPECTED_INVOKE_DESCRIPTION="Call an advanced repository capability directly by name; discovery is optional. Capabilities (args, ?=optional): repo_map{query?,limit?}, project_commands{limit?}, verification_plan{paths?,riskHints?,capabilities?}, verification_assess{plan,evidence?}, verification_next{plan,evidence?}, file_relations{path}, related_tests{path?,name?,limit?}, symbol_references{name,path?,limit?}, git_context{}, git_history{path?,limit?}, git_blame{path,startLine?,endLine?,maxLines?}, knowledge_list{query?,limit?,includeUnverified?}, knowledge_context{query?,limit?,refresh?}; JS/TS only: call_hierarchy{name,path?,limit?}, diagnostics{path,limit?,semantic?}, language_symbol{path,line,column?,operation:definition|references|quick_info|callers|callees,limit?}, code_actions{path,line,column?,limit?,codes?}, organize_imports{path,limit?}, rename_preview{path,line,column?,newName,limit?}. Use trebell_repo/discover for a full input schema.";

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

test("repository tool arguments are parsed from the shared Zod shape before invocation",()=>{
  const definition=REPOSITORY_TOOL_DEFINITIONS.find(item=>item.name==="search_symbols");
  assert.deepEqual(parseRepositoryToolArguments(definition,{query:"Session",limit:5}),{query:"Session",limit:5});
  assert.throws(()=>parseRepositoryToolArguments(definition,{limit:5}),/query/i);
  assert.throws(()=>parseRepositoryToolArguments(definition,{query:"Session",limit:1000}),/too big|less than or equal|100/i);
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

test("progressive Native repository catalog keeps common tools small and discovers advanced capabilities on demand",()=>{
  const [namespace]=repositoryDynamicToolNamespace({progressive:true});
  // 3300 includes the ~0.9 KB one-hop capability index in the invoke description (2365 bytes before it).
  assert.ok(JSON.stringify(namespace).length<=3300,"progressive repository gateway should stay within its recurring wire-size budget");
  assert.ok(Buffer.byteLength(REPOSITORY_INVOKE_TOOL.description,"utf8")<=960,"the invoke capability index is sent with every Native request; keep it compact");
  const names=namespace.tools.map(item=>item.name);
  assert.ok(names.includes("discover"));
  assert.ok(names.includes("invoke"));
  for(const name of CORE_REPOSITORY_TOOL_NAMES)assert.ok(names.includes(name),name);
  assert.ok(names.length<REPOSITORY_TOOL_DEFINITIONS.length);
  assert.equal(names.includes("language_symbol"),false);
  const semantic=searchRepositoryToolDefinitions({query:"semantic definition rename typescript",limit:5,exclude:names});
  assert.ok(semantic.some(item=>item.name==="language_symbol"));
  assert.ok(semantic.some(item=>item.name==="rename_preview"));
  const [expanded]=repositoryDynamicToolNamespace({names:semantic.map(item=>item.name),includeDiscovery:false});
  assert.ok(expanded.tools.some(item=>item.name==="language_symbol"));
  assert.equal(expanded.tools.some(item=>item.name==="discover"),false);
});

test("repository discovery ignores generic navigation queries instead of expanding advanced schemas",()=>{
  assert.deepEqual(searchRepositoryToolDefinitions({query:"repository structure and project layout",limit:8}),[]);
  const semantic=searchRepositoryToolDefinitions({query:"semantic rename typescript code action",limit:8}).map(item=>item.name);
  assert.ok(semantic.includes("rename_preview"));
  assert.ok(semantic.includes("code_actions"));
  const history=searchRepositoryToolDefinitions({query:"git history blame",limit:8}).map(item=>item.name);
  assert.ok(history.includes("git_history"));
  assert.ok(history.includes("git_blame"));
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

test("invoke description is built once from the frozen catalog and is byte-stable across module instances",async()=>{
  assert.equal(REPOSITORY_INVOKE_TOOL.description,EXPECTED_INVOKE_DESCRIPTION);
  assert.ok(Object.isFrozen(REPOSITORY_INVOKE_TOOL));
  assert.equal(REPOSITORY_INVOKE_TOOL.inputSchema.properties.name.description,"Capability name from this description or from discover.");
  assert.deepEqual(REPOSITORY_INVOKE_TOOL.inputSchema.required,["name","arguments"]);
  const fresh=await import("../src/repository-tool-catalog.mjs?byte-stability");
  assert.notEqual(fresh.REPOSITORY_INVOKE_TOOL,REPOSITORY_INVOKE_TOOL,"the second import must be a separate module evaluation");
  assert.equal(fresh.REPOSITORY_INVOKE_TOOL.description,REPOSITORY_INVOKE_TOOL.description);
  const manifest=JSON.stringify(repositoryDynamicToolNamespace({progressive:true}));
  assert.equal(JSON.stringify(fresh.repositoryDynamicToolNamespace({progressive:true})),manifest);
  assert.equal(JSON.stringify(repositoryDynamicToolNamespace({progressive:true})),manifest);
});

test("invoke description lists every advanced capability with its exact required and optional keys",()=>{
  assert.deepEqual([...ADVANCED_REPOSITORY_TOOL_NAMES],REPOSITORY_TOOL_DEFINITIONS.map(item=>item.name).filter(name=>!CORE_REPOSITORY_TOOL_NAMES.includes(name)));
  const description=REPOSITORY_INVOKE_TOOL.description,[general,scoped]=description.split("; JS/TS only: ");
  assert.ok(scoped,"JS/TS-only capabilities should be grouped after the general ones");
  const signatures=text=>[...text.matchAll(/([a-z_]+)\{([^}]*)\}/g)].map(match=>({name:match[1],keys:match[2]?match[2].split(","):[]}));
  assert.deepEqual(signatures(general).map(item=>item.name),ADVANCED_REPOSITORY_TOOL_NAMES.filter(name=>!JS_TS_ONLY_REPOSITORY_TOOL_NAMES.includes(name)));
  assert.deepEqual(signatures(scoped).map(item=>item.name),ADVANCED_REPOSITORY_TOOL_NAMES.filter(name=>JS_TS_ONLY_REPOSITORY_TOOL_NAMES.includes(name)));
  for(const {name,keys} of signatures(description)){
    const definition=advancedRepositoryToolDefinition(name);assert.ok(definition,name);
    // Independent oracle: a key is optional exactly when its Zod schema accepts a missing value.
    const expected=Object.entries(definition.inputSchema).map(([key,schema])=>schema.safeParse(undefined).success?key+"?":key);
    assert.deepEqual(keys.map(key=>key.split(":")[0]),expected,name);
  }
  assert.match(description,new RegExp("language_symbol\\{[^}]*operation:"+advancedRepositoryToolDefinition("language_symbol").inputSchema.operation.options.join("\\|")+","));
  for(const name of CORE_REPOSITORY_TOOL_NAMES)assert.doesNotMatch(description,new RegExp("\\b"+name+"\\{"),name);
});

test("JS/TS-only grouping matches the capabilities whose descriptions are language-bound",()=>{
  for(const name of JS_TS_ONLY_REPOSITORY_TOOL_NAMES)assert.ok(advancedRepositoryToolDefinition(name),name);
  for(const definition of REPOSITORY_TOOL_DEFINITIONS){
    const languageBound=/\b(?:JavaScript|TypeScript|JS\/TS)\b/.test(definition.description);
    assert.equal(JS_TS_ONLY_REPOSITORY_TOOL_NAMES.includes(definition.name),languageBound,definition.name);
  }
});

test("verification assess and next still require an explicit plan",()=>{
  for(const name of ["verification_assess","verification_next"]){
    const definition=advancedRepositoryToolDefinition(name);
    assert.throws(()=>parseRepositoryToolArguments(definition,{evidence:[]}),/plan/,name);
    assert.deepEqual(repositoryToolInputJsonSchema(definition).required,["plan"],name);
  }
});
