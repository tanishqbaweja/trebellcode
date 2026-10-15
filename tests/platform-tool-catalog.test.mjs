import test from "node:test";
import assert from "node:assert/strict";
import { discoverRepositoryCapabilities, exposedToolNamed, platformDynamicToolNamespaces, platformToolCatalog, platformToolDefinition, platformToolParallelSafe } from "../src/platform-tool-catalog.mjs";

test("platform tool catalog adapts repository policy without duplicating repository definitions",()=>{
  const search=platformToolDefinition("trebell_repo","search_symbols");
  assert.equal(search.source,"repository");assert.equal(search.handler,"searchSymbols");assert.equal(search.policy.kind,"read");assert.equal(search.policy.riskLevel,"low");assert.equal(search.policy.idempotent,true);assert.equal(search.requirements.workspace,true);
  const browser=platformToolDefinition("trebell_browser","snapshot");assert.equal(browser.source,"shared");assert.equal(browser.policy.kind,"read");assert.equal(browser.requirements.desktop,true);
  assert.equal(platformToolDefinition("trebell_repo","missing"),null);
});

test("platform dynamic tools compose repository intelligence with only enabled shared capability groups",()=>{
  const names=platformDynamicToolNamespaces({repository:true,workspaceTools:true,terminal:true,browser:true,sourceControl:false}).map(item=>item.name);
  assert.deepEqual(names,["trebell_repo","trebell_workspace","trebell_terminal","trebell_browser"]);
  const withoutRepo=platformDynamicToolNamespaces({repository:false,sourceControl:false}).map(item=>item.name);
  assert.deepEqual(withoutRepo,[]);
  const catalog=platformToolCatalog({repository:true,sourceControl:false});
  const repo=catalog.find(item=>item.name==="trebell_repo");assert.ok(repo.tools.length>10);assert.ok(repo.tools.every(item=>item.platform?.source==="repository"));
  const progressive=platformDynamicToolNamespaces({repository:true,progressiveRepository:true,workspaceTools:true,terminal:true,sourceControl:false});
  const progressiveRepo=progressive.find(item=>item.name==="trebell_repo");assert.ok(progressiveRepo.tools.some(item=>item.name==="discover"));assert.ok(progressiveRepo.tools.some(item=>item.name==="invoke"));assert.ok(progressiveRepo.tools.length<repo.tools.length);
  assert.equal(platformToolDefinition("trebell_repo","discover").source,"repository-discovery");
  assert.equal(platformToolDefinition("trebell_repo","invoke").source,"repository-invoke");
});

test("platform parallel-safety is stricter than generic async safety",()=>{
  assert.equal(platformToolParallelSafe("trebell_repo","search_symbols"),true);
  assert.equal(platformToolParallelSafe("trebell_workspace","read_file"),true);
  assert.equal(platformToolParallelSafe("trebell_browser","snapshot"),true);
  assert.equal(platformToolParallelSafe("trebell_browser","set_viewport"),false,"shared browser state must not race structural reads");
  assert.equal(platformToolParallelSafe("trebell_workspace","write_file"),false);
  assert.equal(platformToolParallelSafe("trebell_delegate","delegate"),false,"child-agent budgeting and workspace creation stay serialized");
});

// A model looking in trebell_repo for a tool the session offers on its own ("terminal") is pointed at it, as in the app so in the
// benchmark runner, instead of being told that nothing matches.
test("trebell_repo/discover points a search for a tool the session offers on its own at that tool",()=>{
  const tools=platformDynamicToolNamespaces({repository:true,progressiveRepository:true,workspaceTools:true,terminal:true});
  const terminal=discoverRepositoryCapabilities(tools,{query:"terminal"});
  assert.deepEqual(terminal.capabilities,[]);
  assert.equal(terminal.instruction,"No matching advanced repository capability. These tools are already available as tool calls of their own, not through trebell_repo/invoke: trebell_terminal__run.");
  const history=discoverRepositoryCapabilities(tools,{query:"git history"});
  assert.ok(history.capabilities.some(item=>item.name==="git_history"));
  assert.equal(history.instruction,"Call trebell_repo/invoke with one returned capability name and matching arguments.");
  assert.equal(discoverRepositoryCapabilities(tools,{query:"zzzz qqqq"}).instruction,"No matching advanced repository capability.");
  assert.throws(()=>discoverRepositoryCapabilities(tools,{query:" "}),/query is required/);
  const terminalRun={namespace:"trebell_terminal",name:"run",shown:"trebell_terminal__run"},readFile={namespace:"trebell_workspace",name:"read_file",shown:"trebell_workspace__read_file"};
  for(const [name,tool] of [["trebell_terminal__run",terminalRun],["trebell_terminal/run",terminalRun],["trebell_workspace.read_file",readFile],["read_file",readFile],["search_files",null],["git_history",null]])assert.deepEqual(exposedToolNamed(tools,name),tool,name);
});
