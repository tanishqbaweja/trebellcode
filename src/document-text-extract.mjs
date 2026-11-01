import { readFile, stat } from "node:fs/promises";
import { posix } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { characterEntities } from "character-entities";
import { SaxesParser } from "saxes";
import { BOUNDS, DocumentRefused, TextLimitReached, documentKind, reachLimit, refuseDocument } from "./document-reading.mjs";
import { writeRtfText } from "./document-rtf.mjs";
import { Archive } from "./document-zip.mjs";

// Reads an attached Word, Excel, PowerPoint, OpenDocument, RTF, EPUB or Jupyter file into plain text for the harnesses. Only
// document-text-worker.mjs runs it, in a process of its own. Every bound it keeps is in document-reading.mjs, with its reason.

const CUT_NOTE="[The document goes on, but Trebell Code read only this much of it.]";
const leftOutNote=what=>`[Left out: ${what} is missing from the document or is not well-formed XML.]`;

// ---------------------------------------------------------------------------------------------------------------------------------
// The text as it is written. Every character is charged against BOUNDS.textCharacters as it is written; text moved from one layer to
// the one below (a cell's text into its row, a part's into the document) is not charged again, and since moving only ever shortens
// text the document stays within the bound. A part is written into a layer of its own, which joins the document only once the part
// has been read whole, so a part that turns out not to be well-formed leaves nothing behind.
class TextWriter{
  #left=BOUNDS.textCharacters;
  #document=[];
  #layers=[];
  #pieces(){return this.#layers.length?this.#layers[this.#layers.length-1]:this.#document}
  write(text){
    if(!text)return;
    const clean=text.includes("\0")?text.replaceAll("\0",""):text;
    const kept=clean.length<=this.#left?clean:clean.slice(0,this.#left);
    this.#left-=kept.length;
    if(kept)this.#pieces().push(kept);
    if(kept.length<clean.length)reachLimit();
  }
  // Adds text that was charged when it was first written.
  move(text){if(text)this.#pieces().push(text)}
  // Takes one trailing character back when the text written last ends with it.
  unwrite(character){
    const pieces=this.#pieces(),last=pieces[pieces.length-1];
    if(!last?.endsWith(character))return;
    pieces[pieces.length-1]=last.slice(0,-character.length);
    this.#left+=character.length;
  }
  lastCharacter(){
    const pieces=this.#pieces();
    for(let index=pieces.length-1;index>=0;index--)if(pieces[index])return pieces[index].at(-1);
    return "";
  }
  mark(){return this.#pieces().length}
  textSince(mark){return this.#pieces().slice(mark).join("")}
  openLayer(){this.#layers.push([])}
  closeLayer(){return this.#layers.pop().join("")}
  // After a bound is reached: what every open layer holds goes into the document, in order.
  settle(){while(this.#layers.length)this.move(this.closeLayer())}
  text(){return this.#document.join("")}
}

// ---------------------------------------------------------------------------------------------------------------------------------
// XML parts, streamed. A reading gets enter(name, attributes), characters(text) and leave(name) with local names (the prefix
// dropped), and passes over whole elements through passesOver(name, attributes). No DTD is read, so an entity a part declares is
// undefined and the part is not well-formed; an EPUB's XHTML also knows HTML's named character references.
const localName=qualified=>qualified.slice(qualified.indexOf(":")+1);
// The value of the attribute with this local name, whatever its prefix.
function attribute(attributes,name){
  if(name in attributes)return attributes[name];
  for(const key of Object.keys(attributes))if(localName(key)===name)return attributes[key];
  return undefined;
}
// A relationship id (r:id): the prefixed attribute named id, since a plain id attribute may sit beside it (PresentationML's sldId).
function relationshipId(attributes){
  for(const key of Object.keys(attributes))if(key.includes(":")&&localName(key)==="id")return attributes[key];
  return attributes.id;
}
function decodePart(bytes){
  if(bytes[0]===0xff&&bytes[1]===0xfe)return new TextDecoder("utf-16le").decode(bytes);
  if(bytes[0]===0xfe&&bytes[1]===0xff)return new TextDecoder("utf-16be").decode(bytes);
  return new TextDecoder("utf-8").decode(bytes);
}
function streamMarkup(source,reading,{htmlNames=false}={}){
  const parser=new SaxesParser();
  if(htmlNames)Object.assign(parser.ENTITIES,characterEntities);
  let depth=0,passingFrom=0;
  parser.on("opentag",tag=>{
    depth+=1;
    if(depth>BOUNDS.nesting)reachLimit();
    if(passingFrom)return;
    const name=localName(tag.name);
    if(reading.passesOver?.(name,tag.attributes)){passingFrom=depth;return}
    reading.enter?.(name,tag.attributes);
  });
  parser.on("closetag",tag=>{
    if(passingFrom){if(passingFrom===depth)passingFrom=0}
    else reading.leave?.(localName(tag.name));
    depth-=1;
  });
  const characters=text=>{if(!passingFrom)reading.characters?.(text)};
  parser.on("text",characters);
  parser.on("cdata",characters);
  parser.write(source).close();
}

// ---------------------------------------------------------------------------------------------------------------------------------
// A package and the document text it is read into.
class Package{
  constructor(archive,writer,{htmlNames=false}={}){this.archive=archive;this.writer=writer;this.htmlNames=htmlNames}
  // Reads the part called name with read(source), inside a layer of its own. A part that is missing or not well-formed adds a note
  // naming it (label, or its name) where its text would have been; returns whether it was read.
  readPart(name,read,label=name){
    const bytes=name===null?null:this.archive.read(name);
    if(bytes===null){this.leaveOut(label);return false}
    const source=decodePart(bytes);
    this.writer.openLayer();
    try{read(source)}
    catch(error){
      if(error instanceof TextLimitReached)throw error;
      this.writer.closeLayer();
      if(error instanceof DocumentRefused)throw error;
      this.leaveOut(label);
      return false;
    }
    this.writer.move(this.writer.closeLayer());
    return true;
  }
  // The note for a part left out, on a line of its own.
  leaveOut(label){
    const last=this.writer.lastCharacter();
    this.writer.write(`${last&&last!=="\n"?"\n":""}${leftOutNote(label)}\n`);
  }
  stream(source,reading){streamMarkup(source,reading,{htmlNames:this.htmlNames})}
  // The part's relationships (ECMA-376 Part 2): {id, type, target} for each one inside the package. A target resolves from the
  // part's folder, or from the package root when it starts with "/"; external targets and ones that leave the package are dropped.
  relationships(part){
    const name=posix.join(posix.dirname(part),"_rels",posix.basename(part)+".rels");
    const bytes=this.archive.read(name),found=[];
    if(bytes===null)return found;
    try{
      streamMarkup(decodePart(bytes),{enter(element,attributes){
        if(element!=="Relationship"||attribute(attributes,"TargetMode")==="External")return;
        const target=resolveTarget(posix.dirname(part),attribute(attributes,"Target")??"");
        if(target)found.push({id:attribute(attributes,"Id"),type:attribute(attributes,"Type")??"",target});
      }});
    }catch(error){if(error instanceof TextLimitReached)throw error;return []}
    return found;
  }
  // The package's main part: the target of its officeDocument relationship, or the name Office gives it.
  mainPart(usualName){
    return this.relationships("").find(link=>link.type.endsWith("/officeDocument"))?.target??usualName;
  }
}
function resolveTarget(folder,target){
  let path=target.split("#")[0];
  try{path=decodeURIComponent(path)}catch{}
  path=path.startsWith("/")?path.slice(1):posix.join(folder,path);
  path=posix.normalize(path);
  return path===""||path==="."||path.startsWith("../")||path===".."?null:path;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Tables, for every format: a row is a line, its cells apart by tabs. A cell's text (its paragraphs, a table inside it) is gathered
// in a layer of its own and joined by single spaces when the cell closes. Blank cells at the end of a row are dropped and blank rows
// skipped; a cell or a row repeated (OpenDocument's repeat counts) is written that many times unless it is blank, so the padding that
// fills a sheet out to its full size is never expanded.
const squeeze=text=>text.split(/\s+/).filter(Boolean).join(" ");
class TableLines{
  constructor(writer){this.writer=writer;this.rows=[]}
  openRow(times=1){this.rows.push({times,start:this.writer.mark(),written:0,blanks:0})}
  openCell(){this.writer.openLayer()}
  closeCell(times=1,shownValue=""){
    let text=squeeze(this.writer.closeLayer());
    if(!text&&shownValue){this.writer.openLayer();this.writer.write(shownValue);text=squeeze(this.writer.closeLayer())}
    const row=this.rows[this.rows.length-1];
    if(!row){this.writer.move(text+" ");return}
    if(!text){row.blanks+=times;return}
    const tabs=row.blanks+(row.written?1:0);
    if(tabs)this.writer.write("\t".repeat(tabs));
    this.writer.move(text);
    for(let copy=1;copy<times;copy++){this.writer.write("\t");this.writer.write(text)}
    row.written+=row.blanks+times;row.blanks=0;
  }
  closeRow(){
    const row=this.rows.pop();
    if(!row?.written)return;
    this.writer.write("\n");
    if(row.times<2)return;
    const line=this.writer.textSince(row.start);
    for(let copy=1;copy<row.times;copy++)this.writer.write(line);
  }
}

// A heading's mark: as many #s as its level, at most six.
const headingMarks=level=>level>0?"#".repeat(Math.min(level,6))+" ":"";
// The heading of one of a document's sections, after a blank line and on a line of its own: "## Sheet 2 of 3: Rates",
// "## Slide 1 of 4", "## Code cell 3 of 9". The place and the count tell a reader where it is and how much follows.
const sectionHeading=(kind,number,total,name="")=>["\n\n","## ",kind," ",number," of ",total,name?": "+name:"","\n"].join("");

// ---------------------------------------------------------------------------------------------------------------------------------
// WordprocessingML (ECMA-376 Part 1, section 17): text is only in w:t; w:tab, w:br, w:cr and w:noBreakHyphen count inside a run.
// Passed over: deleted text (w:delText), field codes (w:instrText), text moved away (w:moveFrom) and Markup Compatibility's fallback
// (mc:Fallback repeats what mc:Choice holds, such as a text box).
const WORD_PASSED_OVER=new Set(["delText","instrText","moveFrom","Fallback"]);
const WORD_RUN_TEXT=new Map([["tab","\t"],["br","\n"],["cr","\n"],["noBreakHyphen","-"]]);
function wordHeadingLevel(styleId){
  const id=String(styleId??"").toLowerCase();
  if(id==="title")return 1;
  if(!id.startsWith("heading"))return 0;
  const level=Number(id.slice("heading".length));
  return Number.isInteger(level)&&level>=1&&level<=9?level:0;
}
class WordReading{
  constructor(writer){this.writer=writer;this.table=new TableLines(writer);this.paragraphs=[];this.runs=0;this.inText=0}
  passesOver(name){return WORD_PASSED_OVER.has(name)}
  begin(){
    const paragraph=this.paragraphs[this.paragraphs.length-1];
    if(!paragraph||paragraph.begun)return;
    paragraph.begun=true;
    this.writer.write(headingMarks(paragraph.level));
  }
  enter(name,attributes){
    const paragraph=this.paragraphs[this.paragraphs.length-1];
    if(name==="p")this.paragraphs.push({level:0,begun:false});
    else if(name==="pStyle"&&paragraph&&!paragraph.begun)paragraph.level=wordHeadingLevel(attribute(attributes,"val"));
    else if(name==="outlineLvl"&&paragraph&&!paragraph.begun&&!paragraph.level){
      const level=Number(attribute(attributes,"val"));
      if(Number.isInteger(level)&&level>=0&&level<=8)paragraph.level=level+1;
    }
    else if(name==="r")this.runs++;
    else if(name==="t"){this.inText++;this.begin()}
    else if(this.runs&&WORD_RUN_TEXT.has(name)){this.begin();this.writer.write(WORD_RUN_TEXT.get(name))}
    else if(name==="tr")this.table.openRow();
    else if(name==="tc")this.table.openCell();
  }
  characters(text){if(this.inText)this.writer.write(text)}
  leave(name){
    if(name==="p"){this.paragraphs.pop();this.writer.write("\n")}
    else if(name==="r")this.runs--;
    else if(name==="t")this.inText--;
    else if(name==="tc")this.table.closeCell();
    else if(name==="tr")this.table.closeRow();
  }
}

// DrawingML text (ECMA-376 Part 1, section 21), as slides and their notes hold it: text is only in a:t, a:br breaks a line, a:p ends
// one, a:tbl is a table. The slide-number field and Markup Compatibility's fallback are passed over.
class DrawingReading{
  constructor(writer){this.writer=writer;this.table=new TableLines(writer);this.inText=0}
  passesOver(name,attributes){return name==="Fallback"||(name==="fld"&&attribute(attributes,"type")==="slidenum")}
  enter(name){
    if(name==="t")this.inText++;
    else if(name==="br")this.writer.write("\n");
    else if(name==="tr")this.table.openRow();
    else if(name==="tc")this.table.openCell();
  }
  characters(text){if(this.inText)this.writer.write(text)}
  leave(name){
    if(name==="t")this.inText--;
    else if(name==="p")this.writer.write("\n");
    else if(name==="tc")this.table.closeCell();
    else if(name==="tr")this.table.closeRow();
  }
}

// OpenDocument (OASIS ODF 1.3, Part 3). Text is what text:p and text:h hold, its white space collapsed as the format asks (a run of
// spaces, tabs and line ends is one space); text:s is text:c spaces, text:tab a tab, text:line-break a line break. Comments
// (office:annotation) and the deleted text of tracked changes (text:tracked-changes) are passed over. Tables repeat rows and cells
// by their counts; a cell that shows no text reads as its typed value. Sheets and slides get a heading each, and a slide's speaker
// notes (presentation:notes) follow a line of their own.
const ODF_PASSED_OVER=new Set(["annotation","annotation-end","tracked-changes"]);
function repetitions(value){
  if(value===undefined)return 1;
  const count=Number(value);
  return /^[0-9]+$/.test(value)&&count>=1?count:refuseDocument("An OpenDocument repeat count is not a whole number of at least 1");
}
function typedCellValue(attributes){
  const value=name=>attribute(attributes,name)??"";
  switch(value("value-type")){
    case "float":return value("value");
    case "percentage":return value("value").trim()?percentOf(value("value")):"";
    case "currency":return value("value").trim()?`${value("value")} ${value("currency")}`.trim():"";
    case "date":return value("date-value");
    case "time":return value("time-value");
    case "boolean":return value("boolean-value");
    case "string":return value("string-value");
    default:return "";
  }
}
class OpenDocumentReading{
  // sections: null for running text, or {element, parent, heading(n, total, attributes)} for a document of sheets or slides.
  constructor(writer,sections=null,total=0){
    this.writer=writer;this.table=new TableLines(writer);this.sections=sections;this.total=total;this.number=0;
    this.path=[];this.paragraphs=0;this.spaceBefore=true;this.cells=[];
  }
  passesOver(name){return ODF_PASSED_OVER.has(name)}
  enter(name,attributes){
    const parent=this.path[this.path.length-1];
    this.path.push(name);
    if(this.sections&&name===this.sections.element&&parent===this.sections.parent){
      this.writer.write(this.sections.heading(++this.number,this.total,attributes));
      return;
    }
    switch(name){
      case "p":case "h":
        this.paragraphs++;this.spaceBefore=true;
        if(name==="h"){const level=Number(attribute(attributes,"outline-level")??1);this.writer.write(headingMarks(Number.isInteger(level)&&level>0?level:1))}
        break;
      case "s":{
        const count=repetitions(attribute(attributes,"c"));
        this.writer.write(" ".repeat(Math.min(count,BOUNDS.textCharacters+1)));this.spaceBefore=false;break;
      }
      case "tab":this.writer.write("\t");this.spaceBefore=false;break;
      case "line-break":this.writer.write("\n");this.spaceBefore=true;break;
      case "notes":if(this.sections)this.writer.write("\nSpeaker notes:\n");break;
      case "table-row":this.table.openRow(repetitions(attribute(attributes,"number-rows-repeated")));break;
      case "table-cell":case "covered-table-cell":
        this.cells.push({times:repetitions(attribute(attributes,"number-columns-repeated")),shown:typedCellValue(attributes)});
        this.table.openCell();break;
    }
  }
  characters(text){
    if(!this.paragraphs)return;
    let collapsed=text.replace(/[ \t\r\n]+/g," ");
    if(this.spaceBefore&&collapsed.startsWith(" "))collapsed=collapsed.slice(1);
    if(!collapsed)return;
    this.writer.write(collapsed);
    this.spaceBefore=collapsed.endsWith(" ");
  }
  leave(name){
    this.path.pop();
    switch(name){
      case "p":case "h":this.paragraphs--;this.writer.write("\n");break;
      case "table-row":this.table.closeRow();break;
      case "table-cell":case "covered-table-cell":{const cell=this.cells.pop();this.table.closeCell(cell.times,cell.shown);break}
    }
  }
}
// How many sections (sheets or slides) a content part holds, for the "<n> of <total>" of their headings.
function countSections(source,{element,parent}){
  const path=[];let count=0;
  streamMarkup(source,{
    passesOver:name=>ODF_PASSED_OVER.has(name),
    enter(name){if(name===element&&path[path.length-1]===parent)count++;path.push(name)},
    leave(){path.pop()},
  });
  return count;
}
const ODF_SHEETS={element:"table",parent:"spreadsheet",heading:(number,total,attributes)=>{
  const name=attribute(attributes,"name");
  return sectionHeading("Sheet",number,total,name);
}};
const ODF_SLIDES={element:"page",parent:"presentation",heading:(number,total)=>sectionHeading("Slide",number,total)};

// XHTML, as an EPUB's content documents are: the head, scripts, styles, templates and noscript are passed over; white space collapses
// as a browser shows it, except inside pre; br breaks a line; block elements end one; h1 to h6 are headings; tables are tables.
const HTML_PASSED_OVER=new Set(["head","script","style","template","noscript"]);
const HTML_BLOCKS=new Set([
  "p","div","li","ul","ol","dl","dt","dd","section","article","aside","nav","header","footer","main","blockquote","pre","figure",
  "figcaption","address","hr","table","caption","h1","h2","h3","h4","h5","h6",
]);
class XhtmlReading{
  constructor(writer){this.writer=writer;this.table=new TableLines(writer);this.preformatted=0}
  passesOver(name){return HTML_PASSED_OVER.has(name)}
  endLine(){const last=this.writer.lastCharacter();if(last&&last!=="\n")this.writer.write("\n")}
  enter(name){
    if(HTML_BLOCKS.has(name))this.endLine();
    const level=name.length===2&&name[0]==="h"?Number(name[1]):0;
    if(level>=1&&level<=6)this.writer.write(headingMarks(level));
    if(name==="pre")this.preformatted++;
    else if(name==="br")this.writer.write("\n");
    else if(name==="tr")this.table.openRow();
    else if(name==="td"||name==="th")this.table.openCell();
  }
  characters(text){
    if(this.preformatted){this.writer.write(text);return}
    let collapsed=text.replace(/[ \t\r\n\f]+/g," ");
    const last=this.writer.lastCharacter();
    if((last===""||last==="\n"||last===" "||last==="\t")&&collapsed.startsWith(" "))collapsed=collapsed.slice(1);
    this.writer.write(collapsed);
  }
  leave(name){
    if(name==="pre")this.preformatted--;
    else if(name==="td"||name==="th")this.table.closeCell();
    else if(name==="tr")this.table.closeRow();
    if(HTML_BLOCKS.has(name))this.endLine();
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// SpreadsheetML (ECMA-376 Part 1, section 18).
// Built-in number formats that show a date, a time or a percentage (section 18.8.30); others show the number as it is stored.
const BUILT_IN_FORMATS=new Map([
  [9,"percent"],[10,"percent"],[14,"date"],[15,"date"],[16,"date"],[17,"date"],[18,"time"],[19,"time"],[20,"time"],[21,"time"],
  [22,"datetime"],[45,"time"],[46,"elapsed"],[47,"time"],
]);
// What a custom format code shows, read from its first section with quoted text, escaped characters and bracketed parts (colours,
// conditions, locales) taken out: y or d means a date, h or s a time, m alone a month, [h] elapsed hours, % a percentage.
function customFormatKind(code){
  const seen=new Set();
  let state="plain",bracket="",elapsed=false;
  for(const character of code){
    if(state==="escaped"){state="plain";continue}
    if(state==="quoted"){if(character==="\"")state="plain";continue}
    if(state==="bracket"){
      if(character!=="]"){bracket+=character.toLowerCase();continue}
      state="plain";
      if(bracket&&"hms".includes(bracket[0])&&bracket.split("").every(letter=>letter===bracket[0]))elapsed=true;
      continue;
    }
    if(character===";")break;
    if(character==="\"")state="quoted";
    else if(character==="\\"||character==="_"||character==="*")state="escaped";
    else if(character==="["){state="bracket";bracket=""}
    else seen.add(character.toLowerCase());
  }
  if(elapsed)return "elapsed";
  const date=seen.has("y")||seen.has("d"),time=seen.has("h")||seen.has("s");
  if(date)return time?"datetime":"date";
  if(time)return "time";
  if(seen.has("m"))return "date";
  return seen.has("%")?"percent":"number";
}
const pad=(number,width=2)=>String(number).padStart(width,"0");
const percentOf=value=>`${Number((Number(value)*100).toPrecision(15))}%`;
const DAY_MS=86_400_000;
// A serial date in the workbook's date system: 1900 counts day 1 as 1 January 1900 and keeps the 29 February 1900 that Lotus 1-2-3
// had; 1904 counts from 1 January 1904. Returns the day and the seconds into it.
function serialDate(serial,from1904){
  let days=Math.floor(serial),seconds=Math.round((serial-days)*86_400);
  if(seconds===86_400){days+=1;seconds=0}
  if(!from1904&&days===60)return {day:"1900-02-29",seconds};
  const origin=from1904?Date.UTC(1904,0,1):Date.UTC(1899,11,days<60?31:30);
  return {day:new Date(origin+days*DAY_MS).toISOString().slice(0,10),seconds};
}
function clock(seconds){
  const text=`${pad(Math.floor(seconds/3600))}:${pad(Math.floor(seconds/60)%60)}`;
  return seconds%60?`${text}:${pad(seconds%60)}`:text;
}
function shownNumber(raw,kind,from1904){
  const value=Number(raw);
  if(!Number.isFinite(value)||kind==="number")return raw;
  if(kind==="percent")return percentOf(value);
  if(kind==="elapsed"){
    if(value<0)return raw;
    const seconds=Math.round(value*86_400);
    return `${Math.floor(seconds/3600)}:${pad(Math.floor(seconds/60)%60)}:${pad(seconds%60)}`;
  }
  if(value<0)return raw;
  const {day,seconds}=serialDate(value,from1904);
  if(kind==="date")return day;
  if(kind==="time")return clock(seconds);
  return `${day} ${clock(seconds)}`;
}
// The workbook's shared strings: each si's text (its rich runs joined), without the phonetic readings (rPh).
function sharedStrings(source){
  const strings=[];let current=null,inText=0;
  streamMarkup(source,{
    passesOver:name=>name==="rPh",
    enter(name){if(name==="si")current="";else if(name==="t")inText++},
    characters(text){if(inText&&current!==null)current+=text},
    leave(name){if(name==="t")inText--;else if(name==="si"){strings.push(current);current=null}},
  });
  return strings;
}
// The number format of each cell style (cellXfs), as the kind of value it shows.
function styleValueKinds(source){
  const codes=new Map(),formats=[];let inCellStyles=0;
  streamMarkup(source,{
    enter(name,attributes){
      if(name==="numFmt")codes.set(Number(attribute(attributes,"numFmtId")),attribute(attributes,"formatCode")??"");
      else if(name==="cellXfs")inCellStyles++;
      else if(name==="xf"&&inCellStyles)formats.push(Number(attribute(attributes,"numFmtId")??0));
    },
    leave(name){if(name==="cellXfs")inCellStyles--},
  });
  return formats.map(id=>codes.has(id)?customFormatKind(codes.get(id)):BUILT_IN_FORMATS.get(id)??"number");
}
const MAX_COLUMNS=16_384;
// The column of a cell reference ("C7" is 2), or -1 when it has no letters; null past column XFD, Excel's last.
function referenceColumn(reference){
  let column=0,letters=0;
  for(const character of String(reference??"")){
    const code=character.charCodeAt(0);
    if(code<0x41||code>0x5a)break;
    column=column*26+code-0x40;letters++;
    if(column>MAX_COLUMNS)return null;
  }
  return letters?column-1:-1;
}
class SheetReading{
  constructor(writer,{strings,formats,from1904}){
    this.writer=writer;this.strings=strings;this.formats=formats;this.from1904=from1904;
    this.row=null;this.cell=null;this.field=null;this.inline=0;
  }
  passesOver(name){return name==="rPh"||name==="Fallback"||name==="extLst"}
  enter(name,attributes){
    switch(name){
      case "row":
        this.row={cells:new Map(),next:0};break;
      case "c":
        this.cell={reference:attribute(attributes,"r"),type:attribute(attributes,"t")??"n",style:Number(attribute(attributes,"s")??0),value:"",formula:"",text:""};
        break;
      case "v":if(this.cell)this.field="value";break;
      case "f":if(this.cell)this.field="formula";break;
      case "is":if(this.cell)this.inline++;break;
      case "t":if(this.cell&&this.inline)this.field="text";break;
    }
  }
  characters(text){if(this.cell&&this.field)this.cell[this.field]+=text}
  leave(name){
    if(name==="v"||name==="f"||name==="t")this.field=null;
    else if(name==="is")this.inline--;
    else if(name==="c")this.placeCell();
    else if(name==="row")this.writeRow();
  }
  shown(cell){
    const value=cell.value.trim();
    if(cell.type==="inlineStr")return cell.text;
    if(!value)return cell.formula.trim()?`=${cell.formula.trim()}`:"";
    switch(cell.type){
      case "s":return this.strings[Number(value)]??"";
      case "b":return value==="1"?"TRUE":value==="0"?"FALSE":value;
      case "str":case "e":case "d":return cell.value;
      default:return shownNumber(value,this.formats[cell.style]??"number",this.from1904);
    }
  }
  placeCell(){
    const cell=this.cell,row=this.row;this.cell=null;
    if(!row)return;
    const found=referenceColumn(cell.reference);
    if(found===null)return;
    const column=found<0?row.next:found;
    row.next=column+1;
    const text=this.shown(cell);
    if(text.trim())row.cells.set(column,text);
  }
  writeRow(){
    const row=this.row;this.row=null;
    if(!row?.cells.size)return;
    let previous=0;
    for(const column of [...row.cells.keys()].sort((a,b)=>a-b)){
      this.writer.write("\t".repeat(column-previous)+row.cells.get(column));
      previous=column;
    }
    this.writer.write("\n");
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The readings of each kind of package.
function readWord(pack,kindPart){
  pack.readPart(pack.mainPart(kindPart),source=>pack.stream(source,new WordReading(pack.writer)));
}
function readExcel(pack){
  const book=pack.mainPart("xl/workbook.xml"),links=pack.relationships(book);
  const linked=(type,usual)=>links.find(link=>link.type.endsWith(`/${type}`))?.target??usual;
  const sheets=[];let from1904=false;
  pack.readPart(book,source=>streamMarkup(source,{enter(name,attributes){
    if(name==="workbookPr")from1904=["1","true"].includes(attribute(attributes,"date1904"));
    else if(name==="sheet")sheets.push({name:attribute(attributes,"name")??"",state:attribute(attributes,"state"),link:relationshipId(attributes)});
  }}));
  let strings=[],formats=[];
  const stringsPart=linked("sharedStrings","xl/sharedStrings.xml"),stylesPart=linked("styles","xl/styles.xml");
  if(pack.archive.has(stringsPart))pack.readPart(stringsPart,source=>{strings=sharedStrings(source)});
  if(pack.archive.has(stylesPart))pack.readPart(stylesPart,source=>{formats=styleValueKinds(source)});
  sheets.forEach((sheet,index)=>{
    const hidden=sheet.state==="hidden"||sheet.state==="veryHidden"?"(hidden)":"";
    pack.writer.write(sectionHeading("Sheet",index+1,sheets.length,[sheet.name,hidden].filter(Boolean).join(" ")));
    const target=links.find(link=>link.id===sheet.link)?.target??null;
    pack.readPart(target,source=>pack.stream(source,new SheetReading(pack.writer,{strings,formats,from1904})),target??`the link to sheet ${index+1}`);
  });
}
function readPowerPoint(pack){
  const deck=pack.mainPart("ppt/presentation.xml"),links=pack.relationships(deck),slides=[];
  pack.readPart(deck,source=>streamMarkup(source,{enter(name,attributes){if(name==="sldId")slides.push(relationshipId(attributes))}}));
  slides.forEach((link,index)=>{
    pack.writer.write(sectionHeading("Slide",index+1,slides.length));
    const slide=links.find(found=>found.id===link)?.target??null;
    if(!pack.readPart(slide,source=>pack.stream(source,new DrawingReading(pack.writer)),slide??`the link to slide ${index+1}`))return;
    for(const notes of pack.relationships(slide).filter(found=>found.type.endsWith("/notesSlide"))){
      pack.writer.write("\nSpeaker notes:\n");
      pack.readPart(notes.target,source=>pack.stream(source,new DrawingReading(pack.writer)));
    }
  });
}
function readOpenDocument(pack,sections){
  pack.readPart("content.xml",source=>{
    const total=sections?countSections(source,sections):0;
    pack.stream(source,new OpenDocumentReading(pack.writer,sections,total));
  });
}
// EPUB 3: the container names the package document, whose spine lists the content documents in reading order. A spine item may be
// a cover or a contents page, so each is a section rather than a chapter.
function readEpub(pack){
  let packagePath=null;
  pack.readPart("META-INF/container.xml",source=>streamMarkup(source,{enter(name,attributes){
    if(name==="rootfile"&&packagePath===null)packagePath=attribute(attributes,"full-path")??null;
  }}));
  if(packagePath===null)return;
  const items=new Map(),spine=[];
  pack.readPart(packagePath,source=>streamMarkup(source,{enter(name,attributes){
    if(name==="item")items.set(attribute(attributes,"id"),attribute(attributes,"href"));
    else if(name==="itemref")spine.push(attribute(attributes,"idref"));
  }}));
  spine.forEach((id,index)=>{
    pack.writer.write(sectionHeading("Section",index+1,spine.length));
    const href=items.get(id),path=href?resolveTarget(posix.dirname(packagePath),href):null;
    pack.readPart(path,source=>pack.stream(source,new XhtmlReading(pack.writer)),path??`section ${index+1}`);
  });
}
const PACKAGE_READINGS={
  "word":pack=>readWord(pack,"word/document.xml"),
  "excel":readExcel,
  "powerpoint":readPowerPoint,
  "odf-text":pack=>readOpenDocument(pack,null),
  "odf-sheets":pack=>readOpenDocument(pack,ODF_SHEETS),
  "odf-slides":pack=>readOpenDocument(pack,ODF_SLIDES),
  "epub":readEpub,
};

// ---------------------------------------------------------------------------------------------------------------------------------
// A Jupyter notebook (nbformat 4): each cell under a heading with its kind and place, its source, and for a code cell what it
// printed, returned, showed or raised.
const CELL_KINDS={code:"Code",markdown:"Markdown",raw:"Raw"};
const isObject=value=>value!==null&&typeof value==="object"&&!Array.isArray(value);
const joinedText=value=>typeof value==="string"?value:Array.isArray(value)?value.filter(line=>typeof line==="string").join(""):"";
const asLines=text=>text&&!text.endsWith("\n")?text+"\n":text;
function outputText(output){
  if(!isObject(output))return "";
  if(output.output_type==="stream")return asLines(joinedText(output.text));
  if(output.output_type==="error"){
    const head=[output.ename,output.evalue].filter(part=>typeof part==="string"&&part).join(": ");
    const trace=Array.isArray(output.traceback)?output.traceback.filter(line=>typeof line==="string").map(stripVTControlCharacters):[];
    return [head,...trace].filter(Boolean).map(line=>line+"\n").join("");
  }
  const data=isObject(output.data)?output.data:{};
  if("text/plain" in data)return asLines(joinedText(data["text/plain"]));
  return Object.keys(data).map(type=>`[${type} output]\n`).join("");
}
function writeNotebook(source,writer){
  let notebook;
  try{notebook=JSON.parse(source)}catch{refuseDocument("The notebook is not valid JSON")}
  const cells=isObject(notebook)?notebook.cells:undefined;
  if(!Array.isArray(cells))refuseDocument("The notebook has no list of cells");
  cells.forEach((cell,index)=>{
    if(!isObject(cell))return;
    writer.write(sectionHeading(`${CELL_KINDS[cell.cell_type]??"Unknown"} cell`,index+1,cells.length));
    writer.write(asLines(joinedText(cell.source)));
    if(cell.cell_type!=="code"||!Array.isArray(cell.outputs)||!cell.outputs.length)return;
    writer.write("Cell output:\n");
    for(const output of cell.outputs)writer.write(outputText(output));
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Blank lines run together into one, and the text loses its blank lines at both ends and the white space after its last line.
function tidy(text){
  let result="",afterBlank=false;
  for(const line of text.split("\n")){
    if(!line.trim()){afterBlank=true;continue}
    result+=(result?(afterBlank?"\n\n":"\n"):"")+line;
    afterBlank=false;
  }
  return result.trimEnd();
}

async function writeDocument(path,kind,writer){
  if((await stat(path)).size>kind.largestFile)reachLimit();
  if(kind.reading==="notebook")return writeNotebook(await readFile(path,"utf8"),writer);
  const bytes=await readFile(path);
  if(bytes.length>kind.largestFile)reachLimit();
  if(kind.reading==="rtf")return writeRtfText(bytes.toString("latin1"),writer);
  PACKAGE_READINGS[kind.reading](new Package(new Archive(bytes),writer,{htmlNames:kind.reading==="epub"}));
}

// The text of the document at path, whose kind its extension (".docx" and the rest) names. A document past a bound keeps the text
// read until then and ends with a note saying so. A document of another kind, one that is not what its name says, damaged, locked or
// without text is refused (DocumentRefused); a failure of the file system's is thrown as it came.
export async function readDocumentText(path,extension){
  const kind=documentKind(extension)??refuseDocument("Trebell does not read this kind of file into text");
  const writer=new TextWriter();
  let cut=false;
  try{await writeDocument(path,kind,writer)}
  catch(error){
    if(!(error instanceof TextLimitReached))throw error;
    writer.settle();cut=true;
  }
  const text=tidy(writer.text());
  if(!cut)return text||refuseDocument("The document has no text");
  return text?`${text}\n\n${CUT_NOTE}`:CUT_NOTE;
}
