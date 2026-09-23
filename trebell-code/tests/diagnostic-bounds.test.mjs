import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundDiagnosticText, boundDiagnosticValue } from "../src/diagnostic-bounds.mjs";
import { AgentThreadStore } from "../src/agent-thread-store.mjs";

test("diagnostic text keeps useful head and tail within a hard bound",()=>{
  const input="HEAD-"+("x".repeat(200_000))+"-TAIL";
  const bounded=boundDiagnosticText(input,16*1024);
  assert.ok(bounded.length<=16*1024);
  assert.match(bounded,/^HEAD-/);
  assert.match(bounded,/-TAIL$/);
  assert.match(bounded,/Trebell truncated/);
});

test("diagnostic objects stop at field, depth and character budgets without choking on cycles",()=>{
  const cyclic={kind:"tool",payload:"x".repeat(100_000),nested:{a:{b:{c:{d:"deep"}}}}};
  cyclic.self=cyclic;
  for(let i=0;i<200;i++)cyclic["field-"+i]="value-"+i;
  const bounded=boundDiagnosticValue(cyclic,{maxChars:4096,maxFields:24,maxDepth:4});
  const serialized=JSON.stringify(bounded);
  assert.ok(serialized.length<12_000);
  assert.match(serialized,/truncated|omitted/i);
  assert.equal(bounded.kind,"tool");
});

test("agent thread persistence bounds raw tool diagnostics but preserves conversation text",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-thread-bounds-"));const env={...process.env,TREBELL_HOME:home};
  try{
    const store=new AgentThreadStore(env);
    const thread=store.create({runtime:"claude",cwd:home,providerSessionId:"provider-1"});
    const turn=store.addTurn(thread.id,{inputText:"user text stays exact"});
    store.addItem(thread.id,turn.id,{type:"agentMessage",id:"assistant",text:"assistant text stays exact"});
    store.addItem(thread.id,turn.id,{
      type:"commandExecution",id:"tool",command:"huge-output",status:"completed",
      aggregatedOutput:"A".repeat(900_000)+"THE-END",
      rawInput:{payload:"I".repeat(500_000)},
      rawOutput:{payload:"O".repeat(900_000)},
    });
    const saved=JSON.parse(await readFile(join(home,"agent-threads.json"),"utf8"));
    const savedTurn=saved.threads[0].turns[0];
    assert.equal(savedTurn.items.find(item=>item.id==="user-"+turn.id).content[0].text,"user text stays exact");
    assert.equal(savedTurn.items.find(item=>item.id==="assistant").text,"assistant text stays exact");
    const tool=savedTurn.items.find(item=>item.id==="tool");
    assert.ok(tool.aggregatedOutput.length<=256*1024);
    assert.match(tool.aggregatedOutput,/THE-END$/);
    assert.match(JSON.stringify(tool.rawInput),/truncated|omitted/i);
    assert.match(JSON.stringify(tool.rawOutput),/truncated|omitted/i);
    assert.ok((await stat(join(home,"agent-threads.json"))).size<900_000);
  }finally{await rm(home,{recursive:true,force:true})}
});
