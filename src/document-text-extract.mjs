import { readFile, stat } from "node:fs/promises";
import { posix } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { characterEntities } from "character-entities";
import { SaxesParser } from "saxes";
import yauzl from "yauzl";

// Reads the text of an attached Word, Excel, PowerPoint, OpenDocument, RTF, EPUB or Jupyter notebook file, for a harness to read.
// It runs only in a process of its own under a 192 MB heap (document-text-worker.mjs, which document-text.mjs starts). The file is
// untrusted, so every read is bounded: the file's size, what its archive unpacks to, its XML's nesting and element count, a
// table's rows and columns, and the text itself. Reaching a bound keeps the text read so far and ends it with a note.
const LIMITS=Object.freeze({
  fileBytes:16*1024*1024,unpackedBytes:32*1024*1024,textChars:1_000_000,archiveEntries:2048,packRatio:200,
  xmlDepth:128,xmlElements:200_000,tableRows:10_000,tableColumns:512,notebookCells:10_000,rtfDepth:128,
});
const LIMIT_NOTE="\n\n[The extracted text stops here, at Trebell Code's limits for a document.]";
// Thrown when a bound is reached: the text written so far stands, with LIMIT_NOTE after it.
class LimitReached extends Error{}

const NO_TEXT=new Set(["script","style","binary-data"]),LINE_BREAKS=new Set(["br","line-break","cr"]);
const ROW_TAGS=new Set(["tr","table-row"]),CELL_TAGS=new Set(["tc","table-cell","covered-table-cell","td","th"]);
const BLOCK_ENDS=new Set(["li","div","section"]),HTML_HEADING=/^h[1-6]$/;
const XML_PART=/\.(xml|rels|xhtml|html|htm|opf|svg)$/i;
const OPEN_DOCUMENT=new Set([".odt",".ods",".odp"]);

// The text taken from a document, kept within LIMITS.textChars. Every piece counts against that budget as it comes, before it is
// tidied, so even endless whitespace runs it out. Inside a table cell the text is put on one line: runs of whitespace become one
// space, and the cell's words are kept apart by single spaces.
class TextSink{
  constructor(){this.text="";this.budget=LIMITS.textChars;this.cellDepth=0;this.cellWritten=false;this.spaceOwed=false}
  write(piece){
    let kept=piece.slice(0,this.budget).replaceAll("\0","");
    this.budget-=Math.min(piece.length,this.budget);
    if(this.cellDepth){
      kept=kept.replace(/\s+/g," ");
      const words=kept.trim();
      if(words){
        if(this.cellWritten&&(this.spaceOwed||kept.startsWith(" ")))this.text+=" ";
        this.text+=words;this.cellWritten=true;
      }
      this.spaceOwed=kept.endsWith(" ")||(kept===""&&this.spaceOwed);
    }else this.text+=kept;
    if(this.budget===0)throw new LimitReached();
  }
  // What a cell holds when it showed no text of its own: an OpenDocument cell's typed value.
  writeIfCellEmpty(piece){if(!this.cellWritten)this.write(piece)}
  openCell(){
    if(this.cellDepth++===0){this.cellWritten=false;this.spaceOwed=false}
    else if(this.cellWritten)this.spaceOwed=true;
  }
  closeCell(){
    this.cellDepth--;
    if(this.cellDepth>0&&this.cellWritten)this.spaceOwed=true;
  }
}

