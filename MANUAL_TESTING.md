# Trebell Code — Remaining Manual Validation

This file tracks the gap between **implemented + automated-tested** and **proven on real machines/accounts/services**.

Current release target: **v1.3.3**

## How to record results

For every test, mark **Pass / Fail / Blocked** and capture:

- OS and Trebell version;
- runtime + provider + model;
- project/environment used;
- screenshot or short recording where useful;
- relevant Trebell logs/event trace on failure;
- exact expected vs actual behavior.

---

## 1. Fresh Windows installer

- [ ] Uninstall an older Trebell build if present.
- [ ] Run **Trebell-Code-Setup-1.3.3.exe**.
- [ ] Choose a non-default install directory.
- [ ] Confirm Start Menu shortcut.
- [ ] Launch Trebell from the installed shortcut.
- [ ] Open Settings → Agents & models.
- [ ] Confirm bundled Codex shows its real readiness state.
- [ ] Open a local Git repository.
- [ ] Start a simple coding thread.
- [ ] Close and reopen Trebell.
- [ ] Confirm project/thread persistence.
- [ ] Uninstall Trebell and confirm user repositories remain untouched.

---

## 2. API keys through Settings

Goal: prove normal users never need a repository .env file.

For every provider you can test:

- [ ] Add the API key in Settings.
- [ ] Save and restart Trebell.
- [ ] Confirm provider remains usable.
- [ ] Start a thread and send a basic prompt.
- [ ] Send a prompt requiring a tool call.
- [ ] Replace/remove the key and confirm the old credential is no longer used.

Providers:

- [ ] Freebuff
- [ ] AgentRouter
- [ ] JustWorker.icu
- [ ] HCNSec.cn
- [ ] VyceAi

Failure checks:

- [ ] Invalid key produces an explicit error.
- [ ] Provider refresh failure does not erase the last valid config.
- [ ] No raw key appears in visible diagnostics/log output.

---

## 3. Trebell Native with a real provider

Automated baseline already proven for **VyceAi + deepseek-v4.1**:

- Native provider path without Codex app-server;
- Trebell Native system prompt delivered to the real model;
- real repository/workspace/terminal tool calls;
- real source edit;
- real terminal verification;
- independent post-turn verification.
- stable progressive repository/MCP discovery keeps advanced schemas out of the baseline request;
- large tool-output virtualization and repeated source-observation deduplication are covered by automated tests;
- request-level telemetry records prompt/schema/history/tool-result estimates, provider bytes/latency, stable hashes, and cache usage;
- the latest small live coding fixture completed in 4 model turns / 12,006 input tokens with no failed tool calls.

Command: `npm run test:vyce:native`

Additional live engineering checks:

- `npm run test:vyce:cache` — repeated-prefix cache experiment for the current Vyce route;
- `npm run bench:vyce:native` — multi-file refactor, failure-repair, and large-output benchmark scenarios.

Final v1.3.3 benchmark baseline on VyceAi + `deepseek-v4.1`:

- multi-file refactor: 6 model turns / 20,343 input tokens;
- failure-driven repair: 6 model turns / 22,055 input tokens;
- 92 KB noisy-output repair: 7 model turns / 36,566 input tokens;
- all three scenarios independently verified after the Native turn;
- Vyce reported 0 cached input tokens.

The checklist below is still required for broader real-world confidence:

- [ ] Select Trebell Native.
- [ ] Select a real provider/model.
- [ ] Ask it to inspect a medium/large repository.
- [ ] Ask for a small code change.
- [ ] Confirm file edits happen through Trebell tools.
- [ ] Ask it to run tests.
- [ ] Force one test failure and ask it to repair it.
- [ ] Confirm repair continues in the same thread.
- [ ] Start a long-running background process/server.
- [ ] Continue chatting while it runs.
- [ ] Stop/clean the process.
- [ ] Restart Trebell and confirm no orphan process remains.

Budget test:

- [ ] Set a deliberately tiny turn/tool/time budget.
- [ ] Trigger a task that exceeds it.
- [ ] Confirm Trebell stops with a clear budget error.

