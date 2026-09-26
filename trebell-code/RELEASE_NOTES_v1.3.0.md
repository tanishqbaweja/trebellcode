# Trebell Code Desktop v1.3.0

Trebell Code 1.3 is the large post-1.2 parity and reliability release. It expands Trebell from a Codex-centered desktop shell into a multi-harness coding workspace while tightening the workflows around background agents, worktrees, browsers, terminals, source control, updates, and provider compatibility.

## Multi-harness runtime support

- Runtime profiles for **Codex, Claude Code, Cursor, Grok Build, OpenCode, and Antigravity**.
- Multiple configured instances per harness, with runtime-specific probing, authentication/status reporting, model discovery, and isolated homes where supported.
- Local, WSL, and SSH environment support for agent execution and workspace access.
- Provider-agnostic usage tracking and restart recovery across supported runtimes.

## Background and multi-model work

- `Ctrl+Enter` / `Cmd+Enter` starts a new task in the background so the composer is immediately free for another prompt.
- Shift-click models in a new-thread model picker to send the same task to multiple models.
- Each selected model receives its own isolated Git worktree and thread.
- Fan-out validates that the project is a Git checkout with a real base branch and rejects detached-HEAD launches.
- Partial failures preserve the failed prompt in Trebell Stash. Ambiguous RPC failures attempt to recover the possibly-started thread by its unique worktree path and warn before retrying, reducing duplicate background work.

## Project and worktree parity

- Per-project identity with automatic monograms, emoji, custom monograms, colors, or imported images.
- Project model, permissions, workspace, worktree-submodule, cleanup, and project-action overrides.
- T3-compatible worktree submodule modes: `recursive`, `top-level`, and `none`, including `t3.json` inheritance.
- Safe managed-worktree cleanup with inactivity, merged-branch, last-thread-deletion, and unchanged-from-base rules.
- Dirty worktrees, active agent paths, running terminal paths, and non-Trebell worktrees are never automatically removed.
- Cleaned managed worktrees retain their branch metadata and are recreated automatically when reopened.
- Project actions can be saved, imported from `t3.json` / `package.json`, run during worktree setup, wait for setup completion, and open preview URLs.

## Codex capability surfaces

- MCP server status, skills, plugins, plugin marketplaces, plugin sharing, apps/connectors, hooks, experimental features, configuration layers, account/usage information, and provider capabilities are exposed through Trebell's Harness Tools UI.
- Connector detail inspection includes tool summaries instead of presenting connectors as dead list items.
- Plugin sharing supports save, checkout, delete, discoverability, and target updates using the bundled Codex app-server's real RPC contracts.

## Browser, desktop, and device tools

- Isolated Agent Browser with navigation, DOM snapshots, click/type, screenshots, responsive viewport controls, cookies, recording permission, annotations, and localhost preview discovery.
- One-time browser-profile import for **Firefox** and **Helium** on Windows. Other Chromium browsers remain intentionally excluded because their cookies use app-bound encryption that Trebell does not bypass.
- Desktop screenshot context plus explicit full-access mouse, keyboard, scroll, and typing controls for agent computer use.
- Android emulator and iOS simulator discovery/control surfaces shipped in 1.3.0, but were subsequently retired. They are not part of Trebell's current desktop-harness scope.
- Global SnapShot shortcut with optional accessibility-text capture and local pending-capture recovery.

## Terminal, source control, and review workflow

- Persistent terminal scrollback survives app restarts as stopped history rather than pretending stale PTYs are still running.
- Git branches, worktrees, status, commit/push/pull/fetch, PR creation/review/comments/merge/update/checkout, multi-forge detection, and diagnostics remain integrated in the workspace.
- Review comments, checkpoints, rewind/revert support where the active harness exposes it, linked pull requests, and diff/file review state are retained across the streamlined workspace UI.

## Reliability and desktop experience

- Restart continuation can recover supported active threads after Trebell restarts; it remains opt-in to avoid silently resuming work.
- Provider switching no longer leaves a stale model catalog visible while the harness restarts.
- Non-Freebuff compatibility bridges now use per-instance dynamic loopback ports, preventing multiple Trebell instances/tests from fighting over one hard-coded socket.
- Firefox/Helium import, attachment ceilings, remote attachment streaming, conditional keybindings, open-in-editor integration, license browsing, custom theme import/export, appearance modes, usage/cost views, and background tray mode are covered by the current test suite.
- **One-click packaged desktop updates** now check GitHub releases, download through `electron-updater`, show progress, and install/restart only after explicit user confirmation. Normal app quit never silently installs a downloaded update.

## Provider validation

- Freebuff, AgentRouter, Vyce AI, JustWorker, and HCNSec integrations remain available to the Codex harness where configured.
- AgentRouter keeps the Codex-compatible request fingerprint required by its current gateway and uses the Responses API.
- Vyce live model discovery is tested against the configured account.
- A live two-model fan-out smoke test ran **`deepseek-v4.1`** and **`agnes-3.0-flash`** through Trebell's real bundled Codex app-server in separate Git worktrees. Both threads completed and returned the expected proof marker.

Run the reusable live fan-out check from `trebell-code`:

```powershell
npm run test:vyce:fanout
```

## Pre-release validation

- Node unit/integration suite: **103/103 passing**.
- Playwright desktop-style harness flow: **passing**.
- Real bundled Codex app-server browser relay integration: **passing**.
- Real Windows DPAPI round-trip and Firefox/Helium cookie-import tests: **passing**.
- Real temporary Git repository tests for worktree creation, cleanup protection, merge/inactivity rules, and restoration: **passing**.
- Live Vyce multi-model fan-out through the Trebell + Codex harness: **passing**.

The Windows release pipeline additionally builds and launches the unpacked packaged app, validates the bundled Codex relay and desktop surfaces, runs a packaged model-driven harness check when Vyce credentials are available, produces NSIS update metadata (`latest.yml` + blockmap), and then publishes the installer and updater assets to GitHub.
