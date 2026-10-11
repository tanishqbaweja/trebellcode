// Display text for the inspector's Files, Diff and Git panels: file paths.

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
