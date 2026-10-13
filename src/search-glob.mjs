// Glob filters for the repository search tools (search_code, search_symbols, search_files), with ripgrep's --glob
// reading: a glob without a slash matches a file name at any depth (*.py), and one with a slash matches the
// repository-relative path (src/**/*.ts), or the path inside the searched folder when the search is scoped. ** spans
// folders, * and ? stay inside one, [...] and [!...] are character classes, {a,b} are alternatives, a trailing slash
// means everything under a folder, a leading slash anchors at the root, and a leading ! excludes. Backslashes are read as
// folder separators, so [[] is how a literal bracket is written. Matching is case-sensitive and runs in time linear in
// the path for each part of the glob, so no glob can stall a search.

const MAX_GLOB_CHARS=500,MAX_ALTERNATIVES=64;

function braceGroup(text){
  for(let start=text.indexOf("{");start>=0;start=text.indexOf("{",start+1)){
    const parts=[];let depth=0,last=start+1;
    for(let index=start;index<text.length;index++){
      const char=text[index];
      if(char==="{")depth++;
      else if(char===","&&depth===1){parts.push(text.slice(last,index));last=index+1}
      else if(char==="}"&&--depth===0){
        parts.push(text.slice(last,index));
        if(parts.length>1)return {start,end:index,parts};
        break;
      }
    }
  }
  return null;
}

function expandBraces(pattern){
  const results=[];
  const expand=text=>{
    const group=braceGroup(text);
    if(!group){
      if(results.length>=MAX_ALTERNATIVES)throw new Error(`Search glob has more than ${MAX_ALTERNATIVES} {…} alternatives`);
      results.push(text);return;
    }
    for(const part of group.parts)expand(text.slice(0,group.start)+part+text.slice(group.end+1));
  };
  expand(pattern);
  return results;
}

function characterClass(pattern,start){
  let index=start+1,negated=false;
  if(pattern[index]==="!"||pattern[index]==="^"){negated=true;index++}
  const ranges=[];
  for(let first=true;index<pattern.length;index++,first=false){
    const char=pattern[index];
    if(char==="]"&&!first)return {token:{type:"class",negated,ranges},end:index+1};
    if(pattern[index+1]==="-"&&index+2<pattern.length&&pattern[index+2]!=="]"){ranges.push([char,pattern[index+2]]);index+=2}
    else ranges.push([char,char]);
  }
  return null;
}

function tokens(pattern){
  const out=[];
  for(let index=0;index<pattern.length;){
    const char=pattern[index];
    if(char==="*"){
      let end=index;while(pattern[end]==="*")end++;
      const wholeSegment=end-index>=2&&(index===0||pattern[index-1]==="/")&&(end===pattern.length||pattern[end]==="/");
      if(wholeSegment&&end<pattern.length){out.push({type:"folders"});index=end+1;continue}
      out.push({type:wholeSegment?"rest":"star"});index=end;continue;
    }
    if(char==="?"){out.push({type:"one"});index++;continue}
    if(char==="["){const parsed=characterClass(pattern,index);if(parsed){out.push(parsed.token);index=parsed.end;continue}}
    out.push({type:"literal",char});index++;
  }
  return out;
}

function classMatches(token,char){
  if(char==="/")return false;
  const hit=token.ranges.some(([from,to])=>char>=from&&char<=to);
  return token.negated?!hit:hit;
}

// Every position of text the glob's parts can reach, one part at a time (an NFA run without backtracking).
function matches(parts,text){
  const length=text.length;let reach=new Uint8Array(length+1);reach[0]=1;
  for(const part of parts){
    const next=new Uint8Array(length+1);let any=false;
    if(part.type==="star"){
      for(let index=0,active=false;index<=length;index++){
        if(reach[index])active=true;
        if(active){next[index]=1;any=true}
        if(text[index]==="/")active=false;
      }
    }else if(part.type==="rest"){
      for(let index=0,active=false;index<=length;index++){if(reach[index])active=true;if(active){next[index]=1;any=true}}
    }else if(part.type==="folders"){
      for(let index=0,active=false;index<=length;index++){
        if(active&&text[index-1]==="/"){next[index]=1;any=true}
        if(reach[index]){next[index]=1;any=true;active=true}
      }
    }else{
      for(let index=0;index<length;index++){
        if(!reach[index])continue;
        const char=text[index];
        const ok=part.type==="literal"?char===part.char:part.type==="one"?char!=="/":classMatches(part,char);
        if(ok){next[index+1]=1;any=true}
      }
    }
    if(!any)return false;
    reach=next;
  }
  return reach[length]===1;
}

export function compileSearchGlob(value){
  const original=String(value??"").trim();
  let text=original,negated=false;
  if(text.startsWith("!")){negated=true;text=text.slice(1).trim()}
  text=text.replace(/\\/g,"/");
  if(text.length>MAX_GLOB_CHARS)throw new Error(`Search glob is longer than ${MAX_GLOB_CHARS} characters`);
  let anchored=false;
  if(/^(?:\.\/|\/)/.test(text)){anchored=true;text=text.replace(/^(?:\.\/|\/)+/,"")}
  if(text.endsWith("/"))text+="**";
  if(!text)throw new Error("Search glob is empty");
  const alternatives=expandBraces(text).map(pattern=>({pathGlob:anchored||pattern.includes("/"),parts:tokens(pattern)}));
  return Object.freeze({
    glob:original,
    // path: repository-relative. scope: the searched folder, if any; a glob with a slash also matches inside it.
    test(path,scope=null){
      const normalized=String(path??"").replace(/\\/g,"/").replace(/^\.\//,""),name=normalized.slice(normalized.lastIndexOf("/")+1);
      const folder=scope?String(scope).replace(/\\/g,"/").replace(/^\.\//,"").replace(/\/+$/,""):"";
      const inside=folder&&normalized.startsWith(folder+"/")?normalized.slice(folder.length+1):null;
      const hit=alternatives.some(item=>item.pathGlob?matches(item.parts,normalized)||(inside!=null&&matches(item.parts,inside)):matches(item.parts,name));
      return negated?!hit:hit;
    },
  });
}
