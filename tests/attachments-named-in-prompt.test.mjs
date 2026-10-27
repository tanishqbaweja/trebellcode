// Every attachment is named in the prompt whatever the length of its text (T3 550f119c3: "The text-input budget must never hide the
// existence of an attachment"), and one Trebell cannot read is said plainly, with what to do, before the harness has anything (T3
// 300a35670: "an attachment could not be read"), instead of Node's bare error.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_MAX_INPUT_CHARS, codexTurnInput, splitCodexAttachmentText } from "../ui/src/codex-turn-options.js";
import { contextualAgentPrompt } from "../src/agent-relay.mjs";
import { EnvironmentManager } from "../src/environment-manager.mjs";
import { museInputParts } from "../src/muse-agent-session.mjs";
import { isSessionRefusal } from "../src/session-refusal.mjs";
import { acpRelay, scriptedAcp } from "./fixtures/scripted-acp.mjs";

const GROK={initialize:{protocolVersion:1,agentCapabilities:{loadSession:true,sessionCapabilities:{resume:{}}}},sessionNew:{sessionId:"grok-session"}};
const requested=(log,method)=>log.filter(entry=>entry.method===method);
// A folder of its own, removed after the test.
async function folder(t){
  const root=await mkdtemp(join(tmpdir(),"trebell-attachments-named-"));
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  return root;
}

test("a Codex prompt at the composer's limit still names every attachment after its text, and the draft gets them all back",()=>{
  const name=path=>path.split("/").pop();
  // What follows the typed text, compared on its own so a failure does not print 120,000 characters.
  const after=(input,long)=>{assert.ok(input.text.startsWith(long),"the typed text comes first, whole");return input.text.slice(long.length)};
  for(const long of ["x".repeat(CODEX_MAX_INPUT_CHARS-10),"y".repeat(CODEX_MAX_INPUT_CHARS)]){
    const [text,...media]=codexTurnInput(long,["H:/a/spec.pdf","H:/a/notes.md"],{displayName:name});
    assert.equal(after(text,long),'\n\n[Attached file "spec.pdf" is saved at: H:/a/spec.pdf]\n\n[Attached file "notes.md" is saved at: H:/a/notes.md]',`${long.length} characters`);
    assert.deepEqual(media,[],"files have no item of their own: the line is how Codex finds them");
    const split=splitCodexAttachmentText(text.text);
    assert.equal(split.text.length,long.length);assert.deepEqual(split.paths,["H:/a/spec.pdf","H:/a/notes.md"]);
  }
  const long="z".repeat(CODEX_MAX_INPUT_CHARS-10),[text,image]=codexTurnInput(long,["H:/a/big.png"],{displayName:name});
  assert.equal(after(text,long),'\n\n[Attached image "big.png" is saved at: H:/a/big.png]',"an image is named too, besides its own item");
  assert.deepEqual(image,{type:"localImage",path:"H:/a/big.png"});
});

test("an attached image whose saved file is gone is refused by its name with what to do, not with Node's bare error",async t=>{
  const root=await folder(t),gone=join(root,"1761500000000-ab12cd34-shot.png");
  await assert.rejects(contextualAgentPrompt([{type:"text",text:"What is this?"},{type:"localImage",path:gone}]),error=>{
    assert.equal(error.message,'The attached image "shot.png" could not be read (ENOENT). Attach it again.');
    assert.ok(isSessionRefusal(error),"the harness had nothing yet, so it is asked nothing");
    return true;
  });
  // One that is there still goes as an image.
  const there=join(root,"there.png");await writeFile(there,Buffer.from([137,80,78,71]));
  const [,image]=await contextualAgentPrompt([{type:"text",text:"What is this?"},{type:"localImage",path:there}]);
  assert.deepEqual(image,{type:"image",mimeType:"image/png",data:Buffer.from([137,80,78,71]).toString("base64")});
});

