# Trebell Code Benchmarks

This file is the canonical home for Trebell Code benchmark definitions, commands, methodology, and recorded results. New benchmark work should be documented here rather than living only in terminal output, chat history, or ad-hoc notes.

## Benchmark rules

- Compare harnesses on the same task, starting repository tree, model, and effective write/execute permissions whenever the comparison is intended to measure harness quality.
- Use an independent verifier after the harness finishes. A harness does not get credit merely for claiming success.
- Do not weaken or edit the verifier during a run.
- Record unsupported metrics as `n/a`; do not turn missing telemetry into zero.
- Keep setup-invalid runs separate from counted results. Examples: wrong sandbox permissions, unavailable model, broken benchmark harness, or provider request rejected before the coding task begins.
- Do not draw a broad superiority conclusion from a single task or a single stochastic run. Repeat tasks and expand the task set.
- Prefer end-to-end coding tasks over microbenchmarks when deciding whether Trebell Native is becoming a stronger coding harness. Microbenchmarks remain useful for explaining *why* a harness is faster or cheaper.

## Live Trebell Native vs Codex baseline

### Webhook dispatcher concurrency + retry repair

Benchmark command:

```text
npm run bench:native-vs-codex:live
```

Benchmark implementation: `scripts/live-native-codex-coding-benchmark.mjs`

The fixture is created as one committed Git repository and cloned independently for each harness. Both harnesses receive the same task text and start from the same Git tree. The task requires repository inspection, edits across `src/dispatcher.mjs` and `src/retry-policy.mjs`, concurrency control, per-endpoint ordering, retry semantics, and execution of `node verify.mjs`. The benchmark independently runs `node verify.mjs` again and checks that `verify.mjs` was not changed.

Current comparison model: **`gpt-6-luna` on both harnesses**.

- Trebell Native: OpenAI API through the Native harness.
- Codex: signed-in Codex harness, explicitly forced to `gpt-6-luna`.
- Codex runs inside the disposable benchmark clone with approvals/sandbox bypassed so its effective benchmark permissions match Native's full workspace permissions. The temp repository is deleted after the run.
- Baseline fixture tree for the runs below: `f7bbc3f3f7a92eed49a368ef55d79769313a14ed`.
- Task SHA-256: `94ee5e26034f951dc42db5a76a60e3620b8e3b9f5131db406d5790c151f33199`.

### Counted paired runs

| Run | Model | Native verify | Native elapsed | Native tokens | Native cached input | Native model turns | Native tool calls | Codex verify | Codex elapsed | Codex tokens* | Codex cached input | Codex tool calls |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 2026-09-28 A | `gpt-6-luna` | PASS | 45.394 s | 27,784 | 20,841 | 7 | 8 | PASS | 75.871 s | 190,239 | 170,240 | 10 |
| 2026-09-28 B | `gpt-6-luna` | PASS | 37.405 s | 24,783 | 18,366 | 6 | 9 | PASS | 52.450 s | 135,011 | 120,832 | 7 |

\* Codex did not expose a populated `totalTokens` field in these CLI events, so Codex total is computed as reported input tokens + reported output tokens. Cached tokens are reported separately and are already part of provider input accounting; they are not added a second time.

### Two-run aggregate

| Metric | Trebell Native | Codex | Observed delta |
| --- | ---: | ---: | ---: |
| Independent verification success | 2 / 2 | 2 / 2 | tied on this fixture |
| Mean elapsed time | 41.400 s | 64.161 s | Native 35.5% lower |
| Mean total tokens | 26,284 | 162,625 | Native 83.8% lower |
| Mean cached input tokens | 19,604 | 145,536 | Native 86.5% lower reported volume |
| Mean tool calls | 8.5 | 8.5 | equal |
| Mean Native model turns | 6.5 | n/a | Codex CLI does not expose a directly comparable count here |

This is an **early baseline, not a general claim that Native is better than Codex**. It is one task with two counted paired runs. The large token gap is important enough to investigate, but it needs a broader task suite and more repetitions before it is treated as a stable harness-level result.

### Valid non-paired validation runs

These runs used the same Luna benchmark fixture but are not included in the paired aggregate above.

| Date | Harness | Model | Verify | Elapsed | Total tokens | Tool calls | Notes |
| --- | --- | --- | --- | ---: | ---: | ---: | --- |
| 2026-09-28 | Trebell Native | `gpt-6-luna` | PASS | 35.581 s | 24,117 | 9 | First valid Native Luna run after fixing nullable generation controls. |
| 2026-09-28 | Codex | `gpt-6-luna` | PASS | 46.735 s | 115,578* | 6 | Codex-only validation after benchmark permissions were corrected. |

### Excluded setup-invalid run

One Codex Luna run was excluded because the benchmark launched Codex with a permission configuration that left the disposable workspace effectively read-only. Codex made zero tool calls and explicitly reported that it could not edit files or run verification. This was a benchmark setup defect, not a Codex coding failure, and is not counted above.

## Automatically recorded Native-vs-Codex runs

Future executions of `npm run bench:native-vs-codex:live` append a compact row here. These raw run records are kept even when only one harness is selected for a diagnostic run; use the counted sections above for curated aggregates.

| Recorded at (UTC) | Model | Native | Native ms | Native tokens | Native tools | Codex | Codex ms | Codex tokens | Codex tools | Baseline tree |
| --- | --- | --- | ---: | ---: | ---: | --- | ---: | ---: | ---: | --- |
<!-- LIVE_NATIVE_CODEX_RUNS_START -->
<!-- LIVE_NATIVE_CODEX_RUNS_END -->

