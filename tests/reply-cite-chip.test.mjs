import test from "node:test";
import assert from "node:assert/strict";
import { citeAssistant } from "../ui/src/components/ReplyCiteButton.jsx";

// Cite's chip gives the length of what was cited, in plain words. It named the thread after it, which for a thread with no name yet
// was its id ('Assistant excerpt 5,999 chars · 419612d0-85b3-448f-90e3-28d6f...', tour L10-15).
async function cite(thread,message,excerpt=""){
  const added=[];let draft="";
  await citeAssistant({activeThread:thread,addContextAttachment:async chip=>{added.push(chip)},setPrompt:next=>{draft=typeof next==="function"?next(draft):next},citeNote:/Use the cited assistant text as context\./,citeSentence:"Use the cited assistant text as context."},message,excerpt);
  return {chip:added[0],draft};
}

test("the Cite chip of an excerpt gives its length and no thread id or name",async()=>{
  const id="419612d0-85b3-448f-90e3-28d6f0a1b2c3",excerpt="x".repeat(5999);
  const {chip,draft}=await cite({id},{id:"reply-1",text:"Earlier reply. "+excerpt},excerpt);
  assert.equal(chip.label,"Assistant excerpt");
  assert.equal(chip.detail,"5,999 chars");
  assert.equal(chip.detail.includes(id),false);
  assert.equal(draft,"Use the cited assistant text as context. ");
  // The file the agent reads still says where the text came from.
  assert.match(chip.text,new RegExp("^Assistant response excerpt\\nThread: "+id+"\\nMessage: reply-1\\n\\nx{5999}$"));
  // A thread with a name gets the same chip: what was cited, not where from.
  assert.equal((await cite({id,name:"Tide tables"},{id:"reply-1",text:"Short reply"},"Short")).chip.detail,"5 chars");
});

test("the Cite chip of a whole reply gives the reply's length and no thread id or name",async()=>{
  const id="419612d0-85b3-448f-90e3-28d6f0a1b2c3";
  const {chip}=await cite({id},{id:"reply-2",text:"The tide tables show two high tides a day."});
  assert.equal(chip.label,"Assistant citation");
  assert.equal(chip.detail,"42 chars");
  assert.equal((await cite({id,name:"Tide tables"},{id:"reply-3",text:"  Done.  "})).chip.detail,"5 chars");
});
