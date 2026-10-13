// trebell_workspace/replace_text: one exact old_text/new_text pair, or an ordered edits list applied to one file, all or nothing.
// A call that cannot apply says why in a form the model can act on without reading the file again: the closest region when an
// old_text has no exact match, and where each match is when it has several. A call that applies returns a compact unified diff
// of what changed; its before/after hashes stay in the raw result (and so in audit logs), not in what the model reads.

export const REPLACE_TEXT_MAX_EDITS=50;
const DIFF_CONTEXT_LINES=3,DIFF_MAX_LINES=200,DIFF_MAX_CHARS=12_000,DIFF_LINE_CHARS=300,DIFF_RUN_LINES=16,DIFF_MAX_EDIT_DISTANCE=1500,DIFF_WORK_BUDGET=20_000_000;
const REGION_MAX_LINES=40,REGION_LINE_CHARS=300,MATCH_LIST_LIMIT=12,HEADER_SEARCH_LINES=3000,TOKEN_LIMIT=64;

function replacementCount(value){const number=Math.trunc(Number(value));return Number.isFinite(number)?Math.max(1,Math.min(100,number)):1}

// The hunks a replace_text call asks for, in order: [{label,oldText,newText,expected}]. label is null for the single-pair form,
// so its messages read as they always have, and "edits[i]" for an edits list.
// Models often send every field of the schema, so the other form's fields count only when they say something: an empty
// edits list beside old_text is the single form, and empty old_text/new_text or expected_replacements 1 beside an edits
// list is the list form.
const filled=value=>value!==undefined&&value!==null&&value!=="";
export function replaceTextHunks(args={}){
  const source=args&&typeof args==="object"&&!Array.isArray(args)?args:{};
  const editsGiven=Array.isArray(source.edits)?source.edits.length>0||!filled(source.old_text):filled(source.edits);
  if(editsGiven){
    if(filled(source.old_text)||filled(source.new_text)||(filled(source.expected_replacements)&&Number(source.expected_replacements)!==1))throw new Error("Use either old_text/new_text or edits, not both; put expected_replacements inside each edit. No changes were written.");
    if(!Array.isArray(source.edits)||!source.edits.length)throw new Error("edits must be a non-empty list of {old_text, new_text}. No changes were written.");
    if(source.edits.length>REPLACE_TEXT_MAX_EDITS)throw new Error(`edits lists ${source.edits.length} edits; one call takes at most ${REPLACE_TEXT_MAX_EDITS}. No changes were written.`);
    return source.edits.map((edit,index)=>{
      const label=`edits[${index}]`;
      if(!edit||typeof edit!=="object"||Array.isArray(edit))throw new Error(`${label} must be an object with old_text and new_text. No changes were written.`);
      const oldText=String(edit.old_text??"");if(!oldText)throw new Error(`${label}.old_text must not be empty. No changes were written.`);
      return {label,oldText,newText:String(edit.new_text??""),expected:replacementCount(edit.expected_replacements)};
    });
  }
  const oldText=String(source.old_text??"");if(!oldText)throw new Error("old_text must not be empty");
  return [{label:null,oldText,newText:String(source.new_text??""),expected:replacementCount(source.expected_replacements)}];
}

function matchOffsets(text,needle){
  const offsets=[];if(!needle)return offsets;
  for(let index=text.indexOf(needle);index>=0;index=text.indexOf(needle,index+needle.length))offsets.push(index);
  return offsets;
}

// Applies the hunks in order (each to the text the previous ones produced). Throws, naming the hunk and with what the model needs
// to correct it, when a hunk does not match exactly its expected number of times; nothing is written in that case.
export function applyReplaceTextHunks(content,hunks,{path="",maxBytes=Infinity}={}){
  const original=String(content??"");let current=original,replacements=0;
  for(let index=0;index<hunks.length;index++){
    const hunk=hunks[index],offsets=matchOffsets(current,hunk.oldText);
    if(offsets.length!==hunk.expected)throw new Error(replacementFailure({original,current,hunks,hunk,index,offsets,path}));
    current=current.split(hunk.oldText).join(hunk.newText);replacements+=offsets.length;
    if(Number.isFinite(maxBytes)&&Buffer.byteLength(current,"utf8")>maxBytes)throw new Error("Edited file exceeds the 2 MB Native edit limit");
  }
  return {content:current,replacements};
}

