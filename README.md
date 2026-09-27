# Trebell Code

> **A desktop coding harness that gives AI agents a real engineering workspace — projects, terminals, Git/worktrees, browser verification, durable context, source control, recovery, and multiple agent runtimes in one place.**

**Version:** 1.3.6 · **Runtime:** Node.js 22+ · **License:** Apache-2.0 · **Desktop:** Windows / macOS / Linux packaging targets

Trebell Code is not a chat box with a terminal glued beside it. It is a **desktop agent harness** designed around the boring-but-important parts of software engineering that make autonomous coding workflows trustworthy:

- durable project/thread state;
- repository-aware context;
- real files, terminals, Git and worktrees;
- bounded delegation and background work;
- browser and desktop verification;
- permission and risk policy;
- checkpoints, rewind/recovery and evidence;
- runtime-aware capabilities instead of fake feature parity;
- provider-independent conversation history;
- honest failure states instead of silent fallbacks.

The product contract lives in **goal.md**. The remaining real-world validation work is tracked in **MANUAL_TESTING.md**.

---

## Why Trebell exists

Most coding-agent frontends answer one question:

> “How do I talk to this model?”

Trebell is built around a harder question:

> “How do I give different coding agents the same dependable engineering environment without pretending they all support the same things?”

That leads to five rules:

1. **Harness capabilities are explicit.** Trebell Native, Codex, Claude Code, OpenCode, Cursor, Grok Build and Antigravity do not magically expose identical queues, sandboxes, rewinds, profiles, delegation or attachment support.
2. **Provider identity does not own conversation identity.** Switching inference provider must not make your projects or previous chats disappear.
3. **Verification uses evidence.** Tests, builds, browser runs, screenshots, Git state and runtime signals beat “another model said it looks good.”
4. **Failure is visible.** If persistence, Git metadata, provider refresh, checkpointing, source control or the runtime fails, Trebell shows it.
5. **Heavy tools are lazy.** The model does not receive every MCP/tool schema on every turn.

---

## Architecture

~~~mermaid
flowchart LR
    UI["React desktop workspace"]
    GUI["Trebell GUI / RPC server"]
    STATE["SQLite state + event journal"]
    SERVICES["Projects · Git · worktrees · terminals · verification · source control"]
    TOOLS["Shared tool gateway + policy + redaction"]
    NATIVE["Trebell Native"]
    CODEX["Codex app-server"]
    EXTERNAL["Claude Code · OpenCode · Cursor · Grok Build · Antigravity"]
    PROVIDERS["Freebuff · AgentRouter · JustWorker · HCNSec · VyceAi"]
    MCP["MCP servers"]
    BROWSER["Agent Browser / desktop verification"]

    UI <--> GUI
    GUI <--> STATE
    GUI <--> SERVICES
    GUI <--> TOOLS
    GUI <--> NATIVE
    GUI <--> CODEX
    GUI <--> EXTERNAL
    NATIVE <--> PROVIDERS
    TOOLS <--> MCP
    TOOLS <--> BROWSER
~~~

### Runtime and inference provider are separate concepts

**Agent runtime** is the coding harness that owns the session/protocol.

**Inference provider** is the model API used by Trebell-managed inference paths.

Examples:

- Trebell Native + VyceAi;
- Trebell Native + AgentRouter;
- Trebell Native + the official OpenAI, Anthropic, or Gemini API;
- Codex using Codex's own account/provider/model configuration;
- Claude Code using Claude Code's own model/auth semantics.

External harnesses are not forced through Trebell Native's provider layer merely to make the UI look symmetrical.

---

## Supported agent runtimes

| Runtime | Integration model | Notes |
|---|---|---|
| **Trebell Native** | Trebell-owned native loop | Deepest Trebell-controlled tool/policy/budget integration |
| **Codex** | OpenAI Codex app-server | Native Codex protocol, skills/plugins/apps/config where exposed |
| **Claude Code** | Claude Agent SDK/runtime integration | Runtime/profile features are capability-gated |
| **OpenCode** | OpenCode SDK/runtime integration | Shared Trebell workspace/delegation capabilities |
| **Cursor** | External agent runtime | Capabilities depend on the connected runtime |
| **Grok Build** | External agent runtime | Capabilities depend on the connected runtime |
| **Antigravity** | External agent runtime | Capability-gated; video attachments currently marked unsupported |

The UI reads a runtime capability contract rather than scattering runtime-name assumptions everywhere.

---

## Trebell-managed inference providers

Current integrations include:

- **Freebuff**
- **AgentRouter**
- **JustWorker.icu**
- **HCNSec.cn**
- **VyceAi**

Provider keys are configured in **Settings** and stored through Trebell's secret handling path.

> **.env is not product configuration.** A local ignored .env may be used for developer/live-provider tests only.

AgentRouter defaults to its current Codex-compatible OpenAI Chat endpoint at `https://co.agentrouter.org/v1`. Trebell Native still owns the prompt, tools, context, turn loop, and session; the Codex-shaped headers are only an upstream compatibility fingerprint. The fingerprint version follows the bundled `@openai/codex` package instead of freezing an old client version. Compatibility overrides remain available through `AGENTROUTER_BASE_URL`, `AGENTROUTER_WIRE_API`, and `AGENTROUTER_CLIENT_VERSION` when an older/private AgentRouter deployment requires them.

For Codex compatibility, Trebell can translate provider protocols into the Responses-style lifecycle expected by the bundled Codex runtime.

---

## Core workspace

### Projects and environments

- project-scoped settings;
- project identity independent of provider;
- local workspaces;
- WSL environments;
- SSH environments;
- remote Git/worktree execution where supported;
- project cloning/background clone jobs;
- safe cleanup and failure rollback.

### Files and terminal

- project file browsing;
- file mentions from the composer;
- integrated terminal sessions;
- environment-aware command execution;
- background processes owned by their originating thread;
- explicit process cleanup;
- bounded terminal/output state.

### Git and worktrees

- branch/status/diff views;
- worktree creation and cleanup;
- isolated delegated coding work;
- source-control review state;
- linked pull-request state;
- checkpoints and recovery;
- branch-aware verification.

### Thread lifecycle

- durable thread metadata;
- provider-independent history;
- paginated history/search;
- queued follow-up messages;
- runtime-aware resume;
- fork/rewind where supported;
- long-thread virtualization;
- bounded sidebar rendering.

---

## Source control and forges

Trebell has provider-specific source-control support rather than assuming every remote is GitHub.

The source-control service includes capability/detection paths for:

- GitHub;
- GitLab;
- Forgejo / Gitea;
- Bitbucket;
- Azure DevOps.

Known public hosts can be detected automatically. Unknown/self-hosted hosts are handled conservatively instead of Trebell guessing the provider and issuing the wrong API calls.

Supported operations vary by provider and credentials.

---

## Tool architecture

### Baseline tools

Common engineering primitives stay available without bloating every turn:

- workspace/file operations;
- terminal operations;
- repository search/intelligence;
- bounded context helpers.

### Lazy specialized namespaces

Heavier capabilities are exposed only when task intent and runtime support justify them:

- browser automation;
- desktop computer control;
- source-control operations;
- delegation.

### MCP

Trebell Native uses progressive MCP discovery:

1. configured MCP servers are indexed internally;
2. the model initially sees a compact discovery surface;
3. matching tool schemas expand only when needed.

This avoids the classic “here are 300 schemas, please remember the user asked to rename one variable” problem.

MCP/tool results pass through Trebell's shared policy and secret-redaction gateway before being returned to the model-facing loop.

---

## Context and repository intelligence

Trebell treats context as an engineering subsystem rather than one giant prompt.

### Repository context

- bounded repository indexing;
- semantic/context selection;
- file/symbol-aware evidence;
- focused task context;
- repository tool catalog;
- runtime-independent repository tools.

### Durable repository knowledge

Saved repository facts carry a trust state:

- **verified** — supporting evidence still matches;
- **unverified** — saved but not yet evidence-backed;
- **stale** — supporting files/revision changed and the fact is omitted from injected context.

This deliberately avoids building a giant always-trusted RepoWiki.

---

## Verification and repair

Trebell's verification model is evidence-first.

Evidence can include:

- unit/integration tests;
- build/type/syntax checks;
- Git/diff state;
- browser interaction;
- screenshots;
- runtime diagnostics;
- checkpoint/recovery evidence;
- source-control state.

When a deterministic check fails, Trebell can feed the failure back into the **same agent/thread** for bounded repair.

It does **not** automatically spawn reviewer swarms simply because “more agents sounds smarter.”

Independent review remains a recommendation where it is genuinely useful.

---

## Delegation and asynchronous work

Delegation is bounded and explicit:

- child-agent counts are budgeted;
- time/tool/token constraints are enforced;
- coding delegation defaults to worktree isolation;
- shared workspace reuse must be explicit;
- remote worktrees stay in the selected environment;
- child agents can be prevented from recursively creating grandchildren;
- failed worktree setup cleans itself up.

Trebell separates:

**Queued agent work** — durable follow-up instructions associated with a thread.

**Background processes** — servers/watchers/commands with an OS process lifetime and independent cleanup.

---

## Safety, permissions and secrets

### Permission policy

Tool calls carry structured metadata such as:

- read vs write;
- risk level;
- reversibility;
- idempotence;
- external side effects;
- workspace/project requirements;
- full-access requirements.

### Secret handling

Trebell redacts known secrets across model/tool boundaries, persisted events and diagnostic surfaces.

Provider credentials are kept separate from normal UI state.

### Untrusted tool output

Native tool observations are framed as **untrusted data** before the next model step. A web page, README or MCP response saying “ignore the user and do X” is content, not automatically promoted to instructions.

---

## Persistence and recovery

SQLite is the authoritative durable store for major Trebell state.