test("Muse Code's turn input names every attachment of a long message, and an image that is gone is refused by its name first",async t=>{
  const root=await folder(t),shot=join(root,"shot.png"),notes=join(root,"notes.md"),long="m".repeat(CODEX_MAX_INPUT_CHARS);
  await writeFile(shot,Buffer.from([137,80,78,71]));await writeFile(notes,"# Notes\n","utf8");
  const files=[{type:"localImage",path:shot},{type:"mention",name:"notes.md",path:notes},{type:"localAudio",path:join(root,"memo.mp3")}];
  const input=museInputParts(await contextualAgentPrompt([{type:"text",text:long},...files]));
  assert.deepEqual(input.map(part=>part.type==="image"?["image",part.mediaType]:["text",part.text.length>200?part.text.length:part.text]),[
    ["text",long.length],["image","image/png"],["text",`Attached file: ${notes}`],["text",`[Attached audio "memo.mp3" is saved at: ${join(root,"memo.mp3")}]`],
  ],"no text budget leaves one out");
  await assert.rejects(contextualAgentPrompt([{type:"text",text:"What is this?"},{type:"localImage",path:join(root,"gone.png")}]).then(museInputParts),{message:'The attached image "gone.png" could not be read (ENOENT). Attach it again.'});
});

test("a send whose attached image is gone is refused by its name before its turn exists, the harness is sent nothing, and the thread goes on",async t=>{
  const fx=await scriptedAcp(t,{...GROK,prompts:[{}]});
  const {ws,rpc,next,threadStore}=await acpRelay(t,"grok",fx);
  const started=await rpc("thread/start",{cwd:fx.root,approvalPolicy:"on-request",sandbox:"workspace-write"}),threadId=started.thread.id;
  let turnStarted=false;const listen=raw=>{if(JSON.parse(String(raw)).method==="turn/started")turnStarted=true};ws.on("message",listen);
  await assert.rejects(rpc("turn/start",{threadId,input:[{type:"text",text:"What is this?"},{type:"localImage",path:join(fx.root,"1761500000000-ab12cd34-shot.png")}]}),
    {message:'The attached image "shot.png" could not be read (ENOENT). Attach it again.'});
  assert.deepEqual(threadStore.get(threadId).turns,[],"no turn is left running behind the refusal");
  assert.notEqual(threadStore.get(threadId).status?.type,"active");
  assert.equal(turnStarted,false,"the window was told of no turn");ws.off("message",listen);
  assert.equal(requested(await fx.log(),"session/prompt").length,0,"Grok was sent nothing");
  const completed=next(message=>message.method==="turn/completed");
  await rpc("turn/start",{threadId,input:[{type:"text",text:"Never mind."}]});
  assert.equal((await completed).params.turn.status,"completed","the next message runs");
  assert.deepEqual(threadStore.get(threadId).turns.map(turn=>turn.status),["completed"]);
});

test("a send whose attached file is gone is refused by its name with what to do, before anything is sent",async t=>{
  const root=await folder(t),manager=new EnvironmentManager({state:{environments:()=>[]}});
  const kept=join(root,"1761500000000-ab12cd34-notes.txt");await writeFile(kept,"notes","utf8");
  assert.equal((await manager.validateAttachments(null,[kept])).count,1);
  await assert.rejects(manager.validateAttachments(null,[kept,join(root,"1761500000000-ab12cd34-report.pdf")]),{message:'The attached file "report.pdf" could not be read (ENOENT). Attach it again.'});
  await assert.rejects(manager.validateAttachments(null,[join(root,"gone.png")]),{message:'The attached image "gone.png" could not be read (ENOENT). Attach it again.'});
  // Nor is a file taken in (an @ file, a pick) once it is gone.
  await assert.rejects(manager.prepareAttachment(null,join(root,"1761500000000-ab12cd34-report.pdf")),{message:'The attached file "report.pdf" could not be read (ENOENT). Attach it again.'});
});
