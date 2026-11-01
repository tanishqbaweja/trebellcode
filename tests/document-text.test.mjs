// An attached Word, Excel, PowerPoint, OpenDocument, RTF, EPUB or notebook file is read into a text file of its own that every
// harness is told of: in a process of its own (15 s, a 192 MB heap, no keys), beside an upload in Trebell's attachments folder and,
// for a file attached from the person's own folders, inside that folder and never beside their file. The reader keeps to the bounds
// in src/document-reading.mjs; a damaged, locked or empty document gets no text.
import test from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as documentText from "../src/document-text.mjs";
import { BOUNDS } from "../src/document-reading.mjs";
import { readDocumentText } from "../src/document-text-extract.mjs";
import { zipArchive } from "./fixtures/documents/zip.mjs";

const FIXTURES=fileURLToPath(new URL("./fixtures/documents/",import.meta.url));
const MiB=1024*1024;
const char=code=>String.fromCharCode(code);
// The note a document past a bound ends with, and the note for a part that is missing or not well-formed.
const GOES_ON="[The document goes on, but Trebell Code read only this much of it.]";
const leftOut=what=>`[Left out: ${what} is missing from the document or is not well-formed XML.]`;
// The text of each fixture (tests/fixtures/documents/make-fixtures.mjs), as a harness reads it.
const FIXTURE_TEXT={
  "report.docx":"# Quarterly Harbor Report\nCargo volume rose 12 percent & the new crane is running.\nPort\tTons\nJuniper\t4200\nNext review: March.",
  "budget.xlsx":"## Sheet 1 of 2: Stores\nItem\tCount\tDelivered\nRope\t52\t2025-12-09 06:00\nPaint\tFALSE\t\t=B2*2\n\n## Sheet 2 of 2: Rates (hidden)\n\tDiesel\t12.5%\t2024-01-01",
  "deck.pptx":"## Slide 1 of 2\nCrossing schedule\nFirst sailing 05:50\n\nSpeaker notes:\nCheck the forecast first\n\n## Slide 2 of 2\nAny questions?",
  "notes.odt":"## Dock journal\nTide at   noon, wind\twest\nCrew of four\nLogged by the harbour master",
  "inventory.ods":"## Sheet 1 of 2: Moorings\nBerth\tBoat\tFee\tShare\nB4\tHeron\t35 GBP\t12.5%\n\n## Sheet 2 of 2\n7\n7",
  "slides.odp":"## Slide 1 of 2\nHarbour safety\n\nSpeaker notes:\nMention the new buoys\n\n## Slide 2 of 2\nThank you",
  "memo.rtf":`Notice:\tGate closes at 9\nCr${char(0xe8)}me caf${char(0xe9)} ${char(0x2013)} open daily\nQuote: ${char(0x2018)}fair winds${char(0x2019)}\nEuro: ${char(0x20ac)}`,
  "novel.epub":`## Section 1 of 3\n\n## Section 2 of 3\n# Low Water\nThe ferry waited${char(0xa0)}for the tide${char(0x2026)}\n\n## Section 3 of 3\n## Crossing\nGulls followed the wake & the bell rang.\nRopes\nLanterns`,
  "analysis.ipynb":"## Markdown cell 1 of 5\n# Fuel use\nWeekly totals\n\n## Code cell 2 of 5\nprint(40 + 2)\nCell output:\n42\n\n## Code cell 3 of 5\nchart(totals)\nCell output:\n<Figure 1>\n[image/png output]\n\n## Raw cell 4 of 5\nraw notes\n\n## Code cell 5 of 5\ntotals['june']\nCell output:\nKeyError: 'june'\n---------------------------------------------------------------------------\nKeyError: 'june'",
};
const extensionOf=name=>name.slice(name.lastIndexOf("."));
async function scratch(t,prefix="trebell-reader-"){
  const root=await mkdtemp(join(tmpdir(),prefix));
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:20,retryDelay:100}));
  return root;
}
// An upload kept in a Trebell home's attachments folder, named as the GUI server names one (<time>-<id>-<name>).
async function upload(home,name,bytes){
  const folder=join(home,"attachments");await mkdir(folder,{recursive:true});
  const path=join(folder,`1762000000000-5e6f7a8b-${name}`);await writeFile(path,bytes);return path;
}
// A worker that counts its runs in a file and then runs the real one; with failFirst its first run fails as the system's would.
async function countedWorker(root,{failFirst=false}={}){
  const worker=join(root,"counted-worker.mjs"),tally=join(root,"tally.txt");
  const real=pathToFileURL(fileURLToPath(new URL("../src/document-text-worker.mjs",import.meta.url))).href;
  await writeFile(worker,[
    'import { appendFileSync, existsSync } from "node:fs";',
    `const tally=${JSON.stringify(tally)},before=existsSync(tally);appendFileSync(tally,"+");`,
    failFirst?'if(!before){console.error("spawn EAGAIN");process.exit(1)}':"",
    `await import(${JSON.stringify(real)});`,
  ].join("\n"),"utf8");
  return {worker,runs:async()=>(await readFile(tally,"utf8").catch(()=>"")).length};
}
// Documents built in the tests: a Word body (paragraphs and runs in WordprocessingML's own namespace), an OpenDocument content part.
const WORD_NS="http://schemas.openxmlformats.org/wordprocessingml/2006/main",WORD_OPEN=`<w:document xmlns:mc="urn:mc" xmlns:w="${WORD_NS}">`;
const wordFile=(body,options)=>zipArchive({"word/document.xml":`${WORD_OPEN}<w:body>${body}</w:body></w:document>`},options);
const words=(text,properties="")=>`<w:p>${properties}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const ODF_NS='xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0"';
const openDocumentFile=(body,options)=>zipArchive({"content.xml":`<office:document-content ${ODF_NS}><office:body>${body}</office:body></office:document-content>`},options);
// Reads bytes saved under name in root, as the worker would.
function reader(root){
  let count=0;
  return async(name,bytes)=>{const path=join(root,`${++count}-${name}`);await writeFile(path,bytes);return readDocumentText(path,extensionOf(name))};
}

test("each kind of document reads as its text, with a heading for every sheet, slide, section and notebook cell",async()=>{
  for(const [name,expected] of Object.entries(FIXTURE_TEXT)){
    assert.equal(await readDocumentText(join(FIXTURES,name),extensionOf(name)),expected,name);
  }
});

test("an upload's text goes beside it, and a file from the person's folders keeps its text in the attachments folder, read again once it changes",async t=>{
  const root=await scratch(t),home=join(root,"home"),{worker,runs}=await countedWorker(root);
  const saved=await upload(home,"report.docx",await readFile(join(FIXTURES,"report.docx")));
  const beside=await documentText.ensureDocumentText(saved,{home,worker});
  assert.equal(beside,saved+".txt","an upload's text goes beside it, and goes with it");
  assert.equal(await readFile(beside,"utf8"),FIXTURE_TEXT["report.docx"]);
  assert.equal(await documentText.ensureDocumentText(saved,{home,worker}),beside,"the text is read once");
  assert.equal(await runs(),1);

  const projects=join(root,"projects"),own=join(projects,"Pier works.docx");
  await mkdir(projects);await copyFile(join(FIXTURES,"report.docx"),own);
  const original=await readFile(own),kept=await documentText.ensureDocumentText(own,{home,worker});
  assert.equal(join(kept,".."),join(home,"attachments"),"the text of the person's own file is kept in the attachments folder");
  assert.match(kept,/[0-9a-f]{32}-Pier_works\.docx\.txt$/);
  assert.deepEqual(await readdir(projects),["Pier works.docx"],"nothing is written beside the person's file");
  assert.deepEqual(await readFile(own),original,"and the file is not changed");
  assert.equal(await documentText.ensureDocumentText(own,{home,worker}),kept);
  assert.equal(await runs(),2);

  // The person saves another version: its text is read again, under its new modification time and size.
  await writeFile(own,wordFile(words("Pier works, second draft")));
  const later=new Date(Date.now()+5000);await utimes(own,later,later);
  const redone=await documentText.ensureDocumentText(own,{home,worker});
  assert.notEqual(redone,kept);assert.equal(await readFile(redone,"utf8"),"Pier works, second draft");
  assert.equal(await runs(),3);
});

test("a damaged, locked, empty or oversized document, or a file of another kind, gets no text and is left as it was",async t=>{
  const root=await scratch(t),home=join(root,"home"),{worker,runs}=await countedWorker(root);
  const refused={
    "torn.docx":"PK but not an archive",
    "locked.docx":zipArchive({"word/document.xml":`${WORD_OPEN}</w:document>`},{encrypted:true}),
    "empty.docx":wordFile(""),
    "cut.ipynb":'{"cells":[',
    "plain.rtf":"just some words",
    "dos.rtf":String.raw`{\rtf1\ansi\ansicpg850 A DOS page}`,
  };
  for(const [name,bytes] of Object.entries(refused)){
    const path=await upload(home,name,bytes);
    assert.equal(await documentText.ensureDocumentText(path,{home,worker}),null,name);
    await assert.rejects(stat(path+".txt"),{code:"ENOENT"},`${name} has no text file`);
    assert.deepEqual(await readFile(path),Buffer.from(bytes),`${name} is kept as it was`);
  }
  const started=await runs();
  assert.equal(started,Object.keys(refused).length);
  // Past its kind's size a document is not opened at all (50 MiB, a notebook 20 MiB); other files are not documents Trebell reads.
  const large=await upload(home,"large.docx","");await truncate(large,BOUNDS.documentFile+1);
  assert.equal(await documentText.ensureDocumentText(large,{home,worker}),null);
  const notebook=await upload(home,"large.ipynb","");await truncate(notebook,BOUNDS.notebookFile+1);
  assert.equal(await documentText.ensureDocumentText(notebook,{home,worker}),null);
  for(const name of ["chart.pdf","archive.zip","readme.txt","report.docx.old"])assert.equal(await documentText.ensureDocumentText(await upload(home,name,"bytes"),{home,worker}),null,name);
  assert.equal(await documentText.ensureDocumentText(join(home,"attachments","missing.docx"),{home,worker}),null,"a file that is not there");
  assert.equal(await runs(),started,"none of them started the worker");
  assert.equal(await documentText.ensureDocumentText(join(FIXTURES,"report.docx"),{worker}),null,"without Trebell's home there is no folder to keep text in");
});

// Re-pinned note: two seconds now (Trebell's own wait; it was one).
test("a document the worker refused is not read again, and a failure of the system's is tried again two seconds later",async t=>{
  const root=await scratch(t),home=join(root,"home");
  const refusing=await countedWorker(await scratch(t,"trebell-reader-refused-"));
  const torn=await upload(home,"torn.docx","PK but not an archive");
  for(const now of [1000,2001,62000])assert.equal(await documentText.ensureDocumentText(torn,{home,worker:refusing.worker,now:()=>now}),null);
  assert.equal(await refusing.runs(),1,"the worker ran once for a document it refused");

  const flaky=await countedWorker(root,{failFirst:true}),memo=await upload(home,"memo.rtf",await readFile(join(FIXTURES,"memo.rtf")));
  assert.equal(await documentText.ensureDocumentText(memo,{home,worker:flaky.worker,now:()=>5000}),null);
  assert.equal(await documentText.ensureDocumentText(memo,{home,worker:flaky.worker,now:()=>6500}),null,"within the two seconds it is not tried again");
  assert.equal(await flaky.runs(),1);
  assert.equal(await documentText.ensureDocumentText(memo,{home,worker:flaky.worker,now:()=>7001}),memo+".txt","two seconds later it is");
  assert.equal(await readFile(memo+".txt","utf8"),FIXTURE_TEXT["memo.rtf"]);
  assert.equal(await flaky.runs(),2);
});

test("two sends of a document while it is read run one reading, and a document with text already waits for no other",async t=>{
  const root=await scratch(t),home=join(root,"home"),{worker,runs}=await countedWorker(root);
  const deck=await upload(home,"deck.pptx",await readFile(join(FIXTURES,"deck.pptx"))),book=await upload(home,"novel.epub",await readFile(join(FIXTURES,"novel.epub")));
  await writeFile(book+".txt","Text from before","utf8");
  const both=Promise.all([documentText.ensureDocumentText(deck,{home,worker}),documentText.ensureDocumentText(deck,{home,worker})]);
  assert.equal(await documentText.ensureDocumentText(book,{home,worker}),book+".txt");
  assert.deepEqual(await both,[deck+".txt",deck+".txt"]);
  assert.equal(await runs(),1);
  assert.equal(await readFile(book+".txt","utf8"),"Text from before","text already there is used as it is");
});

test("the reading runs on Trebell's own Node, hidden, with no shell, none of the server's NODE_OPTIONS or keys, under a 192 MB heap",async t=>{
  const command=documentText.documentTextCommand("D:\\Shared\\Plan.DOCX",{env:{PATH:"p",NODE_OPTIONS:"--max-old-space-size=8192 --require hook.cjs",EXTRA:"1",OPENAI_API_KEY:"sk-server"},electron:false});
  assert.equal(command.file,process.execPath);
  assert.equal(command.args[0],"--max-old-space-size=192");
  assert.match(command.args[1],/document-text-worker\.mjs$/);
  assert.deepEqual(command.args.slice(2),["D:\\Shared\\Plan.DOCX",".docx"]);
  // The pipe takes the whole text at up to 4 bytes a character, and the closing note.
  assert.deepEqual({timeout:command.options.timeout,windowsHide:command.options.windowsHide,shell:command.options.shell,maxBuffer:command.options.maxBuffer},{timeout:15_000,windowsHide:true,shell:false,maxBuffer:BOUNDS.textCharacters*4+4096});
  // A probe in the worker's place reports which of the server's keys reach it: none, and PATH still does.
  const keys=await scratch(t,"trebell-reader-env-"),keysHome=join(keys,"home"),probe=join(keys,"env-probe.mjs");
  await writeFile(probe,'const names=["OPENAI_API_KEY","ANTHROPIC_API_KEY","GEMINI_API_KEY","TREBELL_PROBE_TOKEN","NODE_OPTIONS"];process.stdout.write(JSON.stringify({seen:names.filter(name=>name in process.env),path:Boolean(process.env.PATH||process.env.Path)}));',"utf8");
  const server={...process.env,OPENAI_API_KEY:"sk-server-openai",ANTHROPIC_API_KEY:"sk-ant-server",GEMINI_API_KEY:"gemini-server",TREBELL_PROBE_TOKEN:"token-server",NODE_OPTIONS:"--no-warnings"};
  const seen=await documentText.ensureDocumentText(await upload(keysHome,"keys.rtf",String.raw`{\rtf1 keys}`),{home:keysHome,worker:probe,env:server});
  assert.deepEqual({command:command.options.env,worker:JSON.parse(await readFile(seen,"utf8"))},{command:{PATH:"p"},worker:{seen:[],path:true}});
  assert.equal(documentText.documentTextCommand("a.docx",{env:{},electron:true}).options.env.ELECTRON_RUN_AS_NODE,"1","Electron runs it as Node");
  const root=await scratch(t),home=join(root,"home"),heap=join(root,"heap-probe.mjs");
  await writeFile(heap,'import { getHeapStatistics } from "node:v8";process.stdout.write(String(getHeapStatistics().heap_size_limit));',"utf8");
  const reported=await documentText.ensureDocumentText(await upload(home,"heap.rtf",String.raw`{\rtf1 heap}`),{home,worker:heap,env:{...process.env,NODE_OPTIONS:"--max-old-space-size=4096"}});
  const limit=Number(await readFile(reported,"utf8"));
  assert.ok(limit>192*MiB&&limit<=384*MiB,`the worker's heap limit is ${limit} bytes`);
});

