import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { zipArchive } from "./zip.mjs";

// Writes the documents tests/document-text.test.mjs extracts, one of each type Trebell extracts text from, each as small as its
// format allows while still opening in its own application: node tests/fixtures/documents/make-fixtures.mjs
const here=fileURLToPath(new URL("./",import.meta.url));
const XML='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const W='xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const types=(overrides)=>XML+'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'+overrides.map(([part,type])=>`<Override PartName="${part}" ContentType="${type}"/>`).join("")+"</Types>";
const rels=(entries)=>XML+'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+entries.map(([id,type,target])=>`<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`).join("")+"</Relationships>";
const paragraph=(text,style=null)=>`<w:p>${style?`<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`:""}<w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
const cell=text=>`<w:tc><w:tcPr><w:tcW w:w="2400" w:type="dxa"/></w:tcPr>${paragraph(text)}</w:tc>`;

const documents={
  "report.docx":zipArchive({
    "[Content_Types].xml":types([["/word/document.xml","application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"]]),
    "_rels/.rels":rels([["rId1","officeDocument","word/document.xml"]]),
    "word/document.xml":XML+`<w:document ${W}><w:body>${paragraph("Quarterly Harbor Report","Heading1")}${paragraph("Cargo volume rose 12 percent &amp; the new crane is running.")}<w:tbl><w:tr>${cell("Port")}${cell("Tons")}</w:tr><w:tr>${cell("Juniper")}${cell("4200")}</w:tr></w:tbl>${paragraph("Next review: March.")}</w:body></w:document>`,
  }),
  "budget.xlsx":zipArchive({
    "[Content_Types].xml":types([["/xl/workbook.xml","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"],["/xl/worksheets/sheet1.xml","application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"],["/xl/sharedStrings.xml","application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"],["/xl/styles.xml","application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"]]),
    "_rels/.rels":rels([["rId1","officeDocument","xl/workbook.xml"]]),
    "xl/workbook.xml":XML+'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels":rels([["rId1","worksheet","worksheets/sheet1.xml"],["rId2","sharedStrings","sharedStrings.xml"],["rId3","styles","styles.xml"]]),
    "xl/sharedStrings.xml":XML+'<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="4" uniqueCount="4"><si><t>Item</t></si><si><t>Cost</t></si><si><t>Lantern</t></si><si><t>Due</t></si></sst>',
    "xl/styles.xml":XML+'<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs></styleSheet>',
    "xl/worksheets/sheet1.xml":XML+'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>3</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>37</v></c><c r="C2" s="1"><v>45292</v></c></row></sheetData></worksheet>',
  }),
  "deck.pptx":zipArchive({
    "[Content_Types].xml":types([["/ppt/presentation.xml","application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"],["/ppt/slides/slide1.xml","application/vnd.openxmlformats-officedocument.presentationml.slide+xml"],["/ppt/slides/slide2.xml","application/vnd.openxmlformats-officedocument.presentationml.slide+xml"],["/ppt/notesSlides/notesSlide1.xml","application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"]]),
    "_rels/.rels":rels([["rId1","officeDocument","ppt/presentation.xml"]]),
    "ppt/presentation.xml":XML+'<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/></p:sldIdLst></p:presentation>',
    "ppt/_rels/presentation.xml.rels":rels([["rId2","slide","slides/slide1.xml"],["rId3","slide","slides/slide2.xml"]]),
    "ppt/slides/slide1.xml":XML+'<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Departure plan</a:t></a:r></a:p><a:p><a:r><a:t>Ferries leave at 06:40</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
    "ppt/slides/_rels/slide1.xml.rels":rels([["rId1","notesSlide","../notesSlides/notesSlide1.xml"]]),
    "ppt/slides/slide2.xml":XML+'<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Questions</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
    "ppt/notesSlides/notesSlide1.xml":XML+'<p:notes xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Board at gate 4</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>',
  }),
};
const OFFICE='xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" office:version="1.3"';
const openDocument=(mime,body)=>zipArchive({
  mimetype:mime,
  "META-INF/manifest.xml":XML+`<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:media-type="${mime}"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>`,
  "content.xml":XML+`<office:document-content ${OFFICE}><office:body>${body}</office:body></office:document-content>`,
});
documents["notes.odt"]=openDocument("application/vnd.oasis.opendocument.text",'<office:text><text:h text:outline-level="1">Orchard notes</text:h><text:p>19<text:s text:c="3"/>violet<text:s/>crates by the gate.</text:p></office:text>');
documents["inventory.ods"]=openDocument("application/vnd.oasis.opendocument.spreadsheet",'<office:spreadsheet><table:table table:name="Cargo"><table:table-row><table:table-cell office:value-type="string"><text:p>Violet</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="19"><text:p>19</text:p></table:table-cell><table:table-cell office:value-type="currency" office:value="27.50" office:currency="EUR"/></table:table-row><table:table-row table:number-rows-repeated="1048575"><table:table-cell table:number-columns-repeated="16384"/></table:table-row></table:table></office:spreadsheet>');
documents["slides.odp"]=openDocument("application/vnd.oasis.opendocument.presentation",'<office:presentation><draw:page draw:name="page1"><draw:frame><draw:text-box><text:p>Morning briefing</text:p></draw:text-box></draw:frame></draw:page><draw:page draw:name="page2"><draw:frame><draw:text-box><text:p>Tide tables</text:p></draw:text-box></draw:frame></draw:page></office:presentation>');
documents["memo.rtf"]=Buffer.from(String.raw`{\rtf1\ansi\ansicpg1252\deff0{\fonttbl{\f0 Arial;}}{\colortbl;\red0\green0\blue0;}\f0\fs24 Memo:\tab Release on Friday\par Caf\'e9 opens at 8\emdash bring the \ldblquote harbor\rdblquote  keys\par Greek: \u945?\u946?{\*\generator Trebell fixture;}}`,"latin1");
documents["novel.epub"]=zipArchive({
  mimetype:"application/epub+zip",
  "META-INF/container.xml":XML+'<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>',
  "OEBPS/content.opf":XML+'<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">urn:uuid:5b1b8c2e-2b5e-4d8e-9c1a-trebell</dc:identifier><dc:title>The Lighthouse Keeper</dc:title><dc:language>en</dc:language></metadata><manifest><item id="one" href="chapter%201.xhtml" media-type="application/xhtml+xml"/><item id="two" href="chapter2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>',
  "OEBPS/chapter 1.xhtml":XML+'<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>One</title><style>p{color:red}</style></head><body><h1>The Lamp</h1><p>The keeper climbed&nbsp;the stairs at dusk.</p></body></html>',
  "OEBPS/chapter2.xhtml":XML+'<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Two</title></head><body><h2>The Storm</h2><p>Waves broke over the rocks &amp; the light held.</p></body></html>',
});
documents["analysis.ipynb"]=Buffer.from(JSON.stringify({cells:[
  {cell_type:"markdown",metadata:{},source:["# Survey\n","Vessel: Larkspur"]},
  {cell_type:"code",execution_count:1,metadata:{},source:["print(43 * 7)"],outputs:[{output_type:"stream",name:"stdout",text:["301\n"]}]},
  {cell_type:"code",execution_count:2,metadata:{},source:["1 / 0"],outputs:[{output_type:"error",ename:"ZeroDivisionError",evalue:"division by zero",traceback:["\u001b[31m----> 1 1 / 0\u001b[0m","ZeroDivisionError: division by zero"]}]},
],metadata:{kernelspec:{name:"python3",display_name:"Python 3",language:"python"}},nbformat:4,nbformat_minor:5},null,1),"utf8");

for(const [name,bytes] of Object.entries(documents))writeFileSync(here+name,bytes);
console.log(Object.keys(documents).join("\n"));