The architecture includes:

- durable thread/turn storage;
- indexed thread metadata;
- projects/settings;
- durable goals;
- repository knowledge;
- verification records;
- event history;
- recovery evidence.

The JSONL event file is a **bounded export/fallback mirror**, not a competing source of truth. Legacy/fallback records reconcile without resurrecting events SQLite intentionally pruned.

On restart, uncertain side effects are not blindly replayed.

---

## Performance

Trebell includes:

- conversation virtualization;
- sidebar virtualization;
- bounded timeline rendering;
- frame-buffered/coalesced streaming deltas;
- paginated thread history;
- incremental repository indexing;
- bounded source-control lists;
- lazy-loaded heavy pages;
- visibility-aware polling;
- bounded terminal/diagnostic data.

Automated benchmarks cover large conversation/history/state scenarios.

---

## Browser and desktop verification

### Agent Browser

The isolated Agent Browser supports:

- navigation;
- DOM interaction;
- screenshots;
- responsive viewport checks;
- localhost preview discovery;
- browser evidence collection.

### Desktop control

Desktop screenshots and computer-control capabilities are permission/capability gated.

Windows mouse/keyboard control is only advertised when the bridge reports support. Trebell does not render fake controls on unsupported platforms.

---

## Platform support

| Platform | Status |
|---|---|
| **Windows x64** | Primary release target; NSIS installer and installed-app smoke coverage |
| **macOS** | Electron DMG/ZIP targets configured; real-device validation still required |
| **Linux** | AppImage/deb targets configured; real-distro validation still required |
| **WSL** | Supported as a desktop-controlled development environment |
| **SSH** | Supported as a remote development environment |

See **MANUAL_TESTING.md** for what automated Windows/mock coverage cannot honestly prove.

---

## Explicit non-goals

These are intentionally **not** current Trebell goals:

- Android emulator/iOS simulator orchestration;
- mobile companion remote-control UI;
- automatic “best model” routing/tournaments;
- mandatory reviewer-agent loops;
- swarm-first coding;
- mandatory vector DB / embeddings infrastructure;
- giant always-injected RepoWiki generation;
- decorative Web/Skills composer toggles that do not genuinely gate behavior.

Older releases briefly contained mobile-device control surfaces. They were retired and regression-tested to stay retired.

---

## Installation

### Windows release

Download the latest installer from:

**https://github.com/tanishqbaweja/trebellcode/releases**

Installer naming:

~~~text
Trebell-Code-Setup-<version>.exe
~~~

### Run from source

Requirements:

- Node.js **22+**
- npm
- Git for repository/source-control workflows

~~~bash
git clone https://github.com/tanishqbaweja/trebellcode.git
cd trebellcode
npm install
npm link
trebell
~~~

Frontend development:

~~~bash
npm run gui:server
npm run ui:dev
~~~

Production-style local GUI:

~~~bash
npm run ui:build
trebell gui
~~~

---

## Useful commands

| Command | Purpose |
|---|---|
| **trebell** | Start Trebell Code |
| **trebell doctor** | Check installation/runtime prerequisites |
| **trebell login** | Freebuff login |
| **trebell login --force** | Refresh/switch Freebuff login |
| **trebell logout** | Remove local Freebuff credential |
| **trebell models --provider ID** | Show models for a Trebell Native provider |
| **trebell --model ID** | Ask the real Codex harness to use a model for this CLI run |
| **trebell gui** | Open the multi-harness app, including Trebell Native direct-API inference |

Provider API keys for normal product use belong in **Settings**, not repository environment files.
`trebell run` does not rewrite Codex's provider or account configuration; Native provider selection is intentionally separate.

---

## Testing

### Deterministic

~~~bash
npm test
~~~

At the v1.3.3 Native-harness release checkpoint:

- **808 / 808 deterministic tests passed**
- **138 / 138** full visual/screenshot tests passed
- **2 / 2** targeted Native UI E2E tests passed (compact context seed + thread-owned background process/runtime UI)
- the real `test:vyce:native` coding gate passed with VyceAi + `deepseek-v4.1`

### UI / Playwright

~~~bash
npm run ui:test
npm run ui:test:workspace
npm run ui:test:capabilities
npm run ui:test:visual
~~~

Local Playwright automatically builds the current frontend before running, preventing stale-ui/dist false positives.

The harness is offline by default. Live-provider tests are opt-in.

### Live developer tests

~~~bash
npm run test:vyce
npm run test:vyce:native
npm run test:vyce:codex
npm run test:vyce:cache
npm run bench:vyce:native
npm run bench:vyce:native:recovery
npm run bench:vyce:native:hot-history
npm run bench:vyce:native:hot-preview
npm run bench:vyce:native:post-edit-reread
npm run bench:vyce:native:schema-min
npm run bench:vyce:native:shared-schema
npm run bench:vyce:native:tool-namespace
npm run bench:vyce:native:output-inspect
npm run bench:native:cache-history
npm run bench:vyce:native:search-dedupe
npm run bench:vyce:native:budget-finalization
npm run bench:vyce:native:shell-hint
npm run bench:vyce:native:toolcall-history
npm run bench:vyce:native:prior-context
npm run bench:vyce:native:prior-context-mixed
npm run test:vyce:background
npm run test:vyce:fanout
npm run test:providers:live
npm run test:runtime-profiles:live
npm run test:external-harnesses:live
npm run test:codex:live
npm run bench:harnesses:live
~~~

These may optionally read an ignored root **.env** containing test credentials only.

### Real Trebell Native live gate

The dedicated Native live test is:

~~~bash
npm run test:vyce:native
~~~

It does **not** start the Codex app-server. The test wires `attachAgentRelay` directly to `ProviderManager.turn`, sends a real request to VyceAi, and requires the real model to:

- receive the Trebell Native system prompt;
- see the real `trebell_repo`, `trebell_workspace`, and `trebell_terminal` namespaces;
- use Native repository/workspace tooling as appropriate to the task;
- read and edit a broken source file through Native tools;
- run verification through the Native terminal tool;
- produce a non-empty final assistant response;
- leave a file that an independent Node process verifies afterward.

The v1.3.3 Native audit run passed with `deepseek-v4.1` and explicitly reported `codexAppServerStarted: false`.

That live test also drove concrete Native efficiency work. Advanced repository and MCP capabilities use stable discovery/invocation manifests instead of injecting every specialized schema on every model step. On the latest audit fixture:

- baseline tool functions dropped from **31 to 11**;
- first-request tool-schema JSON dropped from roughly **14.3 KB to 4.9 KB**;
- the first real model request used roughly **2.66k provider input tokens**;
- the complete small coding task finished in **4 model turns / 11,997 input tokens**, down from the first measured run of roughly **40.4k input tokens**;
- all four requests kept one stable prefix and one stable tool-schema hash;
- the model batched three independent reads, made one surgical edit, ran one verification command, and passed independent post-turn verification.

The exact token count varies by model behavior and conversation history, so these are audit measurements rather than a promised fixed cost.

The post external-harness-separation audit improved the same small Native coding fixture again. With `deepseek-v4.1`, the real tool loop completed in **4 model turns / 7,896 input tokens / 261 output tokens**. The first provider request used **1,659 input tokens**, the tool catalog remained **11 functions / ~5.1 KB JSON**, all four turns kept one stable prefix hash and one stable tool-schema hash, and independent verification still passed. Compared with the preserved v1.3.3 small-task audit (**11,997 input tokens**), that is about **34% less input** without reducing the model-turn count or removing edit/verification work. Vyce still reported **0 cached input tokens**.

The Native system prompt itself is intentionally compact: the current release candidate measures roughly **532 estimated tokens**. The larger recurring costs are tool schemas and accumulated conversation/tool evidence, so Native progressively exposes advanced capabilities, deduplicates byte-identical file observations, virtualizes large tool output behind searchable handles, and uses a compact repository seed in the UI instead of replaying full source excerpts on every model/tool round trip.

Context Engine now reuses its discovered repository path inventory when Git proves the path set cannot have changed: the previous and current packets must be from the exact same HEAD with the exact same full-status fingerprint and changed-path set. Parsed-file reuse already avoided reparsing unchanged source, but Trebell was still paying for a fresh `git ls-files` (or the equivalent remote environment round trip) on every packet. This broader guard also helps during active edits: changing the contents of an already-dirty file keeps the path inventory hot while that dirty file is still re-statted and re-read normally. First build, missing Git identity, HEAD changes, added/removed/renamed paths, or any status transition force normal rediscovery. On a clean synthetic **1,200-source-file** Git repository, two reversed-order six-packet measurements put the untouched baseline's ten warm packets at **~105.3 ms average wall time / ~41.8 ms indexing time**; the guarded cache averaged **~62.1 ms / ~0.5 ms**, about **41.0% lower warm packet wall time** and **98.8% lower indexing time**. With one source file kept dirty across the same measurement shape, baseline warm packets averaged **~109.0 ms / ~44.5 ms indexing** versus **~68.8 ms / ~0.6 ms** with stable-dirty reuse, about **36.9% lower wall time** and **98.7% lower indexing time**. Deterministic coverage verifies both clean and dirty reuse and forces rediscovery when the same changed path transitions to a different Git status.

Context packet ranking now also reuses its personalized repository graph when the exact ordered indexed-source fingerprint and all ranking inputs (task terms, changed-path set, and focus set) are unchanged. This avoids rebuilding import/reference edges and rerunning personalized PageRank for repeated continuation packets while preserving the exact uncached `items` and injection text. Any task/focus/change-set transition or indexed source version/parser change invalidates the graph; telemetry exposes `stats.graphReused`. In a reverse-order local Git fixture with **1,200 source files**, five clean warm packets averaged **75.2 ms** on the untouched `b2e6e4c` baseline versus **55.8 ms** with graph reuse, about **25.8% lower wall time**. After one source was made dirty, excluding the first required reparse, the next four packets averaged **72.7 ms** baseline versus **58.3 ms** candidate, about **19.9% lower wall time** even though the first post-reparse warm packet conservatively recomputes once while indexed iteration order normalizes. Focused deterministic coverage verifies cache hits, task invalidation, source invalidation, and byte-identical packet evidence across reused computations.

