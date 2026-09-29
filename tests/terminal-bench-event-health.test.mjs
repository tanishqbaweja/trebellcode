import test from "node:test";
import assert from "node:assert/strict";
import { classifyHealth, healthAdvanced, summarizeCodexEventHealth, summarizeNativeEventHealth } from "../scripts/terminal-bench-event-health.mjs";

test("Native event health reports lifecycle counts only",()=>{
  const marker="payload-marker-xyz";
  const input=[
    {atMs:10,name:"native.model.requested",data:{value:marker}},
    {atMs:20,name:"native.model.completed",data:{value:marker}},
    {atMs:21,name:"native.tool.requested",data:{value:marker}},
    {atMs:30,name:"native.tool.completed",data:{value:marker}},
    {atMs:31,name:"native.tool.requested",data:{value:marker}},
  ].map(JSON.stringify).join("\n");
  const summary=summarizeNativeEventHealth(input);
  assert.equal(summary.counts.modelRequested,1);
  assert.equal(summary.counts.modelCompleted,1);
  assert.equal(summary.counts.toolRequested,2);
  assert.equal(summary.counts.toolCompleted,1);
  assert.equal(summary.pendingTools,1);
  assert.equal(summary.lastAtMs,31);
  assert.equal(JSON.stringify(summary).includes(marker),false);
});

test("Codex event health reports lifecycle counts only",()=>{
  const marker="payload-marker-xyz";
  const input=[
    {timestamp:"2026-09-29T00:00:01Z",type:"event_msg",payload:{type:"item_completed",item:{type:"Reasoning",value:marker}}},
    {timestamp:"2026-09-29T00:00:02Z",type:"response_item",payload:{type:"custom_tool_call",input:marker}},
    {timestamp:"2026-09-29T00:00:03Z",type:"event_msg",payload:{type:"item_completed",item:{type:"CommandExecution",status:"completed",value:marker}}},
    {timestamp:"2026-09-29T00:00:04Z",type:"event_msg",payload:{type:"item_completed",item:{type:"AgentMessage",value:marker}}},
    {timestamp:"2026-09-29T00:00:05Z",type:"token_usage_record",payload:{}},
  ].map(JSON.stringify).join("\n");
  const summary=summarizeCodexEventHealth(input);
  assert.equal(summary.counts.reasoningCompleted,1);
  assert.equal(summary.counts.agentMessages,1);
  assert.equal(summary.counts.toolCalls,1);
  assert.equal(summary.counts.commandCompleted,1);
  assert.equal(summary.counts.usageRecords,1);
  assert.equal(summary.pendingCommands,0);
  assert.equal(JSON.stringify(summary).includes(marker),false);
});

test("event health requires an observable event or byte advance",()=>{
  const before={available:true,fileBytes:100,mtimeMs:1,summary:{kind:"codex",counts:{reasoningCompleted:2,toolCalls:1,commandCompleted:1,usageRecords:1},lastTimestamp:"2026-01-01T00:00:01Z"}};
  assert.equal(healthAdvanced(before,{...before,summary:{...before.summary,counts:{...before.summary.counts}}}),false);
  assert.equal(healthAdvanced(before,{...before,fileBytes:101}),true);
  assert.equal(healthAdvanced(before,{...before,summary:{...before.summary,lastTimestamp:"2026-01-01T00:00:02Z",counts:{...before.summary.counts,reasoningCompleted:3}}}),true);
});

test("event health distinguishes a short quiet window from stale activity",()=>{
  const before={available:true,fileBytes:100,mtimeMs:95_000,summary:{kind:"native",lastAtMs:30,counts:{modelCompleted:1,toolCompleted:1}}};
  const same={...before,summary:{...before.summary,counts:{...before.summary.counts}}};
  assert.equal(classifyHealth(before,same,{nowMs:100_000,recentMs:60_000}),"recently-active");
  assert.equal(classifyHealth(before,{...same,mtimeMs:1},{nowMs:100_000,recentMs:60_000}),"quiet");
  assert.equal(classifyHealth(before,{...same,fileBytes:101},{nowMs:100_000,recentMs:60_000}),"progressed");
});
