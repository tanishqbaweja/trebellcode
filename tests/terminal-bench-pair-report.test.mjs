import test from "node:test";
import assert from "node:assert/strict";
import { jobsForPairReport, SEALED_LIVE_DETAIL } from "../scripts/terminal-bench-pair-report.mjs";

test("live Terminal-Bench pair reports seal free-form lane errors without mutating source jobs",()=>{
  const jobs=[{
    label:"codex-api",
    runError:"harbor failed with sensitive task-bearing output",
    exceptionType:"NonZeroAgentExitCodeError",
    exceptionMessage:"codex exec -- 'full task instruction'",
    reward:0,
  }];
  const live=jobsForPairReport(jobs,{complete:false});

  assert.notEqual(live,jobs);
  assert.equal(live[0].runError,SEALED_LIVE_DETAIL);
  assert.equal(live[0].exceptionMessage,SEALED_LIVE_DETAIL);
  assert.equal(live[0].exceptionType,"NonZeroAgentExitCodeError");
  assert.equal(live[0].reward,0);
  assert.match(jobs[0].exceptionMessage,/full task instruction/);
});

test("completed Terminal-Bench pair reports retain full lane diagnostics",()=>{
  const jobs=[{
    label:"native",
    runError:null,
    exceptionType:"ProviderError",
    exceptionMessage:"full post-run diagnostic",
  }];
  const complete=jobsForPairReport(jobs,{complete:true});

  assert.equal(complete,jobs);
  assert.equal(complete[0].exceptionMessage,"full post-run diagnostic");
});

test("live Terminal-Bench pair reports preserve null error details",()=>{
  const [job]=jobsForPairReport([{runError:null,exceptionMessage:null}],{complete:false});
  assert.equal(job.runError,null);
  assert.equal(job.exceptionMessage,null);
});
