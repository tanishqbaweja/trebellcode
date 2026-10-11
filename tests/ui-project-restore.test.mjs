import test from "node:test";
import assert from "node:assert/strict";
import { projectRemovalQuestion, projectRestoreBlocker, projectRestoreBody } from "../ui/src/project-restore.js";

const listed={
  id:"p1",path:"H:/work/app",environmentId:null,name:"App",createdAt:1,lastOpenedAt:2,
  icon:{kind:"emoji",value:"🧪",color:"#2f6fe0"},scripts:[{id:"dev",name:"Dev",command:"npm run dev"}],preferredScriptId:"dev",
  hooks:[{id:"lint",name:"Lint",event:"verification.required",command:"npm run lint"}],recipes:[{id:"triage",name:"/triage",objective:"Triage"}],
  settingsOverrides:{defaultModel:"m",autoPull:true},defaultModel:"m",permissionMode:"edits",workspaceMode:null,worktreeSubmodules:null,
  worktreeCleanup:{mode:"off"},managedWorktree:null,pullRequestViewedFiles:{},cloneJob:null,
  environment:{id:null,name:"Local machine",type:"local"},effectiveSettings:{defaultModel:"m"},
  git:{isGit:true,branch:"main"},remote:"https://example.test/app.git",suggested:{scripts:[{name:"test",command:"npm test"}]},
};

test("a restore sends back every field the person saved, and none the server works out or the card adds",()=>{
  const body=projectRestoreBody(listed);
  for(const key of ["id","createdAt","lastOpenedAt","environment","effectiveSettings","git","remote","suggested"])assert.equal(key in body,false,key);
  assert.deepEqual(body,{
    path:"H:/work/app",environmentId:null,name:"App",icon:listed.icon,scripts:listed.scripts,preferredScriptId:"dev",hooks:listed.hooks,recipes:listed.recipes,
    settingsOverrides:listed.settingsOverrides,defaultModel:"m",permissionMode:"edits",workspaceMode:null,worktreeSubmodules:null,
    worktreeCleanup:{mode:"off"},managedWorktree:null,pullRequestViewedFiles:{},cloneJob:null,
  });
});

test("a restore names the project's environment, and a missing one is the local machine",()=>{
  assert.equal(projectRestoreBody({...listed,environmentId:"box"}).environmentId,"box");
  assert.equal(projectRestoreBody({...listed,environmentId:undefined}).environmentId,null);
  assert.equal("activate" in projectRestoreBody(listed),false);
});

test("Undo can put a project back unless it is still cloning or its environment cannot take it",()=>{
  assert.equal(projectRestoreBlocker(listed),null);
  for(const status of ["completed","failed","cancelled"])assert.equal(projectRestoreBlocker({...listed,cloneJob:{status}}),null,status);
  for(const status of ["running","cancelling"])assert.equal(projectRestoreBlocker({...listed,cloneJob:{status}}),"cloning",status);
  assert.equal(projectRestoreBlocker({...listed,environmentId:"box",environment:{id:"box",name:"Box",type:"ssh",enabled:true}}),null);
  assert.equal(projectRestoreBlocker({...listed,environmentId:"box",environment:{id:"box",name:"Box",type:"ssh",enabled:false}}),"environment-off");
  assert.equal(projectRestoreBlocker({...listed,environmentId:"gone",environment:{id:"gone",name:"Unavailable environment",type:"unknown",enabled:true}}),"environment-gone");
  assert.equal(projectRestoreBlocker(null),null);
});

test("the question before a removal Undo cannot put back says why and what is lost",()=>{
  assert.equal(projectRemovalQuestion(listed,"cloning"),"Remove “App” while it is still cloning? This cannot be undone: its saved actions, hooks and settings are lost. The clone keeps running.");
  assert.equal(projectRemovalQuestion(listed,"environment-off"),"Remove “App”? Its environment is switched off, so this cannot be undone: its saved actions, hooks and settings are lost.");
  assert.equal(projectRemovalQuestion(listed,"environment-gone"),"Remove “App”? Its environment is no longer saved, so this cannot be undone: its saved actions, hooks and settings are lost.");
  assert.equal(projectRemovalQuestion(listed),"Remove “App”? This cannot be undone: its saved actions, hooks and settings are lost.");
  assert.equal(projectRemovalQuestion({path:"H:/work/unnamed"}),"Remove “H:/work/unnamed”? This cannot be undone: its saved actions, hooks and settings are lost.");
});
