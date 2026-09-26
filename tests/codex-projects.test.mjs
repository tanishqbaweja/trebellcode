import test from "node:test";
import assert from "node:assert/strict";
import {ensureCodexProject,ensureRuntimeProject,matchingCodexProject,matchingRuntimeProject,sameWorkspacePath} from "../ui/src/codex-projects.js";

test("Codex project matching handles Windows path separators and case",()=>{
  assert.equal(sameWorkspacePath("C:\\Repo\\Trebell","c:/repo/trebell/"),true);
  assert.equal(sameWorkspacePath("/home/me/Trebell","/home/me/trebell"),false);
});

test("Codex project bridge prefers Trebell ownership metadata over root coincidence",()=>{
  const projects=[
    {id:"root-match",metadata:{},roots:[{path:"C:\\repo"}]},
    {id:"owned",metadata:{trebellProjectId:"trebell-1"},roots:[{path:"C:\\old"}]},
  ];
  assert.equal(matchingCodexProject(projects,{trebellProjectId:"trebell-1",cwd:"C:\\repo"}).id,"owned");
});

test("Codex project bridge reuses matching roots without creating duplicates",async()=>{
  const calls=[];const client={request:async(method,params)=>{calls.push({method,params});if(method==="project/list")return {data:[{id:"native-1",name:"Existing",roots:[{path:"C:\\repo"}],metadata:{}}],nextCursor:null};throw new Error("unexpected "+method)}};
  const project=await ensureCodexProject(client,{trebellProject:{id:"trebell-1",name:"Repo"},cwd:"c:/repo"});
  assert.equal(project.id,"native-1");assert.equal(calls.length,1);
});

test("Codex project bridge creates one idempotent native project when none exists",async()=>{
  const calls=[];const client={request:async(method,params)=>{calls.push({method,params});if(method==="project/list")return {data:[],nextCursor:null};if(method==="project/create")return {project:{id:"native-new",...params}};throw new Error("unexpected "+method)}};
  const project=await ensureCodexProject(client,{trebellProject:{id:"trebell-1",name:"Repo"},cwd:"C:\\repo"});
  assert.equal(project.id,"native-new");
  assert.deepEqual(calls[1],{method:"project/create",params:{name:"Repo",roots:[{path:"C:\\repo"}],metadata:{trebellManaged:"true",trebellProjectId:"trebell-1"},idempotencyKey:"trebell-code:trebell-1"}});
});

test("runtime project helpers keep Codex compatibility aliases",()=>{
  assert.equal(ensureCodexProject,ensureRuntimeProject);assert.equal(matchingCodexProject,matchingRuntimeProject);
});
