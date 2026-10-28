// An attached Word, Excel, PowerPoint, OpenDocument, RTF, EPUB or notebook file has its text extracted into a file of its own that
// every harness is told of, as T3 Code does (888a3d47d): in a process of its own with T3's limits (16 MB in, 32 MB unpacked, 1,000,000
// characters out, 15 s, a 192 MB heap), beside an upload in Trebell's attachments folder and, for a file attached from the person's
// own folders, inside that folder and never beside their file. A corrupt, encrypted or oversized file gets no text.
import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as documentText from "../src/document-text.mjs";
import { extractDocumentText } from "../src/document-text-extract.mjs";
import { zipArchive } from "./fixtures/documents/zip.mjs";

const FIXTURES=fileURLToPath(new URL("./fixtures/documents/",import.meta.url));
// The note text that reached a limit ends with, and the whole text of one that reached it before any text.
const TRUNCATED="[The extracted text stops here, at Trebell Code's limits for a document.]",CUT="\n\n"+TRUNCATED;
// The text of each fixture (tests/fixtures/documents/make-fixtures.mjs), as an agent is to read it.
const EXPECTED={
  "report.docx":"# Quarterly Harbor Report\nCargo volume rose 12 percent & the new crane is running.\nPort\tTons\nJuniper\t4200\nNext review: March.",
  "budget.xlsx":"## Sheet: Budget\nItem\tCost\tDue\nLantern\t37\t45292 [Excel numFmtId=14; date system 1900]",
  "deck.pptx":"## Slide 1\n\nDeparture plan\nFerries leave at 06:40\nNotes:\n\nBoard at gate 4\n\n## Slide 2\n\nQuestions",
  "notes.odt":"# Orchard notes\n19   violet crates by the gate.",
  "inventory.ods":"## Sheet: Cargo\nViolet\t19\t27.50 EUR",
  "slides.odp":"## Slide 1\nMorning briefing\n\n## Slide 2\nTide tables",
  "memo.rtf":"Memo:\tRelease on Friday\nCafé opens at 8\u2014bring the \u201charbor\u201d keys\nGreek: \u03b1\u03b2",
  "novel.epub":"## Chapter 1\n\nOne# The Lamp\nThe keeper climbed\u00a0the stairs at dusk.\n\n## Chapter 2\n\nTwo## The Storm\nWaves broke over the rocks & the light held.",
  "analysis.ipynb":"## Cell 1 (markdown)\n# Survey\nVessel: Larkspur\n\n## Cell 2 (code)\nprint(43 * 7)\nOutput:\n301\n\n## Cell 3 (code)\n1 / 0\nOutput:\nZeroDivisionError: division by zero\n----> 1 1 / 0\nZeroDivisionError: division by zero",
};
const extension=name=>"."+name.split(".").pop();
async function folder(t,prefix="trebell-document-text-"){
  const root=await mkdtemp(join(tmpdir(),prefix));
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100}));
  return root;
}
// A Trebell home with an upload saved in its attachments folder as the GUI server saves one (<time>-<id>-<name>).
async function upload(home,name,bytes){
  const dir=join(home,"attachments");await mkdir(dir,{recursive:true});
  const path=join(dir,`1761500000000-ab12cd34-${name}`);await writeFile(path,bytes);return path;
}
// A worker that counts its runs in a file and then runs the real one, or, with failFirst, fails its first run as the system would.
async function countingWorker(root,{failFirst=false}={}){
  const worker=join(root,"counting-worker.mjs"),count=join(root,"runs.txt");
  await writeFile(worker,[
    'import { appendFileSync, existsSync } from "node:fs";',
    `const count=${JSON.stringify(count)};const runs=existsSync(count)?1:0;appendFileSync(count,"x");`,
    failFirst?'if(!runs){console.error("spawn EAGAIN");process.exit(1)}':"",
    `await import(${JSON.stringify(pathToFileURL(fileURLToPath(new URL("../src/document-text-worker.mjs",import.meta.url))).href)});`,
  ].join("\n"),"utf8");
  return {worker,runs:async()=>(await readFile(count,"utf8").catch(()=>"")).length};
}
// A Word or OpenDocument file of that XML, deflated, or stored as is with {stored:true}, so its size cannot pass the zip-bomb ratio.
const docx=(body,options)=>zipArchive({"word/document.xml":`<w:document xmlns:w="urn:w"><w:body>${body}</w:body></w:document>`},options);
const odf=(content,options)=>zipArchive({"content.xml":content},options);

