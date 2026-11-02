// What Antigravity is sent of a message's attachments follows the promptCapabilities its initialize advertises: audio as audio
// after the line that names it, PNG, JPEG, WebP, HEIC and HEIF images as images, and with embedded context a UTF-8 text file as
// embedded content and a PDF as a document link, while the message has room; an image it takes that cannot go refuses the message.
// Any other attachment is named by its saved path, as every other harness gets audio, so a GIF or a BMP does not go as an image
// Antigravity may refuse, and an mp3 reaches the model instead of a path Antigravity cannot open.
// The room (acp-agent-session.mjs ANTIGRAVITY_LIMITS): 7 MB for one image, Google's limit for Gemini 3.8 Flash on Vertex AI, and in
// one message 48 MiB of base64 and text on the prompt's line and 96 MB in the model request, where a PDF counts too. Changed on
// purpose on 2026-11-01: an image could be 10 MiB, an audio file 20 MiB and a message 50 MiB in all, and a BMP went as an image.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { acpDocumentTextParts, antigravityPromptParts } from "../src/acp-agent-session.mjs";
import { contextualAgentPrompt } from "../src/agent-relay.mjs";
import { fileUri } from "../src/file-uri.mjs";
import { PROMPT_TEXT_PATH } from "../src/prompt-attachments.mjs";
import { isSessionRefusal } from "../src/session-refusal.mjs";
import { acpRelay, acpSession, scriptedAcp, select } from "./fixtures/scripted-acp.mjs";

const MiB=1024*1024,MB=1_000_000;
// What Antigravity advertises in its initialize (1.2.1 and 1.4.3, read live in isolated homes): images, audio and embedded context.
const ADVERTISED=Object.freeze({image:true,audio:true,embeddedContext:true});
const antigravity=promptCapabilities=>({initialize:{protocolVersion:1,agentCapabilities:{sessionCapabilities:{resume:{}},...(promptCapabilities?{promptCapabilities}:{})}},sessionNew:{sessionId:"agy-session",configOptions:[select("mode","mode","default",["default","auto_edit","yolo"])]},prompts:[{}]});
const GROK={initialize:{protocolVersion:1,agentCapabilities:{loadSession:true,sessionCapabilities:{resume:{}},promptCapabilities:ADVERTISED}},sessionNew:{sessionId:"grok-session"},prompts:[{}]};
const requested=(log,method)=>log.filter(entry=>entry.method===method);
const base64=bytes=>Buffer.from(bytes).toString("base64");
// The line that names an attachment by its saved path, its kind (image or audio) a capitalized word.
const named=(kind,path)=>({type:"text",text:`[${kind[0].toUpperCase()+kind.slice(1)} attachment "${basename(path)}" at ${path}]`});
// What an image Antigravity takes but cannot send refuses the message with: one over the limit for an image, and one with no room left.
const overLimit=name=>`The image "${name}" is over 7 MB, the most Antigravity's models take for one image. Attach a smaller copy of it.`;
const noRoom=name=>`The image "${name}" does not fit in this message to Antigravity with the other attachments. Send it in a message of its own.`;
// A message's prompt as the relay builds it for a turn.
const relayPrompt=(text,files)=>contextualAgentPrompt([{type:"text",text},...files]);
async function folder(t){
  const root=await mkdtemp(join(tmpdir(),"trebell-agy-prompt-"));
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:100}));
  return root;
}
// A file of zeros of that size, written without holding it in memory.
async function sized(path,bytes){await writeFile(path,"");await truncate(path,bytes);return path}
// Each part by its type, a text by its words, content by its type and size and a link by its type, so a failure does not print megabytes.
const shape=parts=>parts.map(part=>part.type==="text"?["text",part.text]:part.data!=null?[part.type,part.mimeType,Buffer.byteLength(part.data,"base64")]:[part.type,part.mimeType??null]);

