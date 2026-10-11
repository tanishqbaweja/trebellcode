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
