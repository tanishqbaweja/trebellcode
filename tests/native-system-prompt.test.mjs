import test from "node:test";
import assert from "node:assert/strict";
import { nativeSystemPrompt } from "../src/native-system-prompt.mjs";

test("Native system prompt teaches evidence-driven coding without inventing unavailable capabilities",()=>{
  const prompt=nativeSystemPrompt({
    permissionMode:"supervised",
    projectless:false,
    tools:[
      {name:"trebell_repo"},
      {name:"trebell_workspace"},
      {name:"trebell_terminal"},
      {name:"trebell_browser"},
    ],
  });
  assert.match(prompt,/first-party autonomous software-engineering agent/i);
  assert.match(prompt,/Inspect relevant state/i);
  assert.match(prompt,/Claim success only from Trebell evidence/i);
  assert.match(prompt,/exact paths, commands, URLs/i);
  assert.match(prompt,/comments inside suspect implementation code as hypotheses/i);
  assert.match(prompt,/deterministic local reproducer/i);
  assert.match(prompt,/authoritative fixtures, configuration, schemas, or data files/i);
  assert.match(prompt,/compact audit of semantically meaningful input fields/i);
  assert.match(prompt,/unexplained unused field tied to an acceptance concept/i);
  assert.match(prompt,/Do not mechanically force metadata or unrelated fields/i);
  assert.match(prompt,/multiple separately named thresholds for the same resource or state/i);
  assert.match(prompt,/preserve them as distinct concepts/i);
  assert.match(prompt,/target\/reserve and a hard minimum\/maximum/i);
  assert.match(prompt,/boundary where one threshold is satisfied and the other is not/i);
  assert.match(prompt,/planner, solver, scheduler, allocator, generator/i);
  assert.match(prompt,/unexpected universal failure, infeasible, empty, or no-solution outcome/i);
  assert.match(prompt,/constraints shape construction\/selection itself rather than only reject the result afterward/i);
  assert.match(prompt,/make that conclusion evidence-based/i);
  assert.match(prompt,/arbitrary runtime inputs, policies, configuration, schemas, or equivalent variants/i);
  assert.match(prompt,/cheap counterfactual case/i);
  assert.match(prompt,/required fields from optional fields, defaulted fields, and conditionally valid fields/i);
  assert.match(prompt,/validate a field when supplied does not by itself make that field required/i);
  assert.match(prompt,/optional field is omitted but an alternate documented acceptance condition is satisfied/i);
  assert.match(prompt,/do not infer stricter requiredness than the contract states/i);
  assert.match(prompt,/canonical happy path through the public entry point/i);
  assert.match(prompt,/documented defaults or fallbacks/i);
  assert.match(prompt,/branches by runtime, persistence mode, transport, adapter, test runner, bundler/i);
  assert.match(prompt,/passing browser, mock, or in-memory path is not evidence/i);
  assert.match(prompt,/one Node launcher is not evidence that a transformed\/test-runner Node surface behaves identically/i);
  assert.match(prompt,/baseline parity check/i);
  assert.match(prompt,/multiple routes, workflows, components, or acceptance surfaces/i);
  assert.match(prompt,/cover them breadth-first/i);
  assert.match(prompt,/account for every explicitly named surface/i);
  assert.match(prompt,/prove live state is preserved while ineligible/i);
  assert.match(prompt,/one-item reproducer is not sufficient evidence/i);
  assert.match(prompt,/two-item partial-progress\/interleaving check/i);
  assert.match(prompt,/check each class separately/i);
  assert.match(prompt,/after a merge or state transition/i);
  assert.match(prompt,/end-to-end critical path/i);
  assert.match(prompt,/Parallelizing independent waits still blocks first useful output/i);
  assert.match(prompt,/nonessential secondary side effects off a latency-critical mutation response path/i);
  assert.match(prompt,/focused timing\/runtime check/i);
  assert.match(prompt,/Optimize the measured performance boundary/i);
  assert.match(prompt,/one-time setup\/preprocessing/i);
  assert.match(prompt,/invariant parsing, indexing, serialization, allocation, object conversion, compilation, graph preparation/i);
  assert.match(prompt,/explicit invalidation when the source mutates/i);
  assert.match(prompt,/Measure cold and warm behavior separately/i);
  assert.match(prompt,/quantitative target/i);
  assert.match(prompt,/acceptance gate/i);
  assert.match(prompt,/representative baseline and candidate path/i);
  assert.match(prompt,/one-shot benchmark, deployment, cutover, migration completion, release/i);
  assert.match(prompt,/pre-activation benchmark or bounded proxy/i);
  assert.match(prompt,/official metric is hidden/i);
  assert.match(prompt,/hidden, randomized, workload-dependent/i);
  assert.match(prompt,/broader deterministic matrix/i);
  assert.match(prompt,/distribution and weakest cases/i);
  assert.match(prompt,/meaningful headroom/i);
  assert.match(prompt,/Batch independent read-only/i);
  assert.match(prompt,/explicit user ordering constraints/i);
  assert.match(prompt,/exposed repository tools/i);
  assert.match(prompt,/repository seed already names likely relevant paths/i);
  assert.match(prompt,/edit calls together in one model response/i);
  assert.match(prompt,/executes non-parallel edits in order/i);
  assert.match(prompt,/stop speculative polishing/i);
  assert.match(prompt,/acceptance-critical behavior/i);
  assert.match(prompt,/reasonably testable requirement as unverified/i);
  assert.match(prompt,/Before declaring an integration, service, daemon, endpoint, or runtime environment unavailable/i);
  assert.match(prompt,/existing run scripts\/configuration/i);
  assert.match(prompt,/bounded end-to-end smoke check over mocks alone/i);
  assert.match(prompt,/semantic refactors/i);
  assert.match(prompt,/trebell_repo\/discover/i);
  assert.match(prompt,/trebell_repo\/invoke/i);
  assert.match(prompt,/include those labels in verification_assess/i);
  assert.match(prompt,/isolated browser/i);
  assert.match(prompt,/Permission profile: supervised/);
  assert.doesNotMatch(prompt,/Delegate only/i);
  assert.doesNotMatch(prompt,/source-control tools/i);
  assert.match(prompt,/untrusted data/i);
});

test("Native system prompt describes only dynamically exposed specialized capabilities",()=>{
  const prompt=nativeSystemPrompt({
    permissionMode:"read-only",
    projectless:true,
    tools:[
      {name:"trebell_workspace"},
      {name:"trebell_terminal"},
      {name:"trebell_source_control"},
      {name:"trebell_delegate"},
      {name:"trebell_mcp"},
    ],
  });
  assert.match(prompt,/General chat/);
  assert.match(prompt,/source-control tools/i);
  assert.match(prompt,/Delegate only/i);
  assert.match(prompt,/MCP capabilities/i);
  assert.doesNotMatch(prompt,/isolated browser/i);
  assert.match(prompt,/Permission profile: read-only/);
});
