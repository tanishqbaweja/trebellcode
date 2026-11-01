// How Trebell keeps and reuses an attached document's extracted text (src/document-text.mjs), past what document-text.test.mjs
// checks: the edge of each kind's size bound (50 MiB, 20 MiB for a notebook), the second a failed reading waits and what counts as a refusal, a refused file of the
// person's own that changes, readings that never overlap, a text file that cannot be put in place, the lookup that reads nothing,
// and the memory of failures that keeps 1,024 documents.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { BOUNDS } from "../src/document-reading.mjs";
import { FailedExtractions, ensureDocumentText, extractedDocumentText } from "../src/document-text.mjs";

const MIB=1024*1024;
async function scratch(t){
  const root=await mkdtemp(join(tmpdir(),"trebell-document-reuse-"));
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100}));
  return root;
}
// An upload in a Trebell home's attachments folder, named as the GUI server names one (<time>-<id>-<name>).
async function upload(home,name,bytes){
  const folder=join(home,"attachments");await mkdir(folder,{recursive:true});
  const path=join(folder,`1761600000000-9f8e7d6c-${name}`);await writeFile(path,bytes);return path;
}
// A stand-in for the process that reads a document. It writes "start <name>" and "end <name>" to its log around its work, and then,
// as asked: fails its first run as the system would (exit 1), prints more than the output bound, or waits pauseMs before reading.
// A document whose bytes begin with "refuse" it refuses (exit 2); any other it answers with "Text of <name>: " and its first 24 bytes.
async function standIn(root,{failFirst=false,loud=false,pauseMs=0}={}){
  const folder=await mkdtemp(join(root,"reader-")),file=join(folder,"reader.mjs"),log=join(folder,"runs.log");
  await writeFile(file,[
    'import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";',
    'import { basename } from "node:path";',
    `const log=${JSON.stringify(log)},once=${JSON.stringify(join(folder,"failed-once"))};`,
    'const name=basename(process.argv[2]);',
    'appendFileSync(log,"start "+name+"\\n");',
    pauseMs?`await new Promise(resolve=>setTimeout(resolve,${pauseMs}));`:"",
    'const bytes=readFileSync(process.argv[2]);',
    'appendFileSync(log,"end "+name+"\\n");',
    failFirst?'if(!existsSync(once)){writeFileSync(once,"");process.exit(1)}':"",
    'if(bytes.subarray(0,6).toString("latin1")==="refuse")process.exit(2);',
    loud?'process.stdout.write("x".repeat(9*1024*1024));':'process.stdout.write("Text of "+name+": "+bytes.subarray(0,24).toString("latin1"));',
  ].join("\n"),"utf8");
  return {file,runs:async()=>(await readFile(log,"utf8").catch(()=>"")).split("\n").filter(Boolean)};
}
const exists=path=>stat(path).then(()=>true,()=>false);

test("a document of exactly its kind's size bound is read and one a byte larger is not, though text already kept for the larger one is used",async t=>{
  const root=await scratch(t),home=join(root,"home"),reader=await standIn(root);
  const exact=await upload(home,"exact.docx","");await truncate(exact,BOUNDS.documentFile);
  assert.equal(await ensureDocumentText(exact,{home,worker:reader.file}),exact+".txt");
  assert.deepEqual(await reader.runs(),[`start ${basename(exact)}`,`end ${basename(exact)}`]);
  const over=await upload(home,"over.docx","");await truncate(over,BOUNDS.documentFile+1);
  assert.equal(await ensureDocumentText(over,{home,worker:reader.file}),null,"one byte past 50 MiB is never opened");
  const notebook=await upload(home,"exact.ipynb","");await truncate(notebook,BOUNDS.notebookFile);
  assert.equal(await ensureDocumentText(notebook,{home,worker:reader.file}),notebook+".txt","a notebook of exactly 20 MiB is read");
  const largeNotebook=await upload(home,"over.ipynb","");await truncate(largeNotebook,BOUNDS.notebookFile+1);
  assert.equal(await ensureDocumentText(largeNotebook,{home,worker:reader.file}),null,"one byte past 20 MiB is never opened");
  await writeFile(over+".txt","Text kept from before","utf8");
  assert.equal(await ensureDocumentText(over,{home,worker:reader.file}),over+".txt","text already there is used, whatever the size");
  assert.equal(await readFile(over+".txt","utf8"),"Text kept from before");
  assert.equal((await reader.runs()).length,4,"none of the larger calls started the reader");
});

