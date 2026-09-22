import test from "node:test";
import assert from "node:assert/strict";
import { matchingMessageExcerpt, searchableThreadMessage } from "../ui/src/thread-message-search.js";

test("thread message search indexes only user and final agent messages",()=>{
  assert.equal(searchableThreadMessage({type:"userMessage",content:[{type:"text",text:"Fix the payment callback"}]}),"Fix the payment callback");
  assert.equal(searchableThreadMessage({type:"agentMessage",text:"Implemented the webhook retry."}),"Implemented the webhook retry.");
  assert.equal(searchableThreadMessage({type:"reasoning",text:"secret scratchpad"}),"");
  assert.equal(searchableThreadMessage({type:"commandExecution",text:"npm test"}),"");
});

test("thread message search returns a compact excerpt around the match",()=>{
  const items=[
    {item:{type:"agentMessage",text:"This is unrelated."}},
    {item:{type:"userMessage",content:[{type:"text",text:"Please investigate the incredibly annoying payment callback failure in checkout."}]}},
  ];
  const excerpt=matchingMessageExcerpt(items,"payment callback",{maxLength:70});
  assert.match(excerpt,/payment callback/i);
  assert.ok(excerpt.length<=72);
  assert.equal(matchingMessageExcerpt(items,"p"),null);
  assert.equal(matchingMessageExcerpt(items,"missing"),null);
});
