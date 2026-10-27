// What Antigravity is sent of a message's attachments follows the promptCapabilities its initialize advertises (T3 buildAntigravityPrompt,
// 532023a24): audio as audio, BMP, JPEG, PNG and WebP images as images, and with embedded context a UTF-8 text file as embedded content
// and a PDF as a document link, within 50 MiB a message. Any other attachment is named by its saved path, as every other harness gets
// audio, so a GIF no longer goes as an image Antigravity may refuse, and an mp3 reaches the model instead of a path Antigravity cannot open.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { antigravityPromptParts } from "../src/acp-agent-session.mjs";
import { contextualAgentPrompt } from "../src/agent-relay.mjs";
import { fileUri } from "../src/file-uri.mjs";
import { isSessionRefusal } from "../src/session-refusal.mjs";
import { acpRelay, acpSession, scriptedAcp, select } from "./fixtures/scripted-acp.mjs";

const MiB=1024*1024;
// What Antigravity advertises in its initialize (1.2.1 and 1.4.3, read live in isolated homes): images, audio and embedded context.
const ADVERTISED=Object.freeze({image:true,audio:true,embeddedContext:true});
const antigravity=promptCapabilities=>({initialize:{protocolVersion:1,agentCapabilities:{sessionCapabilities:{resume:{}},...(promptCapabilities?{promptCapabilities}:{})}},sessionNew:{sessionId:"agy-session",configOptions:[select("mode","mode","default",["default","auto_edit","yolo"])]},prompts:[{}]});
const GROK={initialize:{protocolVersion:1,agentCapabilities:{loadSession:true,sessionCapabilities:{resume:{}},promptCapabilities:ADVERTISED}},sessionNew:{sessionId:"grok-session"},prompts:[{}]};
const requested=(log,method)=>log.filter(entry=>entry.method===method);
const base64=bytes=>Buffer.from(bytes).toString("base64");
// The line that names an attachment by its saved path.
const named=(kind,path)=>({type:"text",text:`[Attached ${kind} "${basename(path)}" is saved at: ${path}]`});
// A message's prompt as the relay builds it for a turn.
const relayPrompt=(text,files)=>contextualAgentPrompt([{type:"text",text},...files]);
async function folder(t){
  const root=await mkdtemp(join(tmpdir(),"trebell-agy-prompt-"));
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  return root;
}
// A file of zeros of that size, written without holding it in memory.
async function sized(path,bytes){await writeFile(path,"");await truncate(path,bytes);return path}

test("an attached audio file goes to Antigravity as audio when it takes audio, and otherwise by its saved path",async t=>{
  const root=await folder(t),mp3=join(root,"1761500000000-ab12cd34-memo.mp3"),wav=join(root,"take 2.wav"),long=await sized(join(root,"long.flac"),20*MiB+1);
  await writeFile(mp3,"ID3 mp3 bytes");await writeFile(wav,"RIFF wav bytes");
  const prompt=await relayPrompt("What is said?",[{type:"localAudio",path:mp3},{type:"localAudio",path:wav},{type:"localAudio",path:long}]);
  assert.deepEqual(await antigravityPromptParts(prompt,{audio:true}),[
    {type:"text",text:"What is said?"},{type:"audio",mimeType:"audio/mpeg",data:base64("ID3 mp3 bytes")},{type:"audio",mimeType:"audio/wav",data:base64("RIFF wav bytes")},
    named("audio",long),
  ],"audio up to 20 MiB goes as audio; a longer file is named by its saved path");
  for(const capabilities of [{audio:false},{},undefined,{image:true,embeddedContext:true}]){
    assert.deepEqual(await antigravityPromptParts(prompt,capabilities),[{type:"text",text:"What is said?"},named("audio",mp3),named("audio",wav),named("audio",long)],`with ${JSON.stringify(capabilities)}`);
  }
});

test("only BMP, JPEG, PNG and WebP images go to Antigravity as images, and only when it takes images; any other is named by its saved path",async t=>{
  const root=await folder(t),png=join(root,"shot.png"),gif=join(root,"1761500000000-ab12cd34-loop.gif"),webp=join(root,"photo.webp"),bmp=join(root,"scan.bmp");
  await writeFile(png,Buffer.from([137,80,78,71]));await writeFile(gif,"GIF89a");await writeFile(webp,"RIFFWEBP");await writeFile(bmp,"BM");
  const prompt=await relayPrompt("Look",[png,gif,webp,bmp].map(path=>({type:"localImage",path})));
  assert.deepEqual(await antigravityPromptParts(prompt,{image:true}),[
    {type:"text",text:"Look"},{type:"image",mimeType:"image/png",data:base64([137,80,78,71])},named("image",gif),
    {type:"image",mimeType:"image/webp",data:base64("RIFFWEBP")},{type:"image",mimeType:"image/bmp",data:base64("BM")},
  ]);
  assert.deepEqual(await antigravityPromptParts(prompt,{audio:true,embeddedContext:true}),[{type:"text",text:"Look"},...[png,gif,webp,bmp].map(path=>named("image",path))],"without image no image goes as one");
});

