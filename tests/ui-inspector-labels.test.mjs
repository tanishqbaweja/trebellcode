import test from "node:test";
import assert from "node:assert/strict";
import { distinctPathParts, splitPath } from "../ui/src/inspector-labels.js";

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