Efficiency observation to revisit manually on larger tasks:

- [ ] Record model turns/tool calls/input-token usage for representative tasks and compare against Codex/Claude/OpenCode on the same task.
- [ ] Repeat the benchmark across other providers/models and compare cache hits, latency and task success.
- [ ] Exercise a real task that requires an advanced repository capability and confirm the model uses `trebell_repo/discover` then `trebell_repo/invoke` without changing the provider-visible manifest.
- [ ] Exercise a real task that requires an MCP tool and confirm discovery/call remains cache-stable and uses the target tool's real policy.

---

## 4. Codex runtime

- [ ] Select Codex.
- [ ] Confirm runtime readiness is truthful.
- [ ] Start a project thread.
- [ ] Edit a file.
- [ ] Run a terminal command.
- [ ] Trigger an approval-requiring operation.
- [ ] Exercise fork/rewind if exposed.
- [ ] Open Harness Tools and inspect Skills/Plugins/Apps/config.
- [ ] Switch Trebell-managed inference provider.
- [ ] Confirm the existing thread remains present.

---

## 5. Claude Code

- [ ] Install/authenticate Claude Code normally.
- [ ] Select Claude Code in Trebell.
- [ ] Confirm runtime/profile discovery.
- [ ] Start a local project thread.
- [ ] Make a file edit.
- [ ] Run a command.
- [ ] Change runtime profile where exposed.
- [ ] Restart Trebell and resume.
- [ ] Confirm Codex-only controls are not shown as usable.

---

## 6. OpenCode

- [ ] Install/authenticate OpenCode.
- [ ] Select OpenCode.
- [ ] Start a project thread.
- [ ] Inspect/edit/run commands.
- [ ] Exercise Trebell delegation.
- [ ] Confirm runtime capability matrix matches reality.
- [ ] Restart and resume.

---

## 7. Cursor

- [ ] Connect/install the supported Cursor runtime path.
- [ ] Start a project thread.
- [ ] Confirm file/terminal context reaches the runtime.
- [ ] Confirm unsupported controls are hidden/disabled honestly.
- [ ] Restart and resume if supported.

---

## 8. Grok Build

- [ ] Connect/install Grok Build.
- [ ] Start a project thread.
- [ ] Perform a small repository change.
- [ ] Verify terminal/tool behavior.
- [ ] Verify capability matrix.
- [ ] Restart and resume if supported.

---

## 9. Antigravity

- [ ] Connect/install Antigravity.
- [ ] Start a text-only coding task.
- [ ] Perform a repository change.
- [ ] Attempt to attach a video.
- [ ] Confirm Trebell blocks video with a clear unsupported message.
- [ ] Verify normal supported attachments.

---

## 10. WSL

Test at least Ubuntu WSL2.

- [ ] Trebell discovers the distro.
- [ ] Create/select a WSL environment.
- [ ] Open a Git project inside WSL.
- [ ] Browse files.
- [ ] Run terminal commands.
- [ ] Check Git status/diff.
- [ ] Create a worktree.
- [ ] Run a coding task.
- [ ] Run verification.
- [ ] Restart and confirm environment/project persistence.

Edge cases:

- [ ] WSL distro stopped before Trebell starts.
- [ ] Invalid WSL project path.
- [ ] Git unavailable in the distro.

---

## 11. SSH

Use a real Linux SSH host.

- [ ] Add host/user/port/key settings.
- [ ] Connect.
- [ ] Open a remote Git repository.
- [ ] Browse files.
- [ ] Run terminal commands.
- [ ] Check Git status/diff.
- [ ] Create a delegated worktree.
- [ ] Confirm it is created on the remote host.
- [ ] Run verification remotely.
- [ ] Disconnect network mid-command and confirm a real failure.
- [ ] Reconnect and continue.
- [ ] Restart and confirm environment persistence.

---

## 12. GitHub source control

