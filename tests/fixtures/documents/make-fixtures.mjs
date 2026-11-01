import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { zipArchive } from "./zip.mjs";

// Writes the documents tests/document-text.test.mjs reads, one of each kind Trebell reads into text, each small but laid out as its
// own application lays it out (package relationships, content types, manifests): node tests/fixtures/documents/make-fixtures.mjs
// The markup is built with element(), so every part is well-formed and its text escaped.
const here=fileURLToPath(new URL("./",import.meta.url));
const escapeXml=text=>String(text).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
// element("w:t", {"xml:space":"preserve"}, "text", element(...)): an element with its attributes and children; a string child is text.
function element(name,attributes={},...children){
  const attributeText=Object.entries(attributes).map(([key,value])=>` ${key}="${escapeXml(value)}"`).join("");
  const inner=children.flat().map(child=>typeof child==="string"?escapeXml(child):child.xml).join("");
  return {xml:inner?["<",name,attributeText,">",inner,"</",name,">"].join(""):["<",name,attributeText,"/>"].join("")};
}
const raw=xml=>({xml});
const part=root=>'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'+root.xml;
const SCHEMAS="http://schemas.openxmlformats.org";
const NS={
  types:`${SCHEMAS}/package/2006/content-types`,relationships:`${SCHEMAS}/package/2006/relationships`,
  link:`${SCHEMAS}/officeDocument/2006/relationships`,word:`${SCHEMAS}/wordprocessingml/2006/main`,
  sheet:`${SCHEMAS}/spreadsheetml/2006/main`,slide:`${SCHEMAS}/presentationml/2006/main`,drawing:`${SCHEMAS}/drawingml/2006/main`,
};
const OFFICE_TYPE="application/vnd.openxmlformats-officedocument";
function contentTypes(overrides){
  return part(element("Types",{xmlns:NS.types},
    element("Default",{Extension:"rels",ContentType:"application/vnd.openxmlformats-package.relationships+xml"}),
    element("Default",{Extension:"xml",ContentType:"application/xml"}),
    Object.entries(overrides).map(([name,type])=>element("Override",{PartName:name,ContentType:`${OFFICE_TYPE}.${type}`})),
  ));
}
function relationships(links){
  return part(element("Relationships",{xmlns:NS.relationships},
    links.map(([id,kind,target])=>element("Relationship",{Id:id,Type:`${NS.link}/${kind}`,Target:target})),
  ));
}

// Word: a Heading1 paragraph, a paragraph with an ampersand, a two-by-two table and a last paragraph.
const wordParagraph=(text,style)=>element("w:p",{},style?element("w:pPr",{},element("w:pStyle",{"w:val":style})):[],element("w:r",{},element("w:t",{"xml:space":"preserve"},text)));
const wordCell=text=>element("w:tc",{},element("w:tcPr",{},element("w:tcW",{"w:w":"3000","w:type":"dxa"})),wordParagraph(text));
const wordRow=(...cells)=>element("w:tr",{},cells.map(wordCell));
const report=zipArchive({
  "[Content_Types].xml":contentTypes({"/word/document.xml":"wordprocessingml.document.main+xml"}),
  "_rels/.rels":relationships([["rIdMain","officeDocument","word/document.xml"]]),
  "word/document.xml":part(element("w:document",{"xmlns:w":NS.word},element("w:body",{},
    wordParagraph("Quarterly Harbor Report","Heading1"),
    wordParagraph("Cargo volume rose 12 percent & the new crane is running."),
    element("w:tbl",{},wordRow("Port","Tons"),wordRow("Juniper","4200")),
    wordParagraph("Next review: March."),
  ))),
});

// Excel: two sheets, the second hidden. Shared strings, a number as stored, a date and time in built-in format 22, a percentage in
// built-in format 9, a custom day/month/year format, a boolean and a formula whose value was never calculated.
const sharedTexts=["Item","Count","Delivered","Rope","Paint","Diesel"];
const cell=(reference,{type,style,value,formula}={})=>element("c",{r:reference,...(type?{t:type}:{}),...(style?{s:String(style)}:{})},
  formula?element("f",{},formula):[],value!==undefined?element("v",{},String(value)):[]);
