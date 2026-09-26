import test from "node:test";
import assert from "node:assert/strict";
import { runAutomaticVerificationEvidence } from "../src/verification-auto-runner.mjs";

test("automatic verification runs only the missing deterministic diagnostics step",async()=>{
  const calls=[],contextEngine={diagnostics:async args=>{calls.push(args);return {supported:true,engine:"babel-parser",semantic:false,diagnostics:[],semanticDiagnostics:[]}}};
  const plan={paths:["src/a.js","src/b.ts","README.md"],steps:[{id:"diagnostics",kind:"diagnostics",cost:"low",required:true},{id:"tests",kind:"tests",cost:"medium",required:true,command:"npm test"}]};
  const result=await runAutomaticVerificationEvidence({contextEngine,plan,root:"/repo"});assert.equal(calls.length,2);assert.deepEqual(calls.map(item=>item.path),["src/a.js","src/b.ts"]);
  assert.deepEqual(result.evidence,[{stepId:"diagnostics",status:"passed",errorCount:0,source:"harness-diagnostics",coveredPaths:["src/a.js","src/b.ts"],engines:["babel-parser"],semantic:false}]);assert.equal(result.nextAction.action,"verify");assert.equal(result.nextAction.nextStep.id,"tests");
});

test("automatic diagnostics failure immediately routes verification back to repair",async()=>{
  const contextEngine={diagnostics:async()=>({supported:true,engine:"babel-parser",diagnostics:[{severity:"error",message:"broken"}],semanticDiagnostics:[]})};
  const plan={paths:["src/a.js"],steps:[{id:"diagnostics",kind:"diagnostics",cost:"low",required:true}]};
  const result=await runAutomaticVerificationEvidence({contextEngine,plan,root:"/repo"});assert.equal(result.evidence[0].status,"failed");assert.equal(result.evidence[0].errorCount,1);assert.equal(result.nextAction.action,"repair");assert.deepEqual(result.nextAction.failedSteps,["diagnostics"]);
});

test("unavailable deterministic diagnostics block verification instead of self-certifying",async()=>{
  const contextEngine={diagnostics:async()=>({supported:false,engine:null,reason:"Language adapter unavailable"})};
  const plan={paths:["src/a.ts"],steps:[{id:"diagnostics",kind:"diagnostics",cost:"low",required:true}]};
  const result=await runAutomaticVerificationEvidence({contextEngine,plan,root:"/repo"});assert.equal(result.evidence[0].status,"blocked");assert.match(result.evidence[0].reason,/adapter unavailable/i);assert.equal(result.nextAction.action,"resolve_blocker");
});

test("automatic verification does not execute command, browser, or integration steps",async()=>{
  let calls=0;const contextEngine={diagnostics:async()=>{calls++;return {supported:true,diagnostics:[]}}};
  const plan={paths:["src/a.js"],steps:[{id:"tests",kind:"tests",cost:"low",required:true,command:"npm test"}]};
  const result=await runAutomaticVerificationEvidence({contextEngine,plan,root:"/repo"});assert.equal(calls,0);assert.deepEqual(result.evidence,[]);assert.equal(result.nextAction.nextStep.id,"tests");
});

test("automatic verification runs Python diagnostics through the existing Context Engine adapter",async()=>{
  const calls=[],contextEngine={diagnostics:async args=>{calls.push(args);return {supported:true,engine:"python-ast",semantic:false,diagnostics:[],semanticDiagnostics:[]}}};
  const plan={paths:["src/service.py","src/types.pyi","README.md"],steps:[{id:"diagnostics",kind:"diagnostics",cost:"low",required:true}]};
  const result=await runAutomaticVerificationEvidence({contextEngine,plan,root:"/repo"});assert.deepEqual(calls.map(item=>item.path),["src/service.py","src/types.pyi"]);assert.equal(result.evidence[0].status,"passed");assert.deepEqual(result.evidence[0].coveredPaths,["src/service.py","src/types.pyi"]);assert.deepEqual(result.evidence[0].engines,["python-ast"]);assert.equal(result.nextAction.action,"complete");
});
