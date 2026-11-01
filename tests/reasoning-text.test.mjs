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

test("a collapsed thought's line leaves out the mark a heading, list item, numbered item or quote opens with",()=>{
  assert.equal(reasoningPreview("## Plan\r\n> quoted\r\n"),"Plan");
  assert.equal(reasoningPreview("## Plan\r\n> quoted\r\n",{latest:true}),"quoted","a Windows line end is not part of the line");
  assert.equal(reasoningPreview("12. Run the tests"),"Run the tests");
  assert.equal(reasoningPreview("12. Run the tests\n\t*  starred\n+ plussed",{latest:true}),"plussed");
  assert.equal(reasoningPreview("\t*  starred"),"starred");
  assert.equal(reasoningPreview("   ###\tSpaced heading  "),"Spaced heading");
  assert.equal(reasoningPreview("#tag -x >y 1.5"),"#tag -x >y 1.5","a mark with no space or tab after it is text");
  assert.equal(reasoningPreview("####### Seven"),"####### Seven","seven #s are not a heading");
  assert.equal(reasoningPreview("> - item"),"- item","only the first mark goes");
});

test("a collapsed thought's line keeps a link's or image's words and leaves out code ticks, ** __ and ~~, but not a lone * _ or ~",()=>{
  const text="12. Run ~~old~~ __new__ tests\n+ ![diagram](a.png) shows [it](https://example.test/it) works";
  assert.equal(reasoningPreview(text),"Run old new tests");
  assert.equal(reasoningPreview(text,{latest:true}),"diagram shows it works");
  assert.equal(reasoningPreview("2 * 3 and snake_case ~5"),"2 * 3 and snake_case ~5");
  assert.equal(reasoningPreview("***both***"),"*both*","the marks go in pairs, left to right");
  assert.equal(reasoningPreview("```js"),"js");
  assert.equal(reasoningPreview("[open link](no-close and [no target]"),"[open link](no-close and [no target]","link syntax that is not closed stays as typed");
  assert.equal(reasoningPreview("!![a](b) [c] [d](e)"),"!a [c] d");
});

test("a collapsed thought's latest line skips lines that only hold marks, and a thought with no words shows none",()=>{
  assert.equal(reasoningPreview("last line\n- \n```\n",{latest:true}),"last line");
  assert.equal(reasoningPreview("\n\n**First**\nsecond"),"First");
  for(const empty of [undefined,null,"",0,"**\n> \n``"])assert.equal(reasoningPreview(empty,{latest:true}),"");
  assert.equal(reasoningPreview("First\nsecond",null),"First","no options means the first line");
});

test("a collapsed thought's line reads a link as its words before its marks, keeps a carriage return that ends no line and reads any other value as text",()=>{
  assert.equal(reasoningPreview("[# a](b)"),"a","a mark at the start of a link's words is a mark");
  assert.equal(reasoningPreview("[[a](b)](c)"),"[a](c)","a link's words are not read again for links");
  assert.equal(reasoningPreview("see ![c] here"),"see ![c] here","a ! goes only with a link it opens");
  assert.equal(reasoningPreview("2026."),"2026.");
  assert.equal(reasoningPreview("a\rb",{latest:true}),"a\rb","only a line feed ends a line");
  assert.equal(reasoningPreview("- done\r",{latest:true}),"done");
  assert.equal(reasoningPreview(false,{latest:true}),"");
  assert.equal(reasoningPreview(7),"7");
});

test("a collapsed thought's line takes time in step with its length, even when a line is full of brackets",()=>{
  const lines=["[".repeat(100_000),"[](".repeat(40_000),"[".repeat(100_000)+"]x","x [y]".repeat(30_000)];
  const started=performance.now();
  for(const line of lines){assert.equal(reasoningPreview(line),line);assert.equal(reasoningPreview("first\n"+line,{latest:true}),line)}
  assert.ok(performance.now()-started<2000,"no line is read again from every [");
});

test("a finished thought becomes a conversation row, and one without text becomes none",()=>{
  assert.deepEqual(reasoningHistoryMessage({type:"reasoning",id:"r1",summary:[],content:["Thinking it over."]},"t1"),{id:"r1",role:"reasoning",text:"Thinking it over.",turnId:"t1"});
  assert.deepEqual(reasoningHistoryMessage({type:"reasoning",id:"r2",summary:[],content:[]},"t1","Streamed text"),{id:"r2",role:"reasoning",text:"Streamed text",turnId:"t1"},"the streamed text stands in when the finished item has none");
  assert.equal(reasoningHistoryMessage({type:"reasoning",id:"r3",summary:[],content:[]},"t1"),null);
  assert.equal(reasoningHistoryMessage({type:"reasoning",summary:[],content:["no id"]},"t1"),null);
  assert.equal(estimateConversationMessageHeight({role:"reasoning",text:"x".repeat(5000)}),40,"a collapsed thought is one line high");
});
