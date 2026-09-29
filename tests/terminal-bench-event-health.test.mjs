import test from "node:test";
import assert from "node:assert/strict";
import { summarizeCodexEventHealth, summarizeNativeEventHealth } from "../scripts/terminal-bench-event-health.mjs";

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
