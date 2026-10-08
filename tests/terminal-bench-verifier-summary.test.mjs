import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeCtrfVerifierSummary, normalizeTraceResultsVerifierSummary, normalizeVerifierDiagnosticText, readJobVerifierSummary, readTrialVerifierSummary } from "../scripts/terminal-bench-verifier-summary.mjs";

test("Terminal-Bench verifier summary normalizes CTRF counts",()=>{
  assert.deepEqual(normalizeCtrfVerifierSummary({results:{summary:{tests:6,passed:5,failed:1,pending:0,skipped:0,other:0}}}),{tests:6,passed:5,failed:1,pending:0,skipped:0,other:0});
  assert.equal(normalizeCtrfVerifierSummary({results:{}}),null);
});

test("Terminal-Bench verifier summary separates task diagnostics from pytest execution",()=>{
  assert.deepEqual(normalizeVerifierDiagnosticText("Scoring: 115/116 lines correct = 99.14%\nCases:   9/10 perfect = 90.00%\nPASSED"),{diagnostic:{correct:115,total:116,percent:99.14},cases:{correct:9,total:10,percent:90}});
});

test("Terminal-Bench verifier summary reads official reward and scorer diagnostics beside CTRF",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-scored-trial-"));
  try{
    const verifier=join(root,"verifier");await mkdir(verifier,{recursive:true});
    await writeFile(join(verifier,"ctrf.json"),JSON.stringify({results:{summary:{tests:1,passed:1,failed:0,pending:0,skipped:0,other:0}}}));
    await writeFile(join(verifier,"reward.json"),JSON.stringify({reward:0}));
    await writeFile(join(verifier,"test-stdout.txt"),"Scoring: 60/116 lines correct = 51.72%\nCases: 6/10 perfect = 60.00%\nPASSED\n");
    assert.deepEqual(await readTrialVerifierSummary(root),{trials:1,tests:1,passed:1,failed:0,pending:0,skipped:0,other:0,officialReward:0,diagnostic:{correct:60,total:116,percent:51.72},cases:{correct:6,total:10,percent:60}});
  }finally{await rm(root,{recursive:true,force:true})}
});

test("Terminal-Bench verifier summary reads the official reward from reward.txt when reward.json is absent",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-reward-txt-trial-"));
  try{
    const verifier=join(root,"verifier");await mkdir(verifier,{recursive:true});
    await writeFile(join(verifier,"ctrf.json"),JSON.stringify({results:{summary:{tests:10,passed:8,failed:2,pending:0,skipped:0,other:0}}}));
    await writeFile(join(verifier,"reward.txt"),"0\n");
    assert.deepEqual(await readTrialVerifierSummary(root),{trials:1,tests:10,passed:8,failed:2,pending:0,skipped:0,other:0,officialReward:0});
    await writeFile(join(verifier,"reward.json"),JSON.stringify({reward:1}));
    assert.equal((await readTrialVerifierSummary(root)).officialReward,1);
    await rm(join(verifier,"reward.json"));
    for(const text of ["","  \n","not-a-number\n"]){
      await writeFile(join(verifier,"reward.txt"),text);
      assert.equal(Object.hasOwn(await readTrialVerifierSummary(root),"officialReward"),false);
    }
  }finally{await rm(root,{recursive:true,force:true})}
});

test("Terminal-Bench verifier summary normalizes trace-results counts",()=>{
  assert.deepEqual(normalizeTraceResultsVerifierSummary({total_cases:20,passed_cases:15,partial_score:.75}),{tests:20,passed:15,failed:5,pending:0,skipped:0,other:0});
  assert.equal(normalizeTraceResultsVerifierSummary({total_cases:0,passed_cases:0}),null);
  assert.equal(normalizeTraceResultsVerifierSummary({total_cases:3,passed_cases:4}),null);
});

test("Terminal-Bench verifier summary aggregates completed trial CTRF files",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-ctrf-summary-")),job="job";
  try{
    for(const [trial,summary] of [["trial-a",{tests:6,passed:5,failed:1,pending:0,skipped:0,other:0}],["trial-b",{tests:4,passed:3,failed:0,pending:1,skipped:0,other:0}]]){
      const verifier=join(root,job,trial,"verifier");await mkdir(verifier,{recursive:true});await writeFile(join(verifier,"ctrf.json"),JSON.stringify({results:{summary}}));
    }
    const traceVerifier=join(root,job,"trial-trace","verifier");await mkdir(traceVerifier,{recursive:true});await writeFile(join(traceVerifier,"trace_results.json"),JSON.stringify({total_cases:20,passed_cases:15,partial_score:.75}));
    await mkdir(join(root,job,"trial-without-verifier-summary"),{recursive:true});
    assert.deepEqual(await readJobVerifierSummary(root,job),{trials:3,tests:30,passed:23,failed:6,pending:1,skipped:0,other:0});
  }finally{await rm(root,{recursive:true,force:true})}
});

test("Terminal-Bench verifier summary reads a trace-results trial directly when CTRF is absent",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-trace-trial-"));
  try{
    const verifier=join(root,"verifier");await mkdir(verifier,{recursive:true});
    await writeFile(join(verifier,"trace_results.json"),JSON.stringify({total_cases:20,passed_cases:19,partial_score:.95}));
    assert.deepEqual(await readTrialVerifierSummary(root),{trials:1,tests:20,passed:19,failed:1,pending:0,skipped:0,other:0});
  }finally{await rm(root,{recursive:true,force:true})}
});

test("Terminal-Bench verifier summary reads one regraded trial directly",async()=>{
  const root=await mkdtemp(join(tmpdir(),"trebell-ctrf-trial-"));
  try{
    const verifier=join(root,"verifier");await mkdir(verifier,{recursive:true});
    await writeFile(join(verifier,"ctrf.json"),JSON.stringify({results:{summary:{tests:4,passed:3,failed:1,pending:0,skipped:0,other:0}}}));
    assert.deepEqual(await readTrialVerifierSummary(root),{trials:1,tests:4,passed:3,failed:1,pending:0,skipped:0,other:0});
  }finally{await rm(root,{recursive:true,force:true})}
});
