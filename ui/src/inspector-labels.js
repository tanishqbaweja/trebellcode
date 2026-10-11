// Display text for the inspector's Files, Diff and Git panels: error banners, git status badges and file paths.

// A banner names the action that failed before the reason the server gave ("Could not open notes.txt: EPERM …"), so a bare
// "EPERM" or "HTTP 500" never arrives without context.
export function actionError(action,error){
  const detail=String(error?.message??error??"").trim();
  return detail?action+": "+detail:action+".";
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
