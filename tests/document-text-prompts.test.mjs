// Every harness is told the file an attached document's text was extracted to, after the document's own path, as T3 Code tells every
// harness ('... is saved at: <path> (text extracted to: <file>)', 888a3d47d): Claude Code, Muse Code, OpenCode 1.x and 2.x, Cursor and
// Grok, Codex and a question's answer. OpenCode 1.x reads that text as the file's text instead of the document's bytes, and Antigravity,
// which cannot open Trebell's attachments folder, gets the text embedded. A document Trebell has no text of is named by its path alone.
import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { antigravityPromptParts } from "../src/acp-agent-session.mjs";
import { contextualAgentPrompt } from "../src/agent-relay.mjs";
import { claudeUserContent } from "../src/claude-agent-session.mjs";
import { ensureDocumentText } from "../src/document-text.mjs";
import { fileUri } from "../src/file-uri.mjs";
import { museInputParts } from "../src/muse-agent-session.mjs";
import { OpenCodeAgentSession } from "../src/opencode-agent-session.mjs";
import { openCode2PromptInput } from "../src/opencode2-agent-session.mjs";
import * as codex from "../ui/src/codex-turn-options.js";
import { FAKE_OPENCODE1_MODEL, eventuallyReal, startFakeOpenCode1 } from "./fixtures/fake-opencode1-server.mjs";
import { acpRelay, scriptedAcp, select } from "./fixtures/scripted-acp.mjs";

const FIXTURES=fileURLToPath(new URL("./fixtures/documents/",import.meta.url));
const REPORT="# Quarterly Harbor Report\nCargo volume rose 12 percent & the new crane is running.\nPort\tTons\nJuniper\t4200\nNext review: March.";
// The file a document link's text was extracted to, which the relay keeps on the link out of what goes on the wire.
const TEXT_PATH=Symbol.for("trebell.prompt.text-path");
const extracted=(path,text)=>`${path} (text extracted to: ${text})`;
async function folder(t){
  const root=await mkdtemp(join(tmpdir(),"trebell-document-prompts-"));
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100}));
  return root;
}
// A Trebell home with uploads saved as the GUI server saves them, a document from the person's own folder, a corrupt document and a
// Markdown file; none has had its text extracted yet.
async function attachments(home,root){
  const dir=join(home,"attachments");await mkdir(dir,{recursive:true});
  const report=join(dir,"1761500000000-ab12cd34-report.docx"),broken=join(dir,"1761500000000-cd34ef56-broken.docx"),notes=join(dir,"1761500000000-ef56ab12-notes.md");
  await copyFile(join(FIXTURES,"report.docx"),report);await writeFile(broken,"invalid document");await writeFile(notes,"# Notes\n");
  const own=join(root,"projects","Harbor plan.docx");await mkdir(join(root,"projects"),{recursive:true});await copyFile(join(FIXTURES,"report.docx"),own);
  return {report,broken,notes,own};
}
const mention=path=>({type:"mention",name:basename(path),path});
// The message's files on this machine had their text extracted as the composer took them in and checked them before the send
// (/api/attachments/import and /validate); a remote environment's were copied to its host.
async function relayParts(t,{remote=false}={}){
  const root=await folder(t),home=join(root,"home"),files=await attachments(home,root),paths=[files.report,files.own,files.broken,files.notes];
  if(!remote)for(const path of paths)await ensureDocumentText(path,{home});
  const parts=await contextualAgentPrompt([{type:"text",text:"Summarize the report"},...paths.map(mention)],{},{home,remote});
  return {root,home,files,parts};
}

test("the relay keeps each attached document's extracted text on its link, and none for another file or a remote environment's",async t=>{
  const {home,files,parts}=await relayParts(t);
  const [,report,own,broken,notes]=parts;
  assert.equal(report[TEXT_PATH],files.report+".txt","an upload's text beside it");
  assert.equal(await readFile(files.report+".txt","utf8"),REPORT);
  assert.equal(join(own[TEXT_PATH],".."),join(home,"attachments"),"the person's own document's text in the attachments folder");
  assert.equal(await readFile(own[TEXT_PATH],"utf8"),REPORT);
  assert.equal(broken[TEXT_PATH],undefined,"a corrupt document has none");
  assert.equal(notes[TEXT_PATH],undefined,"a Markdown file is no document to extract");
  assert.deepEqual(parts.slice(1).map(part=>part.type),["resource_link","resource_link","resource_link","resource_link"]);
  assert.ok(!JSON.stringify(parts).includes(".docx.txt"),"what goes on the wire is the link as before");
  const remote=await relayParts(t,{remote:true});
  assert.deepEqual(remote.parts.slice(1).map(part=>part[TEXT_PATH]),[undefined,undefined,undefined,undefined],"a remote environment's files are on its host");
  await assert.rejects(stat(remote.files.report+".txt"),{code:"ENOENT"});
});

