import test from "node:test";
import assert from "node:assert/strict";
import { verificationEvidenceMeta, verificationEvidenceSummary, verificationEvidenceView } from "../ui/src/verification-evidence-view.js";

test("verification evidence view exposes reviewable facts without raw secret-bearing evidence",()=>{
  const result={record:{id:"verification-1",status:"incomplete",risk:"medium",updatedAt:10,plan:{risk:"medium",steps:[
    {id:"diagnostics",kind:"diagnostics",scope:"changed",required:true,reason:"Catch syntax problems"},
    {id:"project_tests",kind:"tests",scope:"project",required:true,reason:"Run project tests",command:"npm test -- --token TOP_SECRET_COMMAND"},
    {id:"visual",kind:"visual",scope:"changed-flow",required:true,reason:"Review the changed flow"},
  ]},evidence:[
    {stepId:"diagnostics",status:"passed",source:"harness-diagnostics",errorCount:0,coveredPaths:["src/a.js","src/b.js"],engines:["babel-parser"],rawOutput:"TOP_SECRET_OUTPUT"},
    {stepId:"project_tests",status:"passed",source:"runtime-trace",exitCode:0,stdout:"PRIVATE_STDOUT",stderr:"PRIVATE_STDERR",toolCallId:"tests-1"},
  ],assessment:{status:"incomplete",risk:"medium",results:[
    {id:"diagnostics",status:"passed",reason:"TOP_SECRET_ASSESSMENT_REASON",evidence:{rawOutput:"TOP_SECRET_ASSESSMENT"}},
    {id:"project_tests",status:"passed",reason:"Command exited successfully."},
    {id:"visual",status:"incomplete",reason:"No evidence was recorded for this required step."},
  ]}},nextAction:{action:"verify",nextStep:{id:"visual"}}};
  const view=verificationEvidenceView(result);assert.equal(view.required,3);assert.equal(view.passed,2);assert.equal(view.missing,1);assert.equal(view.nextStepId,"visual");
  assert.deepEqual(view.rows[0],{id:"diagnostics",kind:"diagnostics",scope:"changed",required:true,status:"passed",source:"harness-diagnostics",reason:"Catch syntax problems",exitCode:null,errorCount:0,coveredPathCount:2,engines:["babel-parser"],semantic:false});
  assert.equal(verificationEvidenceMeta(view.rows[1]),"runtime-trace · exit 0");assert.match(verificationEvidenceSummary(view),/2\/3 required checks passed · 1 still required/);
  const rendered=JSON.stringify(view);for(const secret of ["TOP_SECRET_COMMAND","TOP_SECRET_OUTPUT","PRIVATE_STDOUT","PRIVATE_STDERR","TOP_SECRET_ASSESSMENT","TOP_SECRET_ASSESSMENT_REASON"])assert.doesNotMatch(rendered,new RegExp(secret));
});

test("verification evidence view handles missing records and deterministic failure summaries",()=>{
  assert.equal(verificationEvidenceView({record:null}),null);assert.equal(verificationEvidenceSummary(null),"No verification evidence recorded");
  const view=verificationEvidenceView({record:{id:"v2",status:"failed",plan:{steps:[{id:"tests",kind:"tests",required:true}]},evidence:[{stepId:"tests",status:"failed",source:"turn-tool",exitCode:2}],assessment:{results:[{id:"tests",status:"failed",reason:"Command exited with code 2."}]}},nextAction:{action:"repair"}});assert.equal(view.failed,1);assert.match(verificationEvidenceSummary(view),/1 failed/);assert.equal(verificationEvidenceMeta(view.rows[0]),"turn-tool · exit 2");
});
