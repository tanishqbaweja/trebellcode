// The text a model reads for search_code, search_symbols and search_files: hits grouped by file, the path written once
// and then "line: text" for each hit, with no per-file cap. Hits the limit cut stay listed by line number under their
// file ("+2 more at 1468, 1472"), and a header counts everything found, so no pointer is lost and the per-hit JSON keys
// that repeat each path are gone. It also reads results without the newer fields (totals, overflow), as logged before
// the format existed. Any other tool, or a value that is not a result object, gets null.

const HIT_TEXT_CHARS=240,HIT_TEXT_SLACK=20,UNREAD_FILE_NAMES=20;

function plural(count,one,many){return `${count} ${count===1?one:many}`}
function list(value){return Array.isArray(value)?value:[]}
function finite(value){return value!=null&&value!==""&&Number.isFinite(Number(value))}

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

// Files in the order they first appear (shown hits, then files with only line numbers left), hits by line within a file.
function groupedByFile(data,more,textOf){
  const groups=new Map(),group=path=>{let entry=groups.get(path);if(!entry){entry={hits:[],more:null};groups.set(path,entry)}return entry};
  for(const item of data)if(item&&item.path!=null)group(String(item.path)).hits.push({line:Number(item.line),text:textOf(item)});
  for(const item of more)if(item&&item.path!=null)group(String(item.path)).more=item;
  const lines=[];let partial=false;
  for(const [path,entry] of groups){
    lines.push(path);
    for(const hit of entry.hits.sort((a,b)=>a.line-b.line))lines.push(`  ${hit.line}: ${hit.text}`);
    if(entry.more){
      const count=Math.max(0,Math.trunc(Number(entry.more.count)||0)),listed=list(entry.more.lines);
      if(listed.length<count)partial=true;
      lines.push(`  +${count} more`+(listed.length?" at "+listed.join(", ")+(listed.length<count?", …":""):""));
    }
  }
  return {lines,files:groups.size,partial};
}

function leftOver(more){return more.reduce((sum,item)=>sum+Math.max(0,Math.trunc(Number(item?.count)||0)),0)}

function formatCode(result){
  const data=list(result.data),more=list(result.more),suffix=scopeSuffix(result);
  const grouped=groupedByFile(data,more,item=>hitText(item.text));
  const total=finite(result.totalMatches)?Number(result.totalMatches):data.length+leftOver(more);
  const files=finite(result.matchedFiles)?Number(result.matchedFiles):grouped.files;
  const out=[total
    ?`${plural(total,"match","matches")} in ${plural(files,"file","files")}${suffix}${data.length<total?`; ${data.length} shown with text, the rest by line number`:""}`
    :`No matches${suffix}.`];
  if(result.regexFallback)out.push(`Not a valid regular expression (${result.regexFallback}), so this is a literal text search.`);
  if(result.source==="index-sample")out.push("Git grep was unavailable, so only indexed source was searched; results may be incomplete.");
  out.push(...grouped.lines);
  if(grouped.partial)out.push("Not every line number is listed; narrow with path or glob to see them all.");
  const unread=list(result.unreadFiles).map(String),unreadCount=finite(result.unreadFileCount)?Number(result.unreadFileCount):unread.length;
  if(unreadCount>0){
    const names=unread.slice(0,UNREAD_FILE_NAMES);
    out.push(`${plural(unreadCount,"more matching file","more matching files")} not searched line by line`+(names.length?": "+names.join(", ")+(unreadCount>names.length?`, +${unreadCount-names.length} more`:""):"")+". Narrow with path or glob to see their matches.");
  }
  if(result.listingCapped)out.push("More files match than were listed; narrow with path or glob.");
  const skipped=Math.max(0,Math.trunc(Number(result.skippedLargeFiles)||0));
  if(skipped)out.push(`${plural(skipped,"matching file was","matching files were")} too large to read.`);
  if(result.truncated===true&&!more.length&&!unreadCount&&!result.listingCapped&&!skipped&&result.source!=="index-sample")out.push("More matches may exist; narrow with path or glob.");
  return out.join("\n");
}

function formatSymbols(result){
  const data=list(result.data),more=list(result.more),suffix=scopeSuffix(result);
  const grouped=groupedByFile(data,more,item=>hitText(item.signature||[item.kind,item.name].filter(Boolean).join(" ")));
  const total=finite(result.totalMatches)?Number(result.totalMatches):data.length+leftOver(more);
  if(!total)return `No definitions${suffix}.`;
  const out=[`${plural(total,"definition","definitions")} in ${plural(grouped.files,"file","files")}${suffix}${data.length<total?`; ${data.length} shown with text, the rest by line number`:""}`,...grouped.lines];
  if(grouped.partial)out.push("Not every line number is listed; narrow with path or glob to see them all.");
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
