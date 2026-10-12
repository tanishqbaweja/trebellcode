// Display text for the inspector's Files, Diff and Git panels: error banners, git status badges and file paths.

// A banner names the action that failed before the reason the server gave ("Could not open notes.txt: EPERM …"), so a bare
// "EPERM" or "HTTP 500" never arrives without context.
export function actionError(action,error){
  const detail=String(error?.message??error??"").trim();
  return detail?action+": "+detail:action+".";
}
// A reason followed by another sentence ends as a sentence, so "… failed" and the next sentence do not run together. A reason that
// already ends in ".", "!", "?" or "…" (before any closing quote or bracket) is kept as it is; a trailing ",", ";" or ":" gives way
// to the full stop.
export function asSentence(text=""){
  const value=String(text??"").trim();
  if(!value||/[.!?…]["'”’»)\]]*$/.test(value))return value;
  const stripped=value.replace(/[\s,;:]+$/,"");
  return stripped?stripped+".":value;
}
// The same, for a reason that may already name what failed: a harness writer's "OpenCode could not write the Git text: …" is shown
// as it is (`named` matches it), while a bare one such as a Native provider's "fetch failed" gets the action first.
export function actionErrorUnlessNamed(action,error,named){
  const detail=String(error?.message??error??"").trim();
  return detail&&named.test(detail)?detail:actionError(action,error);
}

// git status --short codes (index column, then working-tree column). AA and DD are unmerged too, though they hold no U.
const UNMERGED=new Set(["DD","AU","UD","UA","DU","AA","UU"]);
// One badge per status for the Diff and Git lists. An untracked path reads "N" (new): git's own "??" looks like a placeholder,
// and "U" is git's letter for an unmerged path, which both lists show as a conflict.
export function gitStatusBadge(code=""){
  const compact=String(code??"").replace(/\s+/g,"")||"M";
  if(compact==="??")return {label:"N",kind:"added",title:"Untracked: new, not added to Git yet (git status ??)"};
  if(compact==="!!")return {label:"!!",kind:"ignored",title:"Ignored (git status !!)"};
  if(UNMERGED.has(compact)||compact.includes("U"))return {label:compact,kind:"conflict",title:"Conflict: unmerged changes (git status "+compact+")"};
  const kind=compact.includes("A")?"added":compact.includes("D")?"deleted":/[RC]/.test(compact)?"renamed":"modified";
  const name={added:"Added",deleted:"Deleted",renamed:compact.includes("R")?"Renamed":"Copied",modified:compact.includes("T")&&!compact.includes("M")?"Type changed":"Modified"}[kind];
  return {label:compact,kind,title:name+" (git status "+compact+")"};
}

// git status --short (and --porcelain) C-quotes a path that holds a space, a quote, a backslash, a control character or, by
// default, a non-ASCII letter, whose UTF-8 bytes it writes in octal: New folder/ arrives as "New folder/" and café.txt as
// "caf\303\251.txt". Each side of a rename ("old" -> "new") is quoted on its own. This reads the path text after the status code
// back to the names, keeping the " -> " of a rename; an unquoted path is returned as it is.
const C_ESCAPES={a:7,b:8,t:9,n:10,v:11,f:12,r:13,'"':34,"\\":92};
export function gitStatusPath(text=""){
  const value=String(text??""),parts=[],encoder=new TextEncoder();
  let index=0;
  for(;;){
    if(value[index]==='"'){
      const bytes=[];index++;
      while(index<value.length&&value[index]!=='"'){
        const octal=value[index]==="\\"?/^[0-7]{3}/.exec(value.slice(index+1,index+4)):null,escape=value[index]==="\\"?C_ESCAPES[value[index+1]]:undefined;
        if(octal){bytes.push(parseInt(octal[0],8));index+=4}
        else if(escape!==undefined){bytes.push(escape);index+=2}
        else{const char=String.fromCodePoint(value.codePointAt(index));bytes.push(...encoder.encode(char));index+=char.length}
      }
      parts.push(new TextDecoder().decode(new Uint8Array(bytes)));index++;
    }else{
      const end=value.indexOf(" -> ",index);
      parts.push(value.slice(index,end<0?value.length:end));index=end<0?value.length:end;
    }
    if(!value.startsWith(" -> ",index))break;
    index+=4;
  }
  if(index<value.length)parts[parts.length-1]+=value.slice(index);
  return parts.join(" -> ");
}
// A pull request's checks as a person reads them: each one's name and whether it passed, failed, is still pending or was skipped,
// with the host's own word (`detail`, such as TIMED_OUT) kept for its tooltip. GitHub sends check runs (a status, then a conclusion
// once completed) and commit statuses (a state); GitLab sends its pipeline (a status). Anything not yet finished is pending.
const CHECK_STATES={SUCCESS:"passed",NEUTRAL:"passed",FAILURE:"failed",FAILED:"failed",ERROR:"failed",TIMED_OUT:"failed",CANCELLED:"failed",CANCELED:"failed",ACTION_REQUIRED:"failed",STARTUP_FAILURE:"failed",SKIPPED:"skipped",STALE:"skipped"};
export function pullRequestChecks(rollup=[]){
  return (Array.isArray(rollup)?rollup:[]).filter(Boolean).map(check=>{
    const status=String(check.status||"").toUpperCase(),detail=String(status&&status!=="COMPLETED"?status:check.conclusion||check.state||status).toUpperCase();
    return {name:String(check.name||check.context||(check.id!=null?"Pipeline #"+check.id:"Check")),state:CHECK_STATES[detail]||"pending",detail};
  });
}

// One line of git status --short: its two-letter code and its path, unquoted.
export function gitStatusEntry(line=""){
  const text=String(line??"");
  return {code:text.slice(0,2),path:gitStatusPath(text.slice(3))};
}

// Splits a path before its last `segments` segments, keeping the original separators so dir + sep + name is the path again.
// A trailing separator (git's "folder/" for an untracked folder) stays on the name instead of leaving the name empty.
export function splitPath(path="",segments=1){
  const text=String(path??""),trimmed=text.replace(/[\\/]+$/,""),trailing=text.slice(trimmed.length);
  if(!trimmed)return {dir:"",sep:"",name:text};
  let index=trimmed.length;
  for(let count=0;count<segments&&index>0;count++)index=Math.max(trimmed.lastIndexOf("/",index-1),trimmed.lastIndexOf("\\",index-1));
  if(index<=0)return {dir:"",sep:"",name:text};
  return {dir:trimmed.slice(0,index),sep:trimmed[index],name:trimmed.slice(index+1)+trailing};
}

// Each path split before the fewest trailing segments that tell it apart from the other paths: sibling worktrees under one long
// parent ("…/worktrees/Trebell-0c17", "…/worktrees/Trebell-0d63") lead with their own folder, and same-named folders
// ("/a/repo", "/b/repo") keep one more segment ("a/repo", "b/repo").
export function distinctPathParts(paths=[]){
  const list=(Array.isArray(paths)?paths:[]).map(path=>String(path??""));
  const segments=list.map(path=>path.replace(/[\\/]+$/,"").split(/[\\/]+/));
  const tail=(parts,count)=>parts.slice(-count).join("/");
  return list.map((path,index)=>{
    const own=segments[index];let count=1;
    while(count<own.length&&segments.some((other,otherIndex)=>otherIndex!==index&&tail(other,count)===tail(own,count)))count++;
    return splitPath(path,count);
  });
}

// Where each text parts from the others that start like it: "trebell-feature-inspector-review-panels" and "…-polish" part at
// "panels" and "polish". `lead` is the start it shares and `tail` the rest. The tail begins at the start of the word where the texts
// part when that is close by (8 characters), so it reads "panels" rather than "anels"; a text that starts another one ("repo" beside
// "repo-2") keeps its last word, and a text that shares no start (or is the same as another) is all tail.
// `keep` is how many characters of room the tail needs for the difference to show: through the character that differs and 6 more,
// with one for the ellipsis after them, or the whole tail when that is as short. A narrow row cuts the lead before the tail gets less.
const WORD_CHARACTER=/[\p{L}\p{N}\p{M}]/u;
export function distinctTextParts(texts=[]){
  const list=(Array.isArray(texts)?texts:[]).map(text=>String(text??""));
  return list.map(text=>{
    let shared=0;
    for(const other of list){
      if(other===text)continue;
      let length=0;while(length<text.length&&text[length]===other[length])length++;
      shared=Math.max(shared,length);
    }
    let start=Math.min(shared,Math.max(0,text.length-1)),word=start;
    while(word>0&&WORD_CHARACTER.test(text[word-1]))word--;
    if(start-word<=8)start=word;
    // Never between the two halves of a surrogate pair, and never a lead of one character, which a cut could only clip.
    if(start>0&&/[\uDC00-\uDFFF]/.test(text[start]))start--;
    if(start<2)start=0;
    const tail=text.slice(start);
    return {lead:text.slice(0,start),tail,keep:Math.min(tail.length,Math.max(0,shared-start)+8)};
  });
}
