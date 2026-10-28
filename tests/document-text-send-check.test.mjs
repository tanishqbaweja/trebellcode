// A send checks a message's files twice: the composer's check before it goes (dispatchSend's, Send now's, a background send's or a
// fan-out's) and, right after it, the one its turn starts with (startTurn's, startDetachedTurn's). Only the first extracts a document's
// text, as T3 claims a message's attachments once; the second asks for none (extract: false) and only finds the text the first
// extracted. So a send runs each document's extraction once, also when it fails and takes its time: a second extraction of each
// would make the turn wait as long again.
import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGuiServer } from "../src/gui-server.mjs";

const FIXTURES=fileURLToPath(new URL("./fixtures/documents/",import.meta.url));
async function freePort(){
  const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}

test("the second check of a send's files only finds the text its first check extracted, and starts no extraction of its own",async t=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-document-send-check-")),home=join(root,"home"),dir=join(home,"attachments");await mkdir(dir,{recursive:true});
  const [port,appPort]=await Promise.all([freePort(),freePort()]),gui=await createGuiServer({port,appPort,mock:true,env:{...process.env,TREBELL_HOME:home}});
  // The server goes before its home, whose database it holds open.
  t.after(async()=>{await gui.close();await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})});
  const post=async(path,body)=>{const response=await fetch(gui.url+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});assert.equal(response.status,200,path);return response.json()};
  // Two uploads with no text yet, as documents attached while Trebell Native was the harness, which extracts none.
  const report=join(dir,"1761500000000-ab12cd34-report.docx"),deck=join(dir,"1761500000000-cd34ef56-deck.pptx"),paths=[report,deck];
  await copyFile(join(FIXTURES,"report.docx"),report);await copyFile(join(FIXTURES,"deck.pptx"),deck);
  const textPaths=answer=>answer.files.map(file=>file.textPath??null);
  // A check asking for no extraction starts none: no worker's text file is written.
  const looked=await post("/api/attachments/validate",{paths,extract:false});
  assert.deepEqual({textPaths:textPaths(looked),files:(await readdir(dir)).sort()},{textPaths:[null,null],files:[basename(report),basename(deck)].sort()},"nothing extracted by a check that asks for none");
  // A send: its first check extracts each document's text, and its second finds that text.
  const first=await post("/api/attachments/validate",{paths}),second=await post("/api/attachments/validate",{paths,extract:false});
  assert.deepEqual({first:textPaths(first),second:textPaths(second)},{first:[report+".txt",deck+".txt"],second:[report+".txt",deck+".txt"]});
  assert.match(await readFile(report+".txt","utf8"),/^# Quarterly Harbor Report\n/);
  assert.deepEqual(second.files.map(file=>file.path),paths,"the second check still checks the files themselves");
});
