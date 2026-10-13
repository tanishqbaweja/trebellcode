// The text a model reads for search_code, search_symbols and search_files: hits grouped by file, the path written once
// and then "line: text" for each hit, with no per-file cap. Hits the limit cut stay listed by line number under their
// file ("+2 more at 1468, 1472"), and a header counts everything found, so no pointer is lost and the per-hit JSON keys
// that repeat each path are gone. It also reads results without the newer fields (totals, overflow), as logged before
// the format existed. Any other tool, or a value that is not a result object, gets null.

const HIT_TEXT_CHARS=240,HIT_TEXT_SLACK=20,UNREAD_FILE_NAMES=20,SUMMARY_FILE_NAMES=3;
// The model reads a result whole only while it stays within the tool output store's 16 KB hot bound; past it, the result
// becomes a 3,600-character preview behind a handle, which hides most of the hits shown with text. So what is listed by line
// number (the "+N more at" lines, files with no hit shown, and unread files) shares OVERFLOW_BYTES, and never takes more than
// keeps the whole text within TEXT_BYTES. Definition line numbers go first and may use all of TEXT_BYTES; then the other line
// numbers of files with hits shown (the file the limit cut first); then files with only line numbers, in order. Files that do
// not fit are counted, and a few of them are named. 1 KB holds about 150 line numbers: over the ranks 290-321 searches whose
// results were cut, a full 4 KB listing made the text up to 2x what arm A sent, against at most 1.05x at 1 KB.
const OVERFLOW_BYTES=1024,TEXT_BYTES=15*1024,PARTIAL_SUFFIX_BYTES=5;
const PARTIAL_NOTE="Not every line number is listed; narrow with path or glob to see them all.";

function plural(count,one,many){return `${count} ${count===1?one:many}`}
function list(value){return Array.isArray(value)?value:[]}
function finite(value){return value!=null&&value!==""&&Number.isFinite(Number(value))}
const encoder=new TextEncoder();
function textBytes(value){return encoder.encode(String(value)).length}
function lineBytes(value){return textBytes(value)+1}

function scopeSuffix(result){
  const parts=[];
  if(result.path)parts.push("path: "+result.path);
  if(result.glob)parts.push("glob: "+result.glob);
  return parts.length?" ("+parts.join(", ")+")":"";
}

function hitText(value){
  const text=String(value??"").replace(/\s+$/,"");
  return text.length>HIT_TEXT_CHARS+HIT_TEXT_SLACK?text.slice(0,HIT_TEXT_CHARS)+"…":text;
}

function lineNumbers(value){return [...new Set(list(value).map(Number).filter(Number.isFinite))].sort((a,b)=>a-b)}