function lineStartsOf(text){const starts=[0];for(let index=text.indexOf("\n");index>=0;index=text.indexOf("\n",index+1))starts.push(index+1);return starts}
function lineIndexAt(starts,offset){let low=0,high=starts.length-1;while(low<high){const mid=(low+high+1)>>1;if(starts[mid]<=offset)low=mid;else high=mid-1}return low}
function clip(value,limit){const text=String(value??"");return text.length>limit?text.slice(0,limit)+`…[+${text.length-limit} chars]`:text}
function shownLine(line){return clip(String(line??"").replace(/\r$/,""),REGION_LINE_CHARS)}

// Line numbers in a failed later hunk count the earlier hunks as applied. Where those earlier hunks left the lines above (or
// below) unchanged, the number is the same as in the file on disk; elsewhere it is reported as is, with a note.
function lineNumberMapper(original,current){
  if(original===current)return number=>number;
  const before=original.split("\n"),after=current.split("\n");
  let prefix=0;while(prefix<before.length&&prefix<after.length&&before[prefix]===after[prefix])prefix++;
  let suffix=0;while(suffix<before.length-prefix&&suffix<after.length-prefix&&before[before.length-1-suffix]===after[after.length-1-suffix])suffix++;
  const shift=before.length-after.length;
  return number=>number<=prefix?number:number>after.length-suffix?number+shift:null;
}

function isWhitespaceCode(code){return code===32||(code>=9&&code<=13)||code===160||code===0x1680||(code>=0x2000&&code<=0x200a)||code===0x2028||code===0x2029||code===0x202f||code===0x205f||code===0x3000||code===0xfeff}

// Where needle occurs once whitespace is ignored on both sides: up to four [startOffset,endOffset] pairs in text.
function whitespaceInsensitiveMatches(text,needle){
  const compactNeedle=needle.replace(/\s+/g,"");if(!compactNeedle)return [];
  const compactText=text.replace(/\s+/g,""),starts=[];
  for(let index=compactText.indexOf(compactNeedle);index>=0&&starts.length<4;index=compactText.indexOf(compactNeedle,index+compactNeedle.length))starts.push(index);
  if(!starts.length)return [];
  const targets=[...new Set(starts.flatMap(start=>[start,start+compactNeedle.length-1]))].sort((a,b)=>a-b),offsets=new Map();
  for(let index=0,compactIndex=0,target=0;index<text.length&&target<targets.length;index++){
    if(isWhitespaceCode(text.charCodeAt(index)))continue;
    while(target<targets.length&&targets[target]===compactIndex){offsets.set(targets[target],index);target++}
    compactIndex++;
  }
  return starts.map(start=>[offsets.get(start),offsets.get(start+compactNeedle.length-1)]).filter(([start,end])=>Number.isInteger(start)&&Number.isInteger(end));
}

// The window of the needle's line count that shares the most lines with it (whitespace ignored), when enough of them match.
function lineSimilarityRegion(lines,needle){
  const needleLines=needle.split("\n").map(line=>line.replace(/\s+/g,""));
  while(needleLines.length&&!needleLines[0])needleLines.shift();
  while(needleLines.length&&!needleLines.at(-1))needleLines.pop();
  const wanted=new Map();for(const line of needleLines)if(line)wanted.set(line,(wanted.get(line)||0)+1);
  const significant=[...wanted.values()].reduce((sum,value)=>sum+value,0),size=Math.min(needleLines.length,lines.length);
  if(needleLines.length<2||significant<2||size<1)return null;
  const normalized=lines.map(line=>line.replace(/\s+/g,"")),seen=new Map();let score=0,best=0,bestStart=-1;
  for(let index=0;index<normalized.length;index++){
    const added=normalized[index],want=wanted.get(added);
    if(want){const have=seen.get(added)||0;if(have<want)score++;seen.set(added,have+1)}
    if(index>=size){const removed=normalized[index-size],wantRemoved=wanted.get(removed);if(wantRemoved){const have=seen.get(removed)||0;seen.set(removed,have-1);if(have<=wantRemoved)score--}}
    if(index>=size-1&&score>best){best=score;bestStart=index-size+1}
  }
  return bestStart>=0&&best>=Math.max(2,Math.ceil(significant*.4))?{kind:"lines",start:bestStart,end:bestStart+size-1,matched:best,total:significant}:null;
}