- [ ] Provider auto-detection.
- [ ] Load pull-request state.
- [ ] Create/open PR through supported controls.
- [ ] Refresh review/check status.
- [ ] Exercise configured merge method.
- [ ] Break credentials and confirm explicit failure replaces stale success.

---

## 13. GitLab

Test gitlab.com and, if available, self-hosted.

- [ ] Auto-detection for gitlab.com.
- [ ] Explicit provider selection for ambiguous self-hosted host.
- [ ] Merge-request listing/state.
- [ ] Create/open MR where supported.
- [ ] Review/check status.
- [ ] Merge where supported.
- [ ] Authentication failure behavior.

---

## 14. Forgejo / Gitea

- [ ] Add a self-hosted remote.
- [ ] Confirm Trebell does not blindly guess an unknown host.
- [ ] Select provider explicitly.
- [ ] Load PR state.
- [ ] Exercise supported PR operations.
- [ ] Confirm unsupported operations are explicit.

---

## 15. Bitbucket

- [ ] Configure provider.
- [ ] Load PR information.
- [ ] Exercise every operation marked supported.
- [ ] Confirm unsupported operations are explicit.

---

## 16. Azure DevOps

- [ ] Configure remote/project.
- [ ] Load PR state.
- [ ] Exercise supported operations.
- [ ] Verify authentication-expiry behavior.
- [ ] Verify unsupported operations remain visible.

---

## 17. Custom MCP servers

Ideally test:

1. local stdio MCP;
2. authenticated HTTP MCP;
3. MCP with resources/elicitation.

Checklist:

- [ ] Add server.
- [ ] Confirm connection state.
- [ ] Ask an unrelated task and confirm full schemas are not dumped into the turn.
- [ ] Ask a relevant task and confirm matching tools expand.
- [ ] Invoke a read-only tool.
- [ ] Invoke a mutating/high-risk tool and verify policy/confirmation.
- [ ] Return a known fake secret and verify redaction.
- [ ] Restart Trebell and verify config persists.
- [ ] Break the server and verify visible failure.

---

## 18. Browser verification

- [ ] Start a localhost web app.
- [ ] Ask agent to discover/open it.
- [ ] Navigate.
- [ ] Click/type.
- [ ] Capture screenshot evidence.
- [ ] Switch responsive viewport.
- [ ] Verify a deliberately broken UI.
- [ ] Repair it.
- [ ] Re-run verification.
- [ ] Confirm final verification record.

---

## 19. Windows desktop control

- [ ] Confirm desktop control appears on Windows.
- [ ] Capture desktop screenshot.
- [ ] Exercise a harmless mouse/keyboard action.
- [ ] Verify permission/full-access gating.
- [ ] Verify lower permission mode rejects unsafe control.

Use a disposable app/document for this test.

---

## 20. Checkpoints, rewind and recovery

Use a disposable Git repo.

- [ ] Make agent edit.
- [ ] Confirm checkpoint.
- [ ] Make another edit.
- [ ] Rewind/recover.
- [ ] Confirm repo matches selected checkpoint.
- [ ] Force checkpoint creation failure.
- [ ] Confirm Trebell warns and does not fabricate success.
- [ ] Restart during/after a turn.
- [ ] Confirm uncertain side effects are not blindly replayed.

---

## 21. Delegation/worktree isolation

- [ ] Start parent task.
- [ ] Delegate coding subtask with auto isolation.
- [ ] Confirm separate worktree.
- [ ] Confirm parent working tree remains isolated.
- [ ] Exceed child-agent budget and confirm next delegation is blocked.
- [ ] Give child zero child-agent allowance and confirm no grandchildren.
- [ ] Force worktree setup failure and confirm cleanup.
- [ ] Repeat on SSH.

---

## 22. Long conversation / large repository

Use a genuinely large repository and long-lived thread.

- [ ] 500+ loaded history entries.
- [ ] Very long assistant streaming response.
- [ ] Large command output.
- [ ] Large diff.
- [ ] Repeated source-control refresh.
- [ ] Search older history.
- [ ] Rapidly scroll a long conversation.

Watch:

- responsiveness;
- RAM growth;
- CPU while hidden;
- row virtualization;
- streaming smoothness;
- hidden-panel polling.

Record Task Manager metrics before and after 30+ minutes.

---

## 23. Background mode

Windows:

- [ ] Enable Background mode.
- [ ] Close main window.
- [ ] Confirm tray process remains.
- [ ] Reopen from tray.
- [ ] Restart/sign in to Windows.
- [ ] Confirm startup behavior.
- [ ] Disable and verify login startup removal.

macOS/Linux:

- [ ] Repeat equivalent tray/login behavior on real hardware.
- [ ] Confirm wording remains platform-neutral.

---

## 24. In-app updater

Requires two real published versions.

- [ ] Install older release.
- [ ] Publish newer release with latest.yml + blockmap.
- [ ] Check for update.
- [ ] Download update.
- [ ] Install/restart.
- [ ] Confirm new version.
- [ ] Simulate network failure during check/download.
- [ ] Confirm Trebell reports failure and remains usable.

---

## 25. macOS package

On real Intel/Apple Silicon hardware as available:

- [ ] Build DMG/ZIP.
- [ ] Install/open.
- [ ] Confirm native dependencies resolve.
- [ ] Create project.
- [ ] Start thread.
- [ ] Terminal.
- [ ] Git.
- [ ] Browser verification.
- [ ] Background mode.
- [ ] Restart persistence.

Record Gatekeeper/signing/notarization problems separately from Trebell bugs.

---

## 26. Linux package

Test at least Ubuntu/Debian.

- [ ] Build/install deb.
- [ ] Run AppImage.
- [ ] Open project.
- [ ] Terminal.
- [ ] Git.
- [ ] Browser verification.
- [ ] Background/tray behavior.
- [ ] Restart persistence.

If possible test AppImage on one non-Debian distro too.

---

## 27. Secrets and diagnostics

Use fake disposable keys.

- [ ] Enter fake provider secret.
- [ ] Trigger provider error.
- [ ] Trigger MCP output containing the same secret.
- [ ] Trigger terminal output containing it.
- [ ] Inspect visible logs.
- [ ] Inspect exported replay/event bundle.
- [ ] Search Trebell state files for the raw fake secret.

Expected:

- raw secret is redacted where policy applies;
- provider secrets are separate from normal UI state.

---

## 28. Persistence and restart

- [ ] Create multiple projects.
- [ ] Create multiple threads.
- [ ] Add project-scoped settings.
- [ ] Add repository knowledge.
- [ ] Create verification history.
- [ ] Close normally.
- [ ] Restart.
- [ ] Hard-kill once and restart.
- [ ] Confirm durable state survives appropriately.
- [ ] Confirm SQLite remains authoritative.
- [ ] Confirm JSONL event mirror stays bounded.
- [ ] Confirm pruned old events do not resurrect.

---

## 29. Release artifact integrity

For v1.3.3:

- [ ] Compare installer SHA-256 with release-artifacts/v1.3.3/release.json.
- [ ] Confirm byte size.
- [ ] Confirm release.json Git commit matches the release commit.
- [ ] Confirm GitHub release contains installer, latest.yml, release.json and blockmap.
- [ ] Download GitHub-hosted installer and hash it again.

---

## 30. Final acceptance story

Before calling a release manually production-validated:

1. [ ] Fresh install.
2. [ ] Add API key in Settings.
3. [ ] Open a real repository.
4. [ ] Ask Trebell Native for a small frontend change.
5. [ ] Run tests.
6. [ ] Launch the app/site.
7. [ ] Browser-verify the change.
8. [ ] Delegate one follow-up in a worktree.
9. [ ] Inspect diff.
10. [ ] Create/open a PR.
11. [ ] Close Trebell.
12. [ ] Reopen and resume the same thread.
13. [ ] Check for updates.
14. [ ] Confirm no raw API key appears in diagnostics.

If this story works on an installed build, Trebell has crossed the most important gap between **excellent automated coverage** and **real daily-driver validation**.
