import test from "node:test";
import assert from "node:assert/strict";
import { PROJECT_PAGE_SIZE, projectGroupCounts, projectMatches, projectWindow } from "../ui/src/project-window.js";

const projects=Array.from({length:120},(_,index)=>({
  id:"p-"+index,name:"Project "+String(index).padStart(3,"0"),path:"C:/repo/"+index,environmentId:null,
  environment:{name:"Local machine",type:"local"},remote:"https://example.test/shared.git",git:{branch:index%2?"main":"feature"},
  scripts:index===75?[{name:"Deploy",command:"npm run deploy"}]:[],
}));

test("project window mounts a bounded first page while preserving full match counts",()=>{
  const window=projectWindow(projects);
  assert.equal(window.shown,PROJECT_PAGE_SIZE);assert.equal(window.total,120);assert.equal(window.hasMore,true);
});

test("project search covers names, paths, branches, remotes and actions",()=>{
  assert.equal(projectMatches(projects[75],"deploy"),true);
  assert.equal(projectWindow(projects,{query:"Project 099"}).visible[0].id,"p-99");
  assert.ok(projectWindow(projects,{query:"feature"}).total>0);
  assert.equal(projectWindow(projects,{query:"not-present"}).total,0);
});

test("active project remains in the bounded window even when it is older",()=>{
  const window=projectWindow(projects,{currentPath:"C:/repo/99",currentEnvironmentId:null});
  assert.equal(window.shown,PROJECT_PAGE_SIZE);assert.ok(window.visible.some(project=>project.id==="p-99"));
});

test("project group counts describe the full filtered catalog, not just mounted cards",()=>{
  const counts=projectGroupCounts(projects);
  assert.equal([...counts.values()][0],120);
});