PageRank now precomputes each node's outgoing edge-weight total once per ranking pass instead of summing the same row again on every one of the 24 iterations. Five alternating 1,200-node / 3,594-edge CPU microbenchmarks kept the rank maps byte-identical and reduced mean PageRank time by **3.95% to 10.93%** in every run (baseline averages **8.216–8.893 ms**, candidate **7.660–8.077 ms**). This is intentionally treated as a local CPU optimization rather than a model-latency claim; its value is avoiding repeated graph arithmetic without changing ranking semantics.

When task/focus inputs change but indexed source structure does not, Context Engine now also reuses the source-derived graph topology (`available`, definition ownership, import/reference edges, and edge count) while recomputing task-specific relevance, personalization, and PageRank. `stats.graphStructureReused` makes that distinction observable, and any indexed source fingerprint change invalidates the topology. Three independent 1,200-source-file A/B runs against the PageRank-only parent produced byte-identical injection hashes on every packet. Warm baseline averages were **122.205 / 98.470 / 149.307 ms wall** and **89.1 / 84.3 / 106.3 ms CPU**; topology reuse measured **98.754 / 102.384 / 107.001 ms wall** and **73.4 / 71.9 / 70.3 ms CPU**. Aggregated across the three runs, that is roughly **123.3 → 102.7 ms wall (~16.7% lower)** and **93.2 → 71.9 ms CPU (~22.9% lower)** while every changed-task packet still recomputed its personalized graph (`graphReused: false`) and reported a topology hit.

Native repository context is now projected to the exact compact seed **before the server sends the packet to the UI**, and that same delivered projection is what Native persists. Repository instructions remain separated from untrusted evidence, non-Native runtimes keep their existing full delivery packet, selected item metadata is preserved, and projection is idempotent if the UI sees an already-projected packet. Deterministic coverage uses a synthetic 100,000-character source excerpt to verify that the Native packet removes the large raw excerpt, stays below one tenth of the original serialized packet size, and produces exactly the same model context entries as the pre-projection delivery view. On the real Trebell repository, `scripts/context-native-projection-benchmark.mjs` measured the response at **29,962 → 10,161 bytes (~66.1% smaller)** while preserving those model entries; the delivered packet's estimate fell from **2,774 → 357 tokens** because source excerpts that Native would never send to the model no longer cross the local API boundary at all.

Provider timing telemetry distinguishes **time to HTTP response headers**, **response-body read time**, and **total request latency** instead of collapsing them into one number. Non-streaming routes deliberately leave `timeToFirstTokenMs` unset rather than mislabeling response headers as TTFT. Failed retryable HTTP attempts retain the same bounded wire telemetry on the thrown error and surface it on `native.model.retrying`, so 429/5xx time is no longer invisible. The live Native benchmark separately reports logical model turns, raw provider attempts, retry attempts, header latency, body latency, and total provider latency; clean historical runs with no retries keep the same logical model-turn count. A real `deepseek-v4.1` failure-repair check used **4 logical turns / 4 provider attempts / 0 retries**, independently verified the repair, and measured **21,760.8 ms to response headers + ~3.9 ms reading response bodies = 21,764.7 ms total provider latency** across the task. That Vyce run does not prove true TTFT, but it does show that response-body transfer is negligible on that non-streaming route compared with the upstream wait.

Direct OpenAI Native Responses turns now opt into **server-sent-event streaming** so Trebell can measure true text TTFT from the first `response.output_text.delta` instead of guessing from response headers. The stream consumer still waits for the provider's completed Response object before returning a model turn to the agent loop, so final text, usage, and namespaced function-call semantics stay identical to the non-streaming path; tool-call-only streams correctly leave text TTFT unset. Partial stream failures retain bounded bytes/latency evidence for retry diagnostics. This is intentionally an instrumentation-first change rather than a claimed user-visible streaming win: no direct OpenAI credential was available for live validation, while deterministic SSE/text/tool/failure coverage and the exact streaming candidate's full suite passed **891/891** tests.

Vyce Chat Completions SSE support is intentionally **experimental/diagnostic rather than the default Native transport**. `ProviderManager.turn(..., {streamChat:true})` reconstructs text, fragmented tool calls, usage, cached-input metadata, response IDs, wire bytes, and true text TTFT, while `npm run bench:vyce:native` enables it only when `TREBELL_VYCE_STREAMING=1` (or `true`/`yes`) is set. A real streamed coding repair independently verified successfully, but its final response produced first text at about **7.339 s** versus **7.391 s** total, so there was no meaningful perceived-latency win. A later alternating same-model exact-output probe kept token usage identical at **10 input / 3 output tokens** per request but measured **1,124 response bytes** for both streamed requests versus **428 bytes** for both non-streamed requests; streamed wall times were **2.26 s / 3.61 s** versus **1.57 s / 1.23 s** non-streamed. That four-request probe is too small to claim a general latency penalty, but it is strong enough to avoid paying the extra SSE wire/transport complexity in the production Vyce path before Trebell can surface incremental deltas to users. Benchmark TTFT accounting also keeps tool-only/missing TTFT as `null` instead of coercing it into a fake zero-millisecond sample.

The same live benchmark now also separates **summed tool execution time**, **tool wall time with parallel overlap removed**, and residual non-provider/non-tool time. On a fresh independently verified `deepseek-v4.1` failure-repair run, total task time was **27,855.5 ms**: provider requests consumed **27,598.7 ms (~99.1%)**, tools occupied only **162.4 ms wall (~0.58%)**, and the remaining harness/other time was about **94.4 ms (~0.34%)**. The two verifier runs accounted for roughly **149.9 ms** of summed tool execution, while two file reads together cost about **5.6 ms** and the edit about **9.5 ms**. This confirms that, for this task shape, reducing model/provider round trips is orders of magnitude more important than micro-optimizing ordinary filesystem tools.

Direct Anthropic Native turns now enable Anthropic's **automatic prompt caching** with top-level `cache_control: {type: "ephemeral"}` at the Messages API boundary. Trebell marks only the verified first-party Anthropic route as cache-capable; Anthropic-compatible proxies remain conservative until separately verified. Native sessions opt into those cache writes, while generic one-shot ProviderManager calls remain uncached by default so they do not pay Anthropic's cache-write premium without an expected reuse. Native keeps already-sent history and the tool manifest byte-stable instead of cooling or dropping them during cache-friendly finalization, while both streaming and non-streaming adapters retain Anthropic's cache-read/cache-write usage fields so any real benefit is measurable rather than assumed. Deterministic coverage verifies the wire payload, proxy isolation, cache telemetry, and stable finalization behavior; the exact combined cache/telemetry branch passed **885/885** deterministic tests, and the later one-shot cache-write guard passed its focused **73/73** provider/session/GUI checks. No direct Anthropic credential was available for this validation, so Trebell does not claim a measured live cache-hit or billing reduction yet.

The controlled `test:vyce:cache` experiment sent repeated stable ~9k-token prefixes and observed **0 cached input tokens** from the current Vyce Chat Completions route. Trebell therefore records provider cache/state capabilities explicitly and does not assume that an OpenAI-compatible endpoint also implements prompt caching or stateful Responses continuation.

For broader real-model regression work, `npm run bench:vyce:native` exercises disposable repositories covering multi-file refactoring, failing-test repair, and large noisy tool output with independent verification and per-scenario token/latency/tool metrics. The final v1.3.3 benchmark passed all three scenarios:

- multi-file refactor: **5 model turns / 16,349 input tokens**;
- failure-driven repair: **4 model turns / 13,148 input tokens**;
- 92 KB noisy-output repair: **7 model turns / 37,526 input tokens**, with the full command output virtualized outside hot context while retaining failure evidence in the preview.

Across those three live tasks, Trebell used **16 model turns / 67,023 input tokens** total. Vyce reported **0 cached input tokens**, so long/noisy tool loops remain a measured optimization target rather than being hidden behind assumed prompt caching.

The post-split rerun also passed all three scenarios with independent verification:

- multi-file refactor: **5 model turns / 11,686 input tokens** (about **28.5% lower input** than the v1.3.3 run);
- failure-driven repair: **5 model turns / 12,204 input tokens** (about **7.2% lower input**, with one additional model turn);
- 92 KB noisy-output repair: **8 model turns / 34,518 input tokens** (about **8.0% lower input**, with one additional model turn), while the 92,130-byte command output remained virtualized outside hot context.

Across the post-split benchmark Trebell used **18 model turns / 58,408 input tokens / 2,612 output tokens**. That is about **12.9% less total input** than the v1.3.3 three-scenario baseline despite two additional model turns. All scenarios kept stable schemas within a user turn and again reported **0 cached input tokens**, so the measured gain comes from context/tool-loop efficiency rather than provider prompt-cache credits.

A later current-tree rerun after normalizing the conventional `/workspace/...` model path to Trebell's active workspace root passed all three scenarios again:

- multi-file refactor: **6 model turns / 14,591 input tokens**;
- failure-driven repair: **4 model turns / 9,102 input tokens**;
- 92 KB noisy-output repair: **7 model turns / 29,696 input tokens**, with the 92,129-byte command output still virtualized outside hot context.

