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
- [ ] Pin / reorder threads
- [ ] Active / settled / snoozed thread sections
- [ ] Snooze and wake
- [ ] Bulk thread actions
- [ ] Background thread start
- [ ] Multi-model fan-out (Freebuff models only)
- [ ] New worktree / new thread in current worktree
- [ ] Branch-aware thread metadata
- [ ] Thread search across message contents
- [ ] Subagent / delegated-agent inspector

## Composer and context

- [x] Freebuff model picker
- [x] File picker
- [x] Project/workspace picker
- [x] Permission/sandbox settings
- [ ] Composer-level permission mode picker
- [ ] Up to 8 attachments with upload/status UI
- [ ] Drag/drop attachments onto composer and thread rows
- [ ] Paste image/file support
- [ ] Large-paste to text attachment
- [ ] Queued follow-up messages while agent is running
- [ ] Queue vs steer behavior
- [ ] Prompt history recall with ArrowUp/ArrowDown
- [ ] Edit-from-here / rewind
- [ ] Prompt stash
- [ ] Slash commands
- [ ] Skills picker / $ mention
- [ ] Inline context chips
- [ ] File mentions
- [ ] Terminal excerpt context
- [ ] Diff/review-comment context
- [ ] Assistant response citations
- [ ] Pull-request context chips
- [ ] Context meter / compact action
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
- [ ] Rich expandable tool-call cards
- [ ] Full command + stdout/stderr inspection
- [ ] Question UI with options and custom answers
- [ ] Attachments in question answers
- [ ] Remembered/session approvals where supported
- [ ] Background activity/subagent timeline

## Terminal

- [x] Manual command execution through Codex command/exec
- [ ] Real PTY terminal sessions
- [ ] Multiple terminals/tabs
- [ ] Resize/input streaming
- [ ] Persistent bounded scrollback
- [ ] Reconnect to running terminals
- [ ] Terminal excerpts attachable to composer
- [ ] Terminal working-directory tracking

## Files, diffs and checkpoints

- [x] Real workspace tree
- [x] File preview
- [x] Real Git status/diff
- [ ] Syntax-highlighted file viewer
- [ ] Search files
- [ ] File edit/open-in-editor actions
- [ ] Diff review comments
- [ ] Mark reviewed files
- [ ] Turn checkpoints
- [ ] Revert conversation only
- [ ] Revert conversation + workspace
- [ ] Hidden-Git-ref checkpoint management

## Projects, Git and worktrees

- [x] Open local project
- [ ] Add/clone project
- [ ] Recent/imported projects
- [ ] Project groups / multiple checkouts
- [ ] Worktree creation/removal
- [ ] Workspace-mode defaults
- [ ] Branch selector
- [ ] Commit
- [ ] Push
- [ ] Pull/fetch
- [ ] Automatic safe pull
- [ ] Generate commit message with Freebuff
- [ ] Create pull request
- [ ] PR review UI
- [ ] PR comments/reviewers/check status
- [ ] Linked pull requests
- [ ] PR stacks
- [ ] Merge/rebase stack
- [ ] Source-control account diagnostics

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
- [ ] Full Freebuff notices/offers/consent surfaces when returned by server
- [ ] Model capability metadata in picker
- [ ] Context/token usage when available from provider response

## Settings and desktop

- [x] Desktop installer
- [x] Start Menu/Desktop shortcut
- [x] Local runtime health
- [x] CPU/memory/temp-disk status
- [x] Clean child-process shutdown
- [ ] Keyboard-shortcut editor
- [ ] Appearance/theme controls
- [ ] Project overrides/inheritance
- [ ] Update checker + in-app updater
- [ ] Background service mode
- [ ] Diagnostics/log viewer
- [ ] Native notifications
- [ ] Remote environment control
- [ ] WSL/SSH environments
- [ ] Mobile/remote control surface

## Browser/preview tools

- [ ] Browser preview panel
- [ ] Agent browser session
- [ ] Page element picker
- [ ] Screenshot/region capture context
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
