import { readFile, stat } from "node:fs/promises";
import { posix } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { characterEntities } from "character-entities";
import { SaxesParser } from "saxes";
import yauzl from "yauzl";

// The text of an attached Word, Excel, PowerPoint, OpenDocument, RTF, EPUB or Jupyter notebook file. It runs only in a process of
// its own under a 192 MB heap (document-text-worker.mjs, which
// document-text.mjs starts): the file is untrusted, so what it is read up to is bounded (its size, what its archive expands to, its
// XML's depth and elements, a table's rows and columns, the text), and the text stops with a note where a bound is reached.
const MAX_INPUT=16*1024*1024,MAX_EXPANDED=32*1024*1024,MAX_OUTPUT=1_000_000;
const CELL_START=Symbol("cell-start"),CELL_END=Symbol("cell-end");
const TRUNCATED="\n\n[The extracted text stops here, at Trebell Code's limits for a document.]";
// A bound reached: the text so far is kept, with the note.
class Truncation extends Error{}
const SKIPPED=new Set(["script","style","binary-data"]),BREAKS=new Set(["br","line-break","cr"]);
const ODF=new Set([".odt",".ods",".odp"]),CELLS=new Set(["tc","table-cell","covered-table-cell","td","th"]);
const localName=name=>name.split(":").at(-1);

// A document part as a tree of elements by local name, each attribute under its full and its local name; ODF's <text:s c="n"/> keeps
// its count of spaces, and an EPUB's XHTML takes HTML's named entities. saxes reads no DTD, so no entity can expand into more text.
function xml(source,odfSpaces=false,htmlEntities=false){
  const root={name:"root",attrs:{},children:[]},stack=[root];let nodes=0;
  const parser=new SaxesParser();
  if(htmlEntities)Object.assign(parser.ENTITIES,characterEntities);
  parser.on("opentag",tag=>{
    if(++nodes>200_000||stack.length>128)throw new Truncation("XML structure limit");
    const attrs={};
    for(const [key,value] of Object.entries(tag.attributes)){attrs[key]=String(value);attrs[localName(key)]=String(value)}
    const node={name:localName(tag.name),attrs,children:[]};
    if(odfSpaces&&node.name==="s")node.spaceCount=repeatCount(node.attrs.c);
    stack.at(-1).children.push(node);stack.push(node);
  });
  parser.on("closetag",()=>{stack.pop()});
  const text=value=>{stack.at(-1).children.push(value)};
  parser.on("text",text);parser.on("cdata",text);
  parser.write(source).close();
  return root;
}

