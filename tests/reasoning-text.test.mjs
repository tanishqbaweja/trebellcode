import test from "node:test";
import assert from "node:assert/strict";
import { reasoningHistoryMessage, reasoningItemText, reasoningPreview } from "../ui/src/reasoning-text.js";
import { estimateConversationMessageHeight } from "../ui/src/conversation-virtualization.js";

test("a reasoning item's text joins Codex's summary parts and raw content, and the relay's one content part",()=>{
  assert.equal(reasoningItemText({type:"reasoning",id:"rs_1",summary:["**Planning**\n\nFirst look.","**Checking**"],content:[]}),"**Planning**\n\nFirst look.\n\n**Checking**");
  assert.equal(reasoningItemText({type:"reasoning",id:"rs_2",summary:[{type:"summary_text",text:"Summary"}],content:["Raw thought"]}),"Summary\n\nRaw thought");
  assert.equal(reasoningItemText({type:"reasoning",id:"reasoning-1",summary:[],content:["\nWeighing the options.\n"]}),"Weighing the options.");
  assert.equal(reasoningItemText({type:"reasoning",id:"rs_3",summary:[],content:[]}),"");
});

test("a collapsed thought shows its latest line while it streams and its first line once done, as plain text",()=>{
  const text="**Inspecting the repository**\n\nI will read `src/app.js` first.\n- then run [the tests](https://example.test)";
  assert.equal(reasoningPreview(text),"Inspecting the repository");
  assert.equal(reasoningPreview(text,{latest:true}),"then run the tests");
  assert.equal(reasoningPreview("Half a sent",{latest:true}),"Half a sent");
  assert.equal(reasoningPreview("   \n\n "),"");
});

test("a finished thought becomes a conversation row, and one without text becomes none",()=>{
  assert.deepEqual(reasoningHistoryMessage({type:"reasoning",id:"r1",summary:[],content:["Thinking it over."]},"t1"),{id:"r1",role:"reasoning",text:"Thinking it over.",turnId:"t1"});
  assert.deepEqual(reasoningHistoryMessage({type:"reasoning",id:"r2",summary:[],content:[]},"t1","Streamed text"),{id:"r2",role:"reasoning",text:"Streamed text",turnId:"t1"},"the streamed text stands in when the finished item has none");
  assert.equal(reasoningHistoryMessage({type:"reasoning",id:"r3",summary:[],content:[]},"t1"),null);
  assert.equal(reasoningHistoryMessage({type:"reasoning",summary:[],content:["no id"]},"t1"),null);
  assert.equal(estimateConversationMessageHeight({role:"reasoning",text:"x".repeat(5000)}),40,"a collapsed thought is one line high");
});