test("an attached audio file goes to Antigravity as audio after the line that names it when it takes audio, and otherwise as that line alone",async t=>{
  // 37 MiB of audio is over 49 MiB as base64, more than the prompt's line holds (an audio file could be 20 MiB before 2026-11-01).
  const root=await folder(t),mp3=join(root,"1761500000000-ab12cd34-memo.mp3"),wav=join(root,"take 2.wav"),long=await sized(join(root,"long.flac"),37*MiB);
  await writeFile(mp3,"ID3 mp3 bytes");await writeFile(wav,"RIFF wav bytes");
  const prompt=await relayPrompt("What is said?",[{type:"localAudio",path:mp3},{type:"localAudio",path:wav},{type:"localAudio",path:long}]);
  assert.deepEqual(await antigravityPromptParts(prompt,{audio:true}),[
    {type:"text",text:"What is said?"},
    named("audio",mp3),{type:"audio",mimeType:"audio/mpeg",data:base64("ID3 mp3 bytes")},
    named("audio",wav),{type:"audio",mimeType:"audio/wav",data:base64("RIFF wav bytes")},
    named("audio",long),
  ],"audio goes as audio while the line has room, named as every attachment is; a file past that is named alone");
  for(const capabilities of [{audio:false},{},undefined,{image:true,embeddedContext:true}]){
    assert.deepEqual(await antigravityPromptParts(prompt,capabilities),[{type:"text",text:"What is said?"},named("audio",mp3),named("audio",wav),named("audio",long)],`with ${JSON.stringify(capabilities)}`);
  }
});

