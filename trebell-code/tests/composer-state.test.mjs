import test from "node:test";
import assert from "node:assert/strict";
import { isVideoAttachment, restoreQueuedDraft } from "../ui/src/composer-state.js";

test("stopping restores queued text, attachments and context without duplicates",()=>{
  const restored=restoreQueuedDraft({
    prompt:"existing draft",
    attachments:["a.txt"],
    contextChips:[{id:"c1",path:"context.txt",label:"Existing"}],
    queued:[
      {text:"first queued",attachments:["b.png","a.txt"],contextChips:[{id:"c2",path:"review.txt",label:"Review"}]},
      {text:"second queued",attachments:["c.md"],contextChips:[{id:"c3",path:"context.txt",label:"Updated context"}]},
    ],
  });
  assert.equal(restored.prompt,"existing draft\n\nfirst queued\n\nsecond queued");
  assert.deepEqual(restored.attachments,["a.txt","b.png","c.md"]);
  assert.deepEqual(restored.contextChips.map(item=>[item.path,item.label]),[["context.txt","Updated context"],["review.txt","Review"]]);
});

test("Antigravity video attachment detection covers common video extensions",()=>{
  for(const path of ["clip.mp4","movie.MOV","demo.webm","x.mkv","y.m4v"])assert.equal(isVideoAttachment(path),true,path);
  for(const path of ["image.png","notes.md","audio.mp3"])assert.equal(isVideoAttachment(path),false,path);
});
