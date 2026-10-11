import test from "node:test";
import assert from "node:assert/strict";
import { actionError, distinctPathParts, gitStatusBadge, splitPath } from "../ui/src/inspector-labels.js";

test("inspector errors name the failed action before the server's reason",()=>{
  assert.equal(actionError("Could not refresh the diff",new Error("EPERM: operation not permitted")),"Could not refresh the diff: EPERM: operation not permitted");
  assert.equal(actionError("Could not open notes.txt","File is too large to preview (600 KB)"),"Could not open notes.txt: File is too large to preview (600 KB)");
  // No reason at all still reads as a sentence instead of "…: " or "…: Error".
  assert.equal(actionError("Could not open the worktree",new Error("")),"Could not open the worktree.");
  assert.equal(actionError("Could not push",null),"Could not push.");
});

test("untracked paths get one badge that does not collide with git's unmerged U",()=>{
  for(const code of ["??","?? "])assert.deepEqual(gitStatusBadge(code),{label:"N",kind:"added",title:"Untracked: new, not added to Git yet (git status ??)"});
  for(const code of ["UU","AA","DD","AU","UA","DU","UD"]){
    const badge=gitStatusBadge(code);
    assert.equal(badge.kind,"conflict",code);assert.equal(badge.label,code);assert.match(badge.title,/^Conflict/);
  }
  assert.notEqual(gitStatusBadge("??").label,"U");
});

test("git status badges drop the column padding and name the status",()=>{
  assert.deepEqual(gitStatusBadge(" M"),{label:"M",kind:"modified",title:"Modified (git status M)"});
  assert.deepEqual(gitStatusBadge("M "),{label:"M",kind:"modified",title:"Modified (git status M)"});
  assert.deepEqual(gitStatusBadge("MM"),{label:"MM",kind:"modified",title:"Modified (git status MM)"});
  assert.deepEqual(gitStatusBadge("A "),{label:"A",kind:"added",title:"Added (git status A)"});
  assert.deepEqual(gitStatusBadge(" D"),{label:"D",kind:"deleted",title:"Deleted (git status D)"});
  assert.deepEqual(gitStatusBadge("R "),{label:"R",kind:"renamed",title:"Renamed (git status R)"});
  assert.deepEqual(gitStatusBadge("C "),{label:"C",kind:"renamed",title:"Copied (git status C)"});
  assert.deepEqual(gitStatusBadge(" T"),{label:"T",kind:"modified",title:"Type changed (git status T)"});
  assert.equal(gitStatusBadge("").label,"M");
});

test("a path splits into its folder and name, and an untracked folder keeps its name",()=>{
  assert.deepEqual(splitPath("ui/src/App.jsx"),{dir:"ui/src",sep:"/",name:"App.jsx"});
  assert.deepEqual(splitPath("README.md"),{dir:"",sep:"",name:"README.md"});
  // git status reports an untracked folder as "name/": the name is the folder, not an empty string after the slash.
  assert.deepEqual(splitPath("capcut-network-capture/"),{dir:"",sep:"",name:"capcut-network-capture/"});
  assert.deepEqual(splitPath("tests/fixtures/new-dir/"),{dir:"tests/fixtures",sep:"/",name:"new-dir/"});
  assert.deepEqual(splitPath("C:\\Users\\dev\\repo"),{dir:"C:\\Users\\dev",sep:"\\",name:"repo"});
  for(const path of ["ui/src/App.jsx","capcut-network-capture/","tests/fixtures/new-dir/","C:\\Users\\dev\\repo","/srv/app","/"]){
    const {dir,sep,name}=splitPath(path);assert.equal(dir+sep+name,path,path);
  }
});

test("sibling paths lead with the segments that tell them apart",()=>{
  const worktrees=["H:/Github Repositories/Trebell","C:/Users/dev/.devspace/worktrees/Trebell-0c178972","C:/Users/dev/.devspace/worktrees/Trebell-0d6387c0"];
  assert.deepEqual(distinctPathParts(worktrees).map(part=>part.name),["Trebell","Trebell-0c178972","Trebell-0d6387c0"]);
  assert.deepEqual(distinctPathParts(worktrees)[1],{dir:"C:/Users/dev/.devspace/worktrees",sep:"/",name:"Trebell-0c178972"});
  // Same folder name under different parents: one more segment each.
  assert.deepEqual(distinctPathParts(["/work/a/repo","/work/b/repo","/work/c/other"]).map(part=>part.name),["a/repo","b/repo","other"]);
  assert.deepEqual(distinctPathParts(["D:\\wt\\one\\app","D:\\wt\\two\\app"]),[{dir:"D:\\wt",sep:"\\",name:"one\\app"},{dir:"D:\\wt",sep:"\\",name:"two\\app"}]);
  // A single path, or two identical ones, never loses text.
  assert.deepEqual(distinctPathParts(["/srv/app"]),[{dir:"/srv",sep:"/",name:"app"}]);
  for(const part of distinctPathParts(["/same/path","/same/path"]))assert.equal(part.dir+part.sep+part.name,"/same/path");
  assert.deepEqual(distinctPathParts(),[]);
});