// One XML part as a tree of {tag, attrs, kids}: tag is the element's local name, attrs holds each attribute under its qualified and
// its local name, and kids keeps text as strings beside the child elements. OpenDocument's <text:s text:c="n"/> keeps its count of
// spaces (spaces). An EPUB's XHTML knows HTML's named entities. saxes reads no DTD, so no entity a document declares can expand.
const local=name=>name.slice(name.lastIndexOf(":")+1);
const emptyTree=()=>({tag:"#document",attrs:{},kids:[]});
function parseXml(source,{odf=false,html=false}={}){
  const tree=emptyTree(),path=[tree];let elementCount=0;
  const parser=new SaxesParser();
  if(html)Object.assign(parser.ENTITIES,characterEntities);
  parser.on("opentag",({name,attributes})=>{
    elementCount++;
    if(elementCount>LIMITS.xmlElements||path.length>LIMITS.xmlDepth)throw new LimitReached();
    const attrs={};
    for(const [key,value] of Object.entries(attributes)){const text=String(value);attrs[key]=text;attrs[local(key)]=text}
    const element={tag:local(name),attrs,kids:[]};
    if(odf&&element.tag==="s")element.spaces=repeatCount(attrs.c);
    path.at(-1).kids.push(element);path.push(element);
  });
  parser.on("closetag",()=>{path.pop()});
  const addText=value=>{path.at(-1).kids.push(value)};
  parser.on("text",addText);parser.on("cdata",addText);
  parser.write(source).close();
  return tree;
}
const childElements=node=>node?node.kids.filter(kid=>typeof kid!=="string"):[];
// The elements under node whose tag passes match, in document order, not looking inside one that passed.
function findAll(node,match,found=[]){
  for(const kid of childElements(node)){
    if(match(kid))found.push(kid);
    else findAll(kid,match,found);
  }
  return found;
}
function findFirst(node,tag){
  for(const kid of childElements(node)){
    if(kid.tag===tag)return kid;
    const deeper=findFirst(kid,tag);
    if(deeper)return deeper;
  }
  return undefined;
}
const named=tag=>kid=>kid.tag===tag;
const firstText=node=>node?.kids.find(kid=>typeof kid==="string");
// An OpenDocument repeat count (rows, columns, spaces): 1 when absent, else a whole number of at least 1.
function repeatCount(value){
  const count=value===undefined?1:/^[0-9]+$/.test(value)?Number(value):0;
  if(count<1)throw new Error("Invalid repeat count");
  return count;
}

// A run of text inside a paragraph: tabs and line breaks as such, OpenDocument's counted spaces, and no script, style, embedded
// binary or Japanese phonetic guide (Excel's rPh).
function writeInline(node,sink){
  if(NO_TEXT.has(node.tag)||node.tag==="rPh")return;
  if(node.tag==="tab"||node.tag==="cell")return sink.write("\t");
  if(LINE_BREAKS.has(node.tag))return sink.write("\n");
  if(node.spaces!==undefined){
    sink.write(" ".repeat(Math.min(node.spaces,LIMITS.textChars)));
    if(node.spaces>LIMITS.textChars)throw new LimitReached();
    return;
  }
  for(const kid of node.kids)typeof kid==="string"?sink.write(kid):writeInline(kid,sink);
}
// A paragraph's heading level: a Word Heading 1-6 style, an OpenDocument heading's outline level, an HTML h1-h6; 0 for body text.
function headingLevel(paragraph){
  if(paragraph.tag==="h")return Number(paragraph.attrs["outline-level"])||1;
  if(HTML_HEADING.test(paragraph.tag))return Number(paragraph.tag.slice(1));
  const style=findFirst(paragraph,"pStyle")?.attrs.val??"";
  return Number(/^Heading([1-6])$/i.exec(style)?.[1])||0;
}
// Block content: a line for each paragraph, a heading led by as many #s as its level, and tables a row to a line.
function writeBlocks(node,sink){
  if(NO_TEXT.has(node.tag))return;
  for(const kid of node.kids){
    if(typeof kid==="string"){sink.write(kid);continue}
    if(LINE_BREAKS.has(kid.tag))sink.write("\n");
    else if(kid.tag==="tbl"||kid.tag==="table")writeTable(kid,sink);
    else if(kid.tag==="p"||kid.tag==="h"||HTML_HEADING.test(kid.tag)){
      const level=headingLevel(kid);
      if(level)sink.write("#".repeat(Math.min(level,6))+" ");
      writeInline(kid,sink);
      sink.write("\n");
    }else{
      writeBlocks(kid,sink);
      if(BLOCK_ENDS.has(kid.tag))sink.write("\n");
    }
  }
}
// An OpenDocument cell's typed value, which stands in for the cell's text when it has none.
const ODF_VALUE_ATTRIBUTE=new Map([["string","string-value"],["boolean","boolean-value"],["date","date-value"],["time","time-value"]]);
function odfCellValue(cell){
  const attribute=name=>cell.attrs[`office:${name}`]??cell.attrs[name]??"";
  const type=attribute("value-type"),amount=attribute("value");
  if(type==="void")return "";
  if(ODF_VALUE_ATTRIBUTE.has(type))return attribute(ODF_VALUE_ATTRIBUTE.get(type));
  if(type==="currency")return amount.trim()?[amount,attribute("currency")].join(" ").trim():"";
  if(type==="percentage")return amount.trim()?`${amount} [shown as a percentage]`:"";
  return amount;
}
// Whether a cell (or anything in it) shows text. Counted spaces are never expanded to tell, since one can stand for a million.
function cellHasText(node){
  if(odfCellValue(node).trim())return true;
  if(NO_TEXT.has(node.tag)||node.tag==="rPh"||node.spaces!==undefined)return false;
  return node.kids.some(kid=>typeof kid==="string"?kid.trim()!=="":cellHasText(kid));
}
// A table a row to a line and its cells apart by tabs, up to LIMITS.tableRows rows and LIMITS.tableColumns columns. A row's empty
// trailing cells and its empty rows are left out, so the repeated empty rows and cells that pad a spreadsheet's sheet cost nothing.
function writeTable(table,sink){
  let rowsWritten=0;
  for(const row of findAll(table,kid=>ROW_TAGS.has(kid.tag))){
    const cells=childElements(row).filter(kid=>CELL_TAGS.has(kid.tag));
    while(cells.length&&!cellHasText(cells.at(-1)))cells.pop();
    if(!cells.length)continue;
    const copies=repeatCount(row.attrs["number-rows-repeated"]);
    for(let copy=0;copy<copies;copy++){
      if(++rowsWritten>LIMITS.tableRows)throw new LimitReached();
      let column=0;
      for(const cell of cells){
        const span=repeatCount(cell.attrs["number-columns-repeated"]);
        for(let step=0;step<span;step++){
          if(column>=LIMITS.tableColumns)throw new LimitReached();
          if(column++>0)sink.write("\t");
          sink.openCell();writeBlocks(cell,sink);sink.writeIfCellEmpty(odfCellValue(cell));sink.closeCell();
        }
      }
      sink.write("\n");
    }
  }
}
function writeCell(node,sink){sink.openCell();writeInline(node,sink);sink.closeCell()}

