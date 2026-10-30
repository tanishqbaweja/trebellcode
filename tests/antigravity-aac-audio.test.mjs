// An .aac attached to an Antigravity chat, which takes audio/aac as audio when its promptCapabilities take audio. Trebell's
// composer sends only mp3, wav, m4a, ogg and flac as audio (App.jsx inputsFor), so an .aac goes as a file link, which Antigravity 1.2.1
// cannot open in Trebell's attachments folder, and its sound never reached the model. Antigravity's own prompt now adds the audio after
// the link, within the same 20 MiB a file and 50 MiB a message; every other harness gets the link as before.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { antigravityPromptParts } from "../src/acp-agent-session.mjs";
import { contextualAgentPrompt } from "../src/agent-relay.mjs";
import { isSessionRefusal } from "../src/session-refusal.mjs";

const MiB=1024*1024,ADVERTISED=Object.freeze({image:true,audio:true,embeddedContext:true});
const shape=parts=>parts.map(part=>part.type==="text"?["text",part.text]:part.data!=null?[part.type,part.mimeType,Buffer.byteLength(part.data,"base64")]:[part.type,part.name??null]);
async function folder(t){
  const root=await mkdtemp(join(tmpdir(),"trebell-agy-aac-"));
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  return root;
}

test("an .aac attached to an Antigravity chat goes as audio after its file link when Antigravity takes audio, and as the link alone otherwise",async t=>{
  const root=await folder(t),voice=join(root,"1761500000000-ab12cd34-voice.aac");await writeFile(voice,Buffer.from([0xff,0xf1,0x50,0x80,0x01,0x7f,0xfc]));
  // The relay's prompt: the composer sends an .aac as a file (a mention), a file link for every harness.
  const parts=await contextualAgentPrompt([{type:"text",text:"What does it say?"},{type:"mention",name:"voice.aac",path:voice}]);
  assert.deepEqual(shape(parts),[["text","What does it say?"],["resource_link","voice.aac"]]);
  assert.deepEqual(shape(await antigravityPromptParts(parts,ADVERTISED)),[["text","What does it say?"],["resource_link","voice.aac"],["audio","audio/aac",7]]);
  for(const capabilities of [{...ADVERTISED,audio:false},{},undefined])assert.deepEqual(shape(await antigravityPromptParts(parts,capabilities)),[["text","What does it say?"],["resource_link","voice.aac"]]);
});

test("an .aac over 20 MiB stays the link alone, and one that is gone is refused by its name, as an mp3 is",async t=>{
  const root=await folder(t),big=join(root,"big.aac");await writeFile(big,"");await truncate(big,20*MiB+1);
  const link=path=>contextualAgentPrompt([{type:"mention",name:"x.aac",path}]);
  assert.deepEqual(shape(await antigravityPromptParts(await link(big),ADVERTISED)),[["resource_link","x.aac"]]);
  await assert.rejects(antigravityPromptParts(await link(join(root,"1761500000000-ab12cd34-gone.aac")),ADVERTISED),error=>{
    assert.ok(isSessionRefusal(error));assert.equal(error.message,'The attached file "gone.aac" could not be read (ENOENT). Attach it again.');return true;
  });
});
