# Roadmap

This page says where Trebell Code stands and which work is planned next. It gives no dates. The maintainer keeps it up to date ([GOVERNANCE.md](GOVERNANCE.md)), and a proposal for something new starts as a [feature request](https://github.com/tanishqbaweja/trebellcode/issues/new?template=feature_request.yml).

## Where it stands

- **Release 2.1.4**, a desktop app for Windows x64, from the [releases page](https://github.com/tanishqbaweja/trebellcode-releases/releases). Its notes are in [docs/releases/v2.1.4.md](docs/releases/v2.1.4.md).
- **Trebell Native**, Trebell's own harness, on your API key of OpenAI, Anthropic, Google Gemini, xAI or the Meta Model API, or of the AgentRouter, JustWorker.icu, HCNSec.cn and VyceAi compatible routes.
- **Other agents as their real harnesses:** Codex, Claude Code, OpenCode, Cursor, Grok Build, Antigravity and Muse Code.
- **Benchmark results** in [BENCHMARKS.md](BENCHMARKS.md). They were measured before the app and the benchmark runner came to share one Native configuration on 2026-10-29. Results measured with the shared configuration are not published there yet.

## Planned

### Test every feature with every agent

Go through each feature of the app with Trebell Native and with each harness, fix what does not work, and keep the checks as automated tests. The checks that still need a real machine, account or service are listed in [docs/technical/TESTING.md](docs/technical/TESTING.md).

### Benchmarks against each model maker's own agent

Measure Trebell Native on SWE-bench Verified, SWE-bench Pro and Terminal-Bench 4.0 against each model maker's own agent, on that maker's models: Codex on OpenAI's, Claude Code on Anthropic's, Antigravity on Google's, Grok Build on xAI's and Muse Code on Meta's. The goal is the one the [project's principles](CONTRIBUTING.md#the-projects-principles) set: as many resolved tasks or more, at lower cost. Results go into [BENCHMARKS.md](BENCHMARKS.md) under its rules, with the Native the app ships.

### Plan mode in Trebell Native

In Codex, Claude Code and Cursor threads the composer has a mode picker with a Plan mode, for a turn that plans before it changes anything. Trebell Native has no such mode yet, so its threads show no picker (`collaborationModes` in [`src/runtime-capabilities.mjs`](src/runtime-capabilities.mjs)).

## Known gaps

- **macOS and Linux:** the packages are configured, but not validated on real machines, and no release is published for them ([Platform support](docs/technical/TECHNICAL_OVERVIEW.md#platform-support)).
- **The Windows installer is not code-signed yet,** so Windows SmartScreen asks you to confirm it before it runs.

## Not planned

The [technical overview](docs/technical/TECHNICAL_OVERVIEW.md#explicit-non-goals) lists what is deliberately not a goal, such as mobile device control and automatic "best model" routing.