const text=(reference,word)=>cell(reference,{type:"s",value:sharedTexts.indexOf(word)});
const budget=zipArchive({
  "[Content_Types].xml":contentTypes({"/xl/workbook.xml":"spreadsheetml.sheet.main+xml","/xl/worksheets/stores.xml":"spreadsheetml.worksheet+xml","/xl/worksheets/rates.xml":"spreadsheetml.worksheet+xml","/xl/sharedStrings.xml":"spreadsheetml.sharedStrings+xml","/xl/styles.xml":"spreadsheetml.styles+xml"}),
  "_rels/.rels":relationships([["rIdBook","officeDocument","xl/workbook.xml"]]),
  "xl/workbook.xml":part(element("workbook",{xmlns:NS.sheet,"xmlns:r":NS.link},element("sheets",{},
    element("sheet",{name:"Stores",sheetId:"1","r:id":"rIdStores"}),
    element("sheet",{name:"Rates",sheetId:"2",state:"hidden","r:id":"rIdRates"}),
  ))),
  "xl/_rels/workbook.xml.rels":relationships([["rIdStores","worksheet","worksheets/stores.xml"],["rIdRates","worksheet","worksheets/rates.xml"],["rIdText","sharedStrings","sharedStrings.xml"],["rIdLook","styles","styles.xml"]]),
  "xl/sharedStrings.xml":part(element("sst",{xmlns:NS.sheet,count:String(sharedTexts.length),uniqueCount:String(sharedTexts.length)},sharedTexts.map(word=>element("si",{},element("t",{},word))))),
  "xl/styles.xml":part(element("styleSheet",{xmlns:NS.sheet},
    element("numFmts",{count:"1"},element("numFmt",{numFmtId:"170",formatCode:"dd/mm/yyyy"})),
    element("cellXfs",{count:"4"},element("xf",{numFmtId:"0"}),element("xf",{numFmtId:"22",applyNumberFormat:"1"}),element("xf",{numFmtId:"9",applyNumberFormat:"1"}),element("xf",{numFmtId:"170",applyNumberFormat:"1"})),
  )),
  "xl/worksheets/stores.xml":part(element("worksheet",{xmlns:NS.sheet},element("sheetData",{},
    element("row",{r:"1"},text("A1","Item"),text("B1","Count"),text("C1","Delivered")),
    element("row",{r:"2"},text("A2","Rope"),cell("B2",{value:52}),cell("C2",{style:1,value:46000.25})),
    element("row",{r:"3"},text("A3","Paint"),cell("B3",{type:"b",value:0}),cell("D3",{formula:"B2*2"})),
  ))),
  "xl/worksheets/rates.xml":part(element("worksheet",{xmlns:NS.sheet},element("sheetData",{},
    element("row",{r:"4"},text("B4","Diesel"),cell("C4",{style:2,value:0.125}),cell("D4",{style:3,value:45292})),
  ))),
});

// PowerPoint: two slides named by their relationships, the first with speaker notes (and the notes' slide-number field).
const drawingParagraph=words=>element("a:p",{},element("a:r",{},element("a:t",{},words)));
const shapeText=(...paragraphs)=>element("p:cSld",{},element("p:spTree",{},element("p:sp",{},element("p:txBody",{},paragraphs.map(drawingParagraph)))));
const slideNamespaces={"xmlns:p":NS.slide,"xmlns:a":NS.drawing,"xmlns:r":NS.link};
const deck=zipArchive({
  "[Content_Types].xml":contentTypes({"/ppt/presentation.xml":"presentationml.presentation.main+xml","/ppt/slides/opening.xml":"presentationml.slide+xml","/ppt/slides/closing.xml":"presentationml.slide+xml","/ppt/notesSlides/opening-notes.xml":"presentationml.notesSlide+xml"}),
  "_rels/.rels":relationships([["rIdDeck","officeDocument","ppt/presentation.xml"]]),
  "ppt/presentation.xml":part(element("p:presentation",slideNamespaces,element("p:sldIdLst",{},element("p:sldId",{id:"300","r:id":"rIdOpen"}),element("p:sldId",{id:"301","r:id":"rIdClose"})))),
  "ppt/_rels/presentation.xml.rels":relationships([["rIdOpen","slide","slides/opening.xml"],["rIdClose","slide","slides/closing.xml"]]),
  "ppt/slides/opening.xml":part(element("p:sld",slideNamespaces,shapeText("Crossing schedule","First sailing 05:50"))),
  "ppt/slides/_rels/opening.xml.rels":relationships([["rIdTalk","notesSlide","../notesSlides/opening-notes.xml"]]),
  "ppt/slides/closing.xml":part(element("p:sld",slideNamespaces,shapeText("Any questions?"))),
  "ppt/notesSlides/opening-notes.xml":part(element("p:notes",slideNamespaces,element("p:cSld",{},element("p:spTree",{},
    element("p:sp",{},element("p:txBody",{},drawingParagraph("Check the forecast first"))),
    element("p:sp",{},element("p:txBody",{},element("a:p",{},element("a:fld",{id:"{6A1F}",type:"slidenum"},element("a:t",{},"1")))))),
  ))),
});

