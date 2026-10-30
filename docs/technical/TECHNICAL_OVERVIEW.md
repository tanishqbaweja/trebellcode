# Trebell Code

> **A coding harness optimized for verified software-engineering quality per dollar.**

Trebell's primary goal is to make a capable model **more economically effective as a coding agent**: match or beat the result produced by mature coding harnesses while reducing the total model cost required to get there.

The desktop workspace, runtime adapters, terminals, Git/worktrees, browser verification, durable context, source control, and recovery systems all support that goal. Multiple agent runtimes are an interoperability and convenience feature; they are not the core product thesis.

**Version:** 2.0.1 · **Runtime:** Node.js 22+ · **Desktop:** Windows / macOS / Linux packaging targets

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

The product contract lives in **[PRODUCT_PRINCIPLES.md](PRODUCT_PRINCIPLES.md)**. The remaining real-world validation work is tracked in **[TESTING.md](TESTING.md)**.

---

## Why Trebell exists

Most coding-agent frontends answer one question:

> “How do I talk to this model?”

Trebell is built around a harder question:

> “How do I give different coding agents the same dependable engineering environment without pretending they all support the same things?”

That leads to five rules:

1. **Harness capabilities are explicit.** Trebell Native, Codex, Claude Code, OpenCode, Cursor, Grok Build, Antigravity and Muse Code do not magically expose identical queues, sandboxes, rewinds, profiles, delegation or attachment support.
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
    EXTERNAL["Claude Code · OpenCode · Cursor · Grok Build · Antigravity · Muse Code"]
    PROVIDERS["OpenAI · Anthropic · Gemini · xAI · Meta · AgentRouter · JustWorker · HCNSec · VyceAi"]
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
- Trebell Native + the official OpenAI, Anthropic, Gemini, xAI or Meta Model API;
- Codex using Codex's own account/provider/model configuration;
- Claude Code using Claude Code's own model/auth semantics.

Each external harness signs in as the person sets it in Settings for its runtime profile (`src/harness-auth.mjs`): **Sign in**, its own
login in its own home (the default), or **API key**, its vendor's key from Native's key store in the form its official CLI takes it
(`ANTHROPIC_API_KEY` for Claude Code, `META_API_KEY` for Muse Code, `XAI_API_KEY` with Grok's key method, `GEMINI_API_KEY` with Antigravity's
key method, each saved provider's variable for OpenCode, which then runs with none of the logins `opencode auth login` keeps: OpenCode
1.x on an empty set of them, `OPENCODE_AUTH_CONTENT={}`, which it reads in place of its `auth.json`, and OpenCode 2.x, which keeps
them in its database ahead of a key in its environment and reads no `OPENCODE_AUTH_CONTENT`, on a database of Trebell's own for the
profile, `OPENCODE_DB=<Trebell home>/opencode-api-key-homes/<profile>/opencode.db`, which holds none of them; its 2.x sessions live
there too, so a thread whose session is in the other database continues in a new session with its earlier messages handed over;
Codex signs in with `codex login --with-api-key` in a home of Trebell's own over its shared home, which
`codex logout` empties again once the profile is back on Sign in or removed, or the OpenAI key is removed or replaced (every such
home, a profile's that is not running included, once the app-servers on the key have stopped); Grok signs in with its key
method before each chat session and each Git text session starts). A harness on API key runs on this machine only: Trebell sends no
saved key to a WSL or SSH environment, and a key the host's shell holds never stands in for it, so there it is refused until it is set
to Sign in, which uses its own login there. An OpenCode profile with a server URL of its own runs on that server's sign-in and cannot be
set to API key. Every start of a profile on API key checks its key again (`AgentRuntimeManager.keyRefusal`: the relay's sessions, Git
text, and a status kept from before the key went): with none, its status says so once its version is read, and nothing of the
harness starts for it, no chat, Git text, sign-in check (`claude auth status`), account read (Codex's), model-list host (`muse serve`,
OpenCode's catalog server) or usage read (Claude Code's capability probe), each of which would run on the person's own login. A key saved or removed, or a
profile's method changed, closes the chats of the profiles concerned only, and stops their Codex app-servers whether a profile is the
active one or not (only theirs: the active one's catalog starts again, and another Codex profile's threads go on), since each process
keeps the sign-in or key it started with; a profile removed closes its own open chats and stops its Codex app-servers the same way,
so none goes on with a key removed after it. A key saved or removed on a harness's row is Native's key for that provider too: with
Trebell Native active on it, Native's readiness and model list follow at once, as after the Model provider card. What Trebell keeps
of a harness's own answers is kept per sign-in (the method, and on a
key a fingerprint of it): OpenCode's catalog, an ACP harness's model list, Antigravity's list its sessions report and Claude Code's
capability probe (its models, account and plan usage) are read again after a switch or a new key, never served from the other.
Cursor signs in only. No key reaches a harness any
other way: `src/runtime-environment.mjs` keeps every credential name (`isHarnessCredentialName`) out of what each harness gets of
Trebell's environment, a profile's approved names and its variables (on a WSL or SSH host too, in the variables its Codex app-server
starts with), and Cursor's, Grok's and OpenCode's usage meters read none of their stored sign-ins.

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
| **Muse Code** | Meta's SDK over the Muse Session Protocol, on a `muse serve` Trebell starts | Runs on this machine only; models and Thinking levels from Muse's own list; signs in with `muse login` |

