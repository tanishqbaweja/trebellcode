import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EnvironmentManager } from "../src/environment-manager.mjs";
import { createGuiServer } from "../src/gui-server.mjs";
import { unreadableAttachment } from "../src/prompt-attachments.mjs";

// L10-20 and L10-F-1 (tour L10, 2026-11-02): an attachment whose saved copy is gone was refused as 'The attached image "number-png.png"
// could not be read (ENOENT). Attach it again.', a system code in the words, and the composer had no way to know which chip it was, so
// the dead chip refused every later send the same way. The words are plain now, with no code, and the check before a send names every
// file that is gone (missing), so the composer takes their chips off and says so once.

async function folder(t){const root=await mkdtemp(join(tmpdir(),"trebell-attachment-gone-"));t.after(()=>rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250}));return root}

test("an attachment Trebell cannot read is said in plain words, with no system code",()=>{
  const gone=unreadableAttachment("image","/home/me/.trebell/attachments/1761500000000-ab12cd34-number-png.png",Object.assign(new Error("ENOENT: no such file or directory"),{code:"ENOENT"}));
  assert.equal(gone.message,'The attached image "number-png.png" is no longer on this computer. Attach it again.');
  assert.equal(gone.missingPath,"/home/me/.trebell/attachments/1761500000000-ab12cd34-number-png.png","it names the file that is gone");
  const locked=unreadableAttachment("file","C:\\Users\\me\\report.docx",Object.assign(new Error("EPERM: operation not permitted"),{code:"EPERM"}));
  assert.equal(locked.message,'The attached file "report.docx" could not be read, since this computer does not let Trebell Code open it.');
  assert.equal(locked.missingPath,undefined,"a file that is there is not gone");
  assert.equal(unreadableAttachment("file","/tmp/odd.bin",Object.assign(new Error("EIO: i/o error"),{code:"EIO"})).message,'The attached file "odd.bin" could not be read. Attach it again.');
  for(const error of [gone,locked])assert.doesNotMatch(error.message,/\bE[A-Z]{2,}\b|no such file/,"no system code or Node's words");
});

test("the check before a send names every attached file that is gone, as the composer sent it",async t=>{
  const root=await folder(t),manager=new EnvironmentManager({state:{environments:()=>[]}});
  const kept=join(root,"1761500000000-ab12cd34-notes.txt");await writeFile(kept,"notes","utf8");
  const shot=join(root,"1761500000001-cd34ef56-number-png.png"),report=join(root,"1761500000002-ef56ab12-report.pdf");
  await assert.rejects(manager.validateAttachments(null,[shot,kept,report]),error=>{
    assert.equal(error.message,'The attached image "number-png.png" is no longer on this computer. Attach it again.',"the refusal says the first one's name");
    assert.deepEqual(error.missingPaths,[shot,report],"and names every file that is gone");
    return true;
  });
  assert.equal((await manager.validateAttachments(null,[kept])).count,1,"a file that is there still passes");
});

async function freePort(){
  const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));
  const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port;
}

test("the server's check of a message tells the composer which attached files are gone",async t=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-attachment-gone-server-")),home=join(root,"home");
  const [port,appPort]=await Promise.all([freePort(),freePort()]),gui=await createGuiServer({port,appPort,mock:true,env:{...process.env,TREBELL_HOME:home}});
  // The server goes before its home, whose database it holds open.
  t.after(async()=>{await gui.close();await rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:250})});
  const post=(path,body)=>fetch(gui.url+path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
  const uploaded=await (await post("/api/attachments/blob",{name:"number-png.png",mime:"image/png",dataBase64:Buffer.from("not really a png").toString("base64")})).json();
  assert.equal(await readFile(uploaded.path,"utf8"),"not really a png");
  await rm(uploaded.path);
  const response=await post("/api/attachments/validate",{paths:[uploaded.path]});
  assert.equal(response.status,400);
  assert.deepEqual(await response.json(),{error:'The attached image "number-png.png" is no longer on this computer. Attach it again.',missing:[uploaded.path]});
});