## Benchmark command inventory

`package.json` is the executable source of truth for commands. This inventory exists so benchmark coverage is visible in one place. When adding or removing a `bench:*` script, update this section as part of the same change.

### End-to-end and core

| Command | Purpose |
| --- | --- |
| `npm run bench:core` | Deterministic core performance benchmark over replay, virtualization, repository reuse, and durable state. |
| `npm run bench:harnesses:live` | Existing multi-harness live smoke comparison. Useful for reachability/smoke evidence; not the canonical same-model Native-vs-Codex quality comparison. |
| `npm run bench:native-vs-codex:live` | Same-model, same-fixture end-to-end Trebell Native vs Codex coding benchmark. |

### Native live/provider behavior

| Command |
| --- |
| `npm run bench:vyce:native` |
| `npm run bench:vyce:native:recovery` |
| `npm run bench:vyce:native:hot-history` |
| `npm run bench:vyce:native:hot-preview` |
| `npm run bench:vyce:native:post-edit-reread` |
| `npm run bench:vyce:native:schema-min` |
| `npm run bench:vyce:native:shared-schema` |
| `npm run bench:vyce:native:tool-namespace` |
| `npm run bench:vyce:native:output-inspect` |
| `npm run bench:vyce:native:search-dedupe` |
| `npm run bench:vyce:native:budget-finalization` |
| `npm run bench:vyce:native:shell-hint` |
| `npm run bench:vyce:native:toolcall-history` |
| `npm run bench:vyce:native:prior-context` |
| `npm run bench:vyce:native:prior-context-mixed` |

### Native agent-loop, history, direct-path, and telemetry microbenchmarks

| Command |
| --- |
| `npm run bench:native:dedupe` |
| `npm run bench:native:cache-history` |
| `npm run bench:native:cross-turn-verifier` |
| `npm run bench:native:terminal-report` |
| `npm run bench:native:terminal-report-history` |
| `npm run bench:native:direct-terminal-status` |
| `npm run bench:native:direct-terminal-history` |
| `npm run bench:native:direct-terminal-history-overhead` |
| `npm run bench:native:direct-terminal-scan` |
| `npm run bench:native:direct-status-lazy-output` |
| `npm run bench:native:direct-terminal-provider-view-incremental` |
| `npm run bench:native:request-metrics-overhead` |
| `npm run bench:native:message-bucket-metrics` |
| `npm run bench:native:message-array-allocation` |
| `npm run bench:native:message-serialization-cache` |
| `npm run bench:native:history-hash-cache` |
| `npm run bench:native:message-classification-cache` |
| `npm run bench:native:current-turn-breakdown-cache` |
| `npm run bench:native:classified-byte-metrics` |
| `npm run bench:native:provider-history-projector` |
| `npm run bench:native:provider-history-compacted-identity` |
| `npm run bench:native:tool-schema-metrics-cache` |
| `npm run bench:native:latest-user-lookup` |
| `npm run bench:native:tool-repair-scan` |
| `npm run bench:native:chat-tool-manifest-cache` |
| `npm run bench:native:chat-message-cache` |
| `npm run bench:native:prefix-hash-overhead` |
| `npm run bench:native:incremental-history-cooling` |
| `npm run bench:native:tool-schema` |
| `npm run bench:native:restart-verifier` |
| `npm run bench:native:restart-history` |
| `npm run bench:native:direct-terminal-cwd` |
| `npm run bench:native:direct-exact-replacement` |
| `npm run bench:native:direct-exact-replacement-only` |
| `npm run bench:native:direct-exact-replacement-cwd` |
| `npm run bench:native:direct-exact-write` |
| `npm run bench:native:direct-exact-read` |
| `npm run bench:native:direct-exact-list` |
| `npm run bench:native:direct-git-status` |
| `npm run bench:native:direct-git-branch` |
| `npm run bench:native:direct-process-status` |
| `npm run bench:native:direct-browser-runtime` |
| `npm run bench:native:direct-browser-screenshot` |
| `npm run bench:thread:metadata` |

### OpenAI, Anthropic, and provider wire/cache microbenchmarks

| Command |
| --- |
| `npm run bench:openai:response-continuation` |
| `npm run bench:openai:continuation-accounting` |
| `npm run bench:openai:continuation-byte-accounting` |
| `npm run bench:openai:continuation-fingerprint-reuse` |
| `npm run bench:openai:continuation-input-build` |
| `npm run bench:openai:responses-websocket` |
| `npm run bench:openai:responses-input-build` |
| `npm run bench:openai:tool-manifest-cache` |
| `npm run bench:openai:prompt-cache-key-cache` |
| `npm run bench:anthropic:direct-input-build` |
| `npm run bench:anthropic:message-build-cache` |
| `npm run bench:anthropic:tool-manifest-cache` |
| `npm run bench:provider:tool-wire-json` |

## Next benchmark expansion

The next useful step is to add several materially different end-to-end coding tasks, not to tune specifically for the webhook fixture. Good additions should cover at least: unfamiliar multi-file bug diagnosis, test-driven feature work, refactoring with preserved behavior, repository navigation in a larger fixture, and a task where the first attempted fix fails and the harness must use verifier evidence to repair it. Each task should use the same-model paired methodology above and record both correctness and resource usage here.