// Re-pinned note: the wait after a failure is Trebell's own two seconds (it was one).
test("after a failure of the system's a document waits exactly two seconds, and output past the limit is such a failure, not a refusal",async t=>{
  const root=await scratch(t),home=join(root,"home");
  const flaky=await standIn(root,{failFirst:true}),memo=await upload(home,"memo.rtf","Ship's memo");
  assert.equal(await ensureDocumentText(memo,{home,worker:flaky.file,now:()=>5000}),null);
  assert.equal(await ensureDocumentText(memo,{home,worker:flaky.file,now:()=>6999}),null,"1,999 ms later it is not tried");
  assert.equal((await flaky.runs()).length,2);
  assert.equal(await ensureDocumentText(memo,{home,worker:flaky.file,now:()=>7000}),memo+".txt","2,000 ms later it is");
  assert.equal(await readFile(memo+".txt","utf8"),`Text of ${basename(memo)}: Ship's memo`);
  assert.equal((await flaky.runs()).length,4);

  const loud=await standIn(root,{loud:true}),deck=await upload(home,"deck.pptx","Deck");
  for(const now of [1000,2999,3000])assert.equal(await ensureDocumentText(deck,{home,worker:loud.file,now:()=>now}),null,`at ${now}`);
  assert.equal((await loud.runs()).length,4,"it ran at 1000, waited at 2999 and ran again at 3000, so it was never taken for refused");
  assert.deepEqual((await readdir(join(home,"attachments"))).filter(name=>name.includes(basename(deck))),[basename(deck)],"no text file and no .part file");
});

test("a refused file from the person's own folder is not read again until it changes, and nothing is written beside it",async t=>{
  const root=await scratch(t),home=join(root,"home"),reader=await standIn(root),projects=join(root,"projects"),own=join(projects,"Plan.docx");
  await mkdir(projects);await writeFile(own,"refuse: not an archive");
  for(let call=0;call<3;call++)assert.equal(await ensureDocumentText(own,{home,worker:reader.file}),null);
  assert.equal((await reader.runs()).length,2,"read once");
  await writeFile(own,"A plan that reads");const later=new Date(Date.now()+60_000);await utimes(own,later,later);
  const text=await ensureDocumentText(own,{home,worker:reader.file});
  assert.equal(join(text,".."),join(home,"attachments"));
  assert.equal(await readFile(text,"utf8"),"Text of Plan.docx: A plan that reads");
  assert.deepEqual(await readdir(projects),["Plan.docx"]);
  assert.equal(await readFile(own,"utf8"),"A plan that reads");
});

test("documents asked for together are read one after another, never two at once",async t=>{
  const root=await scratch(t),home=join(root,"home"),reader=await standIn(root,{pauseMs:150});
  const paths=await Promise.all(["one.docx","two.xlsx","three.pptx","four.odt"].map(name=>upload(home,name,`Contents of ${name}`)));
  assert.deepEqual(await Promise.all(paths.map(path=>ensureDocumentText(path,{home,worker:reader.file}))),paths.map(path=>path+".txt"));
  const runs=await reader.runs();
  assert.equal(runs.length,8);
  for(let at=0;at<runs.length;at+=2)assert.equal(runs[at+1],runs[at].replace(/^start /,"end "),`each reading ends before the next starts: ${runs.join(", ")}`);
  assert.deepEqual(runs.filter(line=>line.startsWith("start ")).map(line=>line.slice(6)).sort(),paths.map(path=>basename(path)).sort());
});

