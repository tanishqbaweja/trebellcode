// A reasoning item's text as Codex sends it (summary parts, then raw content parts) and as the relay sends a harness's thinking
// (one content part).
export function reasoningItemText(item){
  const parts=[...(Array.isArray(item?.summary)?item.summary:[]),...(Array.isArray(item?.content)?item.content:[])];
  return parts.map(part=>String(typeof part==="string"?part:part?.text||"").trim()).filter(Boolean).join("\n\n");
}

// The one line a collapsed thought shows beside its label, as plain text: with `latest` (while the thought streams) the last
// line that has words, the one being written, else the first (Codex's summary heading); "" when no line has words. The opened
// thought is rendered Markdown, so the line leaves out the marks a reader does not see there. It runs again on every streamed
// piece, so lines are read one at a time from the chosen end and the rest of a long thought is not read at all.
export function reasoningPreview(text,options){
  const source=text?String(text):"";
  return options?.latest?lastLineWithWords(source):firstLineWithWords(source);
}

function firstLineWithWords(source){
  for(let start=0;;){
    const cut=source.indexOf("\n",start),words=lineWords(source.slice(start,cut<0?source.length:cut));
    if(words||cut<0)return words;
    start=cut+1;
  }
}

function lastLineWithWords(source){
  for(let end=source.length;;){
    const cut=end?source.lastIndexOf("\n",end-1):-1,words=lineWords(source.slice(cut+1,end));
    if(words||cut<0)return words;
    end=cut;
  }
}

// A line's words: link and image syntax read as its words first, then the block mark the line opens with goes, then code ticks
// and doubled marks, and last the white space at both ends (with it the carriage return of a Windows line end).
const lineWords=line=>dropInlineMarks(dropBlockMark(unwrapLinks(line))).trim();

// [words](target) reads as its words, and so does ![words](source). The words run to the first "]", which a "(" must follow at
// once, and the target to the first ")" after that; a "[" that opens no such link stays as typed. Each "]" and ")" is looked
// for once (every "[" before a "]" shares it, and with no "]" or ")" ahead no link can follow), so a line full of brackets
// takes time in step with its length.
function unwrapLinks(line){
  let shown="",copied=0,close=-1;
  for(let open=line.indexOf("[");open>=0;open=line.indexOf("[",open+1)){
    if(close<open)close=line.indexOf("]",open+1);
    if(close<0)break;
    if(line[close+1]!=="(")continue;
    const end=line.indexOf(")",close+2);
    if(end<0)break;
    const image=open>copied&&line[open-1]==="!";
    shown+=line.slice(copied,image?open-1:open)+line.slice(open+1,close);
    copied=end+1;
    open=end;
  }
  return shown+line.slice(copied);
}

const isBlank=ch=>ch===" "||ch==="\t";

// The block mark a line opens with, with the spaces or tabs on both sides of it. A mark counts only with a space or tab after it
// (so "#tag", "-x" and "1.5" stay), and only the first one goes.
function dropBlockMark(line){
  let at=0;
  while(isBlank(line[at]))at++;
  const after=blockMarkEnd(line,at);
  if(after<0||!isBlank(line[after]))return line;
  let rest=after+1;
  while(isBlank(line[rest]))rest++;
  return line.slice(rest);
}

// Where a block mark starting at `at` ends, or -1 for none: a bullet ("-", "*", "+"), a quote (">"), a heading (one to six "#";
// seven are not a heading) or an item number (ASCII digits and a ".").
function blockMarkEnd(line,at){
  const ch=line[at];
  if(ch==="-"||ch==="*"||ch==="+"||ch===">")return at+1;
  let end=at;
  if(ch==="#"){
    while(line[end]==="#")end++;
    return end-at>6?-1:end;
  }
  while(line[end]>="0"&&line[end]<="9")end++;
  return end>at&&line[end]==="."?end+1:-1;
}

// Code ticks wherever they stand, and the doubled marks of strong text and strikethrough ("**", "__", "~~") taken left to right
// in pairs. A lone "*", "_" or "~" stays: a product, a snake_case name, "about".
function dropInlineMarks(line){
  let shown="";
  for(let i=0;i<line.length;i++){
    const ch=line[i];
    if(ch==="`")continue;
    if((ch==="*"||ch==="_"||ch==="~")&&line[i+1]===ch){i++;continue}
    shown+=ch;
  }
  return shown;
}

// A finished thought as a conversation row; a reasoning item without text (Codex's encrypted-only reasoning) shows none.
export function reasoningHistoryMessage(item,turnId=null,fallbackText=""){
  const text=reasoningItemText(item)||String(fallbackText||"").trim();
  return item?.id&&text?{id:String(item.id),role:"reasoning",text,turnId:turnId||null}:null;
}