The UI reads a runtime capability contract rather than scattering runtime-name assumptions everywhere.

---

## Trebell-managed inference providers

Current integrations:

- **OpenAI API** (the default selection)
- **Anthropic API**
- **Google Gemini API**
- **xAI API** (Responses, models from `/v1/language-models`; `XAI_API_KEY`)
- **Meta Model API** (Responses, models from `/v1/models`; `META_API_KEY`)
- **AgentRouter**
- **JustWorker.icu**
- **HCNSec.cn**
- **VyceAi**

Every provider requires an API key, so Trebell Native needs one before its first turn. Add it in **Settings → Agents & models**; keys are stored through Trebell's secret handling path. A key saved in Settings takes precedence over the provider's environment variable (for example `OPENAI_API_KEY`).

Only OpenAI's catalog names a default model (`gpt-6-luna`, `nativeDefaultModel`). A catalog that names none and lists more than one model lands the composer on no model (`ui/src/model-choice.js`): its picker reads "Choose a model" and lists every model, each model's versions highest first, and a send before a pick opens the picker and keeps the draft. A saved choice still wins (the thread's own model, the project's default model, a pick made earlier in the window), and a catalog of one model uses it. The harnesses keep their own lists and defaults.

xAI and the Meta Model API are called on their Responses APIs without server-side state: each request carries the whole conversation with `store: false`, asks for `reasoning.encrypted_content` and sends back the reasoning the current turn's replies returned, which both providers document for keeping a model's reasoning across tool calls. A model that refuses `include` gets the request again without it, and its later requests leave it out. Their replies come back whole (`stream: false`), as for every provider but OpenAI, until a live check shows their streamed replies match (`src/native-reply-streaming.mjs`); Meta documents a server-side time limit for unstreamed requests (HTTP 504 `gateway_timeout`), which a live check of a long turn should measure.

`ProviderManager.keyFor(provider)` is the one way the server reads a provider's key for a consumer other than Native's own calls (a harness the person put on API key, `AgentRuntimeManager.harnessKeys`): the key saved in Settings, else the environment variable Native reads for that provider, through the same code; an id that is not a model provider is refused.

> **.env is not product configuration.** A local ignored .env may be used for developer/live-provider tests only.

AgentRouter defaults to its current Codex-compatible OpenAI Chat endpoint at `https://co.agentrouter.org/v1`. Trebell Native still owns the prompt, tools, context, turn loop, and session; the Codex-shaped headers are only an upstream compatibility fingerprint. The fingerprint version follows the bundled `@openai/codex` package instead of freezing an old client version. Compatibility overrides remain available through `AGENTROUTER_BASE_URL`, `AGENTROUTER_WIRE_API`, and `AGENTROUTER_CLIENT_VERSION` when an older/private AgentRouter deployment requires them.

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
- background processes (Trebell Native has them in every session, for servers, watchers and daemons a task needs running);
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

Public benchmark results live in **[../../BENCHMARKS.md](../../BENCHMARKS.md)**.

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

See **[TESTING.md](TESTING.md)** for what automated Windows/mock coverage cannot honestly prove.

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

**https://github.com/tanishqbaweja/trebellcode-releases/releases**

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
| **trebell models --provider ID** | Show models for a Trebell Native provider |
| **trebell --model ID** | Ask the real Codex harness to use a model for this CLI run |
| **trebell gui** | Open the multi-harness app, including Trebell Native direct-API inference |

Provider API keys for normal product use belong in **Settings → Agents & models**, not repository environment files.
`trebell run` does not rewrite Codex's provider or account configuration; Native provider selection is intentionally separate.

---

## Testing

### Deterministic

~~~bash
npm test
~~~

For fast local iteration, Trebell also provides a single-process deterministic gate:

~~~bash
npm run test:fast
~~~

`test:fast` deliberately disables Node's per-file process isolation but keeps serial test execution. Keep `npm test` as the stronger release/final-validation gate.

The deterministic suite is the source of truth for local regression coverage. Live-provider and external-runtime checks are kept separate because they depend on credentials, service availability, and installed runtimes.

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
npm run test:providers:live
npm run test:runtime-profiles:live
npm run test:external-harnesses:live
npm run test:codex:live
~~~