test("text that cannot be put in place leaves no .part file, gives no text, and does not count as the document's failure",async t=>{
  const root=await scratch(t),home=join(root,"home"),reader=await standIn(root),notes=await upload(home,"notes.odp","Notes");
  await mkdir(notes+".txt");
  assert.equal(await ensureDocumentText(notes,{home,worker:reader.file,now:()=>1000}),null);
  assert.deepEqual((await readdir(join(home,"attachments"))).sort(),[basename(notes),basename(notes)+".txt"].sort(),"no .part file is left");
  assert.ok((await stat(notes+".txt")).isDirectory(),"what was in the text file's place is left as it was");
  assert.equal(await ensureDocumentText(notes,{home,worker:reader.file,now:()=>1000}),null);
  assert.equal((await reader.runs()).length,4,"the next call reads it again at once");
  // The text goes to <file>.part and only then is renamed into place: with that name taken by a folder, no text file appears.
  const deck=await upload(home,"deck.pptx","Deck");await mkdir(deck+".txt.part");
  assert.equal(await ensureDocumentText(deck,{home,worker:reader.file}),null);
  assert.equal(await exists(deck+".txt"),false);
  assert.ok((await stat(deck+".txt.part")).isDirectory(),"and the folder in its way is left as it was");
});

test("the lookup names a document's text only once it is there, and never starts a reading",async t=>{
  const root=await scratch(t),home=join(root,"home"),reader=await standIn(root);
  const sheet=await upload(home,"tides.ods","Tides"),notes=await upload(home,"notes.md","# Notes");
  assert.equal(await extractedDocumentText(sheet,{home}),null);
  assert.equal(await exists(sheet+".txt"),false,"the lookup made no text");
  assert.equal(await ensureDocumentText(sheet,{home,worker:reader.file}),sheet+".txt");
  assert.equal(await extractedDocumentText(sheet,{home}),sheet+".txt");
  assert.equal(await extractedDocumentText(sheet,{}),null,"without Trebell's home");
  assert.equal(await extractedDocumentText(notes,{home}),null,"a Markdown file is no document to extract");
  assert.equal(await extractedDocumentText(join(home,"attachments","gone.docx"),{home}),null,"a file that is gone");
  const folder=join(home,"attachments","folder.docx");await mkdir(folder);
  assert.equal(await extractedDocumentText(folder,{home}),null,"a folder named like a document");
  assert.equal(await ensureDocumentText(folder,{home,worker:reader.file}),null);
  assert.equal((await reader.runs()).length,2,"only ensureDocumentText read it");
});

test("the memory of failures keeps 1,024 documents, forgets the one kept longest first, and counts a new failure as the newest",()=>{
  const memory=new FailedExtractions(),name=index=>`doc-${index}.txt`;
  for(let index=0;index<1024;index++)memory.record(name(index),{refused:true,at:index});
  assert.equal(memory.size,1024);
  assert.ok(memory.blocks(name(0),Number.MAX_SAFE_INTEGER),"a refused document stays refused");
  // doc-5 fails again, then six more documents fail: the six kept longest go, and doc-5, now among the newest, stays.
  memory.record(name(5),{refused:true,at:2000});
  for(let index=1024;index<1030;index++)memory.record(name(index),{refused:true,at:index+2000});
  assert.equal(memory.size,1024);
  const kept=index=>memory.blocks(name(index),5000);
  assert.deepEqual([0,1,2,3,4,6].map(kept),[false,false,false,false,false,false],"forgotten, the ones kept longest first");
  assert.deepEqual([5,7,1023,1029].map(kept),[true,true,true,true]);
  const retries=new FailedExtractions();
  retries.record("memo.txt",{refused:false,at:5000});
  assert.deepEqual([4999,5000,6999,7000,8000].map(at=>retries.blocks("memo.txt",at)),[true,true,true,false,false]);
  assert.equal(retries.blocks("never-failed.txt",0),false);
});
