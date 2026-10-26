// The punctuation that ends a word and is not part of it: a full stop, a comma, a closing bracket or quote ('@log.', '(see @log)').
const WORD_END=".,;:!?)]}\"'`”’»…";
// The @ word a pick puts a file in: its path after the @, its spaces kept, one each.
const fileWord=path=>"@"+String(path||"").trim().replace(/\s+/g," ");
export function fileMentionAt(text,caret){
  const value=String(text||"");const at=Math.max(0,Math.min(value.length,Number(caret)||0));
  const prefix=value.slice(0,at);const match=prefix.match(/(^|\s)@([^\s@]*)$/);
  if(!match)return null;
  // The menu looks for what is typed before the caret, and a pick replaces the whole word (but on a word that goes on past the picked
  // file's path, pickedFileMention), up to the next whitespace but for the punctuation that ends it, which stays.
  const query=match[2]||"";let end=at+value.slice(at).search(/\s|$/);
  while(end>at&&WORD_END.includes(value[end-1]))end--;
  return {start:at-query.length-1,end,query};
}

// Whether text names the file at path from its @ at start as a pick puts it there (its spaces kept, one each), up to whitespace or the
// end but for the punctuation that ends a word: the path of a file with a space in its name goes on past the @ word at a caret in its
// first part, which ends at the space ('@docs/Release' of '@docs/Release Notes.md'). A word that goes on past the path, the space after
// it erased ('@src/login.jsnow'), names it at a caret in the path or right after it.
export function namesFileAt(text,start,path,caret){
  const value=String(text||""),word=fileWord(path);let end=start+word.length;
  if(word.length<2||!value.startsWith(word,start))return false;
  while(end<value.length&&WORD_END.includes(value[end]))end++;
  return end===value.length||/\s/.test(value[end])||caret<=end;
}

// The files the @ menu offers on the @ word from start to end (fileMentionAt's), of those found (items): those the search for the word
// as it reads (query, its part before the caret) finds by its rule (workspace.mjs: the query's letters and digits in order in the file's
// path, which ends with its name, or, with none of them, the query in it), but a file on the draft (paths: its chips' paths) that the
// word begins with, which a pick there would only put in again, and on such a word only those the search finds for the whole word. The
// files found for a word stay until the search for the word as it is then answers, so on a word typed on glued to the file
// ('@src/login.jsnow', or End, ArrowRight or a click into 'now') the menu offered the file found for its path, and Enter imported it a
// second time instead of sending, or a file found for an earlier word that the word no longer names (src/login.json found for the path,
// src/logout.js for '@src/l'), which Enter imported over the whole word. The part before a caret in the letters after the path names
// files the whole word does not ('src/login.jsn' after one ArrowRight or a click after 'n', src/login.json), and Enter imported those.
const searchText=value=>String(value||"").toLowerCase().replace(/\\/g,"/");
export function offeredFileMentions(items,text,start,paths,query,end){
  const value=String(text||""),on=new Set((paths||[]).filter(path=>{const word=fileWord(path);return word.length>1&&value.startsWith(word,start)})),needle=searchText(on.size?value.slice(start+1,end):query),letters=needle.replace(/[^a-z0-9]/g,"");
  const finds=path=>{path=searchText(path);let at=0;for(const c of path)if(c===letters[at])at++;return letters?at===letters.length:path.includes(needle)};
  return on.size||needle?(items||[]).filter(item=>{const path=item?.relativePath||item?.path;return !on.has(path)&&finds(path)}):items||[];
}

// The part of the @ word at mention (fileMentionAt's) that a file picked from the menu goes on, label its path: the whole word, or the
// path only on a word that goes on past it ('@src/login.jsnow'), what follows it then staying after it, unless the whole word begins
// the path of a file found for it (found), whose name it is then part of ('@src/login.json', '@Dockerfile.dev'), and which the pick
// replaces whole. The path of a file with a space in its name goes on past the @ word at a caret in its first part: the pick goes on it.
export function pickedFileMention(text,mention,label,found=[]){
  const value=String(text||""),word=fileWord(label);if(!mention||word.length<2||!value.startsWith(word,mention.start))return mention;
  const end=mention.start+word.length,whole=value.slice(mention.start+1,mention.end).toLowerCase();
  return end<mention.end&&(found||[]).some(item=>String(item?.relativePath||item?.path||"").toLowerCase().startsWith(whole))?mention:{...mention,end};
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
