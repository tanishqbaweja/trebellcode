// The GUI server extracts an attached document's text as the document is uploaded or attached from the person's folders, and answers
// with the file it went to (textPath): beside an upload in Trebell's attachments folder, and never beside the person's own file. The
// check a message's files get before it goes answers each document's text too, which the composer names in a Codex message.
import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGuiServer } from "../src/gui-server.mjs";

const FIXTURES=fileURLToPath(new URL("./fixtures/documents/",import.meta.url));
async function freePort(){
  const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}

test("an uploaded, imported or checked document answers with the file its text was extracted to, and the person's own folder gets nothing",async t=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-document-server-")),home=join(root,"home"),projects=join(root,"projects");
  await mkdir(projects,{recursive:true});const own=join(projects,"Budget 2027.xlsx");await copyFile(join(FIXTURES,"budget.xlsx"),own);
  const [port,appPort]=await Promise.all([freePort(),freePort()]),gui=await createGuiServer({port,appPort,mock:true,env:{...process.env,TREBELL_HOME:home}});
  // The server goes before its home, whose database it holds open.
  t.after(async()=>{await gui.close();await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})});
  const post=async(path,body)=>{const response=await fetch(gui.url+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});assert.equal(response.status,200,path);return response.json()};

  const report=await post("/api/attachments/blob",{name:"report.docx",mime:"application/vnd.openxmlformats-officedocument.wordprocessingml.document",dataBase64:(await readFile(join(FIXTURES,"report.docx"))).toString("base64")});
  assert.equal(report.textPath,report.path+".txt","an upload's text goes beside it");
  assert.match(await readFile(report.textPath,"utf8"),/^# Quarterly Harbor Report\n/);
  const broken=await post("/api/attachments/blob",{name:"broken.docx",mime:"application/octet-stream",dataBase64:Buffer.from("invalid document").toString("base64")});
  assert.equal(broken.textPath,undefined,"a corrupt document has none");
  const shot=await post("/api/attachments/blob",{name:"shot.png",mime:"image/png",dataBase64:Buffer.from([137,80,78,71]).toString("base64")});
  assert.equal(shot.textPath,undefined);

  const {files:[imported]}=await post("/api/attachments/import",{paths:[own]});
  assert.equal(imported.path,own,"an attached file stays where the person keeps it");
  assert.equal(join(imported.textPath,".."),join(home,"attachments"),"its text is kept in Trebell's attachments folder");
  assert.match(await readFile(imported.textPath,"utf8"),/^## Sheet: Budget\nItem\tCost\tDue\nLantern\t37/);
  assert.deepEqual(await readdir(projects),["Budget 2027.xlsx"],"nothing is written beside it");
  const {files:[upload]}=await post("/api/attachments/import",{paths:[report.path]});
  assert.equal(upload.textPath,report.textPath,"an upload taken in keeps the text beside it");

  const checked=await post("/api/attachments/validate",{paths:[report.path,own,broken.path,shot.path]});
  assert.deepEqual(checked.files.map(file=>file.textPath),[report.textPath,imported.textPath,undefined,undefined]);
});