// A ZIP-based document's XML parts by name. At most LIMITS.archiveEntries entries are looked at and LIMITS.unpackedBytes of XML
// unpacked in all, and no part that would unpack to more than LIMITS.packRatio times its packed size (a zip bomb). Pictures and
// embedded files are never unpacked. An encrypted entry refuses the document.
function openZip(path){
  return new Promise((resolve,reject)=>yauzl.open(path,{lazyEntries:true,validateEntrySizes:true,strictFileNames:true},
    (error,zip)=>error?reject(error):zip?resolve(zip):reject(new Error("Unreadable archive"))));
}
// Hands out the archive's entries one at a time (null after the last), and any error the archive raised meanwhile.
function entryReader(zip){
  let waiting=null,failure=null;
  zip.on("entry",entry=>waiting?.resolve(entry));
  zip.on("end",()=>waiting?.resolve(null));
  zip.on("error",error=>{failure=error;waiting?.reject(error)});
  return ()=>failure?Promise.reject(failure):new Promise((resolve,reject)=>{waiting={resolve,reject};zip.readEntry()});
}
function entryBytes(zip,entry,most){
  return new Promise((resolve,reject)=>zip.openReadStream(entry,(error,stream)=>{
    if(error||!stream)return reject(error||new Error("Unreadable archive entry"));
    const chunks=[];let total=0;
    stream.on("data",chunk=>{
      total+=chunk.length;
      if(total>most)return void stream.destroy(new LimitReached());
      chunks.push(chunk);
    });
    stream.on("error",reject);
    stream.on("end",()=>resolve(Buffer.concat(chunks)));
  }));
}
// XML that starts with a UTF-16 byte-order mark, or with '<' as two bytes, is UTF-16 in that byte order; anything else is UTF-8.
function decodeXml(bytes){
  const [first,second]=bytes;
  const encoding=(first===0xff&&second===0xfe)||(first===0x3c&&second===0x00)?"utf-16le"
    :(first===0xfe&&second===0xff)||(first===0x00&&second===0x3c)?"utf-16be":"utf-8";
  return new TextDecoder(encoding).decode(bytes);
}
async function unzipParts(path){
  const zip=await openZip(path),next=entryReader(zip),parts=new Map();
  try{
    let unpacked=0;
    for(let seen=1,entry=await next();entry;seen++,entry=await next()){
      if(seen>LIMITS.archiveEntries||zip.entryCount>LIMITS.archiveEntries)throw new LimitReached();
      if(entry.generalPurposeBitFlag&1)throw new Error("Encrypted archive");
      if(!XML_PART.test(entry.fileName))continue;
      const size=entry.uncompressedSize;
      if(size>LIMITS.unpackedBytes||size>Math.max(1024,entry.compressedSize*LIMITS.packRatio))throw new LimitReached();
      unpacked+=size;
      if(unpacked>LIMITS.unpackedBytes)throw new LimitReached();
      parts.set(entry.fileName,decodeXml(await entryBytes(zip,entry,size)));
    }
  }finally{zip.close()}
  return parts;
}