Public benchmark results are summarized in **[../../BENCHMARKS.md](../../BENCHMARKS.md)**. Historical one-off provider and microbenchmark scripts are intentionally not kept in the main repository.

These may optionally read an ignored root **.env** containing test credentials only.

### Benchmarks

Public benchmark comparisons live in **[../../BENCHMARKS.md](../../BENCHMARKS.md)**.

### One Native for the app and the benchmarks

The Trebell Native a person runs and the one the benchmark runner (`benchmarks/harbor/native-harbor-run.mjs`) runs are one program with one configuration, **`src/native-configuration.mjs`**, which both read. It holds every setting that changes what Native does, each with its evidence: measured on fresh benchmark tasks, what every readout ran without a fresh comparison, the app's product default, or new (the last three unmeasured):

| Setting | Value |
|---|---|
| Model | `gpt-6-luna` on OpenAI when the catalog lists it, unless the person picks another; only `gpt-6-luna` has measured settings, and another model runs the unmeasured defaults below |
| Semantic completion gate, its recovery and the mid-task controller checkpoints | Off (measured: no extra resolution, about a third more cost) |
| Ceilings per message | 500 model turns, 5,000 tool calls, no wall-time cap (what every readout ran, the owner's choice for the app; not compared with the app's old 24 and 100); Stop and a goal's budgets stay the person's controls, and a goal's remaining budgets lower them |
| Long context on `gpt-6-luna` | A 272,000-token window with OpenAI server compaction at 245,000 (armed once an input reaches half of it), which rests on the readouts: every readout since 2026-10-01 ran it, but it was never compared on fresh tasks with the client-side read cooling the app ran; other models keep the catalog window and client-side read cooling |
| Reasoning | `reasoning.context` `current_turn` on OpenAI, which rests on the readouts: its fresh comparison with `all_turns` was withdrawn, as a run with one user message shows the model the same reasoning under either, and the app's multi-message threads, where they differ, were never measured; Thinking defaults to Max on `gpt-6-luna` (measured on fresh tasks; the provider's default on other models) unless the person picks a level |
| Speed | No service tier unless the person picks Fast |
| Tools | Repository, workspace, terminal and background processes in every request; output tools from the first request on prompt-caching providers (elsewhere once an output is stored); source control when the message asks for Git work (a git command, a pull or merge request to open, a commit, branch, push, rebase or merge said as such, or an everyday ask such as "fix it and commit", "push it", "new branch", "revert the last commit", "Looks good, commit it" or "Can you commit this?", also at a line's end; never a link or a cited commit, nor a data store's version control), a new rule, narrowed from the product's word rule on 2026-10-29 and unmeasured, which also decides whether a Codex thread gets `trebell_source_control`, from its first message only; browser, desktop control and delegation where the window has them. Background processes were seen only on OpenAI, a prompt-caching provider; elsewhere their tool JSON goes uncached (unmeasured) |
| First message | The repository seed; the continuity block lists only checkpoints already linked to a turn |
| Developer text | The repository-lookup sentence and those of the namespaces the message selected, with no web-research sentence (dropped on 2026-10-29 for the app and the runner alike: no benchmark ran with it, Native has no web search tool, only its terminal's network access, and it invites looking up the upstream fix); other harnesses' threads keep it |
| Context meter and between-turn compaction | Read the last request's input, not the turn's summed input; the window compacts before a message at the person's threshold (85% by default, unmeasured), and the brief runs at the provider's own thinking level under a 4,096-token cap whatever the Thinking pick (unmeasured) |

The runner differs only where a task container cannot have the thing (the browser panel, desktop control, delegation, a person's MCP servers, the permission mode, which stands for Full access, and reply drafts, which change no request); `NATIVE_CONTAINER_ONLY` lists each with its reason. `tests/native-one-config-parity.test.mjs` builds the app's Native and the runner's for the same task and compares their settings, tools, prompts and every byte they send. Benchmark-only environment switches are registered in `NATIVE_RUN_SWITCHES`, off by default and written to each run's metrics; the comparison launcher refuses a readout with any of them set (or with another effort or tier) unless it is named as an experiment, and the integrity audit fails such a lane.

---

## Building a Windows release

~~~bat
make-exe.cmd
~~~

The release pipeline:

1. installs dependencies including optional native packages;
2. runs deterministic tests;
3. materializes app icons;
4. builds the frontend;
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
├── docs/                   architecture, testing, benchmark history, and releases
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

## Third-party attribution

Trebell integrates the OpenAI Codex runtime and retains upstream attribution; see **THIRD_PARTY_NOTICES.md**.

---

## Product contract

If a future implementation decision conflicts with a convenient shortcut, **[PRODUCT_PRINCIPLES.md](PRODUCT_PRINCIPLES.md)** is the reference for what Trebell is trying to become.

> Build a dependable engineering harness around increasingly capable models; do not keep old orchestration complexity merely because weaker models once needed it.
