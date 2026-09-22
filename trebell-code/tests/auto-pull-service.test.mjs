import test from "node:test";
import assert from "node:assert/strict";
import { sweepAutoPullProjects } from "../src/auto-pull-service.mjs";

test("auto-pull sweep runs only enabled projects and distinguishes skips from failures",async()=>{
  const projects=[
    {id:"a",path:"/a",environmentId:null},
    {id:"b",path:"/b",environmentId:"ssh-a"},
    {id:"c",path:"/c",environmentId:null},
    {id:"d",path:"/d",environmentId:null},
  ];
  const enabled=new Set(["/a","/b","/d"]);const calls=[],logs=[];
  const state={
    projects:()=>projects,
    projectSettings:path=>({effective:{autoPull:enabled.has(path)}}),
  };
  const summary=await sweepAutoPullProjects({
    state,
    pullProject:async project=>{
      calls.push(project.path);
      if(project.path==="/a")return {ok:true,changed:true,defaultBranch:"main"};
      if(project.path==="/b")return {ok:false,reason:"not_default_branch"};
      throw new Error("network down");
    },
    log:message=>logs.push(message),
  });
  assert.deepEqual(calls,["/a","/b","/d"]);
  assert.equal(summary.eligible,3);
  assert.equal(summary.updated,1);
  assert.equal(summary.skipped,1);
  assert.equal(summary.failed,1);
  assert.equal(logs.some(line=>line.includes("Updated /a")),true);
  assert.equal(logs.some(line=>line.includes("network down")),true);
  assert.equal(logs.some(line=>line.includes("not_default_branch")),false);
});