// An unpacked document: its parts read as XML trees on demand. A part that is missing or is not XML is read as empty and noted, so
// the rest of the document is still read, and the notes follow its text.
class DocumentPackage{
  constructor(parts,options){this.parts=parts;this.options=options;this.notes=[]}
  has(name){return this.parts.has(name)}
  tree(name){
    try{
      const source=this.parts.get(name);
      if(!source)throw new Error("Missing document part");
      return parseXml(source,this.options);
    }catch(error){
      if(error instanceof LimitReached)throw error;
      this.leftOut(name);
      return emptyTree();
    }
  }
  leftOut(what){this.notes.push(`\n[A part of the document was left out: ${what} is missing or is not valid XML.]\n`)}
  // The targets of a relationships part, by relationship id; links out of the package are not followed.
  links(name){
    return new Map(findAll(this.tree(name),named("Relationship")).filter(link=>link.attrs.TargetMode!=="External").map(link=>[link.attrs.Id,link.attrs.Target]));
  }
}
// A relationship target as a part name: absolute targets from the package root, others from the folder of the part that links them.
const partPath=(folder,target)=>target.startsWith("/")?target.slice(1):posix.normalize(`${folder}/${target}`);
// The relationships part that belongs to a part (ppt/slides/slide1.xml has ppt/slides/_rels/slide1.xml.rels).
const relationshipsOf=part=>posix.join(posix.dirname(part),"_rels",`${posix.basename(part)}.rels`);