const elements=node=>node.children.filter(child=>typeof child!=="string");
// The elements of that name (or one of those names) under node, without looking inside one found.
function* all(node,name){
  for(const child of elements(node)){
    if(typeof name==="string"?child.name===name:name.includes(child.name))yield child;
    else yield* all(child,name);
  }
}
function* text(node){
  if(SKIPPED.has(node.name)||node.name==="rPh")return;
  if(node.name==="tab"||node.name==="cell")yield "\t";
  else if(BREAKS.has(node.name))yield "\n";
  else if(node.spaceCount!==undefined){
    yield " ".repeat(Math.min(MAX_OUTPUT,node.spaceCount));
    if(node.spaceCount>MAX_OUTPUT)throw new Truncation("Space repeat limit");
  }else for(const child of node.children){
    if(typeof child==="string")yield child;
    else yield* text(child);
  }
}
// Paragraphs a line each, a heading after as many #s as its level (a Word Heading style, ODF's outline level, HTML's h1-h6), and
// tables a row a line.
function* paragraphs(node){
  if(SKIPPED.has(node.name))return;
  for(const child of node.children){
    if(typeof child==="string")yield child;
    else if(BREAKS.has(child.name))yield "\n";
    else if(child.name==="tbl"||child.name==="table")yield* table(child);
    else if(child.name==="p"||child.name==="h"||/^h[1-6]$/.test(child.name)){
      const style=all(child,"pStyle").next().value?.attrs.val??"";
      const level=child.name==="h"?Number(child.attrs["outline-level"])||1:/^h[1-6]$/.test(child.name)?Number(child.name[1]):Number(style.match(/^Heading([1-6])$/i)?.[1])||0;
      if(level)yield "#".repeat(Math.min(6,level))+" ";
      yield* text(child);
      yield "\n";
    }else{
      yield* paragraphs(child);
      if(["li","div","section"].includes(child.name))yield "\n";
    }
  }
}
function* inCell(parts){yield CELL_START;yield* parts;yield CELL_END}
function repeatCount(value){
  if(value===undefined)return 1;
  if(!/^[0-9]+$/.test(value)||Number(value)<1)throw new Error("Invalid repeat count");
  return Number(value);
}
// An ODF cell's value from its attributes, which a cell with no paragraph shows.
function odfValue(cell){
  const type=cell.attrs["office:value-type"]??cell.attrs["value-type"];
  const attr=name=>cell.attrs[`office:${name}`]??cell.attrs[name]??"";
  switch(type){
    case "void":return "";
    case "string":return attr("string-value");
    case "boolean":return attr("boolean-value");
    case "date":return attr("date-value");
    case "time":return attr("time-value");
    case "currency":return attr("value").trim()?`${attr("value")} ${attr("currency")}`.trim():"";
    case "percentage":return attr("value").trim()?`${attr("value")} [ODF value-type=percentage]`:"";
    default:return attr("value");
  }
}
function hasCellText(cell){
  if(odfValue(cell).trim())return true;
  // A space marker can repeat a space a million times: telling whether a cell is empty never expands one.
  if(SKIPPED.has(cell.name)||cell.name==="rPh"||cell.spaceCount!==undefined)return false;
  return cell.children.some(child=>typeof child==="string"?Boolean(child.trim()):hasCellText(child));
}
// A row a line, its cells apart by tabs, up to 10,000 rows and 512 columns. ODS writers pad a sheet with repeated empty rows and
// trailing cells, which are left out.
function* table(node){
  let rowCount=0;
  for(const row of all(node,["tr","table-row"])){
    const cells=elements(row).filter(cell=>CELLS.has(cell.name));
    while(cells.length&&!hasCellText(cells.at(-1)))cells.pop();
    if(!cells.length)continue;
    const repeat=repeatCount(row.attrs["number-rows-repeated"]);
    for(let index=0;index<repeat;index++){
      if(++rowCount>10_000)throw new Truncation("Row limit");
      let column=0;
      for(const cell of cells){
        const count=repeatCount(cell.attrs["number-columns-repeated"]);
        for(let i=0;i<count;i++){
          if(column>=512)throw new Truncation("Column limit");
          if(column++)yield "\t";
          yield CELL_START;
          yield* paragraphs(cell);
          yield {fallback:odfValue(cell)};
          yield CELL_END;
        }
      }
      yield "\n";
    }
  }
}

// XML's byte-order mark or its first '<' tells UTF-16 in either byte order from UTF-8.
const encodingOf=data=>(data[0]===0xff&&data[1]===0xfe)||(data[0]===0x3c&&data[1]===0)?"utf-16le":(data[0]===0xfe&&data[1]===0xff)||(data[0]===0&&data[1]===0x3c)?"utf-16be":"utf-8";
// The archive's XML parts by name. Up to 2048 entries are read, 32 MB of XML in all and no part that expands to more than 200 times
// its packed size (a zip bomb); pictures and embedded files are never unpacked, and an encrypted archive is refused.
async function archive(path){
  const zip=await new Promise((resolve,reject)=>yauzl.open(path,{lazyEntries:true,validateEntrySizes:true,strictFileNames:true},(error,result)=>error||!result?reject(error):resolve(result)));
  const files=new Map();let expanded=0,count=0;
  try{
    await new Promise((resolve,reject)=>{
      zip.on("error",reject);zip.on("end",resolve);
      zip.on("entry",entry=>{
        if(++count>2048||zip.entryCount>2048)return reject(new Truncation("Archive limit"));
        if(entry.generalPurposeBitFlag&1)return reject(new Error("Encrypted archive"));
        if(!/\.(xml|rels|xhtml|html|htm|opf|svg)$/i.test(entry.fileName)){zip.readEntry();return}
        if(entry.uncompressedSize>MAX_EXPANDED||entry.uncompressedSize>Math.max(1024,entry.compressedSize*200))return reject(new Truncation("Archive limit"));
        expanded+=entry.uncompressedSize;
        if(expanded>MAX_EXPANDED)return reject(new Truncation("Expanded byte limit"));
        zip.openReadStream(entry,(error,stream)=>{
          if(error||!stream)return reject(error);
          const buffers=[];let size=0;
          stream.on("error",reject);
          stream.on("data",chunk=>{
            size+=chunk.length;
            if(size>entry.uncompressedSize||size>MAX_EXPANDED){stream.destroy(new Truncation("Entry byte limit"));return}
            buffers.push(chunk);
          });
          stream.on("end",()=>{const data=Buffer.concat(buffers);files.set(entry.fileName,new TextDecoder(encodingOf(data)).decode(data));zip.readEntry()});
        });
      });
      zip.readEntry();
    });
  }finally{zip.close()}
  return files;
}