test("each type's document yields its text, headings, tables, sheets, slides with their notes, chapters and cells kept, within the limits",async()=>{
  for(const [name,expected] of Object.entries(EXPECTED)){
    const text=await extractDocumentText(join(FIXTURES,name),extension(name));
    assert.equal(text,expected,name);
    assert.ok(!text.includes(TRUNCATED)&&text.length<1_000_000,`${name} is within the limits`);
  }
});

test("an upload's text goes beside it in the attachments folder, and a file attached from the person's folders keeps its text there too, never beside it, extracted again once the file changes",async t=>{
  const root=await folder(t),home=join(root,"home"),{worker,runs}=await countingWorker(root);
  const saved=await upload(home,"report.docx",await readFile(join(FIXTURES,"report.docx")));
  const sidecar=await documentText.ensureDocumentText(saved,{home,worker});
  assert.equal(sidecar,saved+".txt","an upload's text goes beside it, and goes with it");
  assert.equal(await readFile(sidecar,"utf8"),EXPECTED["report.docx"]);
  assert.equal(await documentText.ensureDocumentText(saved,{home,worker}),sidecar,"the text is extracted once");
  assert.equal(await runs(),1);

  const projects=join(root,"projects"),own=join(projects,"Harbor plan.docx");await mkdir(projects);await copyFile(join(FIXTURES,"report.docx"),own);
  const before=await readFile(own),kept=await documentText.ensureDocumentText(own,{home,worker});
  assert.equal(join(kept,".."),join(home,"attachments"),"the text of the person's own file is kept in the attachments folder");
  assert.match(kept,/[0-9a-f]{32}-Harbor_plan\.docx\.txt$/);
  assert.deepEqual(await readdir(projects),["Harbor plan.docx"],"nothing is written beside the person's file");
  assert.deepEqual(await readFile(own),before,"and the file is not changed");
  assert.equal(await readFile(kept,"utf8"),EXPECTED["report.docx"]);
  assert.equal(await documentText.ensureDocumentText(own,{home,worker}),kept);
  assert.equal(await runs(),2);

  // The person saves the file again with another text: its new text is extracted, under its new modification time and size.
  await writeFile(own,docx('<w:p><w:r><w:t>Revised harbor plan</w:t></w:r></w:p>'));
  const later=new Date(Date.now()+5000);await utimes(own,later,later);
  const revised=await documentText.ensureDocumentText(own,{home,worker});
  assert.notEqual(revised,kept);assert.equal(await readFile(revised,"utf8"),"Revised harbor plan");
  assert.equal(await runs(),3);
});

test("a corrupt, encrypted, oversized or empty document, or a file of another kind, gets no text and stays as it was",async t=>{
  const root=await folder(t),home=join(root,"home"),{worker,runs}=await countingWorker(root);
  const encrypted=zipArchive({"word/document.xml":'<w:document xmlns:w="urn:w"><w:p><w:t>Secret</w:t></w:p></w:document>'},{encrypted:true});
  const cases={"broken.docx":"invalid document","locked.docx":encrypted,"blank.docx":docx(""),"broken.ipynb":"{","plain.rtf":"no RTF header","bad-codepage.rtf":String.raw`{\rtf1\ansi\ansicpg99999 Unsupported}`};
  for(const [name,bytes] of Object.entries(cases)){
    const path=await upload(home,name,bytes);
    assert.equal(await documentText.ensureDocumentText(path,{home,worker}),null,name);
    await assert.rejects(stat(path+".txt"),{code:"ENOENT"},`${name} has no text file`);
    assert.deepEqual(await readFile(path),Buffer.from(bytes),`${name} is kept as it was`);
  }
  const spawned=await runs();
  assert.equal(spawned,Object.keys(cases).length);
  // Over 16 MB, a document is not opened at all; a PDF, a ZIP or a text file is not a document Trebell extracts.
  const large=await upload(home,"large.docx","");await truncate(large,16*1024*1024+1);
  assert.equal(await documentText.ensureDocumentText(large,{home,worker}),null);
  for(const name of ["spec.pdf","bundle.zip","notes.txt","report.docx.bak"])assert.equal(await documentText.ensureDocumentText(await upload(home,name,"bytes"),{home,worker}),null,name);
  assert.equal(await documentText.ensureDocumentText(join(home,"attachments","gone.docx"),{home,worker}),null,"a file that is gone");
  assert.equal(await runs(),spawned,"none of them started the worker");
  assert.equal(await documentText.ensureDocumentText(join(FIXTURES,"report.docx"),{worker}),null,"without Trebell's home there is no folder to keep text in");
});

