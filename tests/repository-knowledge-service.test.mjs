import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,writeFile,rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrebellStateStore } from "../src/trebell-state.mjs";
import { RepositoryKnowledgeService } from "../src/repository-knowledge-service.mjs";

const exec=promisify(execFile);
async function git(root,...args){return exec("git",["-C",root,...args],{windowsHide:true})}

test("repository knowledge service remembers verified evidence, ranks relevance, and marks drift stale",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-knowledge-service-")),home=await mkdtemp(join(tmpdir(),"trebell-knowledge-home-"));
  try{
    await git(root,"init");await git(root,"config","user.email","test@example.com");await git(root,"config","user.name","Trebell Test");
    await writeFile(join(root,"relay.md"),"The relay owns runtime routing.\n");await writeFile(join(root,"build.md"),"Run npm test before release.\n");
    await git(root,"add",".");await git(root,"commit","-m","initial");
    const state=new TrebellStateStore({home}),service=new RepositoryKnowledgeService({state});
    const architecture=await service.remember({projectPath:root,category:"architecture",fact:"Runtime requests go through the relay.",scope:"runtime",confidence:.95,evidence:[{path:"relay.md"}]});
    const command=await service.remember({projectPath:root,category:"command",fact:"Run npm test before release.",scope:"release",confidence:.9,evidence:[{path:"build.md"}]});
    assert.equal(architecture.status,"verified");assert.ok(architecture.lastVerifiedRevision);assert.ok(architecture.evidence[0].fingerprint);
    const ranked=service.list({projectPath:root,query:"relay runtime",limit:2});assert.equal(ranked[0].id,architecture.id);assert.equal(ranked[1].id,command.id);
    const before=await service.context({projectPath:root,query:"runtime",refresh:true});assert.match(before.context,/Runtime requests go through the relay/);
    await writeFile(join(root,"relay.md"),"The policy layer now owns routing before the relay.\n");
    const refreshed=await service.refresh({projectPath:root});assert.equal(refreshed.find(item=>item.id===architecture.id).status,"stale");
    const after=await service.context({projectPath:root,query:"runtime",refresh:false});assert.doesNotMatch(after.context,/Runtime requests go through the relay/);
    await writeFile(join(root,"relay.md"),"The relay owns runtime routing.\n");
    const recovered=await service.context({projectPath:root,query:"relay runtime",refresh:true});
    assert.equal(recovered.entries.find(item=>item.id===architecture.id)?.status,"verified");
    assert.match(recovered.context,/Runtime requests go through the relay/);
    assert.equal(service.forget(command.id),true);
  }finally{await rm(root,{recursive:true,force:true});await rm(home,{recursive:true,force:true})}
});

test("repository knowledge service keeps explicit facts without evidence unverified",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-knowledge-home-"));
  try{
    const state=new TrebellStateStore({home}),service=new RepositoryKnowledgeService({state});
    const entry=await service.remember({projectPath:"C:/repo",category:"decision",fact:"Prefer explicit migrations.",source:"user"});
    assert.equal(entry.status,"unverified");assert.equal(entry.evidence.length,0);
    const context=(await service.context({projectPath:"C:/repo",refresh:false})).context;
    assert.match(context,/Prefer explicit migrations/);assert.match(context,/status: unverified/);assert.match(context,/unverified facts may lack supporting evidence/i);
  }finally{await rm(home,{recursive:true,force:true})}
});
