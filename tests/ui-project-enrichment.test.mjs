import test from "node:test";
import assert from "node:assert/strict";
import { baseProjectRecord, enrichProjectRecords, mapWithConcurrency, projectCardDetail, projectEnvironmentLabel, projectGitLabel, projectIsRemote, projectOpenedLabel, summarizeProjectRefreshErrors } from "../ui/src/project-enrichment.js";

test("one rule decides whether a project is remote: its environment type, else whether it names an environment",()=>{
  assert.equal(projectIsRemote({environmentId:null,environment:{id:null,name:"Local machine",type:"local"}}),false);
  assert.equal(projectIsRemote({environmentId:"box",environment:{id:"box",name:"Box",type:"ssh"}}),true);
  assert.equal(projectIsRemote({environmentId:"wsl",environment:{id:"wsl",name:"WSL",type:"local"}}),false);
  assert.equal(projectIsRemote({environmentId:null}),false);
  assert.equal(projectIsRemote({}),false);
  assert.equal(projectIsRemote({environmentId:"box"}),true);
  assert.equal(projectIsRemote(null),false);
});

test("a project names its environment from the server, then the environments list, and never calls a remote one local",()=>{
  const profiles=[{id:"box",name:"Build box",type:"ssh"}];
  assert.equal(projectEnvironmentLabel({environment:{name:"Remote test",type:"ssh"},environmentId:"box"},profiles),"Remote test");
  assert.equal(projectEnvironmentLabel({environmentId:null}),"Local machine");
  assert.equal(projectEnvironmentLabel({environmentId:"box"},profiles),"Build box");
  assert.equal(projectEnvironmentLabel({environmentId:"gone"},profiles),"Remote environment");
  assert.equal(projectEnvironmentLabel({environmentId:"box"},null),"Remote environment");
});

test("a last-opened time that is missing or unreadable is left out instead of reading Invalid Date",()=>{
  const at=Date.UTC(2026,8,23,10,0,0);
  assert.equal(projectOpenedLabel(at),new Date(at).toLocaleString());
  assert.equal(projectOpenedLabel(new Date(at).toISOString()),new Date(at).toLocaleString());
  for(const value of [undefined,null,"","not a time",NaN,true])assert.equal(projectOpenedLabel(value),"");
});

test("a project card's detail line follows the same local-or-remote rule as its environment label",()=>{
  const at=Date.UTC(2026,8,23,10,0,0),time=new Date(at).toLocaleString();
  // The fixture shape that read "Local machine" above "remote workspace · Invalid Date".
  assert.equal(projectCardDetail({environmentId:null,git:{isGit:true,branch:"main"}}),"main");
  assert.equal(projectCardDetail({environmentId:null,git:null,lastOpenedAt:at}),time);
  assert.equal(projectCardDetail({environmentId:null,git:{isGit:false},lastOpenedAt:at}),"not a Git checkout · "+time);
  assert.equal(projectCardDetail({environmentId:"box",environment:{type:"ssh"},lastOpenedAt:at}),"remote workspace · "+time);
  assert.equal(projectCardDetail({environmentId:"box"}),"remote workspace");
  assert.equal(projectCardDetail({environmentId:null,managedWorktree:{cleanedAt:at},lastOpenedAt:at}),"managed worktree cleaned · click to restore");
});

test("enrichment never probes Git for a project that names an environment without its details",async()=>{
  const probed=[];
  const records=[baseProjectRecord({id:"local",path:"C:/repo",environmentId:null}),baseProjectRecord({id:"remote",path:"/srv/app",environmentId:"box"})];
  assert.equal(records[1].git,null);
  const enriched=await enrichProjectRecords(records,{fetchGit:async project=>{probed.push(project.path);return {isGit:true,branch:"main"}},fetchSuggestions:async()=>({scripts:[],projectFile:{present:false},packageManager:null})});
  assert.deepEqual(probed,["C:/repo"]);assert.equal(enriched[0].git.branch,"main");assert.equal(enriched[1].git,null);
});

test("a project card names the branch, a detached HEAD, or a folder outside Git, and nothing before Git answers",()=>{
  assert.equal(projectGitLabel({isGit:true,branch:"main"}),"main");
  assert.equal(projectGitLabel({isGit:true,branch:""}),"detached HEAD");
  assert.equal(projectGitLabel({isGit:true,branch:null}),"detached HEAD");
  assert.equal(projectGitLabel({isGit:false,branch:null}),"not a Git checkout");
  assert.equal(projectGitLabel(null),"");
  assert.equal(projectGitLabel(undefined),"");
});

test("bounded project enrichment never exceeds the requested worker concurrency",async()=>{
  let active=0,maxActive=0;
  const values=await mapWithConcurrency(Array.from({length:40},(_,index)=>index),4,async value=>{
    active++;maxActive=Math.max(maxActive,active);
    await new Promise(resolve=>setTimeout(resolve,2));
    active--;return value*2;
  });
  assert.equal(maxActive,4);assert.equal(values.length,40);assert.equal(values[17],34);
});

test("base project records render immediately with last-known-good enrichment",()=>{
  const prior={id:"p1",git:{branch:"main"},remote:"https://example.test/repo.git",suggested:{scripts:[{name:"Test"}]}};
  const base=baseProjectRecord({id:"p1",name:"Repo",path:"C:/repo",scripts:null},prior);
  assert.deepEqual(base.git,{branch:"main"});assert.equal(base.remote,prior.remote);assert.equal(base.suggested.scripts.length,1);assert.deepEqual(base.scripts,[]);
});

test("project enrichment preserves prior fields when one enrichment request fails",async()=>{
  const errors=[],base=baseProjectRecord({id:"p1",name:"Repo",path:"C:/repo"},{git:{branch:"old"},remote:"old-url",suggested:{scripts:[{name:"Old"}]}});
  const [result]=await enrichProjectRecords([base],{
    concurrency:2,
    fetchGit:async()=>{throw new Error("git offline")},
    fetchSuggestions:async()=>({scripts:[{name:"New"}],projectFile:{present:false},packageManager:"npm"}),
    onError:(project,kind,error)=>errors.push(project.id+":"+kind+":"+error.message),
  });
  assert.deepEqual(result.git,{branch:"old"});assert.equal(result.remote,"old-url");assert.equal(result.suggested.scripts[0].name,"New");
  assert.deepEqual(errors,["p1:git:git offline"]);
});

test("project refresh error summaries stay bounded",()=>{
  const message=summarizeProjectRefreshErrors(Array.from({length:12},(_,index)=>"Error "+index),3);
  assert.equal(message,"Error 0 · Error 1 · Error 2 · +9 more");
});