test("Claude Code and Muse Code are told each document's extracted text after its path, with the person's words still last for Claude",async t=>{
  const {files,parts}=await relayParts(t),own=parts[2][TEXT_PATH];
  const lines=[`Attached file: ${extracted(files.report,files.report+".txt")}`,`Attached file: ${extracted(files.own,own)}`,`Attached file: ${files.broken}`,`Attached file: ${files.notes}`];
  assert.deepEqual(claudeUserContent(parts).map(block=>block.text),[...lines,"Summarize the report"]);
  assert.deepEqual(museInputParts(parts).map(part=>part.text),["Summarize the report",...lines]);
});

test("OpenCode 2 is told each document's extracted text after its saved path",async t=>{
  const {files,parts}=await relayParts(t),own=parts[2][TEXT_PATH];
  const {text,files:sent}=await openCode2PromptInput(parts);
  assert.equal(text,[
    "Summarize the report",
    `[Attached file "${basename(files.report)}" is saved at: ${extracted(files.report,files.report+".txt")}]`,
    `[Attached file "Harbor plan.docx" is saved at: ${extracted(files.own,own)}]`,
    `[Attached file "${basename(files.broken)}" is saved at: ${files.broken}]`,
    `[Attached file "${basename(files.notes)}" is saved at: ${files.notes}]`,
  ].join("\n"));
  assert.deepEqual(sent,[]);
});

test("OpenCode 1.x reads a document's extracted text as the file's text, told the document's path, and a document without text by its path, never its bytes",async t=>{
  const {files,parts}=await relayParts(t),own=parts[2][TEXT_PATH];
  const fake=await startFakeOpenCode1();t.after(()=>fake.close());
  const session=new OpenCodeAgentSession({cwd:join(files.own,"..",".."),serverUrl:fake.url,onUpdate:()=>{}});t.after(()=>session.close());
  await session.start({model:FAKE_OPENCODE1_MODEL});
  await eventuallyReal(()=>fake.streams.size>0,{message:"the session did not subscribe to OpenCode's events"});
  await session.prompt(parts);
  assert.deepEqual(fake.prompts()[0].parts,[
    {type:"text",text:"Summarize the report"},
    {type:"text",text:`[Attached file "${basename(files.report)}" is saved at: ${extracted(files.report,files.report+".txt")}]`},
    {type:"file",mime:"text/plain",filename:basename(files.report)+".txt",url:fileUri(files.report+".txt")},
    {type:"text",text:`[Attached file "Harbor plan.docx" is saved at: ${extracted(files.own,own)}]`},
    {type:"file",mime:"text/plain",filename:"Harbor plan.docx.txt",url:fileUri(own)},
    {type:"text",text:`[Attached file "${basename(files.broken)}" is saved at: ${files.broken}]`},
    {type:"file",mime:"text/markdown",filename:basename(files.notes),url:fileUri(files.notes)},
  ]);
});

// Antigravity 1.2.1's initialize (images, audio and embedded context), and Grok's.
const ANTIGRAVITY={initialize:{protocolVersion:1,agentCapabilities:{sessionCapabilities:{resume:{}},promptCapabilities:{image:true,audio:true,embeddedContext:true}}},sessionNew:{sessionId:"agy-session",configOptions:[select("mode","mode","default",["default","auto_edit","yolo"])]},prompts:[{}]};
const GROK={initialize:{protocolVersion:1,agentCapabilities:{loadSession:true,sessionCapabilities:{resume:{}},promptCapabilities:{image:true,audio:true,embeddedContext:true}}},sessionNew:{sessionId:"grok-session"},prompts:[{}]};
// A turn through the relay with a document attached, and what the ACP agent was sent for it.
async function acpTurn(t,kind,config){
  const fx=await scriptedAcp(t,config),dir=join(fx.root,"home","attachments"),report=join(dir,"1761500000000-ab12cd34-report.docx"),broken=join(dir,"1761500000000-cd34ef56-broken.docx");
  await mkdir(dir,{recursive:true});await copyFile(join(FIXTURES,"report.docx"),report);await writeFile(broken,"invalid document");
  // As the composer takes them in and checks them before the send.
  for(const path of [report,broken])await ensureDocumentText(path,{home:join(fx.root,"home")});
  const {rpc,next}=await acpRelay(t,kind,fx);
  const started=await rpc("thread/start",{cwd:fx.root,approvalPolicy:"on-request",sandbox:"workspace-write"}),completed=next(message=>message.method==="turn/completed");
  await rpc("turn/start",{threadId:started.thread.id,input:[{type:"text",text:"What is the report's first heading?"},mention(report),mention(broken)]});
  assert.equal((await completed).params.turn.status,"completed",kind);
  const prompt=(await fx.log()).find(entry=>entry.method==="session/prompt").params.prompt;
  return {report,broken,prompt:prompt.slice(0,-1)};
}
const link=path=>({type:"resource_link",uri:fileUri(path),name:basename(path)});
const line=(path,text)=>({type:"text",text:`[Attached file "${basename(path)}" is saved at: ${text?extracted(path,text):path}]`});