const TOKEN=/[A-Za-z_$][\w$]*|\d+/g;
// The line holding most of the needle's identifiers, with the needle's own line count around it.
function tokenRegion(lines,needle){
  const tokens=[...new Set(needle.match(TOKEN)||[])].filter(token=>token.length>=2).slice(0,TOKEN_LIMIT);if(!tokens.length)return null;
  let best=0,bestLine=-1;
  for(let index=0;index<lines.length;index++){
    const line=lines[index];if(line.length>4000)continue;
    const present=new Set(line.match(TOKEN)||[]);let score=0;for(const token of tokens)if(present.has(token))score++;
    if(score>best){best=score;bestLine=index}
  }
  if(bestLine<0||best<Math.max(1,Math.ceil(tokens.length*.5)))return null;
  const needleLines=needle.split("\n"),found=new Set(lines[bestLine].match(TOKEN)||[]);let offset=0,offsetScore=-1;
  needleLines.forEach((line,index)=>{const own=new Set(line.match(TOKEN)||[]);let score=0;for(const token of own)if(found.has(token))score++;if(score>offsetScore){offsetScore=score;offset=index}});
  const start=Math.max(0,bestLine-offset),end=Math.min(lines.length-1,start+Math.max(1,needleLines.length)-1);
  return {kind:"tokens",start,end,matched:best,total:tokens.length};
}

function numberedRegion(lines,start,end,label){
  const rows=[],count=end-start+1,head=count>REGION_MAX_LINES?REGION_MAX_LINES-8:count;
  for(let index=start;index<start+head;index++)rows.push(`${label(index+1)}| ${shownLine(lines[index])}`);
  if(count>head){rows.push(`… ${count-head-6} more lines …`);for(let index=end-5;index<=end;index++)rows.push(`${label(index+1)}| ${shownLine(lines[index])}`)}
  return rows;
}

function rangeText(start,end){return start===end?`line ${start}`:`lines ${start}-${end}`}

// "crlf" when old_text has bare \n line breaks and the text uses \r\n, "lf" when old_text has \r\n and the text uses bare \n;
// otherwise null. A read through trebell_repo/read_source joins lines with \n, so a CRLF file's exact text is not what it shows.
function lineEndingMismatch(text,needle){
  const bare=/(?:^|[^\r])\n/,needleCrlf=needle.includes("\r\n"),needleBare=bare.test(needle);
  if(needleBare&&!needleCrlf&&text.includes("\r\n"))return "crlf";
  if(needleCrlf&&!needleBare&&bare.test(text)&&!text.includes("\r\n"))return "lf";
  return null;
}
function lineEndingNote(path,ending){
  return ending==="crlf"
    ?`${path} uses CRLF (\\r\\n) line endings and old_text uses LF (\\n); send old_text and new_text with \\r\\n line endings.`
    :`${path} uses LF (\\n) line endings and old_text uses CRLF (\\r\\n); send old_text and new_text with \\n line endings.`;
}

// The earlier hunk after which needle no longer occurs as often as in the original text (counted by occurrences), or -1.
function earlierHunkThatChanged(original,hunks,index,occurrences){
  let text=original,before=occurrences(text);
  for(let earlier=0;earlier<index;earlier++){
    text=text.split(hunks[earlier].oldText).join(hunks[earlier].newText);
    const after=occurrences(text);if(after<before)return earlier;before=after;
  }
  return -1;
}

