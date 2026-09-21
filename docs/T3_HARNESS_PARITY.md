# Trebell Code Harness Parity Audit

Updated: 2026-09-21

This file is a source-backed audit, not a marketing checklist. It compares the current Trebell desktop implementation against the user-facing workflows in T3 Code and the v2 Codex app-server protocol vendored in this repository.

Status:
- **Complete** — implemented as a real Trebell workflow.
- **Partial** — useful implementation exists, but it does not cover the full upstream surface.
- **Different by design** — Trebell deliberately uses another implementation that provides the same user outcome.
- **Missing** — not yet surfaced or implemented.

## Daily coding harness

| Capability | Trebell | Notes |
|---|---|---|
| Open/switch local folder | **Complete** | Native folder picker is available directly from the chat workspace header and Projects. |
| Recent projects | **Complete** | Persistent project list with per-project defaults. |
| Clone repository | **Complete** | Git clone into a selected local parent folder. |
| Worktree-per-task | **Complete** | Current checkout / new worktree mode and explicit worktree management. |
| One model selector | **Complete** | The duplicate multi-model selector was removed from the primary composer. |
| Provider switching | **Complete** | Freebuff, AgentRouter, JustWorker, HCNSec and VyceAi are managed separately from Codex. |
| Queue follow-ups | **Complete** | Queue mode preserves follow-up turns while an agent is running. |
| Steer current turn | **Complete** | Uses Codex `turn/steer`. |
| Stop/interrupt | **Complete** | Uses `turn/interrupt`. |
| Durable threads | **Complete** | Uses Codex persisted threads and resume history. |
| Search threads | **Complete** | Sidebar/server search. |
| Pin / snooze / settle | **Complete** | Backed by thread sections and local metadata. |
| Archive thread | **Complete** | Uses `thread/archive`. |
| Fork thread | **Complete** | Uses Codex `thread/fork`. |
| Delete thread | **Complete** | Uses Codex `thread/delete`. |
| Rename thread | **Complete** | Uses `thread/name/set`. |
| Compact context | **Complete** | Uses `thread/compact/start`. |
| Revert conversation | **Complete** | Uses `thread/revert`. |
| Workspace checkpoint restore | **Complete** | Trebell snapshots Git/workspace state around turns. |
| Thread goals API | **Complete** | Goal tab uses Codex `thread/goal/get`, `set` and `clear`, including pause/resume/complete state and budget usage. |
| Persistent thread attachments API | **Partial** | Linked pull requests now persist through Codex `thread/attachment/*` with a local compatibility fallback. Turn file/context inputs remain direct composer inputs. |

## Agent tools

| Capability | Trebell | Notes |
|---|---|---|
| Shell commands | **Complete** | Codex command execution plus a persistent user PTY. |
| Persistent terminal tabs | **Complete** | Real PTY sessions over WebSocket. |
| File read/search/edit | **Complete** | Trebell workspace APIs plus Codex file tooling. |
| Git status/diff/branches | **Complete** | First-class source-control panel. |
| Git commit/fetch/pull/push | **Complete** | Implemented with local Git. |
| Git worktrees | **Complete** | Create/open/remove workflows are supported. |
| GitHub pull requests | **Complete** | Uses authenticated `gh` CLI for list/read/comment/review/merge/create. |
| Non-GitHub forge PR workflows | **Partial** | Core Git works everywhere, but PR UI is currently GitHub-specific. T3 supports more forges. |
| Skills | **Complete** | Codex `skills/list` and composer skill insertion. |
| MCP tools | **Complete** | Codex runtime owns execution; Trebell now exposes live MCP status, tools/resources counts, reload and OAuth sign-in. |
| Plugins | **Complete** | Live Codex plugin catalog plus install/uninstall surface. |
| Apps/connectors | **Partial** | Live Codex app inventory is exposed; app-specific onboarding/config remains Codex-controlled. |
| Hooks | **Complete** | Live Codex hook inventory is exposed. |
| Web search | **Complete** | User-controllable web mode and provider capability reporting. |
| Agent browser | **Complete** | Isolated Electron browser with navigation, DOM refs, click/type, screenshots and cookie import. |
| Desktop screenshot | **Complete** | Primary display capture is available to users and the agent. |
| Desktop Computer Use | **Complete** | Windows coordinate screenshot/move/click/scroll/type/key tools. Mutating input is restricted to Full access mode. |
| Code review | **Complete** | Uses Codex `review/start` for uncommitted changes. |
| Subagents / delegated threads | **Complete** | Child threads are displayed and the Agents panel exposes live Codex collaboration-mode presets through `collaborationMode/list` and `thread/settings/update`. |
| Image generation tool | **Partial** | Provider capability is reported; Trebell does not add a separate image-generation UI when the selected provider lacks it. |

## Permissions and safety