// A notebook's cells in order, each headed by its number and kind, with what a code cell printed, returned or raised (a traceback
// without its terminal colours).
function* notebook(source){
  const book=JSON.parse(source);
  if(!book||typeof book!=="object"||!Array.isArray(book.cells))throw new Error("Invalid notebook");
  function* lines(value){
    if(typeof value==="string")yield value;
    else if(Array.isArray(value))for(const line of value)if(typeof line==="string")yield line;
  }
  for(const [index,cell] of book.cells.entries()){
    if(index>=10_000)throw new Truncation("Notebook cell limit");
    if(!cell||typeof cell!=="object")continue;
    yield `## Cell ${index+1} (${cell.cell_type==="code"?"code":"markdown"})\n`;
    if("source" in cell)yield* lines(cell.source);
    if(Array.isArray(cell.outputs)){
      yield "\nOutput:\n";
      for(const output of cell.outputs){
        if(!output||typeof output!=="object")continue;
        if("text" in output)yield* lines(output.text);
        else if(output.data&&typeof output.data==="object"&&"text/plain" in output.data)yield* lines(output.data["text/plain"]);
        else if(output.output_type==="error"){
          if("ename" in output)yield* lines(output.ename);
          if("evalue" in output){yield ": ";yield* lines(output.evalue)}
          yield "\n";
          if("traceback" in output)for(const line of lines(output.traceback)){yield stripVTControlCharacters(line);yield "\n"}
        }
        yield "\n";
      }
    }
    yield "\n\n";
  }
}

// RTF's text without its control words and the groups that hold no text (fonts, colours, styles, pictures, fields' instructions,
// headers and footers), with \u Unicode characters and their fallbacks, \'hh bytes in the document's single-byte code page and its
// named symbols.
function* rtf(source){
  if(!source.startsWith("{\\rtf"))throw new Error("Invalid RTF document");
  let state={skip:false,uc:1,decoder:new TextDecoder("windows-1252")};
  const stack=[];
  const symbols=new Map([["endash","–"],["emdash",characterEntities.mdash],["enspace"," "],["emspace"," "],["qmspace"," "],["lquote","‘"],["rquote","’"],["ldblquote","“"],["rdblquote","”"],["bullet","•"],["~"," "],["_","‑"],["-",""]]);
  const hidden=new Set(["fonttbl","colortbl","stylesheet","info","pict","object","fldinst","header","footer"]);
  let fallback=0;
  for(let i=0;i<source.length;i++){
    const char=source[i];
    if(char==="{"||char==="}")fallback=0;
    if(char==="{"){
      stack.push({...state});
      if(stack.length>128)throw new Truncation("RTF depth limit");
    }else if(char==="}")state=stack.pop()??state;
    else if(char==="\\"){
      const rest=source.slice(i+1,i+80),hex=/^'([0-9a-f]{2})/i.exec(rest),word=/^([a-z]+)(-?\d+)? ?/i.exec(rest);
      if(hex){
        if(fallback)fallback--;
        else if(!state.skip)yield state.decoder.decode(Uint8Array.of(Number.parseInt(hex[1],16)));
        i+=3;
      }else if(word){
        i+=word[0].length;
        const control=word[1],value=Number(word[2]);
        if(control==="bin"){
          if(!Number.isSafeInteger(value)||value<0)throw new Error("Invalid RTF binary length");
          i+=value;
        }
        if(fallback){fallback--;continue}
        if(hidden.has(control))state.skip=true;
        if(control==="ansicpg"){
          // Bytes are decoded one at a time, which only a single-byte Windows code page allows.
          if(value!==874&&(value<1250||value>1258))throw new Error("Unsupported RTF code page");
          state.decoder=new TextDecoder(`windows-${value}`,{fatal:true});
        }else if(control==="uc"){
          if(!Number.isSafeInteger(value)||value<0)throw new Error("Invalid RTF fallback count");
          state.uc=value;
        }else if(control==="u"&&!state.skip){
          yield String.fromCharCode(value<0?value+65536:value);
          fallback=state.uc;
        }else if(!state.skip&&["par","line","row"].includes(control))yield "\n";
        else if(!state.skip&&["tab","cell"].includes(control))yield "\t";
        else if(!state.skip&&symbols.has(control))yield symbols.get(control);
      }else{
        i++;
        if(fallback)fallback--;
        else if(rest[0]==="*")state.skip=true;
        else if(!state.skip&&["\\","{","}"].includes(rest[0]))yield rest[0];
        else if(!state.skip&&symbols.has(rest[0]))yield symbols.get(rest[0]);
      }
    }else if(!state.skip&&char!=="\n"&&char!=="\r"){
      if(fallback)fallback--;
      else yield char.charCodeAt(0)<128?char:state.decoder.decode(Uint8Array.of(char.charCodeAt(0)));
    }
  }
}