test("a document past a bound keeps the text read until then and ends with a note, and one past it from the start is the note alone",async t=>{
  const read=reader(await scratch(t)),stored={stored:true};
  assert.equal(await read("many.docx",zipArchive({"word/document.xml":`${WORD_OPEN}</w:document>`},{entryCount:BOUNDS.archiveEntries+1})),GOES_ON,"an archive of more entries than the bound");
  assert.equal(await read("claims.docx",zipArchive({"word/document.xml":"<d/>"},{sizes:{"word/document.xml":BOUNDS.partBytes+1}})),GOES_ON,"a part said to unpack past the part bound");
  const media=await read("media.docx",zipArchive({"word/document.xml":`${WORD_OPEN}<w:body>${words("The text beside a large recording")}</w:body></w:document>`,"word/media/recording.wav":Buffer.alloc(BOUNDS.partBytes+MiB)}));
  assert.equal(media,"The text beside a large recording","media are never unpacked");
  // Three content documents of 23 MiB each pass the package's 64 MiB together: the third is not unpacked.
  const padded=word=>`<html xmlns="http://www.w3.org/1999/xhtml"><body><p>${word}</p>${" ".repeat(23*MiB)}</body></html>`;
  const book=zipArchive({
    "META-INF/container.xml":'<container version="1.0"><rootfiles><rootfile media-type="application/oebps-package+xml" full-path="book.opf"/></rootfiles></container>',
    "book.opf":'<package><manifest><item id="a" href="a.xhtml"/><item id="b" href="b.xhtml"/><item id="c" href="c.xhtml"/></manifest><spine><itemref idref="a"/><itemref idref="b"/><itemref idref="c"/></spine></package>',
    "a.xhtml":padded("North"),"b.xhtml":padded("South"),"c.xhtml":padded("East"),
  });
  assert.equal(await read("long.epub",book),`## Section 1 of 3\nNorth\n\n## Section 2 of 3\nSouth\n\n## Section 3 of 3\n\n${GOES_ON}`);
  assert.equal(await read("deep.docx",wordFile("<w:sdt>".repeat(BOUNDS.nesting)+words("Too deep")+"</w:sdt>".repeat(BOUNDS.nesting),stored)),GOES_ON,"elements nested past the bound");
  assert.equal(await read("deep.rtf",String.raw`{\rtf1 `+"{".repeat(BOUNDS.nesting)+"Too deep"+"}".repeat(BOUNDS.nesting+1)),GOES_ON,"RTF groups nested past the bound");
  const long=await read("long.docx",wordFile(words("x".repeat(BOUNDS.textCharacters+50))+words("Never reached"),stored));
  assert.equal(long,"x".repeat(BOUNDS.textCharacters)+"\n\n"+GOES_ON,"text stops at the bound");
  assert.equal(await read("spaces.odt",openDocumentFile(`<office:text><text:p>Start<text:s text:c="${BOUNDS.textCharacters*2}"/>never</text:p></office:text>`,stored)),"Start\n\n"+GOES_ON,"a counted space past the bound");
  const notebook=JSON.stringify({cells:[{cell_type:"markdown",source:"padding"}]})+" ".repeat(BOUNDS.notebookFile);
  assert.equal(await read("padded.ipynb",notebook),GOES_ON,"a notebook past its file bound is not parsed");
  // Rows and cells repeat as written; padding (blank rows, blank cells at a row's end) is never expanded.
  const sheet=await read("repeats.ods",openDocumentFile('<office:spreadsheet><table:table table:name="Shifts"><table:table-row table:number-rows-repeated="3"><table:table-cell table:number-columns-repeated="2"><text:p>on</text:p></table:table-cell><table:table-cell table:number-columns-repeated="16000"/></table:table-row><table:table-row table:number-rows-repeated="1000000"><table:table-cell table:number-columns-repeated="16384"/></table:table-row><table:table-row><table:table-cell/><table:table-cell><text:p>end</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet>'));
  assert.equal(sheet,"## Sheet 1 of 1: Shifts\non\ton\non\ton\non\ton\n\tend");
  await assert.rejects(read("count.ods",openDocumentFile('<office:spreadsheet><table:table><table:table-row table:number-rows-repeated="-2"><table:table-cell><text:p>x</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet>')),/repeat count/);
  await assert.rejects(read("locked.docx",zipArchive({"word/document.xml":"<d/>"},{encrypted:true})),/password-protected/);
  // A part that is missing or not well-formed is left out with a note where its text would be, and the rest is still read.
  const deck=await read("torn.pptx",zipArchive({
    "ppt/presentation.xml":'<presentation><sldIdLst><sldId r:id="rIdA"/><sldId r:id="rIdB"/></sldIdLst></presentation>',
    "ppt/_rels/presentation.xml.rels":'<Relationships><Relationship Id="rIdA" Target="slides/half.xml"/><Relationship Id="rIdB" Target="slides/whole.xml"/></Relationships>',
    "ppt/slides/half.xml":"<sld><p><t>Half a slide</t></sld>","ppt/slides/whole.xml":"<sld><p><t>A whole slide</t></p></sld>",
  }));
  assert.equal(deck,`## Slide 1 of 2\n${leftOut("ppt/slides/half.xml")}\n\n## Slide 2 of 2\nA whole slide`);
  // No DTD is read, so an entity a part declares never expands.
  const declared=await read("declared.docx",zipArchive({"word/document.xml":'<!DOCTYPE d [<!ENTITY x "XXXXXXXX"><!ENTITY y "&x;&x;&x;">]><d><p><t>&y;</t></p></d>'}));
  assert.equal(declared,leftOut("word/document.xml"));
});

