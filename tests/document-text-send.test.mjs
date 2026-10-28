// A send extracts an attached document's text at most once, where its text can be used: attaching a file on this machine extracts it
// (/api/attachments/import) and the check of a message about to go extracts what attaching did not (/api/attachments/validate, T3's
// claim of a message's attachments), while the relay only names the text that is there, as T3's prompt builders only look for it
// (resolveExtractedTextPath). So the relay never runs a second extraction while the turn waits, for Trebell Native neither, whose
// prompt names no text, and an upload is not extracted before the composer takes it in, which for a thread in a remote environment
// copies it to that host, where no harness is told of text on this machine.
import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { contextualAgentPrompt } from "../src/agent-relay.mjs";
import { ensureDocumentText } from "../src/document-text.mjs";
import { createGuiServer } from "../src/gui-server.mjs";

const FIXTURES=fileURLToPath(new URL("./fixtures/documents/",import.meta.url));
const TEXT_PATH=Symbol.for("trebell.prompt.text-path");
const there=path=>stat(path).then(()=>true,()=>false);
async function folder(t,prefix){
  const root=await mkdtemp(join(tmpdir(),prefix));
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250}));
  return root;
}

test("the relay names the text a document's attaching or its send's check extracted, and extracts none itself while the turn waits",async t=>{
  const root=await folder(t,"trebell-document-send-"),home=join(root,"home"),dir=join(home,"attachments");await mkdir(dir,{recursive:true});
  const report=join(dir,"1761500000000-ab12cd34-report.docx"),deck=join(dir,"1761500000000-cd34ef56-deck.pptx");
  await copyFile(join(FIXTURES,"report.docx"),report);await copyFile(join(FIXTURES,"deck.pptx"),deck);
  // The deck's text was extracted as it was attached (or checked before the send); the report's was not, nor could be yet.
  assert.equal(await ensureDocumentText(deck,{home}),deck+".txt");
  const mention=path=>({type:"mention",name:basename(path),path});
  const [,reportPart,deckPart]=await contextualAgentPrompt([{type:"text",text:"Compare them"},mention(report),mention(deck)],{},{home});
  assert.deepEqual({report:reportPart[TEXT_PATH]??null,deck:deckPart[TEXT_PATH]??null},{report:null,deck:deck+".txt"},"only the text that is there is named");
  assert.deepEqual({extractedAtSend:await there(report+".txt"),files:(await readdir(dir)).sort()},{extractedAtSend:false,files:[basename(deck),basename(deck)+".txt",basename(report)].sort()},"the relay started no extraction of its own");
});

async function freePort(){
  const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}

test("an upload is not extracted before the composer takes it in, and taking it in on this machine extracts it once",async t=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-document-upload-")),home=join(root,"home");
  const [port,appPort]=await Promise.all([freePort(),freePort()]),gui=await createGuiServer({port,appPort,mock:true,env:{...process.env,TREBELL_HOME:home}});
  // The server goes before its home, whose database it holds open.
  t.after(async()=>{await gui.close();await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})});
  const post=async(path,body)=>{const response=await fetch(gui.url+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});assert.equal(response.status,200,path);return response.json()};
  const uploaded=await post("/api/attachments/blob",{name:"report.docx",mime:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",dataBase64:(await readFile(join(FIXTURES,"report.docx"))).toString("base64")});
  assert.deepEqual({textPath:uploaded.textPath??null,extracted:await there(uploaded.path+".txt")},{textPath:null,extracted:false},"the upload itself extracts nothing");
  const {files:[taken]}=await post("/api/attachments/import",{paths:[uploaded.path]});
  assert.equal(taken.textPath,uploaded.path+".txt","taking it in on this machine extracts it");
  assert.match(await readFile(taken.textPath,"utf8"),/^# Quarterly Harbor Report\n/);
  const checked=await post("/api/attachments/validate",{paths:[uploaded.path]});
  assert.deepEqual(checked.files.map(file=>file.textPath),[taken.textPath],"and the send's check finds that text");
});
