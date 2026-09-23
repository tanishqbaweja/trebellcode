import test from "node:test";
import assert from "node:assert/strict";
import { mergeNativeQueue, nativeQueueUnavailable, queuedSubmissionDraft, reorderQueue } from "../ui/src/native-queue.js";

test("native queue submissions become Trebell drafts without losing local attachments",()=>{
  const draft=queuedSubmissionDraft({
    id:"q1",clientUserMessageId:"client-1",
    input:[
      {type:"text",text:"follow up",text_elements:[]},
      {type:"localImage",path:"C:/tmp/shot.png"},
      {type:"mention",name:"notes.md",path:"C:/repo/notes.md"},
    ],
  });
  assert.equal(draft.id,"q1");assert.equal(draft.text,"follow up");assert.equal(draft.draftText,"follow up");
  assert.deepEqual(draft.attachments,["C:/tmp/shot.png","C:/repo/notes.md"]);assert.equal(draft.native,true);assert.equal(draft.editable,true);
  assert.deepEqual(draft.contextChips,[{path:"C:/repo/notes.md",kind:"file",label:"notes.md",detail:"C:/repo/notes.md"}]);
});

test("queue payloads from another client do not fake editability for remote media",()=>{
  const draft=queuedSubmissionDraft({id:"q2",clientUserMessageId:"client-2",input:[{type:"text",text:"inspect this",text_elements:[]},{type:"image",url:"https://example.invalid/a.png"}]});
  assert.equal(draft.text,"inspect this");assert.equal(draft.editable,false);assert.deepEqual(draft.attachments,[]);
});

test("refreshing a native queue preserves Trebell-only draft metadata for matching items",()=>{
  const previous=[{id:"q1",native:true,clientUserMessageId:"client-1",contextChips:[{path:"a",label:"Context"}],model:"model-a"}];
  const merged=mergeNativeQueue(previous,[{id:"q1",clientUserMessageId:"client-1",input:[{type:"text",text:"updated",text_elements:[]}]}]);
  assert.equal(merged[0].text,"updated");assert.deepEqual(merged[0].contextChips,previous[0].contextChips);assert.equal(merged[0].model,"model-a");
});

test("native queue fallback detection ignores ordinary request failures",()=>{
  assert.equal(nativeQueueUnavailable(new Error("Method not found: thread/queue/list")),true);
  assert.equal(nativeQueueUnavailable(new Error("user message queue is unavailable")),true);
  assert.equal(nativeQueueUnavailable(new Error("network timeout")),false);
});

test("queued submissions can be reordered without mutating the source list",()=>{
  const source=[{id:"a"},{id:"b"},{id:"c"}];const moved=reorderQueue(source,"b",-1);
  assert.deepEqual(moved.map(item=>item.id),["b","a","c"]);assert.deepEqual(source.map(item=>item.id),["a","b","c"]);
  assert.deepEqual(reorderQueue(source,"a",-1),source);
});
