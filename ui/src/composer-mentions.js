export function fileMentionAt(text,caret){
  const value=String(text||"");const at=Math.max(0,Math.min(value.length,Number(caret)||0));
  const prefix=value.slice(0,at);const match=prefix.match(/(^|\s)@([^\s@]*)$/);
  if(!match)return null;
  // The menu looks for what is typed before the caret, and a pick replaces the whole word, up to the next whitespace.
  const query=match[2]||"";const start=at-query.length-1,end=at+value.slice(at).search(/\s|$/);
  return {start,end,query};
}

// caret: where the person's caret is in text, which stays before the word, moves with what follows it, and goes after the file in it.
export function applyFileMention(text,mention,label,caret=mention?.end){
  const value=String(text||"");if(!mention)return {text:value,caret:value.length};
  const safe=String(label||"").trim().replace(/\s+/g," ");
  const nextChar=value[mention.end]||"";
  const replacement=safe?`@${safe}${nextChar&&/\s/.test(nextChar)?"":" "}`:"";
  const next=value.slice(0,mention.start)+replacement+value.slice(mention.end);
  return {text:next,caret:caret<=mention.start?caret:Math.max(caret,mention.end)+next.length-value.length};
}

// The word a file was picked on (mention, in from: the draft at the pick) in the draft as it is once the file is in (text, its caret at
// caret), the person having typed on meanwhile: an edit before the word moves it and one after it leaves it, while one in it or over it
// leaves no word to put the file on (null). An insertion or removal that fits more than one place (a g typed by a g) is put at the caret.
export function movedFileMention(from,mention,text,caret){
  const a=String(from||""),b=String(text||""),min=Math.min(a.length,b.length),shift=b.length-a.length;if(!mention||a===b)return mention;
  let p=0,s=0;while(p<min&&a[p]===b[p])p++;while(s<min&&a[a.length-1-s]===b[b.length-1-s])s++;
  if(p+s>=min){p=Math.max(min-s,Math.min(p,(caret??b.length)-Math.max(0,shift)));s=min-p}
  return a.length-s<=mention.start?{...mention,start:mention.start+shift,end:mention.end+shift}:p>=mention.end?mention:null;
}

export function rankFileMentions(items,query,{limit=8}={}){
  const needle=String(query||"").trim().toLowerCase();
  return [...(items||[])].sort((a,b)=>{
    const an=String(a.name||"").toLowerCase(),bn=String(b.name||"").toLowerCase();
    const ar=String(a.relativePath||a.path||"").toLowerCase(),br=String(b.relativePath||b.path||"").toLowerCase();
    const score=(name,path)=>name===needle?0:name.startsWith(needle)?1:path.startsWith(needle)?2:name.includes(needle)?3:4;
    return score(an,ar)-score(bn,br)||ar.length-br.length||ar.localeCompare(br);
  }).slice(0,limit);
}
