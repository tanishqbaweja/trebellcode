import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
    const saved=new AgentThreadStore(env).get(thread.id),savedTurn=saved.turns[0];
    assert.equal(savedTurn.items.find(item=>item.id==="user-"+turn.id).content[0].text,"user text stays exact");
    assert.equal(savedTurn.items.find(item=>item.id==="assistant").text,"assistant text stays exact");
    const tool=savedTurn.items.find(item=>item.id==="tool");
    assert.ok(tool.aggregatedOutput.length<=256*1024);
    assert.match(tool.aggregatedOutput,/THE-END$/);
    assert.match(JSON.stringify(tool.rawInput),/truncated|omitted/i);
    assert.match(JSON.stringify(tool.rawOutput),/truncated|omitted/i);
    assert.ok(JSON.stringify(saved).length<900_000);
  }finally{await rm(home,{recursive:true,force:true})}
});

test("agent thread persistence redacts credentials from stored messages and tool diagnostics",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-thread-redaction-")),credential=["opaque","runtime","credential"].join("-");
  const env={...process.env,TREBELL_HOME:home,CUSTOM_RUNTIME_TOKEN:credential};
  try{
    const store=new AgentThreadStore(env),thread=store.create({runtime:"claude",cwd:home,providerSessionId:"provider-2"});
    const turn=store.addTurn(thread.id,{inputText:`use ${credential} for this request`});
    const tool=store.addItem(thread.id,turn.id,{type:"commandExecution",id:"tool-secret",aggregatedOutput:`stdout=${credential}`,rawInput:{authorization:`Bearer ${credential}`},rawOutput:{nested:{token:credential},text:`echo ${credential}`}});
    assert.doesNotMatch(JSON.stringify(tool),new RegExp(credential));
    assert.match(JSON.stringify(tool),/\[redacted\]/);
    const saved=new AgentThreadStore(env).get(thread.id),savedText=JSON.stringify(saved),savedTurn=saved.turns[0];
    assert.doesNotMatch(savedText,new RegExp(credential));
    assert.match(savedTurn.items.find(item=>item.id===`user-${turn.id}`).content[0].text,/\[redacted\]/);
    assert.match(JSON.stringify(savedTurn.items.find(item=>item.id==="tool-secret")),/\[redacted\]/);
  }finally{await rm(home,{recursive:true,force:true})}
});

test("bounded tool persistence still redacts retained secrets after truncation",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-thread-bounded-redaction-")),credential="retained-secret-value-12345";
  const env={...process.env,TREBELL_HOME:home,CUSTOM_RUNTIME_TOKEN:credential};
  try{
    const store=new AgentThreadStore(env),thread=store.create({runtime:"native",cwd:home,providerSessionId:"provider-3"}),turn=store.addTurn(thread.id,{inputText:"inspect output"});
    store.addItem(thread.id,turn.id,{
      type:"commandExecution",id:"large-secret-tool",status:"completed",
      aggregatedOutput:credential+"A".repeat(900_000)+credential,
      rawInput:{payload:credential+"I".repeat(500_000)+credential},
      rawOutput:{payload:credential+"O".repeat(900_000)+credential},
    });
    const savedText=JSON.stringify(new AgentThreadStore(env).get(thread.id));
    assert.doesNotMatch(savedText,new RegExp(credential));assert.match(savedText,/\[redacted\]/);
  }finally{await rm(home,{recursive:true,force:true})}
});