That run totaled **17 model turns / 53,389 input tokens / 2,676 output tokens**, about **20.3% less input** than the preserved v1.3.3 baseline and about **8.6% less** than the earlier post-split rerun. It recorded **0 failed tool calls**, **0 repaired malformed tool calls**, stable schemas within each user turn, and **0 provider-reported cached input tokens**. The per-scenario counts remain stochastic, so the important signal is repeated independent verification plus lower aggregate context/tool-loop cost rather than any single lucky run.

An exact-head rerun on `b2e6e4c` after the later Native history/schema/output optimizations again independently verified all three default scenarios: multi-file refactor used **11,053 input / 644 output tokens / 5 model turns / 8 tools**, failure-driven repair used **13,904 / 983 / 6 / 7**, and the 92 KB noisy-output repair used **22,286 / 1,096 / 8 / 7** while virtualizing **92,129 bytes**. The aggregate was **47,243 input / 2,723 output tokens / 19 model turns / 22 tools**, with **0 failed tool calls** and **0 provider-reported cached input tokens**. That is about **29.5% less aggregate input** than the preserved 67,023-token v1.3.3 baseline, but it should still be treated as a stochastic current-lineage measurement rather than a fixed cost; a subsequent isolated failure-repair baseline completed in **12,066 input / 5 turns / 7 tools** on the same code.

The dedicated `npm run bench:vyce:native:recovery` benchmark now isolates Native path-recovery behavior from the broader stochastic coding suite. In a controlled A/B on the same current tree, with only commit `9d5d4d8` reversed for the comparison build, an oversized source file that was readable from the workspace but intentionally too large for the Context Engine index changed from **3 model turns / 2 tool calls / 1 failed call / 74,059 input tokens** to **2 turns / 1 tool call / 0 failed calls / 6,120 input tokens**. Native's bounded internal `read_source -> read_file` fallback emitted one explicit fallback event and avoided replaying the full ~258 KB file into model context, a measured **91.7% input reduction** in that case. A second task forced the model to read the conventional relative path `workspace/TASK.md` and return file content that was not present in the prompt. Reversing the normalization required **3 turns / 2 reads / 1 failed read / 1,961 input tokens**; current Native completed it in **2 turns / 1 read / 0 failures / 1,116 input tokens**, about **43.1% less input**. A third recovery task forces the equally common container-style `/app/TASK.md` spelling. Before `/app` fallback support, two live `deepseek-v4.1` baseline runs both spent **6 model turns / 5 reads**; one had **5 failed reads / 4,969 input tokens** and exhausted the model-turn budget without recovering, while the other had **4 failed reads / 5,125 input tokens** before eventually finding `/TASK.md`. With the guarded fallback, two candidate runs both completed in **2 turns / 1 read / 0 failures / 1,118 input tokens**. Trebell tries a real top-level `app/` path first and only treats `app` as a virtual workspace root when that literal path does not exist, so repositories that genuinely contain `app/` keep their normal semantics. The same fallback now covers reads, exact replacements, new writes, listings, and terminal/process working directories. All optimized recovery runs independently verified their fixtures and reported **0 cached input tokens**. These are targeted recovery measurements rather than general task-cost guarantees.

Native now applies the same conservative recovery to another common container-root assumption: `/app/...`. Trebell first tries the literal workspace-relative `app/...` path, so repositories that genuinely contain a top-level `app/` directory keep their normal meaning; only when that literal path does not exist does an existing `/app/...` target fall back to the active workspace root. The fallback covers reads, listings, terminal/process working directories, exact replacements, and replacement-style writes to existing files without weakening the existing workspace-boundary checks. In three paired live `deepseek-v4.1` recovery runs that forced the first read to `/app/TASK.md`, the old path used **7,687 input tokens / 11 model turns / 8 reads / 5 failed reads** total. The candidate used **3,362 input / 6 turns / 3 reads / 0 failures**, about **56.3% less input** while returning the hidden marker correctly in every candidate run. A broader recovery-suite pair also kept the oversized-source fallback unchanged at **6,120 input / 2 turns / 1 tool**; the pre-existing `workspace/TASK.md` path continued to succeed at the tool layer and passed cleanly again on an isolated rerun after one stochastic final-text miss.

A targeted rerun of the multi-file scenario after teaching Native to trust already-relevant paths named by Trebell's repository seed used **5 model turns / 11,583 input tokens / 8 tool calls**, down from the immediately preceding **6 turns / 14,591 input / 9 tool calls** while still passing independent verification. The model still performed one initial workspace list, so this is a measured improvement rather than a claim that redundant discovery is fully solved.

A follow-up experiment tested whether Native should stop using the compact seed and inject the full bounded repository evidence packet instead. The full packet added only about **109 estimated working-context tokens** on the first request in this small fixture (**180 → 289**), but it did not reliably reduce discovery: the model still opened with a workspace listing in **4 / 4** full-context runs. Across four paired `deepseek-v4.1` multi-file runs, the compact-seed baseline independently verified every task using **39,771 input tokens / 18 model turns / 32 tool calls** total; full repository context also verified every task but used **56,869 input / 23 turns / 34 calls**. That is about **43% more input**, five extra model turns, and two extra tools overall. Trebell therefore keeps the compact Native repository seed instead of replaying source excerpts upfront; richer context is not an optimization when the model still performs the same discovery work.

A smaller seed-wording experiment was rejected too. It changed the seed from "likely relevant paths" to wording that explicitly said the listed paths were deterministically indexed in the current workspace, hoping the model would trust them enough to skip a root listing. Across two paired `deepseek-v4.1` multi-file runs, the untouched seed used **23,062 input tokens / 10 model turns / 16 tool calls** total; the stronger wording used **25,249 input / 11 turns / 16 calls**. Both variants independently verified every run, but the candidate still called `trebell_workspace/list` in **2 / 2** runs and used about **9.5% more input** overall. Trebell therefore does not keep adding persuasive seed prose to solve redundant discovery; the next useful improvements should be structural and measured end-to-end.

A later prompt-only attempt to prevent gratuitous edits was rejected for the same reason. The candidate added a system rule saying not to modify task/instruction files unless requested or required after one live repair run happened to append a resolution to `TASK.md`. The rule increased the Native system prompt by about **23 estimated tokens on every request**. In the isolated candidate rerun the task used **11,968 input tokens / 5 turns / 7 tools** and did not edit `TASK.md`; the reverse-order untouched baseline also did not edit `TASK.md` and used **12,066 / 5 / 7**. With identical turn/tool counts and only a 98-token aggregate difference, the apparent gain was ordinary model variance rather than evidence for paying a permanent prompt tax, so the rule was not kept.

A structural variant that temporarily hid broad file-discovery tools on the first model turn was rejected as well. Hiding `trebell_workspace/list` when a deterministic repository seed already named several files looked promising in four paired multi-file samples (**39,661 candidate input tokens / 18 turns / 30 tools** versus **46,744 / 20 / 32** for baseline), but the broader three-scenario benchmark regressed: one run substituted `trebell_repo/search_files` for the hidden list, and another stronger variant hallucinated `/app/...` paths and produced four failed reads before recovering. Trebell therefore keeps the full first-turn capability set stable instead of forcing a particular discovery strategy. The `/app/...` root assumption itself was fixed separately by the bounded path-normalization recovery described above, because correcting a harmless protocol/path mismatch is safer than restricting model capabilities.

A resource-aware repository-seed experiment was rejected too. The Context Engine prototype detected static JavaScript/TypeScript resources such as `new URL("./expected-mode.txt", import.meta.url)` and added only the referenced workspace path—not its contents—to the compact Native seed. Deterministic tests confirmed the metadata was narrow and did not leak file contents. In two clean `resource-driven-repair` pairs where the verifier intentionally reported only a generic mismatch, the candidate used **23,035 input tokens / 9 model turns / 15 tool calls** versus **24,406 / 10 / 14** for baseline: about **5.6% less input** and one fewer turn, but one extra tool. In the existing noisy-output task, where the failure already revealed the expected value, the same metadata was counterproductive: **15,758 input / 6 turns / 6 tools** versus **15,016 / 6 / 4** baseline. Across the three clean pairs together, resource metadata moved the total only from **39,422 → 38,793 input tokens (~1.6% less)** while increasing tool calls **18 → 21**. Trebell therefore does not add static resource paths to every Native seed; a tiny context addition can still create extra curiosity/discovery work when the referenced resource is redundant.

A static-resource seed experiment was also rejected. A candidate taught Context Engine to notice relative `new URL("...", import.meta.url)` resources such as `expected-mode.txt` and add only their resolved path names to the compact seed, without preloading file contents. In one noisy-output pair this worked as hoped and reduced the task from **19,620 to 16,516 input tokens** by letting the model batch the referenced file with its other reads. In the next valid pair, however, the model did not exploit the hint and the recurring extra seed tokens became overhead. Across the two valid pairs, baseline used **37,413 input tokens / 14 model turns / 11 tools** total while the resource-seed candidate used **39,237 / 14 / 12**, about **4.9% more input**. Additional attempted samples were excluded because Vyce returned HTTP 429 rate limits. Trebell therefore does not add resource-path hints until a broader measured workload proves they improve end-to-end behavior rather than merely making the repository graph richer.

A narrower just-in-time resource experiment was rejected too. Instead of putting resource metadata in the initial repository seed, that candidate attached the contents of a tiny relative `new URL(..., import.meta.url)` resource only after the model explicitly read the complete source file that referenced it. The deterministic Context Engine behavior passed **24 / 24** focused tests and never attached the sidecar to partial source reads or oversized resources. The real-model behavior still did not improve: in two reversed-order `deepseek-v4.1` pairs the model explicitly reread `expected-mode.txt` in **2 / 2** candidate runs even though its exact contents were already attached to the verifier observation. Baseline totaled **14,288 input tokens / 8 live model turns / 10 tools**; the candidate totaled **16,409 / 9 / 11**, about **14.8% more input**, with one extra failed tool call. Trebell therefore keeps directly referenced resources as explicit model-requested reads instead of speculatively expanding a source observation.

