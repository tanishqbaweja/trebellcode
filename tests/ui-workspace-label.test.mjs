import test from "node:test";
import assert from "node:assert/strict";
import { workspaceLabel } from "../ui/src/workspace-label.js";

test("a workspace at a filesystem root shows its path, not missing metadata",()=>{
  for(const cwd of ["/","\\","//","C:\\","C:/","c:\\","C:","\\\\?\\C:\\","\\\\.\\D:\\"])assert.equal(workspaceLabel({cwd,branch:null}),cwd,cwd);
});

test("any other workspace shows its folder's own name",()=>{
  const cases=[
    ["/home/u/repo","repo"],["/home/u/repo/","repo"],["C:\\Users\\dev\\trebell","trebell"],["C:\\Users\\dev\\trebell\\","trebell"],
    ["H:/Github Repositories/Trebell","Trebell"],["\\\\server\\share","share"],["\\\\server\\share\\checkout\\","checkout"],
    ["\\\\?\\C:\\work\\repo","repo"],["/srv/a:","a:"],["repo","repo"],["~","~"],[" /home/u/repo ","repo"],
  ];
  for(const [cwd,label] of cases)assert.equal(workspaceLabel({cwd}),label,cwd);
});

test("a branch names the workspace first, and no cwd at all is missing metadata",()=>{
  assert.equal(workspaceLabel({cwd:"/",branch:"feature/durable-goals"}),"feature/durable-goals");
  assert.equal(workspaceLabel({cwd:"/home/u/repo",branch:"main"}),"main");
  for(const workspace of [null,undefined,{},{cwd:""},{cwd:"   "},{cwd:null,branch:""}])assert.equal(workspaceLabel(workspace),"No workspace metadata",JSON.stringify(workspace));
});
