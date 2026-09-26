export function fileMentionAt(text,caret){
  const value=String(text||"");const end=Math.max(0,Math.min(value.length,Number(caret)||0));
  const prefix=value.slice(0,end);const match=prefix.match(/(^|\s)@([^\s@]*)$/);
  if(!match)return null;
  const query=match[2]||"";const start=end-query.length-1;
  return {start,end,query};
}

export function applyFileMention(text,mention,label){
  const value=String(text||"");if(!mention)return {text:value,caret:value.length};
  const safe=String(label||"").trim().replace(/\s+/g," ");
  const nextChar=value[mention.end]||"";
  const replacement=safe?`@${safe}${nextChar&&/\s/.test(nextChar)?"":" "}`:"";
  const next=value.slice(0,mention.start)+replacement+value.slice(mention.end);
  return {text:next,caret:mention.start+replacement.length};
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