test("a document the worker refused is not extracted again, and a failure of the system's is tried again a second later",async t=>{
  const root=await folder(t),home=join(root,"home");
  const refused=await countingWorker(await folder(t,"trebell-document-refused-"));
  const broken=await upload(home,"broken.docx","invalid document");
  for(const now of [1000,2001,62000])assert.equal(await documentText.ensureDocumentText(broken,{home,worker:refused.worker,now:()=>now}),null);
  assert.equal(await refused.runs(),1,"the worker ran once for a document it refused");

  const flaky=await countingWorker(root,{failFirst:true}),memo=await upload(home,"memo.rtf",await readFile(join(FIXTURES,"memo.rtf")));
  assert.equal(await documentText.ensureDocumentText(memo,{home,worker:flaky.worker,now:()=>5000}),null);
  assert.equal(await documentText.ensureDocumentText(memo,{home,worker:flaky.worker,now:()=>5500}),null,"within the second it is not tried again");
  assert.equal(await flaky.runs(),1);
  assert.equal(await documentText.ensureDocumentText(memo,{home,worker:flaky.worker,now:()=>6001}),memo+".txt","a second later it is");
  assert.equal(await readFile(memo+".txt","utf8"),EXPECTED["memo.rtf"]);
  assert.equal(await flaky.runs(),2);
});

test("two sends of a document while its text is extracted run one extraction, and a document with text already waits for no other",async t=>{
  const root=await folder(t),home=join(root,"home"),{worker,runs}=await countingWorker(root);
  const deck=await upload(home,"deck.pptx",await readFile(join(FIXTURES,"deck.pptx"))),book=await upload(home,"novel.epub",await readFile(join(FIXTURES,"novel.epub")));
  await writeFile(book+".txt","Kept text","utf8");
  const both=Promise.all([documentText.ensureDocumentText(deck,{home,worker}),documentText.ensureDocumentText(deck,{home,worker})]);
  assert.equal(await documentText.ensureDocumentText(book,{home,worker}),book+".txt");
  assert.deepEqual(await both,[deck+".txt",deck+".txt"]);
  assert.equal(await runs(),1);
  assert.equal(await readFile(book+".txt","utf8"),"Kept text","text already there is used as it is");
});

test("the extraction runs on Trebell's own Node, hidden, with no shell and none of the server's NODE_OPTIONS, under a 192 MB heap",async t=>{
  const command=documentText.documentTextCommand("C:\\Docs\\report.DOCX",{env:{PATH:"p",NODE_OPTIONS:"--max-old-space-size=4096 --require evil.cjs",OTHER:"1"},electron:false});
  assert.equal(command.file,process.execPath);
  assert.equal(command.args[0],"--max-old-space-size=192");
  assert.match(command.args[1],/document-text-worker\.mjs$/);
  assert.deepEqual(command.args.slice(2),["C:\\Docs\\report.DOCX",".docx"]);
  assert.deepEqual({timeout:command.options.timeout,windowsHide:command.options.windowsHide,shell:command.options.shell,maxBuffer:command.options.maxBuffer},{timeout:15_000,windowsHide:true,shell:false,maxBuffer:4*1024*1024+1024});
  assert.deepEqual(command.options.env,{PATH:"p",OTHER:"1"});
  assert.equal(documentText.documentTextCommand("a.docx",{env:{},electron:true}).options.env.ELECTRON_RUN_AS_NODE,"1","Electron runs it as Node");
  // The heap limit holds in the process itself, whatever the server's NODE_OPTIONS ask for.
  const root=await folder(t),home=join(root,"home"),probe=join(root,"heap-probe.mjs");
  await writeFile(probe,'import { getHeapStatistics } from "node:v8";process.stdout.write(String(getHeapStatistics().heap_size_limit));',"utf8");
  const sidecar=await documentText.ensureDocumentText(await upload(home,"heap.rtf",String.raw`{\rtf1 heap}`),{home,worker:probe,env:{...process.env,NODE_OPTIONS:"--max-old-space-size=1024"}});
  const limit=Number(await readFile(sidecar,"utf8"));
  assert.ok(limit>192*1024*1024&&limit<=384*1024*1024,`the worker's heap limit is ${limit} bytes`);
});

