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

The dedicated `npm run bench:vyce:native:recovery` benchmark now isolates Native path-recovery behavior from the broader stochastic coding suite. In a controlled A/B on the same current tree, with only commit `9d5d4d8` reversed for the comparison build, an oversized source file that was readable from the workspace but intentionally too large for the Context Engine index changed from **3 model turns / 2 tool calls / 1 failed call / 74,059 input tokens** to **2 turns / 1 tool call / 0 failed calls / 6,120 input tokens**. Native's bounded internal `read_source -> read_file` fallback emitted one explicit fallback event and avoided replaying the full ~258 KB file into model context, a measured **91.7% input reduction** in that case. A second task forced the model to read the conventional relative path `workspace/TASK.md` and return file content that was not present in the prompt. Reversing the normalization required **3 turns / 2 reads / 1 failed read / 1,961 input tokens**; current Native completed it in **2 turns / 1 read / 0 failures / 1,116 input tokens**, about **43.1% less input**. A third recovery task forces the equally common container-style `/app/TASK.md` spelling. Before `/app` fallback support, two live `deepseek-v4.1` baseline runs both spent **6 model turns / 5 reads**; one had **5 failed reads / 4,969 input tokens** and exhausted the model-turn budget without recovering, while the other had **4 failed reads / 5,125 input tokens** before eventually finding `/TASK.md`. With the guarded fallback, two candidate runs both completed in **2 turns / 1 read / 0 failures / 1,118 input tokens**. Trebell tries a real top-level `app/` path first and only treats `app` as a virtual workspace root when that literal path does not exist, so repositories that genuinely contain `app/` keep their normal semantics. The same fallback now covers reads, exact replacements, new writes, listings, and terminal/process working directories. All optimized recovery runs independently verified their fixtures and reported **0 cached input tokens**. These are targeted recovery measurements rather than general task-cost guarantees.

Native now applies the same conservative recovery to another common container-root assumption: `/app/...`. Trebell first tries the literal workspace-relative `app/...` path, so repositories that genuinely contain a top-level `app/` directory keep their normal meaning; only when that literal path does not exist does an existing `/app/...` target fall back to the active workspace root. The fallback covers reads, listings, terminal/process working directories, exact replacements, and replacement-style writes to existing files without weakening the existing workspace-boundary checks. In three paired live `deepseek-v4.1` recovery runs that forced the first read to `/app/TASK.md`, the old path used **7,687 input tokens / 11 model turns / 8 reads / 5 failed reads** total. The candidate used **3,362 input / 6 turns / 3 reads / 0 failures**, about **56.3% less input** while returning the hidden marker correctly in every candidate run. A broader recovery-suite pair also kept the oversized-source fallback unchanged at **6,120 input / 2 turns / 1 tool**; the pre-existing `workspace/TASK.md` path continued to succeed at the tool layer and passed cleanly again on an isolated rerun after one stochastic final-text miss.

A targeted rerun of the multi-file scenario after teaching Native to trust already-relevant paths named by Trebell's repository seed used **5 model turns / 11,583 input tokens / 8 tool calls**, down from the immediately preceding **6 turns / 14,591 input / 9 tool calls** while still passing independent verification. The model still performed one initial workspace list, so this is a measured improvement rather than a claim that redundant discovery is fully solved.

A follow-up experiment tested whether Native should stop using the compact seed and inject the full bounded repository evidence packet instead. The full packet added only about **109 estimated working-context tokens** on the first request in this small fixture (**180 → 289**), but it did not reliably reduce discovery: the model still opened with a workspace listing in **4 / 4** full-context runs. Across four paired `deepseek-v4.1` multi-file runs, the compact-seed baseline independently verified every task using **39,771 input tokens / 18 model turns / 32 tool calls** total; full repository context also verified every task but used **56,869 input / 23 turns / 34 calls**. That is about **43% more input**, five extra model turns, and two extra tools overall. Trebell therefore keeps the compact Native repository seed instead of replaying source excerpts upfront; richer context is not an optimization when the model still performs the same discovery work.