test("with embedded context a text file goes embedded and a PDF as a document link; without it both stay plain links",async t=>{
  const root=await folder(t),notes=join(root,"notes.md"),pdf=join(root,"spec.pdf");
  await writeFile(notes,"# Notes\n","utf8");await writeFile(pdf,"%PDF-1.7");
  const prompt=await relayPrompt("Read these",[{type:"mention",name:"notes.md",path:notes},{type:"mention",name:"spec.pdf",path:pdf}]);
  assert.deepEqual(await antigravityPromptParts(prompt,{embeddedContext:true}),[
    {type:"text",text:"Read these"},
    {type:"resource",resource:{uri:pathToFileURL(notes).href,mimeType:"text/markdown",text:"# Notes\n"}},
    {type:"resource_link",uri:fileUri(pdf),name:"spec.pdf",mimeType:"application/pdf"},
  ]);
  assert.deepEqual(await antigravityPromptParts(prompt,{image:true,audio:true}),[
    {type:"text",text:"Read these"},{type:"resource_link",uri:fileUri(notes),name:"notes.md"},{type:"resource_link",uri:fileUri(pdf),name:"spec.pdf"},
  ]);
});

test("Antigravity is sent at most 50 MiB of attachment content a message, images and audio together; what does not fit is named by its saved path",async t=>{
  const root=await folder(t);
  const first=await sized(join(root,"part-1.mp3"),18*MiB),second=await sized(join(root,"part-2.mp3"),18*MiB);
  const shot=await sized(join(root,"shot.png"),9*MiB),again=await sized(join(root,"again.png"),9*MiB);
  const prompt=await relayPrompt("Transcribe and describe",[{type:"localAudio",path:first},{type:"localAudio",path:second},{type:"localImage",path:shot},{type:"localImage",path:again}]);
  const parts=await antigravityPromptParts(prompt,ADVERTISED);
  assert.deepEqual(parts.map(part=>part.type==="text"?["text",part.text]:[part.type,part.mimeType,Buffer.byteLength(part.data,"base64")]),[
    ["text","Transcribe and describe"],["audio","audio/mpeg",18*MiB],["audio","audio/mpeg",18*MiB],["image","image/png",9*MiB],["text",named("image",again).text],
  ],"45 MiB go as content; the next 9 MiB would pass 50 MiB");
});

test("an attached audio file that Antigravity would hear but is gone is refused by its name with what to do",async t=>{
  const root=await folder(t),gone=join(root,"1761500000000-ab12cd34-memo.mp3");
  const prompt=await relayPrompt("What is said?",[{type:"localAudio",path:gone}]);
  await assert.rejects(antigravityPromptParts(prompt,{audio:true}),error=>{
    assert.equal(error.message,'The attached file "memo.mp3" could not be read (ENOENT). Attach it again.');
    assert.ok(isSessionRefusal(error),"Antigravity had nothing yet, so it is asked nothing");
    return true;
  });
  assert.deepEqual(await antigravityPromptParts(prompt,{audio:false}),[{type:"text",text:"What is said?"},named("audio",gone)],"one it is not sent as audio is named, as before");
});

test("an Antigravity session decides each attachment from the promptCapabilities its initialize advertised",async t=>{
  const root=await folder(t),mp3=join(root,"memo.mp3"),gif=join(root,"loop.gif"),png=join(root,"shot.png");
  await writeFile(mp3,"ID3");await writeFile(gif,"GIF89a");await writeFile(png,Buffer.from([137,80,78,71]));
  const files=[{type:"localAudio",path:mp3},{type:"localImage",path:gif},{type:"localImage",path:png}];
  // What the agent got, without the runtime note that ends a session's first prompt.
  const sent=async capabilities=>{
    const fx=await scriptedAcp(t,antigravity(capabilities)),{session}=acpSession(t,fx,{runtime:"antigravity"});
    await session.start();await session.prompt(await relayPrompt("What is this?",files));
    return requested(await fx.log(),"session/prompt")[0].params.prompt.slice(0,-1);
  };
  assert.deepEqual(await sent(ADVERTISED),[{type:"text",text:"What is this?"},{type:"audio",mimeType:"audio/mpeg",data:base64("ID3")},named("image",gif),{type:"image",mimeType:"image/png",data:base64([137,80,78,71])}]);
  assert.deepEqual(await sent(null),[{type:"text",text:"What is this?"},named("audio",mp3),named("image",gif),named("image",png)],"an Antigravity that advertises nothing gets every attachment by its path");
});

test("through the relay an attached audio file reaches Antigravity as audio, and Grok, as every other harness, by its saved path",async t=>{
  for(const [kind,config] of [["antigravity",antigravity(ADVERTISED)],["grok",GROK]]){
    const fx=await scriptedAcp(t,config),mp3=join(fx.root,"memo.mp3");await writeFile(mp3,"ID3");
    const {rpc,next}=await acpRelay(t,kind,fx);
    const started=await rpc("thread/start",{cwd:fx.root,approvalPolicy:"on-request",sandbox:"workspace-write"});
    const completed=next(message=>message.method==="turn/completed");
    await rpc("turn/start",{threadId:started.thread.id,input:[{type:"text",text:"What is said?"},{type:"localAudio",path:mp3}]});
    assert.equal((await completed).params.turn.status,"completed",kind);
    const prompt=requested(await fx.log(),"session/prompt")[0].params.prompt;
    const audio=prompt.filter(part=>part.type==="audio"),line=prompt.filter(part=>part.type==="text"&&part.text===named("audio",mp3).text);
    if(kind==="antigravity"){assert.deepEqual(audio,[{type:"audio",mimeType:"audio/mpeg",data:base64("ID3")}]);assert.equal(line.length,0)}
    else{assert.equal(audio.length,0,"Grok advertises audio too, yet only Antigravity's session sends it as audio");assert.equal(line.length,1)}
  }
});
