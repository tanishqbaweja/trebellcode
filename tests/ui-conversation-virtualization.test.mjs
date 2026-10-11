import test from "node:test";
import assert from "node:assert/strict";
import { CONVERSATION_CHUNK_SIZE, conversationChunkIndexForMessage, conversationVirtualChunks, estimateConversationMessageHeight, shouldVirtualizeConversation } from "../ui/src/conversation-virtualization.js";

function messages(count,offset=0){
  return Array.from({length:count},(_,index)=>({id:"m-"+(offset+index),role:index%2?"assistant":"user",text:"x".repeat(20+(index%17)*30)}));
}

test("conversation virtualization keeps small conversations unwindowed",()=>{
  assert.equal(shouldVirtualizeConversation(messages(100)),false);
  assert.equal(shouldVirtualizeConversation(messages(200)),true);
});

test("conversation chunks are bounded and aligned from the newest end",()=>{
  const original=messages(100),chunks=conversationVirtualChunks(original);
  assert.equal(chunks.at(-1).messages.length,CONVERSATION_CHUNK_SIZE);
  assert.deepEqual(chunks.at(-1).messages.map(item=>item.id),original.slice(-CONVERSATION_CHUNK_SIZE).map(item=>item.id));
  const prepended=[...messages(10,-10),...original],next=conversationVirtualChunks(prepended);
  assert.equal(next.at(-1).key,chunks.at(-1).key);
  assert.equal(next.at(-2).key,chunks.at(-2).key);
});

test("active find targets resolve to their virtual chunk",()=>{
  const chunks=conversationVirtualChunks(messages(500));
  const index=conversationChunkIndexForMessage(chunks,"m-233");
  assert.ok(index>=0);assert.ok(chunks[index].messages.some(item=>item.id==="m-233"));
  assert.equal(conversationChunkIndexForMessage(chunks,"missing"),-1);
});

test("height estimates stay positive and bounded for placeholder stability",()=>{
  assert.ok(estimateConversationMessageHeight({role:"user",text:"hi"})>=54);
  assert.ok(estimateConversationMessageHeight({role:"assistant",text:"x".repeat(100_000)})<=560);
});

test("the closed activity cards a row carries add to its chunk's estimate, and the chunk keys stay the same",()=>{
  const original=messages(100),plain=conversationVirtualChunks(original);
  const withCards=conversationVirtualChunks(original,{extraHeight:message=>message.id==="m-99"||message.id==="m-98"?58:0});
  assert.deepEqual(withCards.map(chunk=>chunk.key),plain.map(chunk=>chunk.key));
  assert.equal(withCards.at(-1).estimatedHeight,plain.at(-1).estimatedHeight+116);
  assert.equal(withCards[0].estimatedHeight,plain[0].estimatedHeight);
  // A bad or negative height adds nothing.
  assert.deepEqual(conversationVirtualChunks(original,{extraHeight:()=>-40}).map(chunk=>chunk.estimatedHeight),plain.map(chunk=>chunk.estimatedHeight));
  assert.deepEqual(conversationVirtualChunks(original,{extraHeight:()=>"wide"}).map(chunk=>chunk.estimatedHeight),plain.map(chunk=>chunk.estimatedHeight));
});