test("Word text skips deletions, field codes, moved text and fallbacks, and takes headings from styles and outline levels",async t=>{
  const read=reader(await scratch(t));
  const body=[
    words("Agenda",'<w:pPr><w:pStyle w:val="Title"/><w:tabs><w:tab w:val="left" w:pos="720"/></w:tabs></w:pPr>'),
    words("Scope",'<w:pPr><w:outlineLvl w:val="2"/></w:pPr>'),
    '<w:p><w:r><w:t>Kept</w:t></w:r><w:del><w:r><w:delText> removed</w:delText></w:r></w:del><w:r><w:instrText> PAGE </w:instrText></w:r><w:r><w:tab/><w:t>after a tab</w:t><w:br/><w:t>next line</w:t></w:r></w:p>',
    '<w:moveFrom><w:r><w:t>Old place</w:t></w:r></w:moveFrom>',
    '<w:p><w:r><mc:AlternateContent xmlns:mc="urn:mc"><mc:Choice><w:t>Box text</w:t></mc:Choice><mc:Fallback><w:t>Box text again</w:t></mc:Fallback></mc:AlternateContent></w:r></w:p>',
    '<w:tbl><w:tr><w:tc>'+words("Outer")+'<w:tbl><w:tr><w:tc>'+words("inner a")+'</w:tc><w:tc>'+words("inner b")+'</w:tc></w:tr></w:tbl></w:tc><w:tc/><w:tc>'+words("Last")+'</w:tc><w:tc/></w:tr><w:tr><w:tc/></w:tr></w:tbl>',
    words("Point",'<w:pPr><w:pStyle w:val="Heading8"/></w:pPr>'),
  ].join("");
  assert.equal(await read("plain.docx",wordFile(body)),"# Agenda\n### Scope\nKept\tafter a tab\nnext line\nBox text\nOuter inner a inner b\t\tLast\n###### Point");
});