// OpenDocument text, spreadsheet and presentation, each with its mimetype first and its manifest.
const ODF="urn:oasis:names:tc:opendocument:xmlns";
const odfNamespaces={"xmlns:office":`${ODF}:office:1.0`,"xmlns:text":`${ODF}:text:1.0`,"xmlns:table":`${ODF}:table:1.0`,"xmlns:draw":`${ODF}:drawing:1.0`,"xmlns:presentation":`${ODF}:presentation:1.0`,"office:version":"1.3"};
function odfPackage(kind,body){
  const mime=`application/vnd.oasis.opendocument.${kind}`;
  return zipArchive({
    mimetype:mime,
    "META-INF/manifest.xml":part(element("manifest:manifest",{"xmlns:manifest":`${ODF}:manifest:1.0`,"manifest:version":"1.3"},
      element("manifest:file-entry",{"manifest:full-path":"/","manifest:media-type":mime}),
      element("manifest:file-entry",{"manifest:full-path":"content.xml","manifest:media-type":"text/xml"}),
    )),
    "content.xml":part(element("office:document-content",odfNamespaces,element("office:body",{},body))),
  });
}
const notes=odfPackage("text",element("office:text",{},
  element("text:h",{"text:outline-level":"2"},"Dock journal"),
  element("text:p",{},"Tide at",element("text:s",{"text:c":"3"}),"noon,\n   wind",element("text:tab"),"west",element("text:line-break"),"Crew of four"),
  element("text:p",{},element("office:annotation",{},element("text:p",{},"A comment, not the text")),"Logged by the harbour master"),
));
const odsCell=(attributes,words)=>element("table:table-cell",attributes,words===undefined?[]:element("text:p",{},words));
const inventory=odfPackage("spreadsheet",element("office:spreadsheet",{},
  element("table:table",{"table:name":"Moorings"},
    element("table:table-row",{},odsCell({"office:value-type":"string"},"Berth"),odsCell({"office:value-type":"string"},"Boat"),odsCell({"office:value-type":"string"},"Fee"),odsCell({"office:value-type":"string"},"Share")),
    element("table:table-row",{},odsCell({"office:value-type":"string"},"B4"),odsCell({"office:value-type":"string"},"Heron"),odsCell({"office:value-type":"currency","office:value":"35","office:currency":"GBP"}),odsCell({"office:value-type":"percentage","office:value":"0.125"})),
    element("table:table-row",{"table:number-rows-repeated":"1048000"},odsCell({"table:number-columns-repeated":"16380"})),
  ),
  element("table:table",{},element("table:table-row",{"table:number-rows-repeated":"2"},odsCell({"office:value-type":"float","office:value":"7"},"7"))),
));
const slides=odfPackage("presentation",element("office:presentation",{},
  element("draw:page",{"draw:name":"Safety"},
    element("draw:frame",{},element("draw:text-box",{},element("text:p",{},"Harbour safety"))),
    element("presentation:notes",{},element("draw:frame",{},element("draw:text-box",{},element("text:p",{},"Mention the new buoys")))),
  ),
  element("draw:page",{"draw:name":"Close"},element("draw:frame",{},element("draw:text-box",{},element("text:p",{},"Thank you")))),
));

