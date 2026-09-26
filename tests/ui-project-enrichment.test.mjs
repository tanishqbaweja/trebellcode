import test from "node:test";
import assert from "node:assert/strict";
import { baseProjectRecord, enrichProjectRecords, mapWithConcurrency, summarizeProjectRefreshErrors } from "../ui/src/project-enrichment.js";

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
    fetchSuggestions:async()=>({scripts:[{name:"New"}],t3:{present:false},packageManager:"npm"}),
    onError:(project,kind,error)=>errors.push(project.id+":"+kind+":"+error.message),
  });
  assert.deepEqual(result.git,{branch:"old"});assert.equal(result.remote,"old-url");assert.equal(result.suggested.scripts[0].name,"New");
  assert.deepEqual(errors,["p1:git:git offline"]);
});

test("project refresh error summaries stay bounded",()=>{
  const message=summarizeProjectRefreshErrors(Array.from({length:12},(_,index)=>"Error "+index),3);
  assert.equal(message,"Error 0 · Error 1 · Error 2 · +9 more");
});