test("a sheet's values show as Excel shows them: dates and times by their format and date system, percentages, booleans and errors",async t=>{
  const read=reader(await scratch(t));
  const workbook=zipArchive({
    "xl/workbook.xml":'<workbook xmlns:r="urn:r"><workbookPr date1904="true"/><sheets><sheet name="Log" r:id="rIdLog"/><sheet name="Gone" r:id="rIdGone"/><sheet name="Secret" state="veryHidden" r:id="rIdSecret"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels":'<Relationships><Relationship Id="rIdLog" Target="/xl/sheets/log.xml"/><Relationship Id="rIdSecret" Target="sheets/secret.xml"/><Relationship Id="rIdText" Type="urn:x/sharedStrings" Target="text.xml"/><Relationship Id="rIdLook" Type="urn:x/styles" Target="look.xml"/></Relationships>',
    "xl/look.xml":'<styleSheet><numFmts><numFmt numFmtId="200" formatCode="[h]:mm:ss"/><numFmt numFmtId="201" formatCode="0.0%;[Red]-0.0%"/><numFmt numFmtId="202" formatCode="&quot;day&quot; 0"/><numFmt numFmtId="203" formatCode="hh:mm"/></numFmts><cellStyleXfs><xf numFmtId="14"/></cellStyleXfs><cellXfs><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="200"/><xf numFmtId="201"/><xf numFmtId="202"/><xf numFmtId="203"/></cellXfs></styleSheet>',
    "xl/text.xml":'<sst><si><r><t>Tide</t></r><r><t xml:space="preserve"> log</t></r><rPh><t>reading</t></rPh></si></sst>',
    "xl/sheets/log.xml":'<worksheet><sheetData><row><c t="s"><v>0</v></c><c t="inlineStr"><is><t>inline</t><rPh><t>not this</t></rPh></is></c><c t="e"><v>#DIV/0!</v></c></row><row><c s="1"><v>0</v></c><c s="2"><v>1.5</v></c><c s="3"><v>0.256</v></c><c s="4"><v>12</v></c><c s="5"><v>0.75</v></c></row><row><c t="b"><v>1</v></c><c t="str"><f>A1&amp;"!"</f><v>Tide log!</v></c><c t="d"><v>2026-03-01T00:00:00</v></c><c r="XFE3"><v>9</v></c></row><row><c r="C4"/></row></sheetData></worksheet>',
    "xl/sheets/secret.xml":'<worksheet><sheetData><row><c r="A1"><v>1</v></c></row></sheetData></worksheet>',
  });
  assert.equal(await read("log.xlsx",workbook),[
    "## Sheet 1 of 3: Log","Tide log\tinline\t#DIV/0!","1904-01-01\t36:00:00\t25.6%\t12\t18:00","TRUE\tTide log!\t2026-03-01T00:00:00","",
    "## Sheet 2 of 3: Gone",leftOut("the link to sheet 2"),"",
    "## Sheet 3 of 3: Secret (hidden)","1",
  ].join("\n"));
  // The 1900 date system keeps Excel's 29 February 1900 and counts on from it.
  const days=zipArchive({
    "xl/workbook.xml":'<workbook xmlns:r="urn:r"><sheets><sheet name="Days" r:id="d"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels":'<Relationships><Relationship Id="d" Target="days.xml"/></Relationships>',
    "xl/styles.xml":'<styleSheet><cellXfs><xf numFmtId="0"/><xf numFmtId="15"/><xf numFmtId="21"/></cellXfs></styleSheet>',
    "xl/days.xml":'<worksheet><sheetData><row><c s="1"><v>1</v></c><c s="1"><v>59</v></c><c s="1"><v>60</v></c><c s="1"><v>61</v></c><c s="2"><v>0.99999</v></c><c s="2"><v>0.5000116</v></c></row></sheetData></worksheet>',
  });
  assert.equal(await read("days.xlsx",days),"## Sheet 1 of 1: Days\n1900-01-01\t1900-02-28\t1900-02-29\t1900-03-01\t23:59:59\t12:00:01");
});