test("Cursor and Grok are told a document's extracted text on the line after its link, and a document without text keeps its link alone",async t=>{
  const {report,broken,prompt}=await acpTurn(t,"grok",GROK);
  assert.deepEqual(prompt,[{type:"text",text:"What is the report's first heading?"},link(report),line(report,report+".txt"),link(broken)]);
});

test("Antigravity gets a document's extracted text embedded after the line that names it, as it cannot open Trebell's attachments folder",async t=>{
  const {report,broken,prompt}=await acpTurn(t,"antigravity",ANTIGRAVITY);
  const embedded={type:"resource",resource:{uri:pathToFileURL(report+".txt").href,mimeType:"text/plain",text:REPORT}};
  assert.deepEqual(prompt,[{type:"text",text:"What is the report's first heading?"},link(report),line(report,report+".txt"),embedded,link(broken)]);
  // Without embedded context it has the line alone, and text past 1 MiB is not embedded.
  const parts=[{type:"text",text:"Read it"},Object.defineProperty(link(report),TEXT_PATH,{value:report+".txt"})];
  assert.deepEqual(await antigravityPromptParts(parts,{image:true,audio:true}),[{type:"text",text:"Read it"},link(report),line(report,report+".txt")]);
  await writeFile(report+".txt","x".repeat(1024*1024+1));
  assert.deepEqual(await antigravityPromptParts(parts,{embeddedContext:true}),[{type:"text",text:"Read it"},link(report),line(report,report+".txt")]);
});

test("Codex is told a document's extracted text in its line, which a queued follow-up and a reopened message read back as the document's path",()=>{
  const docx="C:\\Work\\1761500000000-ab12cd34-report.docx",png="C:\\Work\\1761500000000-cd34ef56-shot.png",md="C:\\Work\\notes.md";
  codex.noteDocumentTexts([{path:docx,size:10,image:false,textPath:docx+".txt"},{path:png,size:4,image:true},{path:md,size:8,image:false}]);
  const displayName=path=>basename(path.replaceAll("\\","/")).replace(/^\d{10,}-[0-9a-f]{8}-/,"");
  const [input,...media]=codex.codexTurnInput("What is the first heading?",[docx,png,md],{displayName});
  assert.equal(input.text,[
    "What is the first heading?",
    `[Attached file "report.docx" is saved at: ${docx} (text extracted to: ${docx}.txt)]`,
    `[Attached image "shot.png" is saved at: ${png}]`,
    `[Attached file "notes.md" is saved at: ${md}]`,
  ].join("\n\n"));
  assert.deepEqual(media,[{type:"localImage",path:png}]);
  assert.deepEqual(codex.splitCodexAttachmentText(input.text),{text:"What is the first heading?",paths:[docx,png,md]});
  // A question's answer names it the same way.
  assert.equal(codex.documentTextNote(docx),` (text extracted to: ${docx}.txt)`);
  assert.equal(codex.documentTextNote(md),"");
  // A later check that finds no text for it (its text was cleaned away and could not be extracted again) names none.
  codex.noteDocumentTexts([{path:docx,size:10,image:false}]);
  assert.equal(codex.documentTextNote(docx),"");
  assert.match(codex.codexTurnInput("Again",[docx],{displayName})[0].text,/is saved at: C:\\Work\\1761500000000-ab12cd34-report\.docx\]$/);
});