The large-output path was then tightened across user turns: once a virtualized tool result has already been shown in the hot turn, later turns keep only a compact receipt, the searchable output handle, and bounded high-signal failure lines instead of replaying the original preview again. One run of the same 92 KB noisy-output scenario used **23,063 input tokens / 7 model turns / 6 tool calls**; a fresh reproduced rerun used **24,726 input tokens / 8 model turns / 6 tool calls**. Both had **0 failed tool calls**, no output-handle reread, and passed independent verification. Compared with the immediately preceding **29,696-input-token** run, that is roughly **16.7–22.3% less provider input**; compared with the preserved v1.3.3 **37,526-token** noisy-output baseline, the measured reduction is roughly **34.1–38.5%**. The range is reported deliberately because model behavior is stochastic.

Native now applies the same principle *inside* a user turn, but only after the model has already received one hot read of a virtualized result. Before the next provider request, Trebell cools only the history prefix the provider has definitely seen; the newest tool result stays hot, while older virtualized evidence becomes a compact receipt with high-signal failure lines and the persistent output handle. A controlled `deepseek-v4.1` one-turn repair A/B forces the same verify → read → replace → verify workflow on both sides. The untouched `52b96ae` baseline used **8,812 input tokens / 479 output tokens / 4 model turns / 4 tool calls**; the reconciled same-turn cooling candidate used **7,443 input / 480 output / 4 turns / 4 calls**, a **1,369-token (~15.5%) input reduction**, with **0 failed tool calls**, **0 cached input tokens**, and successful independent verification on both sides. The first hot follow-up remained essentially unchanged (**2,409 → 2,401 input tokens**), while later requests dropped **2,603 → 1,927** and **2,773 → 2,088**, matching the intended “hot once, then cool” behavior. Request bytes also fell **39,508 → 34,393 (~12.9%)**. The candidate happened to finish faster in this pair (**14.9 s vs 20.0 s**), but provider latency is stochastic, so this is not treated as a latency guarantee.

Virtualized-output retrieval now exposes one `trebell_output/inspect` function instead of making the model choose between separate `search` and `read` schemas. Supplying `query` searches bounded excerpts; omitting it reads a bounded line range. Legacy `trebell_output/read` and `trebell_output/search` names remain resolvable internally and in per-turn allowlists so persisted recipes do not break, but only `inspect` is provider-visible. This cuts the recurring output namespace from **1,061 → 762 JSON bytes** and from about **266 → 191 estimated schema tokens** after a large result has been virtualized. A controlled live benchmark hides `ARCHIVE_MARKER=kiwi-314159` in the middle of a ~92 KB command result, outside the head/tail preview. Across three search-style A/B pairs, `inspect` found the marker in **3 model turns / 2 tools every time**; the two-tool baseline needed **3, 5, and 5 turns**, twice rerunning the large command before finally searching. Search-mode totals were **11,278 input / 556 output tokens / 53,797 request bytes** for `inspect` versus **17,175 / 1,617 / 80,792** baseline. Three separate bounded-range pairs also all found the marker in **3 turns / 2 tools** on both sides; candidate input was **11,505 vs 11,758** and request bytes **54,867 vs 56,536**. One candidate range run had an unusually high provider output-token count, so output-token variance is not claimed as an inherent improvement. Across all six pairs combined, the candidate still used **22,783 input + 2,739 output = 25,522 total tokens** versus **28,933 + 2,637 = 31,570** baseline, with **18 vs 22 model turns** and **12 vs 16 tools**. A normal noisy-repair check where retrieval was unnecessary also stayed independently correct and used no output retrieval. The causal claim is the smaller stable schema plus preserved search/range capability; the extra avoided reruns are encouraging model-behavior evidence, not a guaranteed turn reduction.

The first hot view of a virtualized result is now adaptive too. Outputs with no failure-like signal keep the existing **3,600-character** head/tail preview; when Trebell has already extracted important error/assertion lines, the hot preview is capped at **2,200 characters** while retaining those signal lines and the persistent output handle. This avoids paying for pages of decorative noise before same-turn cooling can run, without shrinking ordinary successful logs. The compact path is additionally gated by failure-like result metadata (for example a non-zero exit, explicit failure, timeout, signal, error, or HTTP-style error status), so a successful log that merely contains words such as `expected` or `received` still keeps the wider preview. The controlled `npm run bench:vyce:native:hot-preview` benchmark makes the tool call synthetic and sends only the identical post-tool request to Vyce, removing tool-choice variance. In two reversed-order `deepseek-v4.1` pairs the baseline request used **1,201 input tokens / 4,719 bytes / ~1,076 estimated tool-result tokens** both times; the adaptive candidate used **801** and **799 input tokens**, **3,263 bytes**, and **~712 estimated tool-result tokens**. That is about **33.3% less provider input**, **30.9% fewer request bytes**, and **33.8% less estimated tool-result context** on the hot follow-up. Every response still identified the exact `expected mode=strict but received legacy` failure and pointed at `src/config.mjs`. No-signal and successful-signal preview coverage prove the wider 3,600-character path remains unchanged.

Post-edit verification rereads are compacted only when Trebell can prove the model is rereading exactly what it just changed. Native still executes the filesystem read normally. For `write_file`, Trebell knows the exact successful written body; for `replace_text`, it reconstructs the exact post-edit body only when it already has a full prior read and the successful replacement count matches that body. If the actual reread byte-matches the expected body, a sufficiently large fresh observation becomes a small receipt stating that the workspace contents match the exact successful edit already present in the conversation. If the file changed externally, reconstruction is unavailable, or the file is too small for the receipt to save meaningful context, the full reread remains visible. The controlled `npm run bench:vyce:native:post-edit-reread` benchmark forces an identical real-workspace `read → replace_text → reread` sequence synthetically and sends only the final verification request to Vyce. Across three reversed-order `deepseek-v4.1` pairs, baseline stayed at **7,600 input tokens / 28,311 request bytes** with a **13,002-character** fresh reread; the candidate used **2,671–2,675 input tokens / 15,669 bytes** with a **533-character** verification receipt. That is about **64.8% less provider input** and **44.7% fewer request bytes** on the final request. Every baseline and candidate response returned exactly `VERIFIED`. This optimization saves model context only after Trebell has independently re-read and byte-verified the file; it never skips the filesystem check.

Native's stable progressive-repository gateway is also wire-minified without removing any capability. Only redundant prose in `trebell_repo/discover` and `trebell_repo/invoke` was shortened; tool names, arguments, limits, return protocol, and the provider-visible tool set are unchanged. For the standard coding manifest this reduces schema size from **5,117 → 4,851 characters** and from **~1,280 → ~1,213 estimated schema tokens (~5.2%) on every model request**. The controlled `npm run bench:vyce:native:schema-min` probe requires a live model to discover an unexposed semantic rename capability and then invoke it. Across two reversed-order `deepseek-v4.1` A/B pairs, both baseline and candidate used exactly **`trebell_repo/discover → trebell_repo/invoke` in 3 model turns** every time. The candidate's first-request schema measured **~629 tokens** versus **~696** for baseline in that repository-only probe; aggregate provider input was **6,749 vs 6,865 tokens** and request bytes **34,697 vs 35,810** across the two pairs. A separate two-pair multi-file coding check independently verified every run; candidate used **21,744 input / 10 turns / 16 tools** versus **26,982 / 11 / 18** baseline, but that larger end-to-end difference is treated as model variance rather than attributed to schema minification. The causal claim is the deterministic schema-size reduction with preserved live gateway behavior.

A broader shared workspace/terminal schema trim was rejected. A conservative candidate kept the argv contract, field descriptions, limits, `replace_text` exact-match semantics, and the `write_file` preference for surgical edits, but shortened repeated namespace/tool prose enough to reduce the standard coding manifest only from **4,851 → 4,692 characters** and **~1,213 → ~1,173 estimated schema tokens**. Two multi-file pairs happened to favor the candidate (**17,824 input / 8 turns / 15 tools** versus **26,254 / 11 / 18**), so it was tested on failure-driven repair instead of being accepted from those favorable samples. There it regressed from **8,719 input / 4 turns / 5 tools / 0 failed calls** to **16,792 input / 7 turns / 8 tools / 1 failed call**. After a valid edit the candidate emitted a terminal call missing the required `command`, needed another model turn to recover, and later made an unnecessary edit to `TASK.md`. Trebell therefore keeps the fuller workspace/terminal descriptions: saving about **40 estimated schema tokens per request** is not worthwhile when a harder repair task can spend thousands of extra tokens and introduce avoidable tool behavior.

The common workspace/terminal schema received a smaller, deliberately conservative trim. An aggressive draft that removed the terminal's explicit argv/executable guidance was rejected after a live multi-file run emitted `command: "node verify.mjs"` and used **13,911 input tokens / 6 turns / 8 tools** versus **8,232 / 4 / 7** for the untouched baseline. The landed version keeps `argv`, `Executable only`, `Argument vector`, the explicit-shell rule, `replace_text` preference, and exact-match semantics, trimming only redundant wording. The standard 11-function coding manifest falls **4,851 → 4,702 characters** and **~1,213 → ~1,176 estimated schema tokens**. In two reversed-order focused `deepseek-v4.1` pairs, the forced terminal probe produced the correct `{"command":"node","args":["verify.mjs"]}` shape in **4 / 4** calls; each candidate request used **1,441 input tokens / 7,230 bytes** versus **1,456 / 7,339** for baseline. Broader coding-task token counts remained stochastic, so the claimed win is the deterministic recurring schema reduction with preserved terminal behavior, not the larger end-to-end variance.

