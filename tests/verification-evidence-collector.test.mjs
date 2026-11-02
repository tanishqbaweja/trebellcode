import test from "node:test";
import assert from "node:assert/strict";
import { assessVerification } from "../src/verification-assessor.mjs";
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

test("diagnostics evidence collector includes Python source targets",()=>{
  const plan={paths:["src/service.py"],steps:[{id:"diagnostics",kind:"diagnostics",required:true}]};
  const turnItems=[{type:"dynamicToolCall",id:"diag-python",namespace:"trebell_repo",tool:"diagnostics",status:"completed",arguments:{path:"src/service.py"},rawOutput:{path:"src/service.py",diagnostics:[],semanticDiagnostics:[]}}];
  assert.deepEqual(collectVerificationEvidence({plan,turnItems}),[{stepId:"diagnostics",status:"passed",errorCount:0,source:"turn-tool",toolCallIds:["diag-python"],coveredPaths:["src/service.py"]}]);
});

test("diagnostics evidence collector includes Go source targets",()=>{
  const plan={paths:["cmd/server/main.go"],steps:[{id:"diagnostics",kind:"diagnostics",required:true}]};
  const turnItems=[{type:"dynamicToolCall",id:"diag-go",namespace:"trebell_repo",tool:"diagnostics",status:"completed",arguments:{path:"cmd/server/main.go"},rawOutput:{path:"cmd/server/main.go",diagnostics:[],semanticDiagnostics:[]}}];
  assert.deepEqual(collectVerificationEvidence({plan,turnItems}),[{stepId:"diagnostics",status:"passed",errorCount:0,source:"turn-tool",toolCallIds:["diag-go"],coveredPaths:["cmd/server/main.go"]}]);
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

test("responsive visual evidence counts only viewport sizes that were actually screenshotted",()=>{
  const plan={steps:[{id:"visual",kind:"visual",required:true,evidence:["screenshot","responsive-viewport"]}]},traces=[
    {name:"verification.browser_evidence",data:{namespace:"trebell_browser",tool:"set_viewport",success:true,viewport:true,width:390,height:844,callId:"viewport-mobile"}},
    {name:"verification.browser_evidence",data:{namespace:"trebell_browser",tool:"screenshot",success:true,screenshot:true,width:390,height:844,callId:"shot-mobile"}},
    {name:"verification.browser_evidence",data:{namespace:"trebell_browser",tool:"set_viewport",success:true,viewport:true,width:1280,height:800,callId:"viewport-desktop"}},
    {name:"verification.browser_evidence",data:{namespace:"trebell_browser",tool:"runtime",success:true,consoleErrorCount:0,networkFailureCount:0,viewportCount:2,callId:"runtime-1"}},
  ];
  assert.deepEqual(collectVerificationEvidence({plan,traces}),[
    {stepId:"visual",screenshots:1,viewports:1,source:"browser-receipt",toolCallIds:["shot-mobile","viewport-mobile"]},
  ]);
});

test("a check turn's last command is its behavioral step's check: passed on exit 0, failed otherwise, and only for the step it ran",()=>{
  const plan={paths:["parse-kv.js"],steps:[{id:"diagnostics",kind:"diagnostics",required:true},{id:"focused_behavior",kind:"behavioral",required:true,evidence:["stated-acceptance-behavior"]}]};
  const run=(id,command,exitCode)=>({type:"dynamicToolCall",id,namespace:"trebell_terminal",tool:"run",status:exitCode===0?"completed":"failed",arguments:{command,args:["check.js"]},rawOutput:{exitCode,stdout:"PRIVATE"}});
  const passed=collectVerificationEvidence({plan,turnItems:[run("look","cat",1),run("check","node",0)],checkedStepId:"focused_behavior"});
  assert.deepEqual(passed,[{stepId:"focused_behavior",status:"passed",exitCode:0,evidence:["stated-acceptance-behavior"],source:"turn-tool",toolCallId:"check"}]);
  assert.equal(assessVerification({plan:{steps:[plan.steps[1]]},evidence:passed}).status,"verified");
  const failed=collectVerificationEvidence({plan,turnItems:[run("check","node",2)],checkedStepId:"focused_behavior"});
  assert.equal(failed[0].status,"failed");assert.equal(assessVerification({plan:{steps:[plan.steps[1]]},evidence:failed}).status,"failed");
  // A working turn's own commands, and a check turn for another step, are no behavioral check.
  assert.deepEqual(collectVerificationEvidence({plan,turnItems:[run("check","node",0)]}),[]);
  assert.deepEqual(collectVerificationEvidence({plan,turnItems:[run("check","node",0)],checkedStepId:"diagnostics"}),[]);
  // Codex's commands come as journal traces, newest first.
  const traces=[{name:"item/completed",data:{item:{id:"newest",command:"node check.js",exitCode:0}}},{name:"item/completed",data:{item:{id:"older",command:"node broken.js",exitCode:1}}}];
  assert.deepEqual(collectVerificationEvidence({plan,traces,checkedStepId:"focused_behavior"}).map(item=>[item.toolCallId,item.status]),[["newest","passed"]]);
  assert.doesNotMatch(JSON.stringify(passed),/PRIVATE/);
});

test("a command with no exit code (declined, or never started) neither passes nor fails a check",()=>{
  const plan={steps:[{id:"tests",kind:"tests",required:true,command:"npm test"},{id:"focused_behavior",kind:"behavioral",required:true,evidence:["stated-acceptance-behavior"]}]};
  const traces=[{name:"item/completed",data:{item:{id:"declined",type:"commandExecution",command:"npm test",status:"declined",exitCode:null}}}];
  assert.deepEqual(collectVerificationEvidence({plan,traces}),[]);
  assert.deepEqual(collectVerificationEvidence({plan,traces,checkedStepId:"focused_behavior"}),[]);
  assert.deepEqual(collectVerificationEvidence({plan,traces:[{name:"item/completed",data:{item:{id:"ran",command:"npm test",exitCode:0}}}]}),[{stepId:"tests",status:"passed",exitCode:0,source:"runtime-trace",toolCallId:"ran"}]);
});

test("a check turn whose last command has no exit code keeps no result for its behavioral step, never an earlier command's",()=>{
  const plan={steps:[{id:"focused_behavior",kind:"behavioral",required:true,evidence:["stated-acceptance-behavior"]}]},checked={plan,checkedStepId:"focused_behavior"};
  // A harness's command items (the relays'): a look that exited 0, then the check, which failed with no exit code (as a command Muse
  // Code's sandbox refused), was stopped with its turn, never ended or never started.
  const look={type:"commandExecution",id:"look",command:"git status --short",status:"completed",exitCode:0};
  const check=(status,exitCode=null)=>({type:"commandExecution",id:"check",command:"node check-behavior.js",status,exitCode});
  for(const status of ["failed","stopped","inProgress","pending"])assert.deepEqual(collectVerificationEvidence({...checked,turnItems:[look,check(status)]}),[],status);
  // Native's run that could not start, or that its policy refused: success false and no exit code.
  const native=(id,command,status,rawOutput)=>({type:"dynamicToolCall",id,namespace:"trebell_terminal",tool:"run",status,arguments:{command,args:["check.js"]},rawOutput});
  const nativeLook=native("look","cat","completed",{success:true,exitCode:0});
  assert.deepEqual(collectVerificationEvidence({...checked,turnItems:[nativeLook,native("check","node","failed",{success:false,error:"spawn node ENOENT"})]}),[]);
  assert.deepEqual(collectVerificationEvidence({...checked,turnItems:[nativeLook,native("check","node","failed",{success:false,decision:"REJECT",error:"Blocked by policy."})]}),[]);
  // Codex's journal, newest first: its newest command has no exit code.
  const traces=[{name:"item/completed",data:{item:{id:"check",command:"node check.js",status:"failed",exitCode:null}}},{name:"item/completed",data:{item:{id:"look",command:"git status",exitCode:0}}}];
  assert.deepEqual(collectVerificationEvidence({...checked,traces}),[]);
  // The same last command with an exit code is the check.
  assert.deepEqual(collectVerificationEvidence({...checked,turnItems:[look,check("failed",1)]}).map(item=>[item.toolCallId,item.status]),[["check","failed"]]);
  assert.deepEqual(collectVerificationEvidence({...checked,turnItems:[nativeLook,native("check","node","completed",{success:true,exitCode:0})]}).map(item=>[item.toolCallId,item.status]),[["check","passed"]]);
});
