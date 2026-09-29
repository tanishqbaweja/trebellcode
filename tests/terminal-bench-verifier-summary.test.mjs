import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeCtrfVerifierSummary, readJobVerifierSummary } from "../scripts/terminal-bench-verifier-summary.mjs";

test("Terminal-Bench verifier summary normalizes CTRF counts",()=>{
  assert.deepEqual(normalizeCtrfVerifierSummary({results:{summary:{tests:6,passed:5,failed:1,pending:0,skipped:0,other:0}}}),{tests:6,passed:5,failed:1,pending:0,skipped:0,other:0});
  assert.equal(normalizeCtrfVerifierSummary({results:{}}),null);
});

test("Terminal-Bench verifier summary aggregates completed trial CTRF files",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-ctrf-summary-")),job="job";
  try{
    for(const [trial,summary] of [["trial-a",{tests:6,passed:5,failed:1,pending:0,skipped:0,other:0}],["trial-b",{tests:4,passed:3,failed:0,pending:1,skipped:0,other:0}]]){
      const verifier=join(root,job,trial,"verifier");await mkdir(verifier,{recursive:true});await writeFile(join(verifier,"ctrf.json"),JSON.stringify({results:{summary}}));
    }
    await mkdir(join(root,job,"trial-without-ctrf"),{recursive:true});
    assert.deepEqual(await readJobVerifierSummary(root,job),{trials:2,tests:10,passed:8,failed:1,pending:1,skipped:0,other:0});
  }finally{await rm(root,{recursive:true,force:true})}
});