test("RTF reads in its code page, double-byte pages included, without the groups that hold no body text",async t=>{
  const read=reader(await scratch(t)),slash=char(92);
  const greek=String.raw`{\rtf1\ansi\ansicpg1253{\fonttbl{\f0 Arial;}}{\stylesheet{\s1 Heading;}}{\footer Page footer}{\*\generator Writer;}{\field{\*\fldinst HYPERLINK "https://example.com"}{\fldrslt Site}} \'e1\'e2\'e3 \uc2`+slash+String.raw`u8364\'80\'80 sum\bin5 {}\\x\par{\pict 89504e47}after\line two~\~\-\_end}`;
  assert.equal(await read("greek.rtf",Buffer.from(greek,"latin1")),`Site ${char(0x3b1)}${char(0x3b2)}${char(0x3b3)} ${char(0x20ac)} sum\nafter\ntwo~${char(0xa0)}${char(0x2011)}end`);
  const table=String.raw`{\rtf1\ansi\trowd\cellx1000\cellx2000 Berth\cell Boat\cell\row\trowd\cellx1000\cellx2000 B4\cell Heron\cell\row}`;
  assert.equal(await read("table.rtf",table),"Berth\tBoat\nB4\tHeron");
  // Shift_JIS pairs stay whole even when a byte of the pair is a brace or written as \'hh.
  const japanese=String.raw`{\rtf1\ansi\ansicpg932 \'93\'fa\'96\'7b\par}`;
  assert.equal(await read("japanese.rtf",Buffer.from(japanese,"latin1")),`${char(0x65e5)}${char(0x672c)}`);
  await assert.rejects(read("ebcdic.rtf",String.raw`{\rtf1\ansicpg37 x}`),/code page 37/);
});