// A workbook a sheet at a time, each cell its shown text: a shared or inline string, a value, else its formula. A number formatted
// as a date, a percentage or a format of the workbook's own is followed by that format and the workbook's date system.
function writeWorkbook(pkg,sink){
  const book=pkg.tree("xl/workbook.xml");
  const dateSystem=["1","true"].includes(findFirst(book,"workbookPr")?.attrs.date1904??"")?1904:1900;
  const styles=pkg.has("xl/styles.xml")?pkg.tree("xl/styles.xml"):null;
  const formatCodes=new Map(styles?findAll(styles,named("numFmt")).map(format=>[format.attrs.numFmtId,format.attrs.formatCode]):[]);
  const cellFormats=styles?childElements(findFirst(styles,"cellXfs")):[];
  const shared=pkg.has("xl/sharedStrings.xml")?findAll(pkg.tree("xl/sharedStrings.xml"),named("si")):[];
  const sharedShows=shared.map(cellHasText);
  const sheets=pkg.links(relationshipsOf("xl/workbook.xml"));
  const shows=cell=>{
    const value=findFirst(cell,"v");
    if(cell.attrs.t==="s"){const index=firstText(value)?.trim();return Boolean(index)&&Boolean(sharedShows[Number(index)])}
    if(cell.attrs.t==="inlineStr")return cellHasText(cell);
    return Boolean(value&&cellHasText(value))||findAll(cell,named("f")).some(cellHasText);
  };
  const columnOf=letters=>[...letters].reduce((index,letter)=>index*26+letter.charCodeAt(0)-64,0)-1;
  for(const sheet of findAll(book,named("sheet"))){
    sink.write(`\n## Sheet: ${sheet.attrs.name}\n`);
    const target=sheets.get(sheet.attrs["r:id"]??sheet.attrs.id);
    if(!target){pkg.leftOut(`the link to sheet ${sheet.attrs.name}`);continue}
    let rowsWritten=0;
    for(const row of findAll(pkg.tree(partPath("xl",target)),named("row"))){
      const byColumn=[];let nextColumn=0,tooWide=false;
      for(const cell of childElements(row)){
        if(cell.tag!=="c")continue;
        const letters=/^[A-Z]+/.exec(cell.attrs.r??"")?.[0],column=letters?columnOf(letters):nextColumn;
        nextColumn=column+1;
        if(!shows(cell))continue;
        if(column>=LIMITS.tableColumns){tooWide=true;continue}
        byColumn[column]=cell;
      }
      if(!byColumn.length&&!tooWide)continue;
      if(++rowsWritten>LIMITS.tableRows)throw new LimitReached();
      for(let column=0;column<byColumn.length;column++){
        if(column>0)sink.write("\t");
        const cell=byColumn[column];
        if(!cell)continue;
        const value=findFirst(cell,"v"),raw=firstText(value)??"";
        if(cell.attrs.t==="s"){const string=shared[Number(raw)];if(string)writeCell(string,sink)}
        else if(cell.attrs.t==="inlineStr")writeCell(cell,sink);
        else{
          if(value&&cellHasText(value))writeCell(value,sink);
          else for(const formula of findAll(cell,named("f")))writeCell(formula,sink);
          const formatId=cellFormats[Number(cell.attrs.s??0)]?.attrs.numFmtId,code=formatId?formatCodes.get(formatId):undefined;
          const numeric=cell.attrs.t===undefined||cell.attrs.t==="n";
          if(numeric&&raw.trim()&&formatId&&formatId!=="0")sink.write(` [Excel number format ${formatId}${code?` "${code}"`:""}, ${dateSystem} date system]`);
        }
      }
      sink.write("\n");
      if(tooWide)throw new LimitReached();
    }
  }
}
// A presentation a slide at a time in its slide list's order, each followed by its speaker notes.
function writePresentation(pkg,sink){
  const slides=pkg.links(relationshipsOf("ppt/presentation.xml"));
  let number=0;
  for(const listed of findAll(pkg.tree("ppt/presentation.xml"),named("sldId"))){
    sink.write(`\n\n## Slide ${++number}\n`);
    const target=slides.get(listed.attrs["r:id"]??listed.attrs.id);
    if(!target){pkg.leftOut(`the link to slide ${number}`);continue}
    const slide=partPath("ppt",target);
    writeBlocks(pkg.tree(slide),sink);
    const slideLinks=relationshipsOf(slide);
    if(!pkg.has(slideLinks))continue;
    for(const link of findAll(pkg.tree(slideLinks),named("Relationship"))){
      const notes=link.attrs.Target;
      if(!link.attrs.Type?.endsWith("/notesSlide")||link.attrs.TargetMode==="External"||!notes)continue;
      sink.write("Notes:\n");
      writeBlocks(pkg.tree(notes.startsWith("/")?notes.slice(1):posix.join(posix.dirname(slide),notes)),sink);
    }
  }
}
// An EPUB a chapter at a time, in its spine's reading order.
function writeBook(pkg,sink){
  const packageFile=findFirst(pkg.tree("META-INF/container.xml"),"rootfile")?.attrs["full-path"];
  if(!packageFile){if(!pkg.notes.length)pkg.leftOut("the EPUB package file");return}
  const opf=pkg.tree(packageFile),files=new Map(findAll(opf,named("item")).map(item=>[item.attrs.id,item.attrs.href]));
  let number=0;
  for(const ref of findAll(opf,named("itemref"))){
    sink.write(`\n\n## Chapter ${++number}\n`);
    const href=files.get(ref.attrs.idref);let file=null;
    if(href)try{file=decodeURIComponent(href.split("#")[0])}catch{}
    if(file===null){pkg.leftOut(`chapter ${number}`);continue}
    writeBlocks(pkg.tree(posix.normalize(posix.join(posix.dirname(packageFile),file))),sink);
  }
}
const PACKAGE_WRITERS={
  ".docx":(pkg,sink)=>writeBlocks(pkg.tree("word/document.xml"),sink),
  ".odt":(pkg,sink)=>writeBlocks(pkg.tree("content.xml"),sink),
  ".ods":(pkg,sink)=>{
    for(const sheet of findAll(pkg.tree("content.xml"),named("table"))){sink.write(`\n\n## Sheet: ${sheet.attrs.name??"Untitled"}\n`);writeTable(sheet,sink)}
  },
  ".odp":(pkg,sink)=>{
    let number=0;
    for(const page of findAll(pkg.tree("content.xml"),named("page"))){sink.write(`\n\n## Slide ${++number}\n`);writeBlocks(page,sink)}
  },
  ".xlsx":writeWorkbook,
  ".pptx":writePresentation,
  ".epub":writeBook,
};