const archivePath=(base,target)=>target.startsWith("/")?target.slice(1):posix.normalize(`${base}/${target}`);
async function* document(path,extension){
  if((await stat(path)).size>MAX_INPUT)throw new Truncation("Input byte limit");
  if(extension===".ipynb"){yield* notebook(await readFile(path,"utf8"));return}
  if(extension===".rtf"){yield* rtf((await readFile(path)).toString("latin1"));return}
  const files=await archive(path),notes=[];
  const skip=name=>notes.push(`\n[A part of the document was left out: ${name} is missing or is not valid XML.]\n`);
  const read=name=>{
    try{
      const data=files.get(name);if(!data)throw new Error("Missing document part");
      return xml(data,ODF.has(extension),extension===".epub");
    }catch(error){
      if(error instanceof Truncation)throw error;
      skip(name);return {name:"root",attrs:{},children:[]};
    }
  };
  const relations=name=>new Map([...all(read(name),"Relationship")].filter(rel=>rel.attrs.TargetMode!=="External").map(rel=>[rel.attrs.Id,rel.attrs.Target]));
  if(extension===".docx")yield* paragraphs(read("word/document.xml"));
  else if(ODF.has(extension)){
    const content=read("content.xml");
    if(extension===".odt")yield* paragraphs(content);
    else{
      let index=0;
      for(const part of all(content,extension===".ods"?"table":"page")){
        yield extension===".ods"?`\n\n## Sheet: ${part.attrs.name??"Untitled"}\n`:`\n\n## Slide ${++index}\n`;
        if(extension===".ods")yield* table(part);
        else yield* paragraphs(part);
      }
    }
  }else if(extension===".xlsx"){
    const workbook=read("xl/workbook.xml");
    const dateSystem=["1","true"].includes(all(workbook,"workbookPr").next().value?.attrs.date1904??"")?"1904":"1900";
    const styles=files.has("xl/styles.xml")?read("xl/styles.xml"):undefined;
    const customFormats=new Map(styles?[...all(styles,"numFmt")].map(node=>[node.attrs.numFmtId,node.attrs.formatCode]):[]);
    const cellFormats=styles?all(styles,"cellXfs").next().value:undefined,formats=cellFormats?elements(cellFormats):[];
    const strings=files.has("xl/sharedStrings.xml")?[...all(read("xl/sharedStrings.xml"),"si")]:[],populatedStrings=strings.map(hasCellText);
    const rels=relations("xl/_rels/workbook.xml.rels");
    for(const sheet of all(workbook,"sheet")){
      yield `\n## Sheet: ${sheet.attrs.name}\n`;
      const target=rels.get(sheet.attrs["r:id"]??sheet.attrs.id);
      if(!target){skip(`sheet relationship ${sheet.attrs.name}`);continue}
      const populated=cell=>{
        const value=all(cell,"v").next().value;
        if(cell.attrs.t==="s"){const raw=value?.children.find(child=>typeof child==="string")?.trim();return Boolean(raw)&&Boolean(populatedStrings[Number(raw)])}
        if(cell.attrs.t==="inlineStr")return hasCellText(cell);
        if(value&&hasCellText(value))return true;
        for(const formula of all(cell,"f"))if(hasCellText(formula))return true;
        return false;
      };
      let rowCount=0;
      for(const row of all(read(archivePath("xl",target)),"row")){
        const cells=[];let nextColumn=0,columnsTruncated=false;
        for(const cell of elements(row).filter(node=>node.name==="c")){
          const letters=cell.attrs.r?.match(/^[A-Z]+/)?.[0];
          const column=letters?[...letters].reduce((n,char)=>n*26+char.charCodeAt(0)-64,0)-1:nextColumn;
          nextColumn=column+1;
          if(!populated(cell))continue;
          if(column>=512){columnsTruncated=true;continue}
          cells[column]=cell;
        }
        if(!cells.length&&!columnsTruncated)continue;
        if(++rowCount>10_000)throw new Truncation("Row limit");
        for(const [column,cell] of cells.entries()){
          if(column)yield "\t";
          if(!cell)continue;
          const value=all(cell,"v").next().value,raw=value?.children.find(child=>typeof child==="string")??"";
          if(cell.attrs.t==="s"){const shared=strings[Number(raw)];if(shared)yield* inCell(text(shared))}
          else if(cell.attrs.t==="inlineStr")yield* inCell(text(cell));
          else{
            if(value&&hasCellText(value))yield* inCell(text(value));
            else for(const formula of all(cell,"f"))yield* inCell(text(formula));
            // A number shown as a date, a percentage or a format of the workbook's own says so, with the date system it counts from.
            const formatId=formats[Number(cell.attrs.s??0)]?.attrs.numFmtId,format=formatId?customFormats.get(formatId):undefined;
            if((cell.attrs.t===undefined||cell.attrs.t==="n")&&raw.trim()&&formatId&&formatId!=="0")yield ` [Excel numFmtId=${formatId}${format?`; format=${format}`:""}; date system ${dateSystem}]`;
          }
        }
        yield "\n";
        if(columnsTruncated)throw new Truncation("Column limit");
      }
    }
  }else if(extension===".pptx"){
    const rels=relations("ppt/_rels/presentation.xml.rels");let index=0;
    for(const slide of all(read("ppt/presentation.xml"),"sldId")){
      yield `\n\n## Slide ${++index}\n`;
      const target=rels.get(slide.attrs["r:id"]??slide.attrs.id);
      if(!target){skip(`slide relationship ${index}`);continue}
      const name=archivePath("ppt",target);
      yield* paragraphs(read(name));
      // The slide's speaker notes, from its own relationships.
      const slideRels=posix.join(posix.dirname(name),"_rels",`${posix.basename(name)}.rels`);
      if(!files.has(slideRels))continue;
      for(const rel of all(read(slideRels),"Relationship")){
        const notes=rel.attrs.Target;
        if(!rel.attrs.Type?.endsWith("/notesSlide")||rel.attrs.TargetMode==="External"||!notes)continue;
        yield "Notes:\n";
        yield* paragraphs(read(notes.startsWith("/")?notes.slice(1):posix.join(posix.dirname(name),notes)));
      }
    }
  }else if(extension===".epub"){
    const rootfile=all(read("META-INF/container.xml"),"rootfile").next().value?.attrs["full-path"];
    if(!rootfile){if(!notes.length)skip("EPUB package");yield* notes;return}
    const packageXml=read(rootfile),items=new Map([...all(packageXml,"item")].map(item=>[item.attrs.id,item.attrs.href]));
    let index=0;
    // The chapters in the spine's reading order.
    for(const item of all(packageXml,"itemref")){
      yield `\n\n## Chapter ${++index}\n`;
      const href=items.get(item.attrs.idref);
      if(!href){skip(`chapter ${index}`);continue}
      let decoded;
      try{decoded=decodeURIComponent(href.split("#")[0])}catch{skip(`chapter ${index}`);continue}
      yield* paragraphs(read(posix.normalize(posix.join(posix.dirname(rootfile),decoded))));
    }
  }else throw new Error("Unsupported document");
  yield* notes;
}