// Files in the order they first appear (shown hits, then files with only line numbers left), hits by line within a file.
// fixedBytes: what the rest of the text takes, so the line-number part can be fitted around it. Returns the lines, whether
// any line number was left out, and the overflow budget left (for naming unread files).
function groupedByFile(data,more,textOf,fixedBytes){
  const groups=new Map(),group=path=>{let entry=groups.get(path);if(!entry){entry={path,hits:[],more:false,count:0,lines:[],definitions:new Set()};groups.set(path,entry)}return entry};
  for(const item of data)if(item&&item.path!=null)group(String(item.path)).hits.push({line:Number(item.line),text:textOf(item)});
  for(const item of more)if(item&&item.path!=null){
    const entry=group(String(item.path));
    entry.more=true;entry.count=Math.max(0,Math.trunc(Number(item.count)||0));entry.lines=lineNumbers(item.lines);entry.definitions=new Set(lineNumbers(item.definitions));
  }
  const entries=[...groups.values()],shown=entries.filter(entry=>entry.hits.length),only=entries.filter(entry=>!entry.hits.length&&entry.more);
  for(const entry of shown)entry.hits.sort((a,b)=>a.line-b.line);
  const countLine=entry=>`  +${entry.count} more`;
  // Always written: each file with hits shown, its hits, and its "+N more" count.
  let base=0;
  for(const entry of shown){
    base+=lineBytes(entry.path);for(const hit of entry.hits)base+=lineBytes(`  ${hit.line}: ${hit.text}`);
    if(entry.more)base+=lineBytes(countLine(entry))+PARTIAL_SUFFIX_BYTES;
  }
  // Room kept for the line that counts the files left out, naming a few of them.
  const longest=only.reduce((most,entry)=>Math.max(most,Math.min(400,textBytes(entry.path))),0),summaryReserve=only.length?SUMMARY_FILE_NAMES*(longest+2)+120:0;
  let textLeft=Math.max(0,TEXT_BYTES-fixedBytes-base-summaryReserve),overflowLeft=Math.min(OVERFLOW_BYTES,textLeft);
  const listed=new Map(entries.map(entry=>[entry,[]])),included=new Set(shown);
  const spend=(cost,definition)=>{if(cost>textLeft||(!definition&&cost>overflowLeft))return false;textLeft-=cost;overflowLeft-=cost;return true};
  const include=(entry,definition=false)=>{
    if(included.has(entry))return true;
    if(!spend(lineBytes(entry.path)+lineBytes(countLine(entry))+PARTIAL_SUFFIX_BYTES,definition))return false;
    included.add(entry);return true;
  };
  const add=(entry,number,definition=false)=>{
    if(!include(entry,definition)||!spend(String(number).length+(listed.get(entry).length?2:4),definition))return false;
    listed.get(entry).push(number);return true;
  };
  for(const entry of entries)for(const number of entry.lines)if(entry.definitions.has(number))add(entry,number,true);
  for(const entry of shown)for(const number of entry.lines)if(!entry.definitions.has(number)&&!add(entry,number))break;
  let full=false;
  for(const entry of only){
    if(full)break;
    if(!include(entry)){full=true;break}
    for(const number of entry.lines)if(!entry.definitions.has(number)&&!add(entry,number)){full=true;break}
  }
  const lines=[];let partial=false;
  for(const entry of entries){
    if(!included.has(entry))continue;
    lines.push(entry.path);
    for(const hit of entry.hits)lines.push(`  ${hit.line}: ${hit.text}`);
    if(!entry.more)continue;
    const numbers=listed.get(entry).sort((a,b)=>a-b);
    if(numbers.length<entry.count)partial=true;
    lines.push(countLine(entry)+(numbers.length?" at "+numbers.join(", ")+(numbers.length<entry.count?", …":""):""));
  }
  const omitted=only.filter(entry=>!included.has(entry));
  if(omitted.length){
    partial=true;
    const names=omitted.slice(0,SUMMARY_FILE_NAMES).map(entry=>entry.path),matches=omitted.reduce((sum,entry)=>sum+entry.count,0);
    lines.push(`${plural(omitted.length,"more file","more files")} with ${plural(matches,"match","matches")} by line number, not listed here: ${names.join(", ")}${omitted.length>names.length?`, +${omitted.length-names.length} more`:""}.`);
  }
  return {lines,files:groups.size,partial,overflowLeft:Math.max(0,overflowLeft)};
}

function leftOver(more){return more.reduce((sum,item)=>sum+Math.max(0,Math.trunc(Number(item?.count)||0)),0)}

// Unread files, in the order the search listed them: the first few always named (their room is kept with the fixed text), then
// more while the overflow budget lasts, up to UNREAD_FILE_NAMES.
function unreadLine(unread,count,budget){
  const names=unread.slice(0,SUMMARY_FILE_NAMES);let left=budget;
  for(const name of unread.slice(SUMMARY_FILE_NAMES,UNREAD_FILE_NAMES)){const cost=textBytes(name)+2;if(cost>left)break;names.push(name);left-=cost}
  return `${plural(count,"more matching file","more matching files")} not searched line by line`+(names.length?": "+names.join(", ")+(count>names.length?`, +${count-names.length} more`:""):"")+". Narrow with path or glob to see their matches.";
}

