import test from "node:test";
import assert from "node:assert/strict";
import { mergeTraceFilterOptions, traceQuery } from "../ui/src/runtime-trace-filters.js";

test("trace query exposes thread, turn, runtime, category and bounded time filters",()=>{
  const params=traceQuery({threadId:"thread-1",turnId:"turn-2",runtime:"codex",category:"delegation",timeWindow:"1h",now:10_000_000,limit:80});
  assert.equal(params.get("threadId"),"thread-1");assert.equal(params.get("turnId"),"turn-2");assert.equal(params.get("runtime"),"codex");assert.equal(params.get("category"),"delegation");
  assert.equal(params.get("after"),String(10_000_000-60*60_000));assert.equal(params.get("limit"),"80");
});

test("trace filter options retain discovered values while adding new event categories and turns",()=>{
  const first=mergeTraceFilterOptions({},[{runtime:"codex",category:"delegation",turnId:"turn-12345678901234567890"}]);
  assert.ok(first.categories.includes("delegation"));assert.ok(first.categories.includes("verification"));assert.deepEqual(first.runtimes,["codex"]);assert.equal(first.turns[0].label,"turn-1234567…");
  const second=mergeTraceFilterOptions(first,[{runtime:"claude",category:"knowledge",turnId:"turn-2"}]);
  assert.deepEqual(second.runtimes,["claude","codex"]);assert.ok(second.categories.includes("knowledge"));assert.deepEqual(second.turns.map(item=>item.id),["turn-12345678901234567890","turn-2"]);
});
