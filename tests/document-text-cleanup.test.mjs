// The text Trebell extracts from an uploaded document lives beside the upload in its attachments folder (<file>.txt,
// document-text.mjs) and goes with it: the cleanup of old attachments removes it with its upload, leaves it while the upload stays
// (a fresh one, or one a stash keeps), and removes text whose upload is gone by its own age. Only the cleanup and the state it reads
// are loaded here, so this file runs on code from before document text existed too.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StorageCleanupService } from "../src/storage-cleanup-service.mjs";
import { TrebellStateStore } from "../src/trebell-state.mjs";

const DAY_MS=24*60*60*1000;
// An upload saved in the home's attachments folder as the GUI server saves one (<time>-<id>-<name>).
async function upload(home,name,bytes){
  const dir=join(home,"attachments");await mkdir(dir,{recursive:true});
  const path=join(dir,`1761500000000-ab12cd34-${name}`);await writeFile(path,bytes);return path;
}

test("an upload's text goes with the upload when the attachments folder is cleaned, and stays while the upload does",async t=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-document-cleanup-")),env={...process.env,TREBELL_HOME:home},state=new TrebellStateStore(env);
  t.after(async()=>{state.close();await rm(home,{recursive:true,force:true,maxRetries:20,retryDelay:100})});
  state.updateSettings({storageCleanup:{attachmentsAfterDays:7,terminalHistoryAfterDays:null}});
  const stale=new Date(Date.now()-10*DAY_MS),age=async(...paths)=>{for(const path of paths)await utimes(path,stale,stale)};
  const old=await upload(home,"old.docx","old"),kept=await upload(home,"kept.xlsx","kept"),fresh=await upload(home,"fresh.pptx","fresh");
  await writeFile(old+".txt","old text");await writeFile(kept+".txt","kept text");await writeFile(fresh+".txt","fresh text");
  const orphan=join(home,"attachments","1761400000000-cd34ef56-gone.odt.txt");await writeFile(orphan,"orphan text");
  // The old upload's text was extracted later, and is newer than it; the kept upload's text is as old as it, and a stash keeps the upload.
  await age(old,kept,kept+".txt",fresh+".txt",orphan);
  state.addStash({text:"keep",attachments:[kept],contextChips:[]});
  const result=await new StorageCleanupService({state,env}).sweep({now:Date.now()});
  // What is left, all of it at once, so a cleanup that gets more than one of them wrong shows each.
  const there=path=>stat(path).then(()=>true,()=>false),text=path=>readFile(path,"utf8").catch(()=>null);
  assert.deepEqual({
    "the old upload":await there(old),"the old upload's text, which goes with it":await there(old+".txt"),
    "the kept upload's text, kept with it":await text(kept+".txt"),"the fresh upload's text, whatever its own age":await text(fresh+".txt"),
    "text whose upload is gone, by its own age":await there(orphan),
  },{
    "the old upload":false,"the old upload's text, which goes with it":false,
    "the kept upload's text, kept with it":"kept text","the fresh upload's text, whatever its own age":"fresh text",
    "text whose upload is gone, by its own age":false,
  });
  assert.deepEqual({removed:result.attachments.removed,bytes:result.attachments.bytes},{removed:3,bytes:"old".length+"old text".length+"orphan text".length});
});
