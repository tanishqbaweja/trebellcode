# Trebell Code

Trebell Code uses Codex strictly as the local agentic harness: threads, planning, tools, shell execution, filesystem edits, approvals, MCP, diffs, and history. Model inference is selectable in Settings: **Freebuff, AgentRouter, JustWorker.icu, HCNSec.cn, or VyceAi**.

The user-facing command is `trebell` (or `trebell-code`) and Trebell configuration lives under `~/.trebell-code`. Freebuff sign-in uses the bundled **freebuff2api** compatibility bridge; the other providers use their own API keys.

## Install

```bash
npm install
npm link
trebell
```

Requirements: Node.js 22 or newer.

When Freebuff is selected, the first `trebell` run starts Freebuff sign-in automatically. Other providers are configured from the desktop Settings page with an API key.

```bash
trebell signup
trebell login
trebell models
trebell --provider agentrouter --model gpt-5.5
trebell --provider justworker --model claude-opus-4-8
trebell --provider hcnsec --model glm-5.3
trebell --provider vyceai --model claude-sonnet-4-6
```

## Provider contract

**Codex is the harness, not the model provider.** Trebell Code configures Codex to use exactly the provider selected in Settings.

| Provider | Codex base URL | Model catalog |
| --- | --- | --- |
| Freebuff | local `freebuff2api` bridge | live authenticated Freebuff catalog |
| AgentRouter | `https://co.agentrouter.org/v1` | live `GET /v1/models` for the configured key |
| JustWorker.icu | `https://api.justwoker.icu/v1` | `claude-opus-4-8` |
| HCNSec.cn | `https://api.hcnsec.cn/v1` | `glm-5.3` |
| VyceAi | `https://vyceai.com/v1` | live `GET /v1/models` for the configured key |

The GUI model selector is replaced whenever the provider changes, so models from another provider cannot remain selected. Non-Freebuff API keys are stored separately from normal UI settings and are injected into the Codex app-server environment; the keys are not written into Codex `config.toml` or returned by the provider-status API.

## What happens when you run it

1. Trebell Code creates `~/.trebell-code/codex/config.toml` for the selected inference provider.
2. For Freebuff, it starts the bundled freebuff2api bridge on localhost and uses the authenticated Freebuff session under `~/.trebell-code/freebuff2api`.
3. For AgentRouter, JustWorker, HCNSec, or VyceAi, Trebell injects that provider's saved key into the Codex app-server environment and Codex talks to the provider's OpenAI-compatible endpoint directly.
4. Changing provider or provider credentials restarts the isolated Codex app-server and reconnects the desktop JSON-RPC relay.
5. The runtime keeps Codex filesystem, shell, approval, MCP, diff, history, and agent behavior regardless of which inference provider is active.\n\nFor compatibility testing, Trebell preserves Freebuff-compatible protocol behavior while deliberately attaching the stable upstream header `x-trebell-client: Trebell-Code/0.5.0`. This keeps the client explicitly attributable instead of relying on hidden behavioral differences.

By default Trebell sets `PUBLIC_UPSTREAM_ENABLED=false`, so the bundled bridge uses the authenticated Freebuff route rather than freebuff2api's optional third-party public model routes.

## Useful commands

```text
trebell                 start Trebell Code
trebell login           Freebuff device-code login
trebell login --force   refresh/switch the Freebuff login
trebell signup          open Freebuff sign-up/login in a browser
trebell logout          remove the local credential
trebell models          show models for the active provider
trebell --provider ID    override the saved provider for this CLI run
trebell doctor          check installation
```

Set `TREBELL_HOME` to relocate all Trebell state. Set `TREBELL_MODEL` to choose a default model.

## Licensing

Trebell Code's wrapper code is Apache-2.0.

The agent runtime is OpenAI Codex, Apache-2.0 licensed. Trebell Code retains the required upstream notices and does not claim ownership of that upstream implementation.

The bundled Freebuff compatibility bridge is derived from **chenjh16/freebuff2api**, MIT licensed. Its original license is retained under `vendor/freebuff2api/LICENSE`.

See `NOTICE` and `THIRD_PARTY_NOTICES.md`.


## Graphical harness

Trebell Code includes a local React/Vite agent interface inspired by modern desktop coding agents.

```bash
npm install
npm run ui:build
trebell gui
```

The GUI talks directly to Codex app-server over localhost WebSocket JSON-RPC, so thread history,
turns, plan updates, shell commands, file changes, diffs, approvals, MCP activity, stop/interrupt,
and tool events are surfaced from the real Codex runtime rather than simulated by the UI.
The GUI's model picker is scoped to the active provider. Freebuff is loaded from the local bridge, AgentRouter and VyceAi use their authenticated live `/v1/models` endpoints, and JustWorker/HCNSec use the documented single-model catalogs.

For frontend-only development:

```bash
npm run gui:server
npm run ui:dev
```

The Vite dev server proxies `/api` to the local GUI server.


## Desktop installer

Trebell Code is also packaged as a native Windows desktop application. End users do not need
Node.js, npm, or a terminal. The installer bundles Electron, the production Trebell GUI, the
native Codex harness binary, and the Freebuff compatibility bridge.

After installation, launch **Trebell Code** from the Start Menu or Desktop shortcut. Codex
remains the local agentic harness only; model inference is routed through the provider selected
in Settings.
