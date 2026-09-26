import test from "node:test";
import assert from "node:assert/strict";
import { collectVerificationEvidence } from "../src/verification-evidence-collector.mjs";

test("verification evidence collector binds completed Native diagnostics and commands without storing output",()=>{
  const plan={paths:["src/a.ts","src/b.ts","README.md"],steps:[
    {id:"diagnostics",kind:"diagnostics",required:true},
    {id:"typecheck",kind:"command",required:true,command:"npm run typecheck"},
    {id:"project_tests",kind:"tests",required:true,command:"npm test"},
  ]};
  const turnItems=[
    {type:"dynamicToolCall",id:"diag-a",namespace:"trebell_repo",tool:"diagnostics",status:"completed",arguments:{path:"src/a.ts"},rawOutput:{path:"src/a.ts",diagnostics:[],semanticDiagnostics:[]}},
    {type:"dynamicToolCall",id:"diag-b",namespace:"trebell_repo",tool:"diagnostics",status:"completed",arguments:{path:"src/b.ts"},rawOutput:{path:"src/b.ts",diagnostics:[],semanticDiagnostics:[]}},
    {type:"dynamicToolCall",id:"typecheck-1",namespace:"trebell_terminal",tool:"run",status:"completed",arguments:{command:"npm",args:["run","typecheck"]},rawOutput:{exitCode:0,stdout:"huge output should not persist"}},
    {type:"dynamicToolCall",id:"tests-1",namespace:"trebell_terminal",tool:"run",status:"completed",arguments:{command:"npm",args:["test","--","src/a.test.ts"]},rawOutput:{exitCode:1,stderr:"private failure output"}},
  ];
  const evidence=collectVerificationEvidence({plan,turnItems});assert.equal(evidence.length,3);
  assert.deepEqual(evidence[0],{stepId:"diagnostics",status:"passed",errorCount:0,source:"turn-tool",toolCallIds:["diag-a","diag-b"],coveredPaths:["src/a.ts","src/b.ts"]});
  assert.deepEqual(evidence[1],{stepId:"typecheck",status:"passed",exitCode:0,source:"turn-tool",toolCallId:"typecheck-1"});
  assert.deepEqual(evidence[2],{stepId:"project_tests",status:"failed",exitCode:1,source:"turn-tool",toolCallId:"tests-1"});
  assert.doesNotMatch(JSON.stringify(evidence),/huge output|private failure/);
});

test("verification evidence collector uses bounded Codex command traces and ignores unrelated commands",()=>{
  const plan={paths:["src/a.js"],steps:[{id:"tests",kind:"tests",required:true,command:"npm run test"},{id:"build",kind:"command",required:true,command:"npm run build"}]};
  const traces=[
    {name:"item/completed",data:{item:{id:"lint",command:["npm","run","lint"],exitCode:0}}},
    {name:"item/completed",data:{item:{id:"tests",command:["npm","test"],exitCode:0}}},
  ];
  assert.deepEqual(collectVerificationEvidence({plan,traces}),[{stepId:"tests",status:"passed",exitCode:0,source:"runtime-trace",toolCallId:"tests"}]);
});

test("diagnostics evidence stays incomplete until every changed source target was actually checked",()=>{
  const plan={paths:["src/a.ts","src/b.ts"],steps:[{id:"diagnostics",kind:"diagnostics",required:true}]};
  const turnItems=[{type:"dynamicToolCall",id:"diag-a",namespace:"trebell_repo",tool:"diagnostics",status:"completed",arguments:{path:"src/a.ts"},rawOutput:{path:"src/a.ts",diagnostics:[]}}];
  assert.deepEqual(collectVerificationEvidence({plan,turnItems}),[]);
});

test("verification evidence collector converts sanitized browser receipts into planned browser evidence",()=>{
  const plan={steps:[
    {id:"browser_interaction",kind:"browser",required:true},
    {id:"browser_runtime",kind:"browser-runtime",required:true},
    {id:"visual",kind:"visual",required:true,evidence:["screenshot","responsive-viewport"]},
  ]};
  const traces=[
    {name:"verification.browser_evidence",data:{namespace:"trebell_browser",tool:"open",success:true,interaction:true,passed:true,callId:"open-1",url:"https://should-not-survive.invalid"}},
    {name:"verification.browser_evidence",data:{namespace:"trebell_browser",tool:"click",success:false,interaction:true,passed:false,callId:"click-stale"}},
    {name:"verification.browser_evidence",data:{namespace:"trebell_browser",tool:"click",success:true,interaction:true,passed:true,callId:"click-2"}},
    {name:"verification.browser_evidence",data:{namespace:"trebell_browser",tool:"set_viewport",success:true,viewport:true,width:390,height:844,callId:"viewport-mobile"}},
    {name:"verification.browser_evidence",data:{namespace:"trebell_browser",tool:"screenshot",success:true,screenshot:true,width:390,height:844,callId:"shot-mobile",dataUrl:"TOP_SECRET_IMAGE"}},
    {name:"verification.browser_evidence",data:{namespace:"trebell_browser",tool:"set_viewport",success:true,viewport:true,width:1280,height:800,callId:"viewport-desktop"}},
    {name:"verification.browser_evidence",data:{namespace:"trebell_browser",tool:"screenshot",success:true,screenshot:true,width:1280,height:800,callId:"shot-desktop"}},
    {name:"verification.browser_evidence",data:{namespace:"trebell_browser",tool:"runtime",success:true,consoleErrorCount:0,networkFailureCount:0,viewportCount:2,callId:"runtime-1",consoleErrors:["PRIVATE_CONSOLE"]}},
  ];
  const evidence=collectVerificationEvidence({plan,traces});
  assert.deepEqual(evidence,[
    {stepId:"browser_interaction",status:"passed",passed:true,source:"browser-receipt",interactionCount:3,toolCallIds:["open-1","click-stale","click-2"]},
    {stepId:"browser_runtime",status:"passed",consoleErrorCount:0,networkFailureCount:0,source:"browser-receipt",toolCallId:"runtime-1"},
    {stepId:"visual",screenshots:2,viewports:2,source:"browser-receipt",toolCallIds:["shot-mobile","shot-desktop","viewport-mobile","viewport-desktop"]},
  ]);
  assert.doesNotMatch(JSON.stringify(evidence),/should-not-survive|TOP_SECRET_IMAGE|PRIVATE_CONSOLE/);
});

test("failed browser runtime receipt cannot look like a clean runtime check",()=>{
  const plan={steps:[{id:"browser_runtime",kind:"browser-runtime",required:true}]},traces=[{name:"verification.browser_evidence",data:{namespace:"trebell_browser",tool:"runtime",success:false,consoleErrorCount:0,networkFailureCount:0,callId:"runtime-failed"}}];
  assert.deepEqual(collectVerificationEvidence({plan,traces}),[{stepId:"browser_runtime",status:"failed",source:"browser-receipt",toolCallId:"runtime-failed"}]);
});