test("EPUB sections, notebook cells, slides and OpenDocument cells read as their formats say",async t=>{
  const read=reader(await scratch(t));
  const book=zipArchive({
    mimetype:"application/epub+zip",
    "META-INF/container.xml":'<container version="1.0"><rootfiles><rootfile media-type="application/oebps-package+xml" full-path="OPS/book.opf"/></rootfiles></container>',
    "OPS/book.opf":'<package><manifest><item id="one" href="text/the%20start.xhtml#top"/><item id="three" href="../OPS/end.xhtml"/></manifest><spine><itemref idref="one"/><itemref idref="nowhere"/><itemref idref="three"/></spine></package>',
    "OPS/text/the start.xhtml":'<html><head><title>Not shown</title><script>var hidden=1</script></head><body><h3>Start</h3><p>First&nbsp;words <em>here</em></p><pre>  kept   as is</pre><table><tr><th>Tide</th><td>High</td></tr></table></body></html>',
    "OPS/end.xhtml":"<html><body><div>Last<br/>line</div></body></html>",
  });
  assert.equal(await read("book.epub",book),`## Section 1 of 3\n### Start\nFirst${char(0xa0)}words here\n  kept   as is\nTide\tHigh\n\n## Section 2 of 3\n${leftOut("section 2")}\n\n## Section 3 of 3\nLast\nline`);
  const cells=[42,{cell_type:"code",source:"x = 1",outputs:[]},{cell_type:"code",source:["show()"],outputs:[{output_type:"display_data",data:{"image/svg+xml":"<svg/>","application/json":{}}},{output_type:"stream",name:"stderr",text:"warning"}]},{cell_type:"heading",source:"old kind"}];
  assert.equal(await read("cells.ipynb",JSON.stringify({cells})),"## Code cell 2 of 4\nx = 1\n\n## Code cell 3 of 4\nshow()\nCell output:\n[image/svg+xml output]\n[application/json output]\nwarning\n\n## Unknown cell 4 of 4\nold kind");
  await assert.rejects(read("old.ipynb",JSON.stringify({worksheets:[{cells:[]}]})),/no list of cells/);
  const deck=zipArchive({
    "_rels/.rels":'<Relationships><Relationship Id="m" Type="urn:x/officeDocument" Target="/deck/main.xml"/></Relationships>',
    "deck/main.xml":'<p:presentation xmlns:p="urn:p" xmlns:r="urn:r"><p:sldIdLst><p:sldId id="256" r:id="s1"/><p:sldId id="257" r:id="s9"/></p:sldIdLst></p:presentation>',
    "deck/_rels/main.xml.rels":'<Relationships><Relationship Id="s1" Target="pages/one.xml"/></Relationships>',
    "deck/pages/one.xml":'<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:p><a:r><a:t>Route</a:t></a:r><a:br/><a:r><a:t>map</a:t></a:r></a:p><a:tbl><a:tr><a:tc><a:txBody><a:p><a:r><a:t>Stop</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>Time</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl></p:sld>',
    "deck/pages/_rels/one.xml.rels":'<Relationships><Relationship Id="n" Type="urn:x/notesSlide" Target="/deck/talk.xml"/><Relationship Id="w" Type="urn:x/notesSlide" Target="https://example.com/notes" TargetMode="External"/></Relationships>',
    "deck/talk.xml":'<p:notes xmlns:p="urn:p" xmlns:a="urn:a"><a:p><a:r><a:t>Go slowly</a:t></a:r></a:p></p:notes>',
  });
  assert.equal(await read("route.pptx",deck),`## Slide 1 of 2\nRoute\nmap\nStop\tTime\n\nSpeaker notes:\nGo slowly\n\n## Slide 2 of 2\n${leftOut("the link to slide 2")}`);
  const typed=openDocumentFile('<office:spreadsheet><table:table table:name="Kinds"><table:table-row><table:table-cell office:value-type="boolean" office:boolean-value="false"/><table:table-cell office:value-type="date" office:date-value="2026-11-01"/><table:table-cell office:value-type="time" office:time-value="PT2H30M"/><table:table-cell office:value-type="float" office:value="3.5"/><table:table-cell table:number-columns-spanned="2" office:value-type="string"><text:p>wide</text:p></table:table-cell><table:covered-table-cell/><table:table-cell office:value-type="float" office:value="1"><text:p>one</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet>');
  assert.equal(await read("kinds.ods",typed),"## Sheet 1 of 1: Kinds\nfalse\t2026-11-01\tPT2H30M\t3.5\twide\t\tone");
});

