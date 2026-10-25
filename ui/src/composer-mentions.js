export function fileMentionAt(text,caret){
  const value=String(text||"");const at=Math.max(0,Math.min(value.length,Number(caret)||0));
  const prefix=value.slice(0,at);const match=prefix.match(/(^|\s)@([^\s@]*)$/);
  if(!match)return null;
  // The menu looks for what is typed before the caret, and a pick replaces the whole word, up to the next whitespace but for the
  // punctuation that ends it, which stays: a full stop, a comma, a closing bracket or quote ('@log.', '(see @log)').
  const query=match[2]||"";let end=at+value.slice(at).search(/\s|$/);
  while(end>at&&".,;:!?)]}\"'`”’»…".includes(value[end-1]))end--;
  return {start:at-query.length-1,end,query};
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
// leaves no word to put the file on (null). An insertion or removal that fits more than one place (a g typed by a g) is put at the caret,
// or, with the caret moved off it meanwhile (Home, a click), where it leaves the word whole if it fits there: ' then debug' typed after
// '@log' fits after its g and before it. Edits on both sides of the word (letters typed after it, then before it) read as one over it,
// so the word is then looked for, whole, in what changed, where most of what was around it is kept (a word typed twice), what changed
// taken to start before the word and end after it when its own letters are at its ends ('Please ' and ' then debug' around '@log'): a
// word edited or gone meanwhile is not found.
export function movedFileMention(from,mention,text,caret){
  const a=String(from||""),b=String(text||""),min=Math.min(a.length,b.length),shift=b.length-a.length;if(!mention||a===b)return mention;
  const {start,end}=mention,word=a.slice(start,end);let p=0,s=0;while(p<min&&a[p]===b[p])p++;while(s<min&&a[a.length-1-s]===b[b.length-1-s])s++;
  if(p+s>=min){
    const lo=min-s,hi=p,c=(caret??b.length)-Math.max(0,shift),fore=Math.min(hi,start+Math.min(0,shift)),aft=Math.max(lo,end);
    p=c>=lo&&c<=hi?c:(c<lo?[fore,aft]:[aft,fore]).find(q=>q>=lo&&q<=hi)??Math.max(lo,Math.min(hi,c));s=min-p;
  }else if(a.length-s>start&&p<end){p=Math.min(p,start);s=Math.min(s,a.length-end)}
  if(a.length-s<=start)return {...mention,start:start+shift,end:end+shift};if(p>=end)return mention;
  const kept=i=>{let l=0,r=0;while(l<i&&l<400&&b[i-1-l]===a[start-1-l])l++;while(r<400&&i+word.length+r<b.length&&b[i+word.length+r]===a[end+r])r++;return l+r};
  let at=-1,most=-1;if(p<=start&&a.length-s>=end)for(let i=b.indexOf(word,p),k;i>=0&&i+word.length<=b.length-s;i=b.indexOf(word,i+1))if((k=kept(i))>most){most=k;at=i}
  return at<0?null:{...mention,start:at,end:at+word.length};
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
