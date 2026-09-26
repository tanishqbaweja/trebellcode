# Trebell Code

Trebell Code is a desktop coding harness that keeps projects, repository intelligence, files, terminals, Git/worktrees, browser verification, source control, continuity, verification, and agent history in one workspace.

Trebell is **multi-harness**. The active agent runtime can be:

- **Trebell Native**
- **Codex**
- **Claude Code**
- **Cursor**
- **Grok Build**
- **OpenCode**
- **Antigravity**

Capabilities are runtime-gated. Trebell does not pretend every harness exposes the same queue, fork, rewind, sandbox, MCP, delegation, or profile-switching features.

The user-facing command is `trebell` (or `trebell-code`). Trebell-owned configuration and state live under `~/.trebell-code` unless `TREBELL_HOME` is set.

## Install

```bash
npm install
npm link
trebell
```

Requirements for source installs: Node.js 22 or newer.

For frontend development:

```bash
npm run gui:server
npm run ui:dev
```

For a production-style local GUI:

```bash
npm run ui:build
trebell gui
```

## Runtime and provider model

Trebell separates two ideas that older builds mixed together:

1. **Agent runtime** — the coding harness that owns the agent session and protocol.
2. **Inference provider** — the model API used by Trebell-owned inference paths such as Trebell Native and Codex compatibility routing.

External harnesses such as Claude Code, Cursor, Grok Build, OpenCode, and Antigravity keep their own authentication/model semantics. Trebell integrates them through their supported protocol/runtime interfaces rather than forcing them through the Codex provider bridge.

### Trebell-managed inference providers

Where the selected runtime uses Trebell's inference layer, currently supported provider integrations include:

- **Freebuff**
- **AgentRouter**
- **JustWorker.icu**
- **HCNSec.cn**
- **VyceAi**

Provider credentials are kept separate from normal UI state and are not exposed through provider-status APIs.

For Codex compatibility, Trebell configures the bundled Codex runtime to use the Responses API. Providers that expose Chat Completions or Anthropic-compatible Messages are translated through Trebell's loopback compatibility layer and converted back into the Responses event lifecycle.

## Agent runtime behavior

Trebell keeps shared product responsibilities outside individual harnesses wherever practical:

- project and environment identity,
- repository context and structural intelligence,
- files and terminal surfaces,
- Git/worktree workflows,
- source-control integration,
- browser/runtime verification evidence,
- durable goals and continuity,
- history and metadata,
- permissions and policy,
- checkpoints,
- verification and recovery,
- usage/trace surfaces.

A runtime keeps its own native strengths when they exist. Trebell does not build duplicate infrastructure merely for symmetry, and it does not require all runtimes to expose identical controls.

## Desktop product scope

Trebell is a **desktop coding harness**.

It supports desktop-controlled local and remote development environments, including local workspaces, WSL, and SSH where configured.

Mobile-device orchestration is intentionally **not** part of the current product scope. Older 1.3.0 work briefly included Android emulator/iOS simulator control surfaces; those were retired and are covered by regression tests to prevent them from silently returning.

## Core workspace

The desktop workspace includes:

- provider-independent conversation history,
- project and environment management,
- resizable chat/sidebar/right-panel/terminal surfaces,
- files, diff, Git, runtime, goal, browser, and agent panels,
- command palette and keyboard navigation,
- project/worktree settings,
- background work and bounded delegation where the runtime supports it,
- thread history pagination and search,
- checkpoints and rewind/fork where supported,
- light/dark/custom themes,
- failure-visible UI instead of fake empty/default states.

Basic capabilities such as normal research are not exposed as meaningless composer toggles. Heavier specialized tool namespaces are exposed only when useful and supported.

## Browser and desktop verification

Trebell includes an isolated Agent Browser for supported browser workflows, with navigation, DOM interaction, screenshots, responsive viewport checks, annotations, and localhost preview discovery.

Desktop screenshot context is supported, and Windows desktop mouse/keyboard control is capability- and permission-gated. Trebell uses explicit access boundaries rather than silently escalating control.

## Projects, Git, and worktrees

Trebell supports:

- project-scoped settings,
- local and remote environments,
- branch/status/diff workflows,
- managed worktrees,
- background task isolation,
- safe cleanup rules,
- source-control provider detection,
- pull-request workflows,
- checkpoints,
- review state,
- repository-aware verification.

Conversation identity is independent of inference provider. Changing provider must not make existing chats disappear.

## MCP, skills, plugins, and harness capabilities

Harness-specific capabilities are exposed only when the active runtime actually supports them.

Codex exposes its native skills/plugins/apps/hooks/configuration surfaces through Trebell's Harness Tools UI. Other runtimes use their supported MCP/tool integration paths without Trebell fabricating unsupported parity.

## Useful commands

```text
trebell                         start Trebell Code
trebell login                   Freebuff login
trebell login --force           refresh/switch the Freebuff login
trebell signup                  open Freebuff sign-up/login in a browser
trebell logout                  remove the local Freebuff credential
trebell models                  show models for the active Trebell-managed provider
trebell --provider ID           override the saved provider for this CLI run
trebell --model ID              choose a model for this CLI run
trebell doctor                  check installation
```

Examples for Trebell-managed provider routing:

```bash
trebell --provider agentrouter --model gpt-5.6-sol
trebell --provider justworker --model claude-opus-4-8
trebell --provider hcnsec --model glm-5.3
trebell --provider vyceai --model claude-sonnet-4-6
```

Set `TREBELL_HOME` to relocate Trebell-owned state. Set `TREBELL_MODEL` to choose a default model for compatible CLI flows.

## Testing

Deterministic suite:

```bash
npm test
```

Build the frontend:

```bash
npm run ui:build
```

Full Playwright UI suite:

```bash
npm run ui:test
```

Focused suites:

```bash
npm run ui:test:workspace
npm run ui:test:capabilities
npm run ui:test:visual
```

Playwright's local test harness runs offline by default and blocks external provider traffic unless network access is explicitly enabled for a live test.

Live-provider scripts are separate and opt-in. They may load credentials from `../.env`; do not invent or commit secrets.

## Desktop packaging

Electron packaging targets exist for Windows, macOS, and Linux where the required native dependencies are available.

Windows is the primary release flow:

```bat
make-exe.cmd
```

That prepares the icon, provider bridge, production UI, and Windows installer.

To build and publish the Windows release for the package version:

```bat
make-exe.cmd publish
```

Publishing requires GitHub CLI authentication with release permission.

Equivalent npm commands are:

```text
npm run release:windows
npm run release:windows:publish
```

Additional packaging targets:

```text
npm run desktop:dist:mac
npm run desktop:dist:linux
```

## Licensing

Trebell Code's wrapper code is Apache-2.0.

The bundled OpenAI Codex runtime is Apache-2.0 licensed. Trebell retains the required upstream notices and does not claim ownership of that implementation.

The bundled Freebuff compatibility bridge is derived from **chenjh16/freebuff2api**, MIT licensed. Its original license is retained under `vendor/freebuff2api/LICENSE`.

See `NOTICE` and `THIRD_PARTY_NOTICES.md`.