// A notebook's cells in order, each under a heading with its number and kind, then what a code cell printed, returned or raised (a
// traceback without its terminal colours).
function writeNotebook(source,sink){
  const book=JSON.parse(source);
  if(!book||typeof book!=="object"||!Array.isArray(book.cells))throw new Error("Invalid notebook");
  const linesOf=value=>typeof value==="string"?[value]:Array.isArray(value)?value.filter(line=>typeof line==="string"):[];
  const writeLines=value=>{for(const line of linesOf(value))sink.write(line)};
  for(let index=0;index<book.cells.length;index++){
    if(index>=LIMITS.notebookCells)throw new LimitReached();
    const cell=book.cells[index];
    if(!cell||typeof cell!=="object")continue;
    sink.write(`## Cell ${index+1} (${cell.cell_type==="code"?"code":"markdown"})\n`);
    if("source" in cell)writeLines(cell.source);
    if(Array.isArray(cell.outputs)){
      sink.write("\nOutput:\n");
      for(const output of cell.outputs){
        if(!output||typeof output!=="object")continue;
        if("text" in output)writeLines(output.text);
        else if(output.data&&typeof output.data==="object"&&"text/plain" in output.data)writeLines(output.data["text/plain"]);
        else if(output.output_type==="error"){
          if("ename" in output)writeLines(output.ename);
          if("evalue" in output){sink.write(": ");writeLines(output.evalue)}
          sink.write("\n");
          if("traceback" in output)for(const line of linesOf(output.traceback)){sink.write(stripVTControlCharacters(line));sink.write("\n")}
        }
        sink.write("\n");
      }
    }
    sink.write("\n\n");
  }
}