function replacementFailure({original,current,hunks=[],hunk,index,offsets,path}){
  const count=offsets.length,prefix=hunk.label?hunk.label+": ":"",later=index>0;
  const head=`${prefix}Expected ${hunk.expected} exact replacement${hunk.expected===1?"":"s"} in ${path}, found ${count}. No changes were written${hunk.label?" (edits are all or nothing)":""}.`;
  const lines=current.split("\n"),starts=lineStartsOf(current),mapLine=later?lineNumberMapper(original,current):number=>number;
  let unmapped=false;const label=number=>{const mapped=mapLine(number);if(mapped==null){unmapped=true;return number}return mapped};
  const out=[head];
  const regionsAt=pairs=>pairs.map(([startOffset,endOffset])=>[lineIndexAt(starts,startOffset),lineIndexAt(starts,endOffset)]);
  const alsoAt=others=>others.length?` (also at ${others.map(([start,end])=>rangeText(label(start+1),label(end+1))).join(", ")})`:"";
  // A later hunk written against the file as it is on disk, where an earlier hunk of this call already changed that text.
  const changedEarlier=(matches,exactly)=>{
    if(!later||!matches.length)return null;
    const earlier=earlierHunkThatChanged(original,hunks,index,exactly?text=>matchOffsets(text,hunk.oldText).length:text=>whitespaceInsensitiveMatches(text,hunk.oldText).length);
    if(earlier<0)return null;
    const originalStarts=lineStartsOf(original),[startOffset,endOffset]=matches[0];
    return `old_text matches ${rangeText(lineIndexAt(originalStarts,startOffset)+1,lineIndexAt(originalStarts,endOffset)+1)} of the file${exactly?"":" when whitespace is ignored"}, but ${hunks[earlier].label||"an earlier edit"} already changed that text; put both changes in one hunk, or write this hunk against the text the earlier hunks leave.`;
  };
  const noMatch=()=>{
    const overlapping=changedEarlier(matchOffsets(original,hunk.oldText).map(offset=>[offset,offset+hunk.oldText.length-1]),true);
    if(overlapping)return [overlapping];
    // Line endings are checked before whitespace, so a CRLF region is not offered as "exact" text that lost its \r.
    const ending=lineEndingMismatch(current,hunk.oldText),note=ending?[lineEndingNote(path,ending)]:[];
    const converted=ending==="crlf"?hunk.oldText.replace(/\r?\n/g,"\r\n"):ending==="lf"?hunk.oldText.replace(/\r\n/g,"\n"):null;
    const convertedOffsets=converted?matchOffsets(current,converted):[];
    if(convertedOffsets.length){
      const [first,...others]=regionsAt(convertedOffsets.map(offset=>[offset,offset+converted.length-1]));
      return [`old_text matches ${rangeText(label(first[0]+1),label(first[1]+1))}${alsoAt(others)} except for its line endings: ${note[0]}`];
    }
    const whitespace=whitespaceInsensitiveMatches(current,hunk.oldText);
    if(whitespace.length){
      const [first,...others]=regionsAt(whitespace),carriageReturns=lines.slice(first[0],first[1]+1).some(line=>line.endsWith("\r"));
      return [`old_text matches ${rangeText(label(first[0]+1),label(first[1]+1))} when whitespace is ignored${alsoAt(others)}. ${carriageReturns?"The current text there, without the \\r that ends its lines:":"The exact current text there:"}`,...numberedRegion(lines,first[0],first[1],label),...note];
    }
    const overlappingLoosely=changedEarlier(whitespaceInsensitiveMatches(original,hunk.oldText),false);
    if(overlappingLoosely)return [overlappingLoosely,...note];
    const region=lineSimilarityRegion(lines,hunk.oldText)||tokenRegion(lines,hunk.oldText);
    if(!region)return ["No similar region was found in the file.",...note];
    const evidence=region.kind==="lines"?`${region.matched} of ${region.total} old_text lines match it when whitespace is ignored`:`${region.matched} of ${region.total} names in old_text appear there`;
    return [`Closest region, ${rangeText(label(region.start+1),label(region.end+1))} (${evidence}):`,...numberedRegion(lines,region.start,region.end,label),...note];
  };
  if(count===0)out.push(...noMatch());
  else{
    out.push(count>hunk.expected?`Matches (add nearby text to old_text so it matches ${hunk.expected===1?"once":hunk.expected+" times"}, or set expected_replacements to ${count}):`:`Matches (set expected_replacements to ${count}, or correct old_text):`);
    for(const offset of offsets.slice(0,MATCH_LIST_LIMIT)){
      const lineIndex=lineIndexAt(starts,offset),own=lines[lineIndex]??"";
      let context=null;
      if(!/\S/.test(current.slice(starts[lineIndex],offset)))for(let above=lineIndex-1;above>=Math.max(0,lineIndex-3);above--)if(/\S/.test(lines[above]??"")){context=above;break}
      out.push(context==null?`  line ${label(lineIndex+1)}: ${clip(own.replace(/\r$/,"").trim(),160)}`:`  line ${label(lineIndex+1)}, after line ${label(context+1)}: ${clip(String(lines[context]).replace(/\r$/,"").trim(),160)}`);
    }
    if(count>MATCH_LIST_LIMIT)out.push(`  +${count-MATCH_LIST_LIMIT} more at lines ${offsets.slice(MATCH_LIST_LIMIT).map(offset=>label(lineIndexAt(starts,offset)+1)).join(", ")}`);
  }
  if(unmapped)out.push(`(Line numbers count the edits before ${hunk.label} as applied.)`);
  return out.join("\n");
}