test("an archive that is damaged, names a file outside itself or does not add up is refused",async t=>{
  const read=reader(await scratch(t));
  await assert.rejects(read("climb.docx",zipArchive({"word/document.xml":"<d/>","../../outside.xml":"<x/>"})),/points outside/);
  await assert.rejects(read("drive.docx",zipArchive({"word/document.xml":"<d/>","C:/outside.xml":"<x/>"})),/points outside/);
  for(const size of [3,500])await assert.rejects(read(`size-${size}.docx`,zipArchive({"word/document.xml":`${WORD_OPEN}<w:body>${words("Not this size")}</w:body></w:document>`},{sizes:{"word/document.xml":size}})),/unpack/,`a part said to unpack to ${size} bytes`);
  await assert.rejects(read("stored.docx",zipArchive({"word/document.xml":"<d/>"},{stored:true,sizes:{"word/document.xml":2}})),/two sizes/);
  // A changed byte in a stored part no longer matches its checksum.
  const intact=zipArchive({"word/document.xml":`${WORD_OPEN}<w:body>${words("Checked")}</w:body></w:document>`},{stored:true});
  const changed=Buffer.from(intact),at=changed.indexOf("Checked");changed[at]=0x63;
  assert.equal(await read("intact.docx",intact),"Checked");
  await assert.rejects(read("changed.docx",changed),/checksum/);
  // The archive's comment is allowed, with the length its end record gives.
  const plain=zipArchive({"word/document.xml":`${WORD_OPEN}<w:body>${words("With a note")}</w:body></w:document>`}),end=plain.length-22;
  const noted=length=>Buffer.concat([plain.subarray(0,end+20),Buffer.from([length,0]),Buffer.from("a note")]);
  assert.equal(await read("noted.docx",noted(6)),"With a note");
  await assert.rejects(read("misnoted.docx",noted(8)),/Not a ZIP archive/);
});

test("OpenDocument text leaves out comments and the deleted text of tracked changes, and RTF reads the Macintosh page",async t=>{
  const read=reader(await scratch(t));
  const tracked=openDocumentFile('<office:text><text:tracked-changes><text:changed-region text:id="c1"><text:deletion><text:p>Deleted words</text:p></text:deletion></text:changed-region></text:tracked-changes><text:h>Plain heading</text:h><text:p>Body<office:annotation><text:p>a margin note</text:p></office:annotation> text</text:p></office:text>');
  assert.equal(await read("tracked.odt",tracked),"# Plain heading\nBody text");
  assert.equal(await read("mac.rtf",Buffer.from(String.raw`{\rtf1\mac Caf\'8e}`,"latin1")),`Caf${char(0xe9)}`);
});