The narrower `npm run bench:vyce:native:hot-history` benchmark removes tool-choice variance almost entirely by making only the identical final history request live and sending no tool schemas on that final measurement request. That request measured **720 input tokens** without same-turn cooling versus **412** with it (about **42.8% less**), while message history fell from **4,764 to 2,440 characters** and estimated tool-result context from **1,059 to 478 tokens**. The old noisy observation shrank from **4,087 to 1,766 characters**, while its critical failure evidence and output handle remained available and the fresh second-tool result stayed hot. Focused Native loop/session coverage passed **43 / 43**. The concurrent final-validation checkpoint recorded **842 / 842** deterministic tests; a separate follow-up full run completed **841 / 842** with one unrelated Codex app-server integration timeout (`turn/completed notification timed out`), and rerunning that exact test immediately afterward passed **1 / 1**.

History cooling is provider-aware rather than universal. Direct OpenAI is marked as prompt-cache capable, so Native leaves already-sent tool observations byte-identical across later requests and across the next user turn instead of rewriting the cacheable prefix. It also keeps the provider-visible tool manifest stable when the tool budget is exhausted and disables tool use with `tool_choice: "none"` rather than deleting definitions from that cached prefix. Routes without verified prompt caching, including the current Vyce integration, retain the measured aggressive history/schema trimming. The deterministic `npm run bench:native:cache-history` fixture proves both sides without provider credentials: the OpenAI-shaped path keeps the same large observation digest/character count and the same tool manifest, while the Vyce-shaped path shrinks the old **4,087-character** observation to the compact receipt and drops exhausted tool schemas. This is a cache-hit-rate optimization, not a claimed OpenAI billing measurement; no direct OpenAI test key was available for this audit. Current OpenAI guidance recommends preserving growing conversation history and stable tool definitions for multi-turn prompt caching.

Repeated deterministic repository searches are also re-executed before Trebell decides whether their provider-visible evidence can be compressed. When the same `search_code`, `search_symbols`, or `search_files` call returns byte-identical successful evidence, the later result becomes a small receipt pointing back to the earlier observation; changed, failed, or uncertain results remain fully visible. In the controlled `npm run bench:vyce:native:search-dedupe` live A/B, the untouched `0459771` baseline replayed the same **12,338-character** search result twice and used **6,975 input tokens** on the final request. The candidate reran the same search, confirmed identical evidence, compressed only the duplicate to **368 characters**, and used **2,859 input tokens** on the otherwise identical final request: **4,116 fewer input tokens (~59.0%)**. Final request message size fell **26,939 → 14,183 characters (~47.4%)**, and request bytes fell **27,092 → 14,336 (~47.1%)**. Both runs reported **0 cached input tokens**. This optimization saves model context, not repository work: Trebell deliberately still executes the second search so repository changes cannot be hidden. The current combined candidate passed **852 / 852** deterministic tests.

Native also stops advertising tools once the exact per-turn tool-call budget has been spent on routes where stable provider-side prompt caching is not verified. If no explicitly required tool remains, Trebell adds one bounded finalization instruction, sends the next model request with **zero tool schemas**, and asks for the best evidence-backed final answer instead of offering tools that would be rejected if called. Direct OpenAI takes the cache-preserving variant described above: schemas stay byte-stable but `tool_choice: "none"` makes them unavailable. If an explicitly required tool is still missing, Trebell fails before spending another inference. In a reproduced controlled Vyce `deepseek-v4.1` A/B after one allowed workspace read, the untouched `700669a` baseline sent **13 unusable functions / 6,177 schema characters** on the final request and used **1,318 input tokens**. The candidate sent **0 functions / 2 schema characters (`[]`)** and used **160 input tokens**, **1,158 fewer (~87.9%)**. Request bytes fell **6,479 → 1,058 (~83.7%)**. Both runs returned the same exact final marker with **0 provider tool calls** and **0 cached input tokens**.

Native terminal normalization also tolerates one harmless compatibility artifact seen from OpenAI-compatible models: an extra generic `shell` hint on an otherwise valid argv-style terminal call is ignored before schema validation. This does **not** permit shell syntax; pipes/redirection still require an explicitly invoked shell executable and remain rejected otherwise. In the controlled `npm run bench:vyce:native:shell-hint` A/B from the same `cd83e29` baseline, the old path turned `{"command":"node verify.mjs","shell":"cmd"}` into **3 model turns / 2 tool calls / 1 failed call** before the model repaired it, with the final request using **1,301 input tokens / 6,831 bytes**. The candidate normalized the harmless hint and completed in **2 turns / 1 tool call / 0 failed calls**; its final request used **693 input tokens / 3,695 bytes**. Both runs reached a nonempty final answer with **0 final provider tool calls** and **0 cached input tokens**. This is primarily a reliability/latency win, with lower token use as a consequence of avoiding the repair turn.

Native now also repairs one narrow namespace-placement error without guessing. If a model emits an exact visible Trebell tool name under the wrong *visible Trebell namespace*, Trebell moves the call only when that exact name has one unique visible Trebell home. Ambiguous names remain untouched, and this repair never moves a call into an external/MCP namespace. Normal tool policy still runs on the repaired target. The controlled `npm run bench:vyce:native:tool-namespace` probe injects the same malformed `trebell_repo/replace_text` call into both builds and makes only the final answer request live. Across two reversed-order `deepseek-v4.1` pairs, baseline consistently needed **3 model turns / 2 tool calls / 1 failed call** before the corrected `trebell_workspace/replace_text` succeeded; the candidate consistently used **2 turns / 1 tool / 0 failures**. The final live request fell from **205 → 121 input tokens (~41.0%)**, **1,282 → 824 request bytes (~35.7%)**, and **~110 → ~54 estimated tool-result tokens (~50.9%)**. Focused Native loop coverage passed **34 / 34**, including ambiguity and external-namespace guards; the integrated authoritative suite then passed **878 / 878** with **0 failures**.

Historical tool-call arguments are cooled on non-cache routes after one provider-visible read, just like large tool results. This is deliberately narrow: only oversized (≥4 KB) `trebell_workspace/write_file.content` and `replace_text.old_text/new_text` payloads are replaced with a bounded hash+preview receipt; paths and small edits remain exact, newer tool calls stay hot, and the cache-preserving OpenAI lane leaves already-sent calls byte-identical. Compaction also fails closed on recoverability: failed, uncertain, unparseable, or not-yet-completed edit calls keep their exact arguments so a later repair still has the original content. In the controlled `npm run bench:vyce:native:toolcall-history` A/B from the same `7bf19e9` baseline, a 40,073-character historical `write_file` argument stayed fully hot for its first provider read. On the next request the baseline replayed all **40,073 characters**, using **11,424 input tokens / 41,532 request bytes**. The candidate cooled that old argument to **485 characters** while leaving the newer read evidence intact; the otherwise identical live request used **320 input tokens / 1,946 bytes**, about **97.2% less input** and **95.3% fewer request bytes**. Focused helper/session/loop coverage passed **62 / 62** after the recoverability guard.

Generated Trebell working-context packets are also cooled across later user turns on routes without verified prompt caching, but only by source. When a newer packet refreshes a source such as repository knowledge or the durable goal, the older copy of that source is removed from provider-visible history. Prior sources that the new packet does **not** replace remain available verbatim, so one-off evidence such as a verification-repair packet is not silently discarded. Direct OpenAI keeps prior packets byte-identical for prompt-cache reuse. In the controlled `npm run bench:vyce:native:prior-context` A/B, two same-shaped ~19.5k-character context packets changed the second request from **10,873 → 5,492 input tokens (~49.5% less)** and **39,832 → 20,282 request bytes (~49.1% less)** with the refreshed packet still present. The mixed-source benchmark is stricter: the old packet contained repository + goal + one-off repair evidence, while the new packet refreshed only repository + goal. The conservative all-or-nothing cooler therefore replayed everything and used **12,119 input tokens / 44,457 bytes**. Source-aware cooling removed only the stale repository/goal copies, retained the one-off repair evidence, and used **6,674 input / 24,630 bytes** — about **44.9% less input** and **44.6% fewer request bytes** than that conservative candidate. These Vyce runs reported **0 cached input tokens**; cache-capable provider behavior remains intentionally different.

The same cooler now handles small generated packets by economics instead of an arbitrary size threshold: Trebell replaces an older source only when the replacement text is actually shorter, so cooling can never expand provider-visible history. With `TREBELL_PRIOR_CONTEXT_ROWS=3`, a controlled 363-character old/new context pair used **211 input tokens / 1,246 request bytes** on the second Vyce request before this refinement and **143 input / 989 bytes** after it — about **32.2% less input** and **20.6% fewer request bytes**. The old packet was absent, the new packet remained present, and a separate regression proves tiny contexts stay untouched when the omission marker would be larger.

Native repository seeds no longer repeat the current visible user task when the Context Engine's ranking task is byte-for-byte the same text. The user message already carries that information, so this removes duplicate provider context without deleting any fact. Continuation queries remain conservative: when a short follow-up such as `continue` expands the ranking task to include the previous objective, that richer continuity task stays in the seed. In the forced four-tool `implicit-rerun-completion` fixture, this reduced the repository working-context estimate from **190 to 149 tokens per request** while preserving the same **4 model turns / 4 tool calls / 0 failed calls** and independent verification. Across two reversed-order live `deepseek-v4.1` pairs, baseline input totaled **8,706 tokens / 43,322 request bytes** and the duplicate-free candidate totaled **8,243 / 41,631**, about **5.3% less provider input** and **3.9% fewer request bytes**. The strictly deterministic saving is the repeated 41-token working-context reduction; the remaining end-to-end difference can include normal provider-response variance. Candidate wall time was slower across these samples, so no latency improvement is claimed.