function formatCode(result){
  const data=list(result.data),more=list(result.more),suffix=scopeSuffix(result);
  const total=finite(result.totalMatches)?Number(result.totalMatches):data.length+leftOver(more);
  const files=finite(result.matchedFiles)?Number(result.matchedFiles):new Set([...data,...more].map(item=>item?.path).filter(path=>path!=null)).size;
  const head=[total
    ?`${plural(total,"match","matches")} in ${plural(files,"file","files")}${suffix}${data.length<total?`; ${data.length} shown with text, the rest by line number`:""}`
    :`No matches${suffix}.`];
  if(result.regexFallback)head.push(`Not a valid regular expression (${result.regexFallback}), so this is a literal text search.`);
  if(result.source==="index-sample")head.push("Git grep was unavailable, so only indexed source was searched; results may be incomplete.");
  const unread=list(result.unreadFiles).map(String),unreadCount=finite(result.unreadFileCount)?Number(result.unreadFileCount):unread.length;
  const tail=[];
  if(result.listingCapped)tail.push("More files match than were listed; narrow with path or glob.");
  const skipped=Math.max(0,Math.trunc(Number(result.skippedLargeFiles)||0));
  if(skipped)tail.push(`${plural(skipped,"matching file was","matching files were")} too large to read.`);
  if(result.truncated===true&&!more.length&&!unreadCount&&!result.listingCapped&&!skipped&&result.source!=="index-sample")tail.push("More matches may exist; narrow with path or glob.");
  const fixed=[...head,...tail].reduce((sum,line)=>sum+lineBytes(line),0)+(more.length?lineBytes(PARTIAL_NOTE):0)+(unreadCount>0?lineBytes(unreadLine(unread,unreadCount,0)):0);
  const grouped=groupedByFile(data,more,item=>hitText(item.text),fixed);
  const out=[...head,...grouped.lines];
  if(grouped.partial)out.push(PARTIAL_NOTE);
  if(unreadCount>0)out.push(unreadLine(unread,unreadCount,grouped.overflowLeft));
  out.push(...tail);
  return out.join("\n");
}

function formatSymbols(result){
  const data=list(result.data),more=list(result.more),suffix=scopeSuffix(result);
  const total=finite(result.totalMatches)?Number(result.totalMatches):data.length+leftOver(more);
  if(!total)return `No definitions${suffix}.`;
  const fileCount=new Set([...data,...more].map(item=>item?.path).filter(path=>path!=null).map(String)).size;
  const header=`${plural(total,"definition","definitions")} in ${plural(fileCount,"file","files")}${suffix}${data.length<total?`; ${data.length} shown with text, the rest by line number`:""}`;
  const grouped=groupedByFile(data,more,item=>hitText(item.signature||[item.kind,item.name].filter(Boolean).join(" ")),lineBytes(header)+(more.length?lineBytes(PARTIAL_NOTE):0));
  const out=[header,...grouped.lines];
  if(grouped.partial)out.push(PARTIAL_NOTE);
  return out.join("\n");
}

function formatFiles(result){
  const data=list(result.data),suffix=scopeSuffix(result),total=finite(result.totalMatches)?Number(result.totalMatches):data.length;
  if(!total)return `No matching files${suffix}.`;
  return [`${plural(total,"matching file","matching files")}${suffix}${data.length<total?`; ${data.length} shown, narrow with path or glob to see the rest`:""}`,...data.map(item=>String(item?.path??""))].join("\n");
}

export function formatRepositorySearchResult(name,result){
  if(!result||typeof result!=="object"||Array.isArray(result))return null;
  if(name==="search_code")return formatCode(result);
  if(name==="search_symbols")return formatSymbols(result);
  if(name==="search_files")return formatFiles(result);
  return null;
}
