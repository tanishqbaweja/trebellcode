# Trebell Code

> **A coding harness built to get more engineering done per dollar.**

Trebell Code is an agentic software-engineering harness optimized for **quality per dollar**: reach the same or better verified result as leading coding harnesses while spending less to get there.

The core product is **Trebell Native**, where Trebell controls the model/tool loop and can optimize the parts that determine real agent cost: context growth, prompt caching, tool selection, retries, verification, recovery, compaction, and unnecessary model turns.

Support for Codex, Claude Code, OpenCode, and other runtimes is useful for convenience and side-by-side comparison, but **runtime switching is not the product thesis**.

**Working desktop MVP · Node.js 22+ · Windows release + macOS/Linux packaging**

![Trebell Code workspace: Trebell Native fixes a bug, runs the tests, verifies the change and shows the diff](docs/assets/trebell-code-workspace.png)

## Why Trebell

The price of an agentic coding task is not just the model's list price. It is also determined by how much context the harness repeatedly sends, how well it preserves cacheable prefixes, how many unnecessary turns it takes, which tools it exposes, when it verifies work, and how efficiently it recovers from mistakes.

Trebell's core idea is simple:

**A better harness should get more useful software engineering out of the same model and the same dollar.**

Trebell therefore treats cost as an engineering metric, not a billing afterthought. The goal is not to minimize tokens blindly. A run that uses fewer input tokens but produces much more expensive output, retries more often, or fails the task is not more efficient.

The target is:

**same or better verified quality → lower total model cost.**

Public benchmark work compares Trebell Native against mature harnesses using the **same model and reasoning settings**, then measures the quality-normalized cost required to finish the task. The Native the benchmarks run is the Native you download: both read one configuration ([`src/native-configuration.mjs`](src/native-configuration.mjs)), and a test compares what each sends byte for byte. The benchmarks ran `gpt-6-luna` at Full access, which is Native's OpenAI default when your key lists it; on another model Native runs the app's unmeasured defaults for it (the catalog's context window, client-side history cooling, the provider's thinking level).

## What works today

- **Trebell Native agent harness** with a Trebell-owned model/tool loop, context management, reasoning controls, verification, recovery, and detailed usage telemetry.
- **Cost-aware benchmark instrumentation** for input tokens, cached input, output tokens, total API-equivalent cost, model turns, tool calls, retries, cache behavior, and task quality.
- **Public harness comparisons** against Codex API and Codex OAuth using controlled model/reasoning configurations on software-engineering benchmarks.
- **Context and cache optimization** including lazy tool exposure, bounded context growth, compaction, cache-aware continuation, and evidence-driven recovery.
- **Multi-runtime access** to Codex, Claude Code, OpenCode, and capability-gated external runtimes as a convenience and comparison surface.
- **Provider-independent projects and threads** so workspace identity is not owned by one model vendor.
- **Real engineering tools** for files, terminals, Git, branches, worktrees, source control, background processes, and repository search.
- **Local and remote environments**, including local Windows, WSL, SSH, and environment-aware execution paths.
- **Browser and desktop verification** with Playwright-backed browser workflows, screenshots, runtime checks, and evidence-aware verification.
- **MCP, skills, plugins, and lazy tool exposure** so specialized capabilities do not have to inflate every prompt.
- **Durable context and recovery** through persisted thread state, event history, checkpoints, verification records, and bounded recovery flows.
- **Official provider support** for OpenAI, Anthropic, Google Gemini, xAI, and the Meta Model API, plus the AgentRouter, JustWorker.icu, HCNSec.cn, and VyceAi compatible routes, each used with your own API key.

## What makes it different

| Problem | Trebell approach |
| --- | --- |
| Strong models can still be expensive inside inefficient harnesses | Optimize the harness for verified engineering output per dollar, not raw token minimization |
| Context and tool overhead compounds over long tasks | Measure cache behavior and context growth; keep expensive schemas and stale control context out of hot paths |
| Recovery can cost more than the original mistake | Bound repair loops, preserve evidence, and fix upstream failures before spending on downstream retries |
| A model says "done" without proving it | Verification uses tests, commands, browser evidence, screenshots, Git state, and persisted checks |
| Cost comparisons are meaningless if quality differs | Compare harnesses with the same model/settings and evaluate cost only alongside verifier/task quality |
| Every coding agent becomes its own silo | Shared projects and runtime adapters make other harnesses easy to access without making runtime switching the core product |
| Different runtimes pretend to have feature parity | Capabilities are detected and surfaced honestly instead of creating fake toggles |

## Product architecture

```mermaid
flowchart LR
    UI["Desktop workspace"]
    CORE["Projects · Git · terminals · verification · context"]
    POLICY["Tool gateway · permissions · redaction"]
    NATIVE["Trebell Native"]
    RUNTIMES["Codex · Claude Code · OpenCode · other runtimes"]
    PROVIDERS["OpenAI · Anthropic · Gemini · compatible providers"]
    TOOLS["MCP · browser · desktop · remote environments"]

    UI <--> CORE
    CORE <--> POLICY
    CORE <--> NATIVE
    CORE <--> RUNTIMES
    NATIVE <--> PROVIDERS
    POLICY <--> TOOLS
```

The optimization work happens primarily inside **Trebell Native**, where Trebell owns the agent loop. Runtime adapters for Codex, Claude Code, OpenCode, and others are useful product integrations and controlled comparison surfaces, but they are secondary to the quality-per-dollar goal.

## Engineering proof

Trebell is developed as a harness, not as a prompt demo.

