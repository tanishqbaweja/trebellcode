# Trebell Code — T3-style harness parity contract

T3 Code (pingdotgg/t3code) is the feature-completeness reference for Trebell Code's desktop control surface.
Trebell keeps its own visual identity and architecture.

## Provider rule

- Codex is used only as the local agent/harness runtime: threads, turns, tools, shell, file edits, approvals, diffs, checkpoints/history, MCP, and orchestration.
- Freebuff is the model provider.
- Trebell exposes only Freebuff models and Freebuff account/session/Freebucks state.
- No UI control is considered implemented until it is backed by a real local or Freebuff action/state.

## Core thread/workspace experience

- [x] New thread
- [x] Resume/list saved Codex threads
- [x] Rename thread
- [x] Archive thread
- [x] Hydrate saved user/assistant history
- [x] Stop/interrupt active turn
- [x] Pin / reorder threads
- [x] Active / settled / snoozed thread sections
- [x] Snooze and wake
- [x] Bulk thread actions
- [x] Background thread start
- [x] Multi-model fan-out (Freebuff models only)
- [x] New worktree / new thread in current worktree
- [x] Branch-aware thread metadata
- [x] Thread search across message contents
- [x] Subagent / delegated-agent inspector

## Composer and context

- [x] Freebuff model picker
- [x] File picker
- [x] Project/workspace picker
- [x] Permission/sandbox settings
- [x] Composer-level permission mode picker
- [x] Up to 8 attachments with upload/status UI
- [x] Drag/drop attachments onto composer
- [x] Paste image/file support
- [x] Large-paste to text attachment
- [x] Queued follow-up messages while agent is running
- [x] Queue vs steer behavior
- [x] Prompt history recall with ArrowUp/ArrowDown
- [x] Edit-from-here / rewind
- [x] Prompt stash
- [x] Slash commands
- [x] Skills picker / $ mention
- [ ] Inline context chips
- [x] File mentions
- [x] Terminal excerpt context
- [x] Diff/review-comment context
- [x] Assistant response citations
- [x] Pull-request attachment context
- [x] Context meter / compact action
- [ ] Functional voice input (do not show enabled until implemented)

## Agent activity and approvals

- [x] Live turn/activity events
- [x] Command approval
- [x] File-change approval
- [x] Permission approval
- [x] Request-user-input handling
- [x] Shell output activity
- [x] File-change activity
- [x] Tool/MCP activity events
- [x] Rich expandable tool-call cards
- [x] Full command + stdout/stderr inspection
- [x] Question UI with options and custom answers
- [x] Attachments in question answers
- [x] Remembered/session approvals where supported
- [x] Background activity/subagent inspector

## Terminal

- [x] Manual command execution through Codex command/exec
- [x] Real PTY terminal sessions
- [x] Multiple terminals/tabs
- [x] Input streaming and PTY resize backend
- [x] Bounded terminal scrollback
- [x] Reconnect to running terminals
- [x] Terminal excerpts attachable to composer
- [x] Terminal working-directory tracking

## Files, diffs and checkpoints

- [x] Real workspace tree
- [x] File preview
- [x] Real Git status/diff
- [x] Syntax-highlighted file viewer
- [x] Search files
- [x] File edit/save actions
- [x] Diff review comments
- [x] Mark reviewed files
- [x] Turn checkpoints
- [x] Revert conversation only
- [x] Revert conversation + workspace
- [x] Hidden-Git-ref checkpoint management

## Projects, Git and worktrees

- [x] Open local project
- [x] Add/clone project
- [x] Recent projects
- [x] Project groups / multiple checkouts
- [x] Worktree creation/removal
- [x] Workspace-mode selection
- [x] Branch selector
- [x] Commit
- [x] Push
- [x] Pull/fetch
- [x] Automatic safe pull
- [x] Generate commit message with Freebuff
- [x] Create pull request
- [x] PR review UI
- [x] PR comments/review/check status
- [x] Linked pull requests
- [x] PR stacks
- [x] Merge/rebase stack
- [x] Source-control account diagnostics

## Freebuff product state

- [x] Device/login flow
- [x] Freebucks balance
- [x] Active Freebuff model
- [x] Freebucks/hour pricing
- [x] Live server price preference with documented fallback
- [x] Session state
- [x] Active instance/model from proxy session
- [x] Usage streak
- [x] Daily bonus
- [x] Rate-limit display
- [x] Off-peak state/offers
- [x] 45-second heartbeat during active turns
- [x] Freebuff notices/offers/consent state surfaces when returned by server
- [x] Freebuff serving-agent metadata in picker
- [x] Context/token usage when available from provider response

## Settings and desktop

- [x] Desktop installer
- [x] Start Menu/Desktop shortcut
- [x] Local runtime health
- [x] CPU/memory/temp-disk status
- [x] Clean child-process shutdown
- [x] Keyboard-shortcut editor
- [x] Appearance/theme controls
- [x] Project overrides/inheritance
- [x] Update checker; installer handoff opens the release
- [ ] Background service mode
- [x] Diagnostics/log viewer
- [x] Native notifications
- [ ] Remote environment control
- [ ] WSL/SSH environments
- [ ] Mobile/remote control surface

## Browser/preview tools

- [x] Browser preview panel
- [x] Agent browser session
- [x] Page element inspector / context picker
- [x] Browser screenshot context
- [ ] Preview annotations
- [ ] Browser profile/cookie import

## Implementation standard

A checkbox can move to complete only when:

1. the UI calls a real backend/runtime action or reads authoritative state,
2. error and disconnected states are surfaced,
3. the feature is exercised by at least one automated test,
4. production builds do not substitute demo/static data,
5. the installed Windows app is tested where desktop packaging can affect behavior.

Reference: https://github.com/pingdotgg/t3code