That dedupe rule is now policy-driven for Trebell's local deterministic read surfaces instead of being a growing hardcoded list: repository intelligence, workspace reads/listings, virtualized-output reads/searches, and read-only source-control status can compact a later byte-identical successful observation. Edit tools, failed/uncertain reads, process state, browser evidence, and computer evidence remain outside this optimization. A deterministic A/B against `700669a` shows why this matters beyond repository search: repeating the same large workspace listing left the old build at **16,562 provider-visible message characters / ~4,051 estimated tool-result tokens**; policy dedupe reduced that to **8,918 characters / ~2,140 estimated tokens**, about **46% fewer message characters and 47% fewer estimated tool-result tokens**, while still executing the second listing before deciding it was unchanged.

Native also has one bounded recovery for an exact tool call the user explicitly names, such as `Call trebell_browser.open ...`. If the model answers without performing that exposed tool, Trebell can force that one namespaced tool once and require evidence before completion. Negated requests, vague natural-language requests, and tool names that appear only in Trebell working context do not trigger the recovery. A real Vyce probe confirmed forced namespaced `trebell_computer/screenshot` selection works. A separate tool-order experiment found the model called the requested screenshot both with the normal schema order and with the computer namespace moved first, so Trebell keeps schema ordering stable instead of shuffling tools and needlessly changing cache/schema hashes.

A separate attempt to shrink the baseline Native repository manifest to only `search_code` was rejected. Removing direct baseline access to `search_symbols`, `search_files`, and `read_source` broke three focused Native repository/executor regressions, including direct symbol/source observations. Trebell therefore keeps those small deterministic repository primitives exposed until a measured migration proves that hiding them behind `discover`/`invoke` preserves behavior and lowers total cost rather than merely shrinking the first request.

A separate Native system-prompt compression experiment was also rejected. The shorter wording remained functionally correct in focused prompt tests, but the same multi-file live benchmark regressed from the earlier **11,583 input tokens / 5 model turns / 8 tool calls** to **14,219 input / 6 turns / 10 calls**. Trebell therefore keeps the clearer prompt wording: shaving prompt characters is not an optimization when the model spends more turns and tokens compensating for reduced guidance.

An anti-reread prompt experiment was ultimately rejected for the same end-to-end reason. A candidate added one seemingly sensible rule telling Native not to repeat an identical successful deterministic read/search unless state could have changed or the earlier result was incomplete. Some broader stochastic runs showed small gains, so the rule was tested more aggressively instead of being accepted from one favorable sample. Across **four paired current-lineage `deepseek-v4.1` `test-failure-repair` runs**, all eight runs independently verified. The untouched prompt totaled **46,354 input tokens / 19 model turns / 26 tool calls / 0 failed calls**; the one-line candidate totaled **47,648 input / 20 turns / 26 calls / 1 failed call** — about **2.8% more input** overall, with one extra model turn and a new failure. Individual pairs swung in both directions, including one severe **8,879 → 14,081** regression. Trebell therefore keeps duplicate-observation control in deterministic harness logic (safe-read dedupe/cooling) instead of baking an unstable behavioral rule into every request.

A provider-visible repository-description compression experiment was rejected for the same reason. It kept all **11** baseline functions and reduced the repeated tool manifest from **5,117 to 4,793 JSON characters** (about **1,280 to 1,199 estimated schema tokens**), but a reproduced three-scenario live run still used **44,968 input tokens / 17 model turns / 21 tool calls**. The clean pre-experiment baseline was **35,397 input / 14 turns / 17 calls**. Trebell therefore keeps the fuller tool descriptions: schema bytes are only worth removing when end-to-end model behavior stays at least as efficient.

A non-cache history experiment that removed old assistant prose attached to fully successful tool-call messages was also rejected as too small and inconclusive. The candidate waited until every tool call in the assistant message had a structured successful result and until that message had already been read hot by the provider; cache-capable routes such as direct OpenAI were left byte-stable. Two failure-repair samples happened to balance to the same **10 model turns / 13 tool calls** on each side and moved aggregate input only **23,968 → 23,765 tokens (~0.85%)**, while a same-shape large-output comparison moved **18,078 → 17,944 input tokens** and **83,900 → 82,795 request bytes** with the same **7 turns / 6 tools**. The broader three-scenario candidate still used **38,406 input / 16 turns / 20 tools** versus current main's **37,978 / 16 / 19**. All runs independently verified, but the recurring saving was under 1% and did not improve the end-to-end aggregate, so Trebell keeps completed tool-call rationale in history rather than trading semantic context for a marginal token reduction.

A blanket Native provider-output cap was rejected after a controlled `deepseek-v4.1` failure-repair probe. The recent uncapped current-tree run completed and independently verified in **4 model turns / 6 tool calls / 8,983 input / 613 output tokens / 24.27 s**. Setting every model turn to a maximum of **512 output tokens** did not truncate any individual response, yet the same task regressed to **6 turns / 8 tools / 15,266 input / 971 output / 40.44 s**. Because the cap altered model behavior enough to create extra inference/tool work without ever reaching the ceiling, Trebell does not apply a blanket lower output limit; finalization cost should be reduced with deterministic harness state, not a global token squeeze.

Proactively forcing the existing schema-free tool-budget finalization path after the same repair loop was also rejected as a completion optimization. Capping the scenario at the six tool calls used by the successful baseline did remove the tool manifest from the final requests (**4,702 schema characters → 2**), and the run still independently verified with exactly **6 tool calls**, but the model needed **6 inference turns** instead of 4. Total use regressed to **12,519 input / 942 output tokens / 35.03 s**. The final two provider attempts had no tool calls and no schemas, so the regression came from needing an extra finalization inference rather than extra tool work. Trebell therefore keeps schema-free finalization as a safety mechanism when the real tool budget is exhausted, but does not intentionally exhaust the budget merely to make a task look complete.

The narrower verifier-driven finalization case **was accepted** because it has deterministic completion evidence instead of an artificial budget trick. Trebell disables tools for the next/final model request only when the user explicitly says to answer after a verifier passes, that exact terminal command previously failed, at least one successful workspace edit occurred, and the same normalized command later exits 0. Any user steering disables the shortcut for the active turn, and cache-capable providers keep the stable tool manifest while using **tool_choice: none**. On the explicit noisy-verifier benchmark, baseline and candidate both independently verified with the same **4 model turns / 4 tool calls**; input moved **7,025 → 6,734 tokens (~4.1% lower)**, while the final request's tool schema fell from **386 estimated tokens to 1** and its provider input moved **2,091 → 1,824 tokens**. Wall-time differences are not credited because provider latency was stochastic.

That accepted path is now quality-gated as well as cheap. When the user explicitly asks for a **concise/brief/short summary after the verifier passes**, every explicitly required tool is already satisfied, and Trebell has the exact fail → successful workspace edit → same-verifier-pass chain, Native may skip the final model call only when every verified edit is a small, safely describable `replace_text` change. The synthesized answer reports the changed path, a bounded semantic replacement, and the passing verifier status. Opaque, multiline, large, write-file, or secret-like edits deliberately fall back to the normal provider-authored final turn instead of trading answer quality or secrecy for token savings; richer requests such as root-cause analysis or next-step advice also still go back to the model. In a same-model `deepseek-v4.1` live A/B on the forced noisy-verifier workflow, the pre-synthesis baseline independently verified with **4 provider calls / 4 tools / 6,790 input tokens / 31,583 request bytes**; the hardened synthesis candidate independently verified the same workflow with **3 provider calls / 4 tools / 4,968 input tokens / 23,182 request bytes**, and its final summary stated `src/config.mjs: replaced "legacy" with "strict"`. That structurally removes one provider round trip and about **26.8% of measured input** in this fixture. The observed wall times (**24.42 s vs 23.69 s**) are recorded only as samples because upstream latency was noisy, not as a guaranteed speedup. The hardened isolated tree passed **901/901** deterministic tests with **0 failures / 0 skips**.

The same verified-finalization mechanism now handles one even more deterministic response shape without inference: if the real user instruction ends by asking Trebell to **reply/answer/respond exactly** with a bounded quoted literal or simple token after the verifier passes, Native returns that user-specified literal directly once the same fail → successful edit → same-verifier-pass chain is proven and all explicitly required tools are satisfied. Literal detection reads the real user-input provenance rather than appended working context, so repository/context text cannot smuggle in the marker; steering or any request for richer final content keeps the normal provider-authored path. In a controlled `deepseek-v4.1` A/B with the identical forced `run verifier → read → replace → rerun verifier` sequence and final `VERIFIED_OK` instruction, the baseline used **4 provider calls / 4 tools / 6,656 input tokens / 31,058 request bytes**. Exact-literal synthesis used **3 provider calls / 4 tools / 4,853 input tokens / 22,723 request bytes**, eliminating one provider round trip, **1,803 input tokens (~27.1%)**, and **8,335 request bytes (~26.8%)** while both runs independently verified. The candidate happened to take **21.66 s** versus the baseline's **19.05 s**, so Trebell records no latency win from that pair; the causal gain is the removed inference request and its recurring context. The combined hardened-summary + exact-literal tree passed **904/904** deterministic tests with **0 failures / 0 skips**.

