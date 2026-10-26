// Codex cuts the middle out of any additionalContext value over 1,000 tokens, which it counts as UTF-8 bytes divided by four, and
// says nothing (codex-rs context-fragments additional_context.rs: MAX_ADDITIONAL_CONTEXT_VALUE_TOKENS, truncate_middle_with_token_budget,
// in 0.155.1 and 0.162.0). So a longer value goes as pieces under numbered keys that also say how many there are, <key>.01-of-03,
// <key>.02-of-03 and so on. Codex sends a turn's entries in key order (it keeps them in a BTreeMap), so the model reads the pieces in
// the text's order, whole. And it sends only the entries whose value changed since the thread's last turn (state/additional_context.rs):
// a value that gains or loses a piece renames them all and goes again whole, so no piece of its old text is left as if still current.
export const CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES=4000;
// The Codex requests whose additionalContext Codex cuts that way.
const CONTEXT_METHODS=new Set(["turn/start","turn/steer"]);

// UTF-8 bytes of a code point; a lone surrogate counts 3, as Buffer.byteLength counts the U+FFFD it becomes.
const utf8Bytes=codePoint=>codePoint<0x80?1:codePoint<0x800?2:codePoint<0x10000?3:4;
// Where the longest run of text from start that fits maxBytes ends, on a code point (one code point at least).
function fittingEnd(text,start,maxBytes){
  let index=start,bytes=0;
  while(index<text.length){
    const codePoint=text.codePointAt(index),size=utf8Bytes(codePoint);
    if(bytes+size>maxBytes&&index>start)break;
    bytes+=size;index+=codePoint>0xffff?2:1;
  }
  return index;
}
// Where a piece of text[start, end) ends: after its last paragraph break (blank lines), else after its last line break, else at end.
function pieceEnd(text,start,end){
  const run=text.slice(start,end);let paragraph=-1;
  for(const match of run.matchAll(/\n(?:[ \t\r]*\n)+/g))paragraph=match.index+match[0].length;
  if(paragraph>0)return start+paragraph;
  const line=run.lastIndexOf("\n");
  return line>=0?start+line+1:end;
}

// A value cut into pieces of at most maxBytes UTF-8 bytes that join, in order, back into the value: at paragraph breaks first, then
// line breaks, then code points. A value that fits is one piece.
export function codexAdditionalContextPieces(value,maxBytes=CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES){
  const text=String(value??"");if(Buffer.byteLength(text,"utf8")<=maxBytes)return [text];
  const pieces=[];
  for(let start=0;start<text.length;){
    const end=fittingEnd(text,start,maxBytes),cut=end>=text.length?end:pieceEnd(text,start,end);
    pieces.push(text.slice(start,cut));start=cut;
  }
  return pieces;
}

// The additionalContext with every value over maxBytes split into numbered pieces of the same kind; entries that fit are left as
// they are, and an additionalContext with none to split is returned itself.
export function splitCodexAdditionalContext(additionalContext,maxBytes=CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES){
  if(!additionalContext||typeof additionalContext!=="object"||Array.isArray(additionalContext))return additionalContext;
  const long=([,entry])=>typeof entry?.value==="string"&&Buffer.byteLength(entry.value,"utf8")>maxBytes;
  if(!Object.entries(additionalContext).some(long))return additionalContext;
  const split={};
  for(const [key,entry] of Object.entries(additionalContext)){
    if(!long([key,entry])){split[key]=entry;continue}
    const pieces=codexAdditionalContextPieces(entry.value,maxBytes),width=Math.max(2,String(pieces.length).length),count=String(pieces.length).padStart(width,"0");
    pieces.forEach((value,index)=>{split[`${key}.${String(index+1).padStart(width,"0")}-of-${count}`]={...entry,value}});
  }
  return split;
}

// A turn's start or steer with its additionalContext split for Codex; any other message is returned as it is.
export function withCodexContextPieces(message){
  const additionalContext=message?.params?.additionalContext;
  if(!CONTEXT_METHODS.has(message?.method)||!additionalContext)return message;
  const split=splitCodexAdditionalContext(additionalContext);
  return split===additionalContext?message:{...message,params:{...message.params,additionalContext:split}};
}
