import test from "node:test";
import assert from "node:assert/strict";
import { platformDynamicToolNamespaces, platformToolCatalog, platformToolDefinition, platformToolParallelSafe } from "../src/platform-tool-catalog.mjs";

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
});

test("platform parallel-safety is stricter than generic async safety",()=>{
  assert.equal(platformToolParallelSafe("trebell_repo","search_symbols"),true);
  assert.equal(platformToolParallelSafe("trebell_workspace","read_file"),true);
  assert.equal(platformToolParallelSafe("trebell_browser","snapshot"),true);
  assert.equal(platformToolParallelSafe("trebell_browser","set_viewport"),false,"shared browser state must not race structural reads");
  assert.equal(platformToolParallelSafe("trebell_workspace","write_file"),false);
  assert.equal(platformToolParallelSafe("trebell_delegate","delegate"),false,"child-agent budgeting and workspace creation stay serialized");
});