// RTF in the Windows Latin page, with a font table, document information and a page header that are not body text.
const memo=Buffer.from(String.raw`{\rtf1\ansi\ansicpg1252\deff0{\fonttbl{\f0\fswiss Helvetica;}}{\info{\title Hidden title}}{\header Page header\par}\f0\fs22 Notice:\tab Gate closes at 9\par Cr\'e8me caf\'e9 \endash  open daily\par Quote: \lquote fair winds\rquote\par Euro: `+String.fromCharCode(92)+String.raw`u8364?}`,"latin1");

// EPUB 3: the package in its own folder, a cover with only a picture, a content document whose name has a space and one that uses
// HTML's named characters; the head and the style sheet are not text.
const XHTML="http://www.w3.org/1999/xhtml";
const page=(title,...body)=>'<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n'+element("html",{xmlns:XHTML},element("head",{},element("title",{},title),element("style",{},"p{margin:0}")),element("body",{},body)).xml;
const novel=zipArchive({
  mimetype:"application/epub+zip",
  "META-INF/container.xml":part(element("container",{version:"1.0",xmlns:`${ODF}:container`},element("rootfiles",{},element("rootfile",{"full-path":"content/package.opf","media-type":"application/oebps-package+xml"})))),
  "content/package.opf":part(element("package",{xmlns:"http://www.idpf.org/2007/opf",version:"3.0","unique-identifier":"book"},
    element("metadata",{"xmlns:dc":"http://purl.org/dc/elements/1.1/"},element("dc:identifier",{id:"book"},"urn:uuid:8d2f0b6a-7c41-4f0e-9a55-ferryman"),element("dc:title",{},"The Ferryman"),element("dc:language",{},"en")),
    element("manifest",{},
      element("item",{id:"cover",href:"cover.xhtml","media-type":"application/xhtml+xml"}),
      element("item",{id:"first",href:"part%20one.xhtml","media-type":"application/xhtml+xml"}),
      element("item",{id:"second",href:"text/two.xhtml","media-type":"application/xhtml+xml"}),
    ),
    element("spine",{},element("itemref",{idref:"cover"}),element("itemref",{idref:"first"}),element("itemref",{idref:"second"})),
  )),
  "content/cover.xhtml":page("Cover",element("img",{src:"cover.png",alt:"A ferry at dawn"})),
  "content/part one.xhtml":page("One",element("h1",{},"Low Water"),element("p",{},"The ferry waited",raw("&nbsp;"),"for the tide",raw("&hellip;"))),
  "content/text/two.xhtml":page("Two",element("h2",{},"Crossing"),element("p",{},"Gulls  followed\n  the wake & the bell rang."),element("ul",{},element("li",{},"Ropes"),element("li",{},"Lanterns"))),
});

// A notebook with each kind of cell and output: printed text, a result with a picture beside it, and an error with terminal colours.
const analysis=Buffer.from(JSON.stringify({cells:[
  {cell_type:"markdown",metadata:{},source:["# Fuel use\n","Weekly totals"]},
  {cell_type:"code",execution_count:1,metadata:{},source:["print(40 + 2)"],outputs:[{output_type:"stream",name:"stdout",text:["42\n"]}]},
  {cell_type:"code",execution_count:2,metadata:{},source:"chart(totals)",outputs:[{output_type:"execute_result",execution_count:2,metadata:{},data:{"text/plain":["<Figure 1>"]}},{output_type:"display_data",metadata:{},data:{"image/png":"iVBORw0KGgo="}}]},
  {cell_type:"raw",metadata:{},source:"raw notes"},
  {cell_type:"code",execution_count:3,metadata:{},source:["totals['june']"],outputs:[{output_type:"error",ename:"KeyError",evalue:"'june'",traceback:["\u001b[0;31m---------------------------------------------------------------------------\u001b[0m","\u001b[0;31mKeyError\u001b[0m: 'june'"]}]},
],metadata:{kernelspec:{name:"python3",display_name:"Python 3",language:"python"}},nbformat:4,nbformat_minor:5},null,1),"utf8");

const documents={"report.docx":report,"budget.xlsx":budget,"deck.pptx":deck,"notes.odt":notes,"inventory.ods":inventory,"slides.odp":slides,"memo.rtf":memo,"novel.epub":novel,"analysis.ipynb":analysis};
for(const [name,bytes] of Object.entries(documents))writeFileSync(here+name,bytes);
console.log(Object.keys(documents).join("\n"));
