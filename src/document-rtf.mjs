import { BOUNDS, reachLimit, refuseDocument } from "./document-reading.mjs";

// RTF (Microsoft's RTF 1.9.1 specification), scanned a character at a time from the file read as Latin-1, so each character is one
// byte of the file. Text bytes (plain characters and \'hh escapes) are gathered and decoded together in the document's code page,
// which lets a double-byte page's pairs stay whole; \uN gives a UTF-16 unit directly.

// The code pages Trebell decodes, by \ansicpg number, as the Encoding Standard names them: Windows' single-byte pages, the four
// double-byte East Asian ones, and the Macintosh page that \mac selects.
const CODE_PAGES=new Map([
  [874,"windows-874"],[1250,"windows-1250"],[1251,"windows-1251"],[1252,"windows-1252"],[1253,"windows-1253"],
  [1254,"windows-1254"],[1255,"windows-1255"],[1256,"windows-1256"],[1257,"windows-1257"],[1258,"windows-1258"],
  [932,"shift_jis"],[936,"gbk"],[949,"euc-kr"],[950,"big5"],[10000,"macintosh"],
]);

// Destinations whose groups hold no body text, so everything in them is passed over (a group marked \* is passed over as well).
const PASSED_OVER=new Set([
  // tables the body refers to
  "fonttbl","colortbl","stylesheet","listtable","listoverridetable","revtbl","rsidtbl",
  // the document's information (title, author, dates)
  "info",
  // page furniture repeated on every page
  "header","headerl","headerr","headerf","footer","footerl","footerr","footerf",
  // embedded data
  "pict","objdata","datastore","themedata",
  // a field's instruction; its result (fldrslt) is the text that shows
  "fldinst",
]);

// Control words that stand for text.
const WORD_TEXT=new Map([
  ["par","\n"],["line","\n"],["sect","\n"],["page","\n"],["row","\n"],["tab","\t"],["cell","\t"],
  ["lquote","\u2018"],["rquote","\u2019"],["ldblquote","\u201c"],["rdblquote","\u201d"],["bullet","\u2022"],
  ["endash","\u2013"],["emdash","\u2014"],["enspace","\u2002"],["emspace","\u2003"],["qmspace","\u2005"],
]);
// Control symbols (a backslash and one character that is not a letter) that stand for text. A backslash before a line end is a
// paragraph mark.
const SYMBOL_TEXT=new Map([
  ["\\","\\"],["{","{"],["}","}"],["~","\u00a0"],["_","\u2011"],["-",""],["\n","\n"],["\r","\n"],
]);

const isLetter=code=>(code>=0x61&&code<=0x7a)||(code>=0x41&&code<=0x5a);
const isDigit=code=>code>=0x30&&code<=0x39;
const hexValue=code=>isDigit(code)?code-0x30:(code|0x20)>=0x61&&(code|0x20)<=0x66?(code|0x20)-0x57:-1;
const isTextBreak=code=>code===0x7b||code===0x7d||code===0x5c||code===0x0d||code===0x0a;

// Writes the RTF document in source (a Latin-1 string) to writer.
export function writeRtfText(source,writer){
  if(!source.startsWith("{\\rtf"))refuseDocument("Not an RTF file");
  let decoder=new TextDecoder(CODE_PAGES.get(1252));
  let group={passOver:false,standIns:1};
  const outer=[];
  let bytes=[];          // text bytes waiting to be decoded, as Latin-1 strings
  let standInsLeft=0;    // characters still to skip after a \uN
  const decodeBytes=()=>{
    if(!bytes.length)return;
    const run=Buffer.from(bytes.join(""),"latin1");bytes=[];
    writer.write(decoder.decode(run));
  };
  const emit=text=>{decodeBytes();writer.write(text)};
  const controlWord=(word,value)=>{
    if(standInsLeft){standInsLeft--;return}
    if(PASSED_OVER.has(word)){group.passOver=true;return}
    if(word==="uc"){group.standIns=value!==null&&value>=0?value:1;return}
    if(group.passOver)return;
    if(word==="ansicpg"||word==="mac"){
      const label=CODE_PAGES.get(word==="mac"?10000:value)??refuseDocument(`Trebell cannot decode code page ${value} of this file`);
      decodeBytes();decoder=new TextDecoder(label);
      return;
    }
    if(word==="u"&&value!==null){
      emit(String.fromCharCode(value<0?value+0x10000:value&0xffff));
      standInsLeft=group.standIns;
      return;
    }
    if(word==="row"){decodeBytes();writer.unwrite("\t")}
    const text=WORD_TEXT.get(word);
    if(text!==undefined)emit(text);
  };
  for(let at=0;at<source.length;){
    const code=source.charCodeAt(at);
    if(code===0x7b){
      decodeBytes();standInsLeft=0;
      outer.push(group);
      if(outer.length>BOUNDS.nesting)reachLimit();
      group={...group};at++;
    }else if(code===0x7d){
      decodeBytes();standInsLeft=0;
      group=outer.pop()??group;at++;
    }else if(code===0x0d||code===0x0a){
      at++;
    }else if(code!==0x5c){
      let end=at+1;
      while(end<source.length&&!isTextBreak(source.charCodeAt(end)))end++;
      let from=at;
      if(standInsLeft){const skipped=Math.min(standInsLeft,end-at);from+=skipped;standInsLeft-=skipped}
      if(!group.passOver&&from<end)bytes.push(source.slice(from,end));
      at=end;
    }else if(isLetter(source.charCodeAt(at+1))){
      let end=at+1;
      while(end<source.length&&isLetter(source.charCodeAt(end)))end++;
      const word=source.slice(at+1,end);
      let digitsEnd=end+(source.charCodeAt(end)===0x2d?1:0);
      const digitsStart=digitsEnd;
      while(digitsEnd<source.length&&isDigit(source.charCodeAt(digitsEnd)))digitsEnd++;
      const value=digitsEnd>digitsStart?Number(source.slice(end,digitsEnd)):null;
      at=value===null?end:digitsEnd;
      if(source.charCodeAt(at)===0x20)at++;
      // \binN: N bytes of binary data follow, which are never text.
      if(word==="bin"){at+=value!==null&&value>0?value:0;continue}
      controlWord(word,value);
    }else if(source.charCodeAt(at+1)===0x27){
      const high=hexValue(source.charCodeAt(at+2)),low=hexValue(source.charCodeAt(at+3));
      at+=4;
      if(high<0||low<0)continue;
      if(standInsLeft){standInsLeft--;continue}
      if(!group.passOver)bytes.push(String.fromCharCode(high*16+low));
    }else{
      const symbol=source.charAt(at+1);at+=2;
      if(standInsLeft){standInsLeft--;continue}
      if(symbol==="*"){group.passOver=true;continue}
      if(group.passOver)continue;
      const text=SYMBOL_TEXT.get(symbol);
      if(text!==undefined)emit(text);
    }
    if(bytes.length>=4096)decodeBytesAtBoundary();
  }
  decodeBytes();

  // A long run of text bytes is decoded once it ends on a plain ASCII byte, which never starts a double-byte pair.
  function decodeBytesAtBoundary(){
    const last=bytes.at(-1);
    if(last&&last.charCodeAt(last.length-1)<0x80)decodeBytes();
  }
}