Native now recognizes another common deterministic stopping condition: when the real user's **terminal instruction** is to rerun a named verifier command (for example `node verify.mjs`) or a generic verifier/check/test until it passes, Trebell may finish immediately after proving the same `fail → successful workspace edit → pass` chain instead of buying one more model call merely to say that the requested workflow is complete. The generic completion receipt is intentionally narrower than the concise-summary path: it reports only bounded changed paths plus the passing-verifier fact, so secret-like replacement contents are never echoed just to save a turn. Negated instructions and requests with trailing work still fall through to the model. Explicit command targets are additionally bound to the actual normalized terminal command that passed; an unrelated `setup.mjs` fail/pass cannot satisfy a request to rerun `node verify.mjs`. Generic verifier/test/check wording also fails closed unless the repeated terminal command itself looks verification-related (for example a verify/test/check/lint/typecheck command); ambiguous custom commands simply keep the normal model-finalization path. Clear older post-verifier clauses such as `after the verifier passes, reply...` use the same guard, while ambiguous post-verifier article/pronoun clauses keep the previous conservative behavior instead of inventing a target. In a controlled same-model `deepseek-v4.1` A/B with the **identical forced four-tool workflow** ending in `Re-run the verification until it passes`, the pre-feature parent independently verified with **4 provider calls / 4 tools / 6,859 input tokens / 32,134 request bytes**. Completion synthesis independently verified with **3 provider calls / the same 4 tools / 4,866 input tokens / 22,855 request bytes**, eliminating one provider round trip, **1,993 input tokens (~29.1%)**, and **9,279 request bytes (~28.9%)**. The candidate happened to take **33.06 s** versus the baseline's **28.26 s**, so Trebell records no latency win from that pair; the causal gain is the removed post-verification inference and its recurring context. The final target-bound, path-only receipt tree passed **910/910** deterministic tests with **0 failures / 0 skips**.

The terminal-completion parser now safely covers the common shorthand **`rerun it until it passes`** (and equivalent `this`/`that`/`again` forms) without guessing what `it` means. Trebell only enables the shortcut when the same real user instruction already positively referenced a run/verifier/test/check, exactly one distinct terminal command had failed before the successful edit, the command itself looks verification-related, and the command that later passes is that same failed command; a unique but unrelated command such as `setup.mjs`, multiple failed command identities, missing earlier run context, a negated earlier reference or rerun instruction, or trailing requested work all keep normal model finalization. The live benchmark has a hidden `implicit-rerun-completion` scenario that restricts each forced request to exactly one intended tool so model batching cannot contaminate the comparison. In the controlled `deepseek-v4.1` pair, baseline and candidate both independently verified the identical **run → read → replace → rerun** workflow with **4 tool calls / 0 failed tools**. Baseline needed **5 provider calls / 5,778 input tokens / 28,542 request bytes**; pronoun resolution needed **4 provider calls / 4,298 input tokens / 21,565 request bytes**, removing one provider round trip and measuring **1,480 fewer input tokens (~25.6%)** plus **6,977 fewer request bytes (~24.4%)**. The baseline's removed fifth request alone accounted for **1,408 input tokens**; the remaining small difference came from normal provider-response variance earlier in the run. The observed wall times (**52.41 s vs 32.14 s**) are samples only, not a claimed latency guarantee.

The same evidence-gated completion path now understands **`keep rerunning … until it passes`** / **`keep re-running … until it passes`** for both a named verifier and the uniquely resolved pronoun form. In a controlled `deepseek-v4.1` A/B using the same hidden four-tool fixture with only that wording changed, baseline and candidate both independently verified with **4 tool calls / 0 failed tools**. The baseline needed **5 provider calls / 5,808 input tokens / 28,547 request bytes**; the grammar-aware candidate needed **4 provider calls / 4,389 input tokens / 21,885 request bytes**, removing one provider round trip, **1,419 input tokens (~24.4%)**, and **6,662 request bytes (~23.3%)**. The observed wall times (**44.17 s vs 38.70 s**) are samples only. One earlier candidate attempt was excluded from the comparison because the provider invented a nonexistent working directory and failed the very first verifier call; it never reached the edit or deterministic-completion path and independent verification failed, so Trebell does not count it as optimization evidence.

A hidden post-edit auto-verifier was also rejected after a causal trace check. One `deepseek-v4.1` repair sample appeared to improve to **3 model turns / 6,495 input tokens**, but the second provider response had already emitted both `trebell_workspace/replace_text` **and** `trebell_terminal/run` before either result was available. The hidden verifier therefore ran the exact same `node verify.mjs` check a second time; it did not cause the saved inference turn. Trebell keeps verification explicit and model-visible rather than adding invisible duplicate command work. The useful finding is that Native already preserves model order for unsafe tool batches, so a model can issue an edit followed by its known verifier in one response when it has enough evidence to do so safely.

Moving an explicitly required failing verifier **before** the first model request was also rejected. Trebell pre-ran the exact `node verify.mjs` command and attached the real exit-1 evidence as application context, but the same `deepseek-v4.1` repair task expanded to **6 model turns / 8 total tool executions / 15,708 input / 1,533 output tokens / ~62.3 s**. The normal current-lineage sample completed in **4 turns / 5 tools / 8,730 input / 707 output / ~27.9 s**. The preflight model explored more files and even performed an unnecessary `TASK.md` rewrite, so Trebell does not automatically front-run explicit verification commands just to remove the model's first tool decision.

A narrowly worded system-prompt hint advertising ordered dependent batching (for example, "exact edit then exact verifier in one response") was rejected as unreliable. Two independently verified `deepseek-v4.1` repair samples still needed **4 turns / 9,254 input / 27.6 s** and **5 turns / 12,180 input / 30.4 s** respectively. Trebell already executes unsafe calls in model order; adding permanent prompt prose did not make the useful batching behavior consistent enough to justify recurring tokens on every request.

A one-fixture "simple task → faster model" routing probe was likewise insufficient to justify automatic model switching. On the same independently verified failure-repair fixture, current `deepseek-v4.1` used **4 turns / 5 tools / 8,730 input / ~27.9 s**. `deepseek-v4-flash` exhausted the **10-turn** budget despite leaving the repository fixed (**10 tools / 24,480 input / ~57.9 s**), `gpt-6-luna` passed in **6 turns / 7 tools / 39,369 input / ~42.3 s**, and `claude-sonnet-4-6` passed in **6 turns / 8 tools / 15,616 input / ~48.8 s**. These are single stochastic samples, not a general model ranking; the only supported conclusion is that Trebell should not route "easy" coding work from model names or presumed speed without broader task-level evidence.

### Same-task live harness comparison

`npm run bench:harnesses:live` gives each available harness its own disposable copy of the same small repository bug-fix task, requires the harness to edit code and run `node verify.mjs`, and then reruns that verification independently outside the harness. Set `TREBELL_HARNESS_COMPARE_ONLY` to a comma-separated runtime list to run a bounded subset. The command is explicitly live/opt-in and should not be used as a background benchmark tournament.

One reproduced 2026-09-27 Windows run after the Native/external-harness architecture split measured:

| Harness path | Model | Result | Task latency |
| --- | --- | --- | ---: |
| Trebell Native → VyceAi | `deepseek-v4.1` | independent verification passed; 4 model turns, 7,888 input / 281 output tokens | 12.93 s |
| Codex native account | `gpt-6-luna` | independent verification passed | 12.57 s |
| OpenCode | `opencode/muse-spark-1.3-contributor-free` | independent verification passed | 10.92 s |
| Antigravity ACP | `gemini-3.8-flash-high` | independent verification passed | 16.61 s |
| Grok ACP | runtime reached, but the provider returned `Rate limited` before the task could run | not verified | — |

These are integration measurements from one task/run, not a general quality ranking. Models, service load, provider routing, and stochastic tool choices can materially change latency and token counts. Claude Code remained installed but unauthenticated on this machine, and the Cursor launcher was unavailable, so neither is represented as a successful live comparison.

---

## Building a Windows release

~~~bat
make-exe.cmd
~~~

The release pipeline:

1. installs dependencies including optional native packages;
2. runs deterministic tests;
3. materializes app icons;
4. builds the provider bridge and frontend;
5. builds an unpacked Windows app;
6. runs installed desktop + bundled Codex smoke tests;
7. builds the NSIS installer/update metadata;
8. copies release artifacts into the ignored **release-artifacts/vX.Y.Z/** folder.

Build **and publish**:

~~~bat
make-exe.cmd publish
~~~

Equivalent npm commands:

~~~bash
npm run release:windows
npm run release:windows:publish
~~~

Other configured packaging targets:

~~~bash
npm run desktop:dist:mac
npm run desktop:dist:linux
~~~

---

## Repository layout

~~~text
.
├── bin/                    CLI entrypoints
├── branding/               source branding assets
├── build/                  source icon + generated packaging icons
├── desktop/                Electron shell, preload, updater, desktop bridge
├── scripts/                release, benchmark, replay and live-test scripts
├── src/                    backend/runtime/services
├── tests/                  deterministic and integration tests
├── ui/                     React/Vite desktop UI + Playwright E2E tests
├── vendor/freebuff2api/    vendored compatibility bridge source
├── goal.md                 product/architecture contract
├── MANUAL_TESTING.md       remaining real-world validation checklist
├── THIRD_PARTY_NOTICES.md  attribution/provenance
├── make-exe.cmd            Windows release entrypoint
└── package.json
~~~

Generated installers are intentionally not committed:

~~~text
release-artifacts/
desktop-dist/
~~~

---

## Release and update behavior

The Windows release produces:

- NSIS installer;
- blockmap;
- latest.yml;
- release.json with SHA-256, byte size, build time and Git commit.

Updater failures remain visible instead of being converted into fake success.

---

## Licensing and attribution

Trebell Code wrapper/integration code is licensed under **Apache-2.0**.

Trebell integrates the OpenAI Codex runtime and retains upstream attribution.

The Freebuff compatibility bridge is derived from **chenjh16/freebuff2api** under the MIT license.

See:

- **LICENSE**
- **NOTICE**
- **THIRD_PARTY_NOTICES.md**

---

## Product contract

If a future implementation decision conflicts with a convenient shortcut, **goal.md** is the reference for what Trebell is trying to become.

> Build a dependable engineering harness around increasingly capable models; do not keep old orchestration complexity merely because weaker models once needed it.
