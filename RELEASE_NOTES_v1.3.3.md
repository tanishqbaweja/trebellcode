# Trebell Code 1.3.3

Version 1.3.3 hardens Trebell Native as a real first-party coding harness and adds live-provider proof that Native is independent from the Codex app-server path.

## Trebell Native real-model validation

- Added `npm run test:vyce:native`, a real-provider end-to-end Native harness gate.
- The live test wires `attachAgentRelay` directly to `ProviderManager.turn`; it never starts the Codex app-server.
- The real model must receive the Trebell Native system prompt and Native tool schemas, inspect source, edit a file, run terminal verification, produce a final answer, and leave output that an independent Node process verifies afterward.
- The v1.3.3 validation passed with VyceAi + `deepseek-v4.1`.
- Live instrumentation records model turns, provider request size, schema size, tool calls, arguments, and token usage without exposing credentials.

## Native coding-agent prompt

- Added a first-party Trebell Native system prompt instead of relying on tool schemas and optional thread developer instructions alone.
- The prompt teaches evidence-driven coding, permission boundaries, verification discipline, untrusted tool-data handling, minimal coherent edits, and honest failure reporting.
- It tells the model to use exact paths/commands supplied by the user or tools instead of rediscovering them.
- It encourages batching independent read-only tool calls to reduce unnecessary model round trips.
- The latest live trace measured the system prompt at roughly 527 estimated tokens; prompt size is not the dominant Native cost.

## Progressive repository tools

- Reduced the baseline Native repository tool surface to high-value search/read primitives plus stable `trebell_repo/discover` + `trebell_repo/invoke`.
- Advanced capabilities such as semantic rename/code actions, call hierarchy, Git history/blame, deterministic verification control, and durable repository knowledge are exposed only when specifically requested.
- Generic discovery queries such as “repository structure and project layout” no longer inflate the advanced schema set.
- Discovery returns capability metadata as data instead of mutating the provider-visible schema manifest.
- Native MCP follows the same stable-manifest idea with generic discovery/call/resource tools while policy still resolves the real target tool.
- On the measured coding path, baseline functions dropped from 31 to 11 and first-request tool-schema JSON dropped from about 14.3 KB to about 5.1 KB.

## Native context efficiency

- Native UI turns now keep scoped repository instructions but replace large preloaded source excerpts with a compact untrusted repository seed map.
- On the Trebell repository audit task, the repository evidence preamble dropped from about 2,778 estimated tokens to about 340 tokens while preserving selected paths and orientation.
- Exact source is fetched on demand through Native repository/workspace tools instead of being replayed in every model/tool round trip.
- Byte-identical repeated source reads are replaced with a compact unchanged-observation marker.
- Large redacted tool output is stored outside hot model context behind bounded `trebell_output/search` and `trebell_output/read` handles, with a signal-aware preview that retains likely failure/assertion lines.

## Tool-loop reliability

- Added one bounded recovery attempt for empty terminal model responses; a second empty completion now fails visibly.
- Normalized common safe argv mistakes such as `args: "verify.mjs"` and `command: "node verify.mjs"` without implicitly interpreting shell syntax.
- Normalized model-style workspace-root paths such as `/src/app.js` before both policy evaluation and execution while preserving traversal/absolute-path boundaries.
- Added schema validation for Trebell-owned tool arguments before policy evaluation/execution.
- Invalid or unexpected tool arguments fail closed instead of reaching the executor.
- Long-running server/watcher control lives behind lazy `trebell_process` tools instead of bloating the always-present one-shot terminal schema.

## Native inference telemetry and provider capabilities

- Every Native model step now records a stable inference id, prompt-section estimates, tool-schema/stable-prefix hashes, normalized provider usage, cache-read/write tokens, request/response bytes, latency, provider endpoint/wire API, and context-window utilization where known.
- Trebell preserves internal provenance so actual user text can be measured separately from Trebell application/untrusted working context without changing provider-visible serialization.
- Provider capability metadata distinguishes protocol compatibility from verified prompt caching, explicit cache control, stateful continuation, persistent connections, native compaction, and cache telemetry.
- A controlled Vyce repeated-prefix experiment observed **0 cached input tokens**, so Trebell does not pretend the current Vyce Chat Completions route has a cache/stateful continuation feature it has not demonstrated.

## Live efficiency result

The first measured real Native coding run consumed roughly **40.4k input tokens** for the small validation fixture. The latest equivalent run completed successfully in **4 model turns / 12,006 input tokens / 373 output tokens**, with no failed tool calls, one stable prefix, one stable tool-schema hash, and independent post-turn verification.

A new `bench:vyce:native` live benchmark also covers multi-file refactoring, failing-test repair, and large noisy command output in disposable repositories with independent verification and per-scenario token/latency/tool metrics. Large-output work remains an optimization area: virtualizing output materially bounds retained context, but model/tool-loop decisions can still dominate total cost.

## Release validation

- **808 / 808** deterministic tests passed.
- **138 / 138** full visual/screenshot tests passed in offline provider-safe mode.
- **2 / 2** targeted Native UI E2E tests passed (compact context seed + thread-owned background process/runtime UI).
- The real Vyce Native coding gate passed with `deepseek-v4.1`, including independent post-turn verification.