- The repository currently carries **1,300+ deterministic tests** across runtime behavior, providers, tool policy, persistence, source control, verification, desktop integration, and benchmark infrastructure.
- UI behavior is covered with **headless Playwright** workflows, including workspace and visual verification paths.
- Trebell Native is compared against Codex API and Codex OAuth on **Terminal-Bench 4.0** using the same model, reasoning effort, service tier, and hosted-web-search policy.
- Benchmark accounting tracks **verifier quality, input/output tokens, cache use, cost, tool calls, turns, and runtime behavior** instead of treating token count alone as efficiency.
- Benchmark evidence is converted into generic harness improvements rather than task-specific prompt patches.

The optimization target is the product thesis itself:

> **For the same model and task, Trebell should match or beat the result of mature coding harnesses at a lower total cost.**

If Trebell is cheaper but worse, it has not won. If it uses fewer tokens but costs more because of output/reasoning mix, it has not won. The metric that matters is **verified result per dollar**.

See [benchmark results](BENCHMARKS.md) for verifier-grounded comparisons where Trebell Native matches or beats comparison quality while using less model spend or substantially less model traffic.

## Quick start

### Windows release

Download the latest installer from the [Trebell Code releases](https://github.com/tanishqbaweja/trebellcode-releases/releases) page.

### Run from source

Requirements:

- Node.js 22+
- npm
- Git

```bash
git clone https://github.com/tanishqbaweja/trebellcode.git
cd trebellcode
npm install
npm link
trebell
```

Production-style local GUI:

```bash
npm run ui:build
trebell gui
```

Frontend development:

```bash
npm run gui:server
npm run ui:dev
```

### Model provider

Trebell Native calls the model provider you select with your own API key: OpenAI (the default), Anthropic, Google Gemini, xAI, the Meta Model API, AgentRouter, JustWorker.icu, HCNSec.cn, or VyceAi. Every provider needs a key, so add one in **Settings → Agents & models** before the first Native turn (without one, each provider reads its own environment variable, such as `OPENAI_API_KEY`, `XAI_API_KEY` or `META_API_KEY`). The composer's model picker lists every model the key gives: OpenAI starts on its measured default, `gpt-6-luna`, and a provider that names no default model (the Meta Model API, xAI and the rest) asks which one to use before the first message, unless it lists only one.

### How each harness signs in

Trebell Native always runs on API keys, as above. Every other harness runs as its own official CLI or SDK, and you choose in **Settings → Agents & models**, on the harness or on each of its runtime profiles, how it signs in:

- **Sign in** (the default): the harness's own login in its own home (`codex login`, `claude auth login`, `grok login`, `opencode auth login`, `muse login`, or Antigravity's own sign-in, which its row's **Sign in** runs). Trebell never reads or copies the credentials a harness keeps for it.
- **API key**: the harness runs on its vendor's key from the same store the Model provider card uses (Claude Code on the Anthropic key, Codex on the OpenAI key, Muse Code on the Meta Model API key, Grok Build on the xAI key, Antigravity on the Google Gemini key, OpenCode on each saved key of a provider it supports). The row names the key and lets you add, replace or remove it there, in that one store, so for Trebell Native too; with none saved, the provider's environment variable counts (the row names that variable, and a key saved there replaces it for Trebell Native too), and with neither the row says the key is missing and the harness does not start. A harness runs on an API key on this machine only: in a WSL or SSH environment it is refused, as Trebell never sends a saved key to another machine; set it to Sign in to use its own login there. An OpenCode profile with a server URL of its own runs on that server's sign-in and cannot be set to API key.

Cursor has no API key: it signs in with `cursor-agent login` only. A key in `.env`, in Trebell's environment or in a profile's approved variables never reaches a harness on Sign in, and never moves one to its API key: only the choice above does.

## Validation

```bash
npm test
npm run ui:build
npm run ui:test
```

Live-provider and external-runtime checks are opt-in because they depend on credentials, installed runtimes, and external service availability.

## Product direction

Near-term work is focused on four things:

1. **Quality per dollar** — make Trebell Native produce the same or better verified result at lower total model cost.
2. **Harness efficiency** — improve caching, context selection, tool use, turn count, recovery behavior, and output discipline based on public benchmark evidence.
3. **Evidence-first autonomy** — make verification, repair, checkpoints, and recovery improve correctness without wasting model spend.
4. **Product usability** — keep the desktop workspace, provider support, and runtime integrations convenient without letting those features obscure the core optimization goal.

## Documentation

| Document | Purpose |
| --- | --- |
| [Technical overview](docs/technical/TECHNICAL_OVERVIEW.md) | Detailed architecture, services, runtime integrations, safety, and release behavior |
| [Product principles](docs/technical/PRODUCT_PRINCIPLES.md) | The product and architecture contract |
| [Testing](docs/technical/TESTING.md) | Deterministic, UI, live-provider, and manual validation |
| [Benchmark results](BENCHMARKS.md) | Verifier-grounded quality, cost, token, and execution-efficiency comparisons |
| [v2.1.0 release notes](docs/releases/v2.1.0.md) | Current release notes |

## Repository layout

```text
bin/           CLI entrypoints
branding/      source branding assets
build/         packaging icons/resources
desktop/       Electron shell and desktop integration
docs/          architecture, testing, benchmarks, and release notes
scripts/       release, benchmark, replay, and live-test tooling
src/           backend, runtime, services, providers, and tool policy
tests/         deterministic and integration coverage
ui/            React/Vite desktop UI and Playwright tests
```

## Security and secrets

Provider credentials belong in Trebell's Settings/secret paths. Repository `.env` files are ignored and are used only for explicit developer/live-provider testing. Tool execution is capability- and policy-aware, and secret-bearing outputs are redacted from persisted telemetry where applicable.

Please report security issues privately as described in [SECURITY.md](SECURITY.md).

## Third-party notices

Third-party attribution is recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