function linesWithTerminators(text){return text?text.match(/[^\n]*\n|[^\n]+$/g)||[]:[]}

// Myers' O(ND) line diff of a[aLow,aHigh) against b[bLow,bHigh): the changed blocks [{aStart,aEnd,bStart,bEnd}], or null when
// the edit distance passes the bound (the caller then shows the whole range as one change). The bound shrinks for long ranges, so
// a whole-file rewrite costs at most about DIFF_WORK_BUDGET line comparisons.
function myersBlocks(a,b,aLow,aHigh,bLow,bHigh){
  const n=aHigh-aLow,m=bHigh-bLow;
  if(!n||!m)return [{aStart:aLow,aEnd:aHigh,bStart:bLow,bEnd:bHigh}];
  const limit=Math.min(n+m,DIFF_MAX_EDIT_DISTANCE,Math.max(64,Math.floor(DIFF_WORK_BUDGET/(n+m)))),offset=limit+1,v=new Int32Array(2*limit+3),trace=[];let found=-1;
  search:for(let d=0;d<=limit;d++){
    trace.push(v.slice(offset-d-1,offset+d+2));
    for(let k=-d;k<=d;k+=2){
      let x=k===-d||(k!==d&&v[offset+k-1]<v[offset+k+1])?v[offset+k+1]:v[offset+k-1]+1,y=x-k;
      while(x<n&&y<m&&a[aLow+x]===b[bLow+y]){x++;y++}
      v[offset+k]=x;
      if(x>=n&&y>=m){found=d;break search}
    }
  }
  if(found<0)return null;
  const deleted=new Uint8Array(n),added=new Uint8Array(m);let x=n,y=m;
  for(let d=found;d>0;d--){
    const before=trace[d],at=k=>before[k+d+1],k=x-y,previousK=k===-d||(k!==d&&at(k-1)<at(k+1))?k+1:k-1,previousX=at(previousK),previousY=previousX-previousK;
    while(x>previousX&&y>previousY){x--;y--}
    if(x===previousX)added[y-1]=1;else deleted[x-1]=1;
    x=previousX;y=previousY;
  }
  const blocks=[];let i=0,j=0;
  while(i<n||j<m){
    if(i<n&&j<m&&!deleted[i]&&!added[j]){i++;j++;continue}
    const aStart=i,bStart=j;
    while((i<n&&deleted[i])||(j<m&&added[j])){while(i<n&&deleted[i])i++;while(j<m&&added[j])j++}
    if(i===aStart&&j===bStart){i++;j++;continue}
    blocks.push({aStart:aLow+aStart,aEnd:aLow+i,bStart:bLow+bStart,bEnd:bLow+j});
  }
  return blocks;
}

function changedBlocks(a,b){
  let start=0;while(start<a.length&&start<b.length&&a[start]===b[start])start++;
  let aEnd=a.length,bEnd=b.length;while(aEnd>start&&bEnd>start&&a[aEnd-1]===b[bEnd-1]){aEnd--;bEnd--}
  if(start===aEnd&&start===bEnd)return [];
  return myersBlocks(a,b,start,aEnd,start,bEnd)??[{aStart:start,aEnd,bStart:start,bEnd}];
}

