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

The dedicated `npm run bench:vyce:native:recovery` benchmark now isolates Native path-recovery behavior from the broader stochastic coding suite. In a controlled A/B on the same current tree, with only commit `9d5d4d8` reversed for the comparison build, an oversized source file that was readable from the workspace but intentionally too large for the Context Engine index changed from **3 model turns / 2 tool calls / 1 failed call / 74,059 input tokens** to **2 turns / 1 tool call / 0 failed calls / 6,120 input tokens**. Native's bounded internal `read_source -> read_file` fallback emitted one explicit fallback event and avoided replaying the full ~258 KB file into model context, a measured **91.7% input reduction** in that case. A second task forced the model to read the conventional relative path `workspace/TASK.md` and return file content that was not present in the prompt. Reversing the normalization required **3 turns / 2 reads / 1 failed read / 1,961 input tokens**; current Native completed it in **2 turns / 1 read / 0 failures / 1,116 input tokens**, about **43.1% less input**. Both optimized runs independently verified the fixture and reported **0 cached input tokens**. These are targeted recovery measurements rather than general task-cost guarantees.

A targeted rerun of the multi-file scenario after teaching Native to trust already-relevant paths named by Trebell's repository seed used **5 model turns / 11,583 input tokens / 8 tool calls**, down from the immediately preceding **6 turns / 14,591 input / 9 tool calls** while still passing independent verification. The model still performed one initial workspace list, so this is a measured improvement rather than a claim that redundant discovery is fully solved.

The large-output path was then tightened across user turns: once a virtualized tool result has already been shown in the hot turn, later turns keep only a compact receipt, the searchable output handle, and bounded high-signal failure lines instead of replaying the original preview again. One run of the same 92 KB noisy-output scenario used **23,063 input tokens / 7 model turns / 6 tool calls**; a fresh reproduced rerun used **24,726 input tokens / 8 model turns / 6 tool calls**. Both had **0 failed tool calls**, no output-handle reread, and passed independent verification. Compared with the immediately preceding **29,696-input-token** run, that is roughly **16.7–22.3% less provider input**; compared with the preserved v1.3.3 **37,526-token** noisy-output baseline, the measured reduction is roughly **34.1–38.5%**. The range is reported deliberately because model behavior is stochastic.

Native now applies the same principle *inside* a user turn, but only after the model has already received one hot read of a virtualized result. Before the next provider request, Trebell cools only the history prefix the provider has definitely seen; the newest tool result stays hot, while older virtualized evidence becomes a compact receipt with high-signal failure lines and the persistent output handle. A controlled `deepseek-v4.1` one-turn repair A/B forces the same verify → read → replace → verify workflow on both sides. The untouched `52b96ae` baseline used **8,812 input tokens / 479 output tokens / 4 model turns / 4 tool calls**; the reconciled same-turn cooling candidate used **7,443 input / 480 output / 4 turns / 4 calls**, a **1,369-token (~15.5%) input reduction**, with **0 failed tool calls**, **0 cached input tokens**, and successful independent verification on both sides. The first hot follow-up remained essentially unchanged (**2,409 → 2,401 input tokens**), while later requests dropped **2,603 → 1,927** and **2,773 → 2,088**, matching the intended “hot once, then cool” behavior. Request bytes also fell **39,508 → 34,393 (~12.9%)**. The candidate happened to finish faster in this pair (**14.9 s vs 20.0 s**), but provider latency is stochastic, so this is not treated as a latency guarantee.

The narrower `npm run bench:vyce:native:hot-history` benchmark removes tool-choice variance almost entirely by making only the identical final history request live and sending no tool schemas on that final measurement request. That request measured **720 input tokens** without same-turn cooling versus **412** with it (about **42.8% less**), while message history fell from **4,764 to 2,440 characters** and estimated tool-result context from **1,059 to 478 tokens**. The old noisy observation shrank from **4,087 to 1,766 characters**, while its critical failure evidence and output handle remained available and the fresh second-tool result stayed hot. Focused Native loop/session coverage passed **43 / 43**. The concurrent final-validation checkpoint recorded **842 / 842** deterministic tests; a separate follow-up full run completed **841 / 842** with one unrelated Codex app-server integration timeout (`turn/completed notification timed out`), and rerunning that exact test immediately afterward passed **1 / 1**.

Native also has one bounded recovery for an exact tool call the user explicitly names, such as `Call trebell_browser.open ...`. If the model answers without performing that exposed tool, Trebell can force that one namespaced tool once and require evidence before completion. Negated requests, vague natural-language requests, and tool names that appear only in Trebell working context do not trigger the recovery. A real Vyce probe confirmed forced namespaced `trebell_computer/screenshot` selection works. A separate tool-order experiment found the model called the requested screenshot both with the normal schema order and with the computer namespace moved first, so Trebell keeps schema ordering stable instead of shuffling tools and needlessly changing cache/schema hashes.

A separate attempt to shrink the baseline Native repository manifest to only `search_code` was rejected. Removing direct baseline access to `search_symbols`, `search_files`, and `read_source` broke three focused Native repository/executor regressions, including direct symbol/source observations. Trebell therefore keeps those small deterministic repository primitives exposed until a measured migration proves that hiding them behind `discover`/`invoke` preserves behavior and lowers total cost rather than merely shrinking the first request.

A separate Native system-prompt compression experiment was also rejected. The shorter wording remained functionally correct in focused prompt tests, but the same multi-file live benchmark regressed from the earlier **11,583 input tokens / 5 model turns / 8 tool calls** to **14,219 input / 6 turns / 10 calls**. Trebell therefore keeps the clearer prompt wording: shaving prompt characters is not an optimization when the model spends more turns and tokens compensating for reduced guidance.

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
