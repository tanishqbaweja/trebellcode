import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,writeFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrebellStateStore } from "../src/trebell-state.mjs";
import { assessRepositoryKnowledgeFreshness, captureRepositoryKnowledgeEvidence, repositoryKnowledgeContext, verifyRepositoryKnowledgeEntry } from "../src/repository-knowledge.mjs";

test("repository knowledge persists explicit facts and filters by repository",async()=>{
  const home=await mkdtemp(join(tmpdir(),"trebell-knowledge-state-"));
  try{
    const state=new TrebellStateStore({home});
    const saved=state.upsertRepositoryKnowledge({projectPath:"/repo/a",category:"architecture",fact:"Requests enter through the relay.",scope:"runtime",status:"verified",evidence:[{path:"src/relay.js",fingerprint:"abc"}],lastVerifiedRevision:"deadbeef"});
    state.upsertRepositoryKnowledge({projectPath:"/repo/b",fact:"Other repo fact"});
    assert.equal(state.repositoryKnowledge({projectPath:"/repo/a"}).length,1);assert.equal(state.repositoryKnowledge({projectPath:"/repo/a"})[0].id,saved.id);
    assert.equal(state.removeRepositoryKnowledge(saved.id),true);assert.equal(state.repositoryKnowledge({projectPath:"/repo/a"}).length,0);
  }finally{await rm(home,{recursive:true,force:true})}
});

test("repository knowledge evidence becomes stale when supporting files drift",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-knowledge-evidence-")),file=join(root,"architecture.txt");
  try{
    await writeFile(file,"relay -> runtime\n");
    const verified=await verifyRepositoryKnowledgeEntry({projectPath:root,category:"architecture",fact:"The relay hands work to the runtime.",evidence:[{path:"architecture.txt"}]},{root,now:1000});
    assert.equal(verified.status,"verified");assert.ok(verified.evidence[0].fingerprint);assert.equal(verified.verifiedAt,1000);
    const unchanged=await captureRepositoryKnowledgeEvidence({root,evidence:verified.evidence});
    assert.equal(assessRepositoryKnowledgeFreshness(verified,unchanged).status,"verified");
    await writeFile(file,"relay -> policy -> runtime\n");
    const changed=await captureRepositoryKnowledgeEvidence({root,evidence:verified.evidence}),assessment=assessRepositoryKnowledgeFreshness(verified,changed);
    assert.equal(assessment.status,"stale");assert.deepEqual(assessment.changed,["architecture.txt"]);
  }finally{await rm(root,{recursive:true,force:true})}
});

test("repository knowledge rejects evidence outside the repository and omits stale facts from context",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-knowledge-bounds-"));
  try{
    await assert.rejects(captureRepositoryKnowledgeEvidence({root,evidence:[{path:"../secret.txt"}]}),/inside the repository/i);
    const context=repositoryKnowledgeContext([
      {category:"decision",fact:"Use one relay.",scope:"runtime",status:"verified",evidence:[{path:"src/relay.js"}],lastVerifiedRevision:"abcdef1234567890"},
      {category:"failure-mode",fact:"Old stale claim.",status:"stale",evidence:[]},
    ]);
    assert.match(context,/Use one relay/);assert.doesNotMatch(context,/Old stale claim/);assert.match(context,/abcdef123456/);
  }finally{await rm(root,{recursive:true,force:true})}
});
