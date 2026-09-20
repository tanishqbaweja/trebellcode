# Trebell Code

Trebell Code is a terminal coding agent distribution that keeps the Codex agent/tool runtime while routing model traffic through Freebuff using a bundled, pinned copy of **freebuff2api**.

The user-facing command is `trebell` (or `trebell-code`), Trebell configuration lives under `~/.trebell-code`, and Freebuff sign-in is handled by the same device-code flow used by freebuff2api.

## Install

```bash
npm install
npm link
trebell
```

Requirements: Node.js 22 or newer.

The first `trebell` run starts Freebuff sign-in automatically. You can also run:

```bash
trebell signup
trebell login
trebell models
trebell --model freebuff/deepseek/deepseek-v4-flash
```

## What happens when you run it

1. Trebell Code creates `~/.trebell-code/codex/config.toml`.
2. It starts the bundled freebuff2api bridge on localhost only.
3. freebuff2api authenticates with the Freebuff account stored under `~/.trebell-code/freebuff2api`.
4. The Codex runtime is launched with a custom `freebuff` model provider using the OpenAI-compatible Chat Completions wire API exposed by freebuff2api.
5. The runtime keeps Codex filesystem, shell, approval, MCP, diff, history, and agent behavior. Trebell owns the sign-in, provider configuration, storage paths, command name, and visible terminal branding.\n\nFor compatibility testing, Trebell preserves Freebuff-compatible protocol behavior while deliberately attaching the stable upstream header `x-trebell-client: Trebell-Code/0.1.0`. This keeps the client explicitly attributable instead of relying on hidden behavioral differences.

By default Trebell sets `PUBLIC_UPSTREAM_ENABLED=false`, so the bundled bridge uses the authenticated Freebuff route rather than freebuff2api's optional third-party public model routes.

## Useful commands

```text
trebell                 start Trebell Code
trebell login           Freebuff device-code login
trebell login --force   refresh/switch the Freebuff login
trebell signup          open Freebuff sign-up/login in a browser
trebell logout          remove the local credential
trebell models          show currently available models
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
The GUI's model picker is populated only from `GET /v1/models` on the local Freebuff bridge.

For frontend-only development:

```bash
npm run gui:server
npm run ui:dev
```

The Vite dev server proxies `/api` to the local GUI server.