// The document's text, at most 1,000,000 characters: a table cell's text is put on one line, and a run of blank lines kept to one.
// Text is counted before it is tidied, so whitespace repeated without end also runs the budget out. A document with no text at all,
// or one that is not what its name says, is refused (throws).
export async function extractDocumentText(path,extension){
  let result="",remaining=MAX_OUTPUT,cellDepth=0,started=false,space=false,truncated=false;
  try{
    for await(const part of document(path,extension)){
      if(part===CELL_START){
        if(cellDepth++===0){started=false;space=false}
        else if(started)space=true;
        continue;
      }
      if(part===CELL_END){
        cellDepth--;
        if(cellDepth>0&&started)space=true;
        continue;
      }
      // A cell's value from its attributes counts only when the cell showed no text of its own.
      if(typeof part!=="string"&&started)continue;
      const raw=typeof part==="string"?part:part.fallback;
      let value=raw.slice(0,remaining).replaceAll("\0","");
      remaining-=Math.min(raw.length,remaining);
      if(cellDepth){
        value=value.replaceAll(/\s+/g," ");
        const trimmed=value.trim();
        if(trimmed){result+=(started&&(space||value.startsWith(" "))?" ":"")+trimmed;started=true}
        space=value.endsWith(" ")||(!value&&space);
      }else result+=value;
      if(remaining===0)throw new Truncation("Output budget");
    }
  }catch(error){
    if(!(error instanceof Truncation))throw error;
    truncated=true;
  }
  result=result.replaceAll(/\n(?:[ \t]*\n){2,}/g,"\n\n").trim();
  if(!result&&!truncated)throw new Error("No text extracted");
  return result+(truncated?TRUNCATED:"");
}
