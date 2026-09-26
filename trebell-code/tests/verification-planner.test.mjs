import test from "node:test";
import assert from "node:assert/strict";
import { planVerification } from "../src/verification-planner.mjs";

const commands={declared:[
  {command:"pnpm run test",kind:"test",confidence:"declared"},
  {command:"pnpm run typecheck",kind:"typecheck",confidence:"declared"},
  {command:"pnpm run build",kind:"build",confidence:"declared"},
]};

test("TypeScript verification prefers diagnostics, typecheck, then related tests",()=>{
  const plan=planVerification({changedPaths:["src/context-engine.ts"],projectCommands:commands,relatedTests:["tests/context-engine.test.ts"],capabilities:{semanticDiagnostics:true}});
  assert.equal(plan.risk,"medium");
  assert.deepEqual(plan.steps.map(step=>step.id),["diagnostics","typecheck","targeted_tests"]);
  assert.equal(plan.steps[0].semantic,true);
  assert.equal(plan.steps[1].command,"pnpm run typecheck");
  assert.deepEqual(plan.steps[2].targets,["tests/context-engine.test.ts"]);
  assert.equal(plan.independentReview,false);
});

test("frontend verification always includes browser runtime and visual evidence",()=>{
  const plan=planVerification({changedPaths:["ui/src/components/Composer.tsx"],projectCommands:commands,relatedTests:["ui/e2e/composer.spec.ts"]});
  assert.equal(plan.categories.frontend,true);
  assert.ok(plan.steps.some(step=>step.id==="browser_interaction"));
  assert.deepEqual(plan.steps.find(step=>step.id==="browser_runtime").evidence,["console","network"]);
  assert.deepEqual(plan.steps.find(step=>step.id==="visual").evidence,["screenshot","responsive-viewport"]);
});

test("auth and storage changes escalate to high-risk integration evidence",()=>{
  const plan=planVerification({changedPaths:["src/auth/session.ts","src/storage/schema.ts"],projectCommands:commands,relatedTests:["tests/auth-session.test.ts"]});
  assert.equal(plan.risk,"high");
  assert.equal(plan.independentReview,true);
  assert.ok(plan.steps.some(step=>step.id==="integration"&&step.required));
  assert.ok(plan.steps.some(step=>step.id==="build"&&step.command==="pnpm run build"));
});

test("documentation-only changes avoid expensive verification",()=>{
  const plan=planVerification({changedPaths:["README.md","docs/architecture.mdx"],projectCommands:commands});
  assert.equal(plan.risk,"low");
  assert.equal(plan.categories.docsOnly,true);
  assert.deepEqual(plan.steps.map(step=>step.id),["diff_review"]);
});

test("Rust changes use cargo check convention when no declared typecheck exists",()=>{
  const plan=planVerification({changedPaths:["src/main.rs"],projectCommands:{conventional:[{command:"cargo check",kind:"typecheck",confidence:"convention"},{command:"cargo test",kind:"test",confidence:"convention"}]}});
  assert.equal(plan.categories.rust,true);
  assert.equal(plan.steps[0].id,"rust_check");
  assert.equal(plan.steps[0].command,"cargo check");
  assert.ok(plan.steps.some(step=>step.id==="project_tests"&&step.command==="cargo test"));
});

test("Python changes use deterministic diagnostics and discovered project tests",()=>{
  const plan=planVerification({
    changedPaths:["src/service.py"],
    projectCommands:{declared:[{name:"test",command:"python -m pytest",kind:"test",confidence:"declared"}],conventional:[]},
    capabilities:{diagnostics:true,semanticDiagnostics:true},
  });
  assert.equal(plan.categories.python,true);assert.equal(plan.risk,"medium");assert.match(plan.reasons.join(" "),/Python changes benefit from AST syntax diagnostics/i);
  const diagnostics=plan.steps.find(step=>step.id==="diagnostics");assert.ok(diagnostics);assert.equal(diagnostics.semantic,true);assert.match(diagnostics.reason,/Python syntax/i);
  const tests=plan.steps.find(step=>step.id==="project_tests");assert.ok(tests);assert.equal(tests.command,"python -m pytest");
});