test("an archive past its limits has its text cut with a note, or none, instead of being read on",async t=>{
  const root=await folder(t),stored={stored:true};let index=0;
  const extract=async(name,bytes)=>{const path=join(root,`${++index}-${name}`);await writeFile(path,bytes);return extractDocumentText(path,extension(name))};
  const count=(text,word)=>text.split(word).length-1;
  // A part that unpacks to more than 200 times its packed size is a zip bomb: nothing of it is read.
  assert.equal(await extract("bomb.docx",docx("<w:p><w:t>A</w:t></w:p>".repeat(100_000))),CUT);
  assert.equal(await extract("crowded.docx",zipArchive({"word/document.xml":"<document><p>Kept</p></document>"},{entryCount:2049})),CUT,"an archive of more than 2048 entries");
  assert.equal(await extract("claims.docx",zipArchive({"word/document.xml":"<document><p>Claims more</p></document>"},{sizes:{"word/document.xml":33*1024*1024}})),CUT,"an entry that says it unpacks past 32 MB");
  const media=await extract("media.docx",zipArchive({"word/document.xml":"<document><p>Readable despite embedded media</p></document>","word/embeddings/unused.bin":Buffer.alloc(33*1024*1024)}));
  assert.equal(media,"Readable despite embedded media","embedded files are never unpacked");
  assert.equal(await extract("deep.docx",docx("<div>".repeat(129)+"Lost"+"</div>".repeat(129),stored)),CUT,"XML nested more than 128 deep");
  assert.equal(await extract("wide.docx",docx("<w:p/>".repeat(200_001),stored)),CUT,"more than 200,000 elements");
  const rows=await extract("rows.ods",odf('<document><table:table table:name="Long"><table:table-row table:number-rows-repeated="10001"><table:table-cell><text:p>Repeated value</text:p></table:table-cell></table:table-row></table:table></document>',stored));
  assert.equal(count(rows,"Repeated value"),10_000);assert.ok(rows.endsWith(TRUNCATED),"more than 10,000 rows");
  const columns=await extract("columns.ods",odf('<document><table:table table:name="Wide"><table:table-row><table:table-cell table:number-columns-repeated="513"><text:p>Cell</text:p></table:table-cell></table:table-row></table:table></document>',stored));
  assert.equal(count(columns,"Cell"),512);assert.ok(columns.endsWith(TRUNCATED),"more than 512 columns");
  assert.equal(await extract("spaces.odt",odf('<document><text:p>Start<text:s text:c="1000001"/>Unneeded</text:p></document>',stored)),"Start"+CUT,"a space repeated past the text's limit");
  const padded=await extract("padded.ods",odf('<document><table:table table:name="Padded"><table:table-row><table:table-cell><text:p>Populated</text:p></table:table-cell><table:table-cell table:number-columns-repeated="16383"/></table:table-row><table:table-row table:number-rows-repeated="1048575"><table:table-cell table:number-columns-repeated="16384"><text:p/></table:table-cell></table:table-row></table:table></document>',stored));
  assert.equal(padded,"## Sheet: Padded\nPopulated","a sheet's padding of empty rows and cells is never expanded");
  const long=await extract("long.docx",docx(`<w:p><w:t>${"A".repeat(1_000_100)}</w:t></w:p><w:p><w:t>Unneeded</w:t></w:p>`,stored));
  assert.ok(long==="A".repeat(1_000_000)+CUT,"text past 1,000,000 characters stops there");
  const notebook=await extract("cells.ipynb",JSON.stringify({cells:Array.from({length:10_001},(_,cell)=>({cell_type:"markdown",source:[`c${cell}`]}))}));
  assert.ok(notebook.endsWith(TRUNCATED)&&notebook.includes("## Cell 10000 (markdown)")&&!notebook.includes("Cell 10001"),"more than 10,000 notebook cells");
  assert.equal(await extract("nested.rtf",String.raw`{\rtf1 `+"{".repeat(129)+"Lost"+"}".repeat(130)),CUT,"RTF groups nested more than 128 deep");
  await assert.rejects(extract("locked.docx",zipArchive({"word/document.xml":"<document><p>Secret</p></document>"},{encrypted:true})),/Encrypted archive/);
  // A part that is missing or is not XML is left out, said, and the rest still read.
  const partial=await extract("partial.pptx",zipArchive({
    "ppt/presentation.xml":'<presentation><sldId r:id="bad"/><sldId r:id="good"/></presentation>',
    "ppt/_rels/presentation.xml.rels":'<Relationships><Relationship Id="bad" Target="bad.xml"/><Relationship Id="good" Target="good.xml"/></Relationships>',
    "ppt/bad.xml":"<slide><p>Discard</slide>","ppt/good.xml":"<slide><p>Healthy part</p></slide>",
  }));
  assert.ok(partial.includes("Healthy part")&&partial.includes("[A part of the document was left out: ppt/bad.xml is missing or is not valid XML.]")&&!partial.includes("Discard"));
  // No DTD is read, so an entity a document declares never expands: the part is left out as not valid XML.
  const entities=await extract("entities.docx",zipArchive({"word/document.xml":'<!DOCTYPE d [<!ENTITY a "AAAAAAAAAA"><!ENTITY b "&a;&a;&a;&a;&a;">]><d><p>&b;</p></d>'}));
  assert.ok(entities.includes("[A part of the document was left out: word/document.xml is missing or is not valid XML.]")&&!entities.includes("AAAA"));
});