A smaller seed-wording experiment was rejected too. It changed the seed from "likely relevant paths" to wording that explicitly said the listed paths were deterministically indexed in the current workspace, hoping the model would trust them enough to skip a root listing. Across two paired `deepseek-v4.1` multi-file runs, the untouched seed used **23,062 input tokens / 10 model turns / 16 tool calls** total; the stronger wording used **25,249 input / 11 turns / 16 calls**. Both variants independently verified every run, but the candidate still called `trebell_workspace/list` in **2 / 2** runs and used about **9.5% more input** overall. Trebell therefore does not keep adding persuasive seed prose to solve redundant discovery; the next useful improvements should be structural and measured end-to-end.

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

That dedupe rule is now policy-driven for Trebell's local deterministic read surfaces instead of being a growing hardcoded list: repository intelligence, workspace reads/listings, virtualized-output reads/searches, and read-only source-control status can compact a later byte-identical successful observation. Edit tools, failed/uncertain reads, process state, browser evidence, and computer evidence remain outside this optimization. A deterministic A/B against `700669a` shows why this matters beyond repository search: repeating the same large workspace listing left the old build at **16,562 provider-visible message characters / ~4,051 estimated tool-result tokens**; policy dedupe reduced that to **8,918 characters / ~2,140 estimated tokens**, about **46% fewer message characters and 47% fewer estimated tool-result tokens**, while still executing the second listing before deciding it was unchanged.

Native also has one bounded recovery for an exact tool call the user explicitly names, such as `Call trebell_browser.open ...`. If the model answers without performing that exposed tool, Trebell can force that one namespaced tool once and require evidence before completion. Negated requests, vague natural-language requests, and tool names that appear only in Trebell working context do not trigger the recovery. A real Vyce probe confirmed forced namespaced `trebell_computer/screenshot` selection works. A separate tool-order experiment found the model called the requested screenshot both with the normal schema order and with the computer namespace moved first, so Trebell keeps schema ordering stable instead of shuffling tools and needlessly changing cache/schema hashes.

A separate attempt to shrink the baseline Native repository manifest to only `search_code` was rejected. Removing direct baseline access to `search_symbols`, `search_files`, and `read_source` broke three focused Native repository/executor regressions, including direct symbol/source observations. Trebell therefore keeps those small deterministic repository primitives exposed until a measured migration proves that hiding them behind `discover`/`invoke` preserves behavior and lowers total cost rather than merely shrinking the first request.

A separate Native system-prompt compression experiment was also rejected. The shorter wording remained functionally correct in focused prompt tests, but the same multi-file live benchmark regressed from the earlier **11,583 input tokens / 5 model turns / 8 tool calls** to **14,219 input / 6 turns / 10 calls**. Trebell therefore keeps the clearer prompt wording: shaving prompt characters is not an optimization when the model spends more turns and tokens compensating for reduced guidance.

An anti-reread prompt experiment was ultimately rejected for the same end-to-end reason. A candidate added one seemingly sensible rule telling Native not to repeat an identical successful deterministic read/search unless state could have changed or the earlier result was incomplete. Some broader stochastic runs showed small gains, so the rule was tested more aggressively instead of being accepted from one favorable sample. Across **four paired current-lineage `deepseek-v4.1` `test-failure-repair` runs**, all eight runs independently verified. The untouched prompt totaled **46,354 input tokens / 19 model turns / 26 tool calls / 0 failed calls**; the one-line candidate totaled **47,648 input / 20 turns / 26 calls / 1 failed call** — about **2.8% more input** overall, with one extra model turn and a new failure. Individual pairs swung in both directions, including one severe **8,879 → 14,081** regression. Trebell therefore keeps duplicate-observation control in deterministic harness logic (safe-read dedupe/cooling) instead of baking an unstable behavioral rule into every request.

A provider-visible repository-description compression experiment was rejected for the same reason. It kept all **11** baseline functions and reduced the repeated tool manifest from **5,117 to 4,793 JSON characters** (about **1,280 to 1,199 estimated schema tokens**), but a reproduced three-scenario live run still used **44,968 input tokens / 17 model turns / 21 tool calls**. The clean pre-experiment baseline was **35,397 input / 14 turns / 17 calls**. Trebell therefore keeps the fuller tool descriptions: schema bytes are only worth removing when end-to-end model behavior stays at least as efficient.

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