// RTF's visible text. Control words and the destinations that hold no text (font, colour and style tables, document information,
// pictures, objects, field instructions, headers and footers, and any \* destination) are dropped; \par, \line and \row end a line,
// \tab and \cell are tabs; \uN gives a Unicode character and skips the \ucN characters that stand in for it; \'hh is a byte in the
// document's code page, which has to be a single-byte Windows one (\ansicpgN) since bytes are decoded one at a time.
const RTF_SYMBOLS=new Map([
  ["endash","–"],["emdash",characterEntities.mdash],["enspace"," "],["emspace"," "],["qmspace"," "],
  ["lquote","‘"],["rquote","’"],["ldblquote","“"],["rdblquote","”"],["bullet","•"],
  ["~"," "],["_","‑"],["-",""],
]);
const RTF_HIDDEN=new Set(["fonttbl","colortbl","stylesheet","info","pict","object","fldinst","header","footer"]);
const RTF_HEX=/'([0-9a-fA-F]{2})/y,RTF_WORD=/([a-zA-Z]+)(-?\d+)? ?/y;
function writeRtf(source,sink){
  if(!source.startsWith("{\\rtf"))throw new Error("Invalid RTF document");
  let state={hidden:false,fallbackLength:1,codePage:new TextDecoder("windows-1252")},toSkip=0,pending="";
  // Text is handed to the sink in pieces, at the latest when it would use up the budget, so a limit stops the read where it falls.
  const flush=()=>{if(pending){const piece=pending;pending="";sink.write(piece)}};
  const groups=[],out=value=>{pending+=value;if(pending.length>=Math.min(65_536,sink.budget))flush()};
  const byte=code=>state.codePage.decode(Uint8Array.of(code));
  for(let at=0;at<source.length;at++){
    const char=source[at];
    if(char==="{"){
      toSkip=0;groups.push({...state});
      if(groups.length>LIMITS.rtfDepth){flush();throw new LimitReached()}
      continue;
    }
    if(char==="}"){toSkip=0;state=groups.pop()??state;continue}
    if(char!=="\\"){
      if(state.hidden||char==="\n"||char==="\r")continue;
      if(toSkip>0)toSkip--;
      else out(char.charCodeAt(0)<128?char:byte(char.charCodeAt(0)));
      continue;
    }
    RTF_HEX.lastIndex=at+1;RTF_WORD.lastIndex=at+1;
    const hex=RTF_HEX.exec(source),word=hex?null:RTF_WORD.exec(source);
    if(hex){
      at+=hex[0].length;
      if(toSkip>0)toSkip--;
      else if(!state.hidden)out(byte(Number.parseInt(hex[1],16)));
      continue;
    }
    if(!word){
      const symbol=source[++at];
      if(toSkip>0)toSkip--;
      else if(symbol==="*")state.hidden=true;
      else if(!state.hidden&&(symbol==="\\"||symbol==="{"||symbol==="}"))out(symbol);
      else if(!state.hidden&&RTF_SYMBOLS.has(symbol))out(RTF_SYMBOLS.get(symbol));
      continue;
    }
    at+=word[0].length;
    const [,name,digits]=word,value=Number(digits);
    if(name==="bin"){
      if(!Number.isSafeInteger(value)||value<0)throw new Error("Invalid RTF binary length");
      at+=value;
    }
    if(toSkip>0){toSkip--;continue}
    if(RTF_HIDDEN.has(name))state.hidden=true;
    if(name==="ansicpg"){
      if(value!==874&&!(value>=1250&&value<=1258))throw new Error("Unsupported RTF code page");
      state.codePage=new TextDecoder(`windows-${value}`,{fatal:true});
    }else if(name==="uc"){
      if(!Number.isSafeInteger(value)||value<0)throw new Error("Invalid RTF fallback count");
      state.fallbackLength=value;
    }else if(state.hidden)continue;
    else if(name==="u"){out(String.fromCharCode(value<0?value+65536:value));toSkip=state.fallbackLength}
    else if(name==="par"||name==="line"||name==="row")out("\n");
    else if(name==="tab"||name==="cell")out("\t");
    else if(RTF_SYMBOLS.has(name))out(RTF_SYMBOLS.get(name));
  }
  flush();
}

async function writeDocument(path,extension,sink){
  if((await stat(path)).size>LIMITS.fileBytes)throw new LimitReached();
  if(extension===".ipynb")return writeNotebook(await readFile(path,"utf8"),sink);
  if(extension===".rtf")return writeRtf((await readFile(path)).toString("latin1"),sink);
  const pkg=new DocumentPackage(await unzipParts(path),{odf:OPEN_DOCUMENT.has(extension),html:extension===".epub"});
  const write=PACKAGE_WRITERS[extension];
  if(!Object.hasOwn(PACKAGE_WRITERS,extension))throw new Error("Unsupported document");
  write(pkg,sink);
  for(const note of pkg.notes)sink.write(note);
}

// The document's text, at most LIMITS.textChars characters, with runs of blank lines kept to one. A document with no text at all,
// or one that is not what its name says, is refused (throws).
export async function extractDocumentText(path,extension){
  const sink=new TextSink();let limited=false;
  try{await writeDocument(path,extension,sink)}
  catch(error){
    if(!(error instanceof LimitReached))throw error;
    limited=true;
  }
  const text=sink.text.replace(/\n(?:[ \t]*\n){2,}/g,"\n\n").trim();
  if(!text&&!limited)throw new Error("No text extracted");
  return text+(limited?LIMIT_NOTE:"");
}