| Capability | Trebell | Notes |
|---|---|---|
| Supervised mode | **Complete** | Workspace sandbox with explicit approvals. |
| Auto-accept edits | **Complete** | File-change approvals are automatically accepted while command approvals remain supervised. |
| Auto mode | **Complete** | Codex untrusted approval mode. |
| Full access | **Complete** | Danger-full-access / never-ask mode, explicitly selected by the user. |
| Read-only | **Complete** | Additional Trebell safety mode. |
| Named Codex permission profiles | **Partial** | Live `permissionProfile/list` inventory is exposed; the composer still uses stable Trebell presets. |
| Approval UI | **Complete** | Command/file/permission approvals plus user-input questions. |
| Computer input permission gate | **Complete** | Mouse/keyboard automation is refused unless Full access is selected. |

## Projects and environments

| Capability | Trebell | Notes |
|---|---|---|
| Local environment | **Complete** | Native Windows/local workspace. |
| WSL environment profiles | **Partial** | Discovery, persisted profiles and connectivity probes work; normal Codex turns are not yet routed through a WSL exec-server. |
| SSH environment profiles | **Partial** | Persisted host/user/port/key/cwd profiles and command probes work; normal Codex turns are not yet routed through a remote exec-server. |
| Environment UI | **Complete** | New Environments surface shows host capabilities and profiles. |
| LAN remote access | **Complete** | Token-protected mobile/web remote control is configurable in the desktop UI. |
| Background/tray mode | **Complete** | Can stay running after the desktop window closes. |
| Start with Windows | **Complete** | Managed by background mode. |
| T3 device/account pairing model | **Different by design** | Trebell currently uses local token-protected LAN remote access rather than T3's device-account infrastructure. |

## Composer and UI

| Capability | Trebell | Notes |
|---|---|---|
| Minimal chat workspace | **Complete** | Thread list + conversation + one composer; advanced tools are secondary surfaces. |
| Single model selector | **Complete** | No second multi-model chooser in chat. |
| Folder switcher in chat | **Complete** | Clicking the project crumb opens the native folder picker; adjacent control opens recent Projects. |
| Attach files | **Complete** | Native file picker, drag/drop and paste. |
| Screenshot attachment | **Complete** | Desktop and browser screenshots. |
| Context chips | **Complete** | Files, browser annotations, terminal excerpts, PRs and review comments can be attached. |
| Slash commands | **Complete** | Includes compact/model/terminal/diff/git/preview/agents/review/new/clear/plan. |
| Voice dictation | **Complete** | Uses platform Web Speech support when available. |
| Command palette | **Complete** | Ctrl/Cmd+K opens a searchable command/thread palette for navigation and core harness actions. |
| Keybinding editor | **Partial** | Core shortcuts are editable; conditional/fully remappable T3 keybinding grammar is not implemented. |
| Welcome wizard | **Complete** | Fresh installs get a focused workspace/provider/permission setup flow; existing installs are migrated without interruption. |
| Appearance themes | **Complete** | Dark/midnight/black. |

## Codex app-server v2 surface

Trebell intentionally does **not** duplicate every app-server RPC into a button. The desktop should expose workflows, while Codex remains the execution harness.

### Directly used or surfaced
- threads: start/resume/list/items/sections/archive/delete/fork/name/revert/compact
- turns: start/steer/interrupt
- review: `review/start`
- skills: `skills/list`
- permission profiles: `permissionProfile/list`
- MCP: `mcpServerStatus/list`, reload, OAuth
- plugins: list/install/uninstall
- apps: list
- hooks: list
- experimental features: list/toggle
- provider capabilities: read
- approvals, user-input requests and dynamic tool calls

### Available through an equivalent Trebell implementation
- `fs/*` — Trebell has its own workspace tree/search/read/write/watch-oriented server APIs and UI.
- `command/exec/*` — Codex command items plus Trebell persistent PTYs provide the user workflow.
- project/worktree operations — Trebell Git/project manager owns these.
- desktop/browser control — Trebell dynamic tool namespaces provide explicit Electron/Windows implementations.

### Not currently surfaced
- full Codex attachment persistence for every transient composer file/context item
- advanced realtime/thread subscription APIs
- remote exec-server routing for the Trebell WSL/SSH profiles
- every experimental capability-root control
- ChatGPT-account-specific billing/rate-limit/account workflows, because Trebell intentionally uses independent inference providers

These items should remain **not complete** until a real Trebell workflow exists.

## T3-specific gaps still worth doing

1. Multi-forge pull-request UI beyond GitHub.
2. Richer conditional keybinding grammar beyond the editable core shortcuts.
3. Route normal Codex turns through configured WSL/SSH exec-server environments, not only probe/execute profiles.
4. Persist every transient composer file/context item through Codex attachments where that improves cross-client continuity.
5. App-specific connector onboarding where Codex exposes a stable client workflow.

Everything else should be evaluated as a user workflow, not by counting upstream RPC methods.
