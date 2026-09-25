import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createGuiServer } from "../src/gui-server.mjs";

async function freePort(){const server=createServer();await new Promise((resolve,reject)=>server.listen(0,"127.0.0.1",resolve).once("error",reject));const port=server.address().port;await new Promise(resolve=>server.close(resolve));return port}

test("project recipes resolve into bounded executable turn context without permission escalation",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-gui-recipe-")),[port,appPort]=await Promise.all([freePort(),freePort()]);
  const gui=await createGuiServer({port,appPort,mock:true,env:{...process.env,TREBELL_HOME:home}});
  try{
    const projectPath=join(home,"repo");
    const saved=await fetch(gui.url+"/api/projects",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({
      path:projectPath,environmentId:null,recipes:[
        {name:"fix-ci",objective:"Fix the failing CI job.",permission:"workspace-write",validation:["Run affected tests"],maxChildren:0},
        {name:"bounded",objective:"Inspect auth.",allowedTools:["repo"]},
        {name:"claude-only",objective:"Use Claude.",runtime:"claude"},
      ],
    })}).then(response=>response.json());
    assert.equal(saved.project.recipes.length,3);

    const resolved=await fetch(gui.url+"/api/project-recipe/resolve",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({
      path:projectPath,environmentId:null,recipe:"/fix-ci",input:"Linux runner only",currentPermission:"full",runtime:"codex",
    })});
    assert.equal(resolved.status,200);
    const execution=(await resolved.json()).execution;
    assert.equal(execution.permissionMode,"edits");assert.equal(execution.goalPatch.childAgentBudget,0);
    assert.match(execution.turnInput,/Linux runner only/);assert.match(execution.context,/Run affected tests/);

    const bounded=await fetch(gui.url+"/api/project-recipe/resolve",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({path:projectPath,recipe:"/bounded",runtime:"codex"})});
    assert.equal(bounded.status,400);assert.match((await bounded.json()).error,/cannot prove recipe tool-policy enforcement/i);
    const wrongRuntime=await fetch(gui.url+"/api/project-recipe/resolve",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({path:projectPath,recipe:"/claude-only",runtime:"codex"})});
    assert.equal(wrongRuntime.status,400);assert.match((await wrongRuntime.json()).error,/requires the claude runtime/i);
  }finally{await gui.close();await rm(home,{recursive:true,force:true})}
});