test("only PNG, JPEG, WebP, HEIC and HEIF images go to Antigravity as images, and only when it takes images; any other is named by its saved path",async t=>{
  const root=await folder(t),png=join(root,"shot.png"),gif=join(root,"1761500000000-ab12cd34-loop.gif"),webp=join(root,"photo.webp"),bmp=join(root,"scan.bmp"),jpeg=join(root,"cat.JPG");
  await writeFile(png,Buffer.from([137,80,78,71]));await writeFile(gif,"GIF89a");await writeFile(webp,"RIFFWEBP");await writeFile(bmp,"BM");await writeFile(jpeg,Buffer.from([0xff,0xd8,0xff]));
  const images=[png,gif,webp,bmp,jpeg],prompt=await relayPrompt("Look",images.map(path=>({type:"localImage",path})));
  assert.deepEqual(await antigravityPromptParts(prompt,{image:true}),[
    {type:"text",text:"Look"},{type:"image",mimeType:"image/png",data:base64([137,80,78,71])},named("image",gif),
    {type:"image",mimeType:"image/webp",data:base64("RIFFWEBP")},named("image",bmp),{type:"image",mimeType:"image/jpeg",data:base64([0xff,0xd8,0xff])},
  ],"a BMP is named by its saved path, as Google does not list it for Gemini (it went as an image before 2026-11-01)");
  // HEIC and HEIF, which Google lists too, go as images, whatever the case of their type.
  const heic={type:"image",mimeType:"image/HEIC",data:base64("ftypheic")},heif={type:"image",mimeType:"image/heif",data:base64("ftypmif1")};
  assert.deepEqual(await antigravityPromptParts([heic,heif],{image:true}),[heic,heif]);
  assert.deepEqual(await antigravityPromptParts(prompt,{audio:true,embeddedContext:true}),[{type:"text",text:"Look"},...images.map(path=>named("image",path))],"without image no image goes as one");
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

test("the prompt's line carries at most 48 MiB of base64 content a message, audio and images together; audio that does not fit is named alone",async t=>{
  const root=await folder(t);
  // 15 MiB of audio is 20 MiB as base64: two files take 40 MiB of the line, a third would pass 48 MiB, and a 5 MiB image (under 7
  // MiB as base64) still fits after it.
  const audio=await Promise.all([1,2,3].map(n=>sized(join(root,`part-${n}.mp3`),15*MiB))),shot=await sized(join(root,"shot.png"),5*MiB);
  const prompt=await relayPrompt("Transcribe and describe",[...audio.map(path=>({type:"localAudio",path})),{type:"localImage",path:shot}]);
  assert.deepEqual(shape(await antigravityPromptParts(prompt,ADVERTISED)),[
    ["text","Transcribe and describe"],
    ["text",named("audio",audio[0]).text],["audio","audio/mpeg",15*MiB],["text",named("audio",audio[1]).text],["audio","audio/mpeg",15*MiB],
    ["text",named("audio",audio[2]).text],["image","image/png",5*MiB],
  ]);
  // No audio file has a limit of its own: 25 MiB, past the 20 MiB a file could be before 2026-11-01, goes when the line has room.
  const long=await sized(join(root,"long.flac"),25*MiB);
  assert.deepEqual(shape(await antigravityPromptParts(await relayPrompt("Transcribe",[{type:"localAudio",path:long}]),ADVERTISED)),[
    ["text","Transcribe"],["text",named("audio",long).text],["audio","audio/flac",25*MiB],
  ]);
});

test("an image Antigravity takes that cannot go refuses the message by its name with what to do",async t=>{
  const root=await folder(t);
  // One image may be 7 MB (it could be 10 MiB before 2026-11-01): a byte more is refused, alone in its message as well.
  const big=await sized(join(root,"1761500000000-ab12cd34-big.png"),7*MB+1),most=await sized(join(root,"most.png"),7*MB);
  await assert.rejects(antigravityPromptParts(await relayPrompt("Look",[{type:"localImage",path:big}]),ADVERTISED),error=>{
    assert.equal(error.message,overLimit("big.png"));
    assert.ok(isSessionRefusal(error),"Antigravity had nothing yet, so it is asked nothing");
    return true;
  });
  assert.deepEqual(shape(await antigravityPromptParts(await relayPrompt("Look",[{type:"localImage",path:most}]),ADVERTISED)),[["text","Look"],["image","image/png",7*MB]]);
  // 36 MiB of audio is 48 MiB as base64, the whole of the prompt's line, so even a small image after it has no room.
  const memo=await sized(join(root,"memo.mp3"),36*MiB),shot=join(root,"1761500000000-ab12cd34-shot.png");
  await writeFile(shot,Buffer.from([137,80,78,71]));
  const prompt=await relayPrompt("Transcribe and describe",[{type:"localAudio",path:memo},{type:"localImage",path:shot}]);
  await assert.rejects(antigravityPromptParts(prompt,ADVERTISED),error=>{
    assert.equal(error.message,noRoom("shot.png"));
    assert.ok(isSessionRefusal(error));
    return true;
  });
  // Without audio the audio is its line alone, which takes no room, and the image goes; without image the image is named.
  assert.deepEqual(shape(await antigravityPromptParts(prompt,{image:true})).map(([type])=>type),["text","text","image"]);
  assert.deepEqual(shape(await antigravityPromptParts(prompt,{audio:true})).slice(-1),[["text",named("image",shot).text]]);
});

test("a PDF takes room in the model request, counted as base64, and none on the prompt's line",async t=>{
  const root=await folder(t),memo=await sized(join(root,"memo.mp3"),36*MiB),report=await sized(join(root,"report.pdf"),20*MB),more=await sized(join(root,"more.pdf"),15*MB);
  // The audio fills the line. The 20 MB PDF takes about 26.7 MB of the request's 96 MB beside the audio's 48 MiB, and another
  // 15 MB PDF (20 MB as base64) would pass 96 MB, so it stays a plain link.
  const prompt=await relayPrompt("Compare",[{type:"localAudio",path:memo},{type:"mention",name:"report.pdf",path:report},{type:"mention",name:"more.pdf",path:more}]);
  assert.deepEqual(shape(await antigravityPromptParts(prompt,ADVERTISED)),[
    ["text","Compare"],["text",named("audio",memo).text],["audio","audio/mpeg",36*MiB],["resource_link","application/pdf"],["resource_link",null],
  ]);
});

test("embedded text takes room on the prompt's line as the JSON string it travels in, so a full line leaves a text file a link and a document without its text",async t=>{
  // 37,747,986 bytes of audio are 50,330,648 as base64, which leaves 1,000 bytes of the line's 48 MiB.
  const root=await folder(t),memo=await sized(join(root,"memo.mp3"),37_747_986);
  const letters=join(root,"letters.txt"),breaks=join(root,"breaks.txt"),report=join(root,"report.docx"),text=join(root,"report.docx.txt");
  await writeFile(letters,"a".repeat(600));await writeFile(breaks,"\n".repeat(600));await writeFile(text,"b".repeat(1_200));
  const afterAudio=async file=>antigravityPromptParts(await relayPrompt("Read this",[{type:"localAudio",path:memo},file]),ADVERTISED);
  // 600 letters are 602 bytes as a JSON string and fit. 600 line breaks are 600 bytes too, but 1,202 as a JSON string, so they
  // stay a link.
  assert.deepEqual((await afterAudio({type:"mention",name:"letters.txt",path:letters})).slice(-1),[{type:"resource",resource:{uri:pathToFileURL(letters).href,mimeType:"text/plain",text:"a".repeat(600)}}]);
  assert.deepEqual(shape(await afterAudio({type:"mention",name:"breaks.txt",path:breaks})).slice(-1),[["resource_link",null]]);
  // A document's extracted text of 1,200 characters has no room either: the document keeps its link and the line that names its
  // text, and alone in its message the text goes after them.
  const document=Object.defineProperty({type:"resource_link",uri:fileUri(report),name:"report.docx"},PROMPT_TEXT_PATH,{value:text});
  const withAudio=[...await relayPrompt("Read it",[{type:"localAudio",path:memo}]),document];
  assert.deepEqual((await antigravityPromptParts(withAudio,ADVERTISED)).slice(-2),acpDocumentTextParts([document]));
  assert.deepEqual(await antigravityPromptParts([document],ADVERTISED),[
    ...acpDocumentTextParts([document]),{type:"resource",resource:{uri:pathToFileURL(text).href,mimeType:"text/plain",text:"b".repeat(1_200)}},
  ]);
});

test("an attached audio file that Antigravity would hear but is gone is refused by its name with what to do",async t=>{
  const root=await folder(t),gone=join(root,"1761500000000-ab12cd34-memo.mp3");
  const prompt=await relayPrompt("What is said?",[{type:"localAudio",path:gone}]);
  await assert.rejects(antigravityPromptParts(prompt,{audio:true}),error=>{
    assert.equal(error.message,'The attached file "memo.mp3" is no longer on this computer. Attach it again.');
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
  assert.deepEqual(await sent(ADVERTISED),[{type:"text",text:"What is this?"},named("audio",mp3),{type:"audio",mimeType:"audio/mpeg",data:base64("ID3")},named("image",gif),{type:"image",mimeType:"image/png",data:base64([137,80,78,71])}]);
  assert.deepEqual(await sent(null),[{type:"text",text:"What is this?"},named("audio",mp3),named("image",gif),named("image",png)],"an Antigravity that advertises nothing gets every attachment by its path");
});

test("through the relay an attached audio file reaches Antigravity as audio, and every harness by its saved path",async t=>{
  for(const [kind,config] of [["antigravity",antigravity(ADVERTISED)],["grok",GROK]]){
    const fx=await scriptedAcp(t,config),mp3=join(fx.root,"memo.mp3");await writeFile(mp3,"ID3");
    const {rpc,next}=await acpRelay(t,kind,fx);
    const started=await rpc("thread/start",{cwd:fx.root,approvalPolicy:"on-request",sandbox:"workspace-write"});
    const completed=next(message=>message.method==="turn/completed");
    await rpc("turn/start",{threadId:started.thread.id,input:[{type:"text",text:"What is said?"},{type:"localAudio",path:mp3}]});
    assert.equal((await completed).params.turn.status,"completed",kind);
    const prompt=requested(await fx.log(),"session/prompt")[0].params.prompt;
    const audio=prompt.filter(part=>part.type==="audio"),line=prompt.filter(part=>part.type==="text"&&part.text===named("audio",mp3).text);
    if(kind==="antigravity")assert.deepEqual(audio,[{type:"audio",mimeType:"audio/mpeg",data:base64("ID3")}]);
    else assert.equal(audio.length,0,"Grok advertises audio too, yet only Antigravity's session sends it as audio");
    assert.equal(line.length,1,`${kind} is told the audio's name and saved path`);
  }
});

test("through the relay a message whose image does not fit in what Antigravity takes ends saying which image and what to do, and the thread goes on",async t=>{
  const fx=await scriptedAcp(t,{...antigravity(ADVERTISED),prompts:[{steps:[{update:{sessionUpdate:"agent_message_chunk",content:{type:"text",text:"The report has three sections."}}}]}]});
  // 36 MiB of audio is 48 MiB as base64, all the room the prompt's line has.
  const memo=await sized(join(fx.root,"memo.mp3"),36*MiB),shot=join(fx.root,"shot.png");await writeFile(shot,Buffer.from([137,80,78,71]));
  const {rpc,next,threadStore}=await acpRelay(t,"antigravity",fx);
  const started=await rpc("thread/start",{cwd:fx.root,approvalPolicy:"on-request",sandbox:"workspace-write"}),threadId=started.thread.id;
  const failed=next(message=>message.method==="turn/completed");
  await rpc("turn/start",{threadId,input:[{type:"text",text:"Transcribe and describe"},{type:"localAudio",path:memo},{type:"localImage",path:shot}]});
  const {turn}=(await failed).params;
  assert.equal(turn.status,"failed");assert.equal(turn.error?.message,noRoom("shot.png"));
  assert.equal(requested(await fx.log(),"session/prompt").length,0,"Antigravity was sent nothing");
  const completed=next(message=>message.method==="turn/completed");
  await rpc("turn/start",{threadId,input:[{type:"text",text:"Describe the picture"},{type:"localImage",path:shot}]});
  assert.equal((await completed).params.turn.status,"completed","the next message runs");
  assert.deepEqual(threadStore.get(threadId).turns.map(item=>item.status),["failed","completed"]);
});