const CONTROL_KEYWORD=/^(?:if|else|elif|elsif|for|foreach|while|do|switch|case|default|try|catch|except|finally|with|return|match|when|select|using|lock|unless|until|loop|begin|rescue|ensure|throw|raise|new|await|yield|assert|import|from|package|require|include)\b/;
const DEFINITION_KEYWORD=/^(?:(?:export|default|public|private|protected|internal|static|async|abstract|final|override|virtual|inline|extern|unsafe|sealed|partial|open|suspend|declare|local|pub(?:\([^)]*\))?)\s+)*(?:def|defp|defmodule|class|function\*?|func|fun|fn|interface|struct|enum|trait|impl|module|namespace|object|protocol|record|union|sub|proc)\b/;
const CALL_SIGNATURE=/^(?:[\w$<>[\],.?*&:@]+\s+)*[\w$.~:]+\s*\(/;
function indentation(line){return /^[ \t]*/.exec(line)[0].length}
function definitionHeader(trimmed,next){
  if(CONTROL_KEYWORD.test(trimmed))return false;
  if(DEFINITION_KEYWORD.test(trimmed))return true;
  return CALL_SIGNATURE.test(trimmed)&&!/;\s*$/.test(trimmed)&&(trimmed.endsWith("{")||next==="{");
}

// The def/class (or function) line that encloses lines[index], found by climbing to ever smaller indentation; null when the
// change is at the top level or the header is already among the hunk's context lines.
function enclosingHeader(lines,index,targetIndent,visibleFrom){
  let threshold=targetIndent;
  for(let line=index-1;line>=Math.max(0,index-HEADER_SEARCH_LINES)&&threshold>0;line--){
    const text=String(lines[line]??"").replace(/\r?\n$/,""),trimmed=text.trim();
    if(!trimmed||/^[)\]}]/.test(trimmed)||trimmed==="{")continue;
    const indent=indentation(text);if(indent>=threshold)continue;
    let next="";for(let after=line+1;after<lines.length&&after<=line+2;after++){const value=String(lines[after]).trim();if(value){next=value;break}}
    if(definitionHeader(trimmed,next))return line>=visibleFrom?null:clip(trimmed,120);
    threshold=indent;
  }
  return null;
}

function hunkRange(start,length){return length===1?String(start+1):`${length===0?start:start+1},${length}`}
function diffLine(sign,line){return sign+clip(String(line).replace(/\r?\n$/,""),DIFF_LINE_CHARS)}

// A compact unified diff of before -> after: about three lines of context, each hunk header naming the enclosing def/class, long
// added or removed runs shortened, and the whole bounded so a large rewrite cannot flood the model's context.
export function compactReplaceDiff(before,after){
  const a=linesWithTerminators(String(before??"")),b=linesWithTerminators(String(after??"")),blocks=changedBlocks(a,b);
  if(!blocks.length)return "No lines changed.";
  const groups=[];
  for(const block of blocks){const last=groups.at(-1);if(last&&block.aStart-last.at(-1).aEnd<=2*DIFF_CONTEXT_LINES)last.push(block);else groups.push([block])}
  const out=[];
  const push=(sign,line)=>{out.push(diffLine(sign,line));if(!String(line).endsWith("\n"))out.push("\\ No newline at end of file")};
  const pushRun=(sign,lines)=>{
    if(lines.length<=DIFF_RUN_LINES){for(const line of lines)push(sign,line);return}
    for(const line of lines.slice(0,10))push(sign,line);
    out.push(`[Trebell: ${lines.length-13} more ${sign==="+"?"added":"removed"} lines]`);
    for(const line of lines.slice(-3))push(sign,line);
  };
  for(const group of groups){
    const first=group[0],last=group.at(-1),aStart=Math.max(0,first.aStart-DIFF_CONTEXT_LINES),aEnd=Math.min(a.length,last.aEnd+DIFF_CONTEXT_LINES);
    const bStart=first.bStart-(first.aStart-aStart),bEnd=last.bEnd+(aEnd-last.aEnd);
    const changed=[...b.slice(first.bStart,first.bEnd),...a.slice(first.aStart,first.aEnd)].find(line=>String(line).trim());
    const header=changed==null?null:enclosingHeader(b,first.bStart,indentation(changed),bStart);
    out.push(`@@ -${hunkRange(aStart,aEnd-aStart)} +${hunkRange(bStart,bEnd-bStart)} @@${header?" "+header:""}`);
    let index=aStart;
    for(const block of group){
      for(;index<block.aStart;index++)push(" ",a[index]);
      pushRun("-",a.slice(block.aStart,block.aEnd));pushRun("+",b.slice(block.bStart,block.bEnd));
      index=block.aEnd;
    }
    for(;index<aEnd;index++)push(" ",a[index]);
  }
  let chars=0,kept=0;
  for(;kept<out.length&&kept<DIFF_MAX_LINES;kept++){chars+=out[kept].length+1;if(chars>DIFF_MAX_CHARS)break}
  return kept<out.length?[...out.slice(0,kept),`[Trebell: diff truncated; ${out.length-kept} more diff lines. Read the file for the rest.]`].join("\n"):out.join("\n");
}
