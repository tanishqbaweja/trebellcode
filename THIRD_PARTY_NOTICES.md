# Third-party notices

## OpenAI Codex

Trebell Code uses the exact npm runtime release `@openai/codex@0.155.1`.

Upstream: https://github.com/openai/codex  
License: Apache License 2.0
Revision used by Trebell: npm package version `0.155.1`
Destination/integration: dependency in `package.json`; packaged native binaries are resolved by `desktop/bundled-codex.mjs`; Trebell communicates with Codex through its app-server/protocol integration rather than maintaining a renamed fork of the Codex implementation.
Local modifications: Trebell wraps/configures the upstream runtime and provides its own provider compatibility, persistence, UI, policy, verification and desktop layers. Trebell does not claim ownership of the upstream Codex implementation.

## Muse Code SDK

Trebell Code uses the exact npm release `@muse-code/sdk@1.4.13`, Meta's TypeScript SDK for the Muse Session Protocol.

Upstream: https://github.com/meta-models/muse-code-sdk  
License: MIT License, Copyright (c) Meta Platforms, Inc. and affiliates
Revision used by Trebell: npm package version `1.4.13`
Destination/integration: dependency in `package.json`; `src/muse-host.mjs` loads it when the first Muse Code session starts and drives the person's own installed `muse serve` through its `Connection`.
Local modifications: none; Trebell does not patch or bundle a modified copy of the SDK.

## saxes

Trebell Code uses the exact npm release `saxes@6.0.0`, an XML parser, with its one dependency `xmlchars@2.2.0` (MIT License,
Copyright Louis-Dominique Dubeau and contributors to xmlchars, https://github.com/lddubeau/xmlchars).

Upstream: https://github.com/lddubeau/saxes  
License: ISC License, Copyright (c) Contributors; Copyright (c) Isaac Z. Schlueter and Contributors. Its full text, with the
permission notice, is in `third-party-licenses/saxes/LICENSE` (see below).
Revision used by Trebell: npm package version `6.0.0`
Destination/integration: dependency in `package.json`; `src/document-text-extract.mjs` parses the XML of an attached Word, Excel,
PowerPoint, OpenDocument or EPUB file with it, in the process of its own that `src/document-text.mjs` starts to extract the file's text.
Local modifications: none.

## yauzl

Trebell Code uses the exact npm release `yauzl@2.10.0`, a ZIP archive reader, which `extract-zip` also brings in.

Upstream: https://github.com/thejoshwolfe/yauzl  
License: MIT License, Copyright (c) 2014 Josh Wolfe
Revision used by Trebell: npm package version `2.10.0`
Destination/integration: dependency in `package.json`; `src/document-text-extract.mjs` reads the XML parts of an attached Word, Excel,
PowerPoint, OpenDocument or EPUB file with it, within that file's limits.
Local modifications: none.

## character-entities

Trebell Code uses the exact npm release `character-entities@2.0.2`, HTML's named character references, which `react-markdown` also
brings in (through `decode-named-character-reference`).

Upstream: https://github.com/wooorm/character-entities  
License: MIT License, Copyright (c) 2015 Titus Wormer
Revision used by Trebell: npm package version `2.0.2`
Destination/integration: dependency in `package.json`; `src/document-text-extract.mjs` reads an EPUB's named entities and an RTF file's
dash with it.
Local modifications: none.

## License files of packages whose npm release has none

The npm releases of these runtime dependencies include no LICENSE or NOTICE file. Trebell Code ships the license files of each
one's source repository at that release, unchanged, in `third-party-licenses/<package name>/`, and the Open source licenses page
shows them for that package:

- `saxes@6.0.0`: `LICENSE` of https://github.com/lddubeau/saxes at tag `v6.0.0` (commit `211fa0eb`, the release's `gitHead`).
- `@openai/codex@0.155.1` and its platform build (`0.155.1-win32-x64` on Windows x64): `LICENSE` and `NOTICE` of
  https://github.com/openai/codex at tag `rust-v0.155.1`.
- `@opencode-ai/sdk@1.3.15`: `LICENSE` of https://github.com/anomalyco/opencode at tag `v1.3.15`, whose `packages/sdk/js` is
  that release.
- `@opencode/client@2.0.24`: `LICENSE` of https://github.com/anomalyco/opencode at tag `v2.0.24`, whose `packages/client` is
  that release.

## T3 Code

Parts of Trebell Code were written from T3 Code's source. Each part below names the Trebell file and what in it was written that
way, then the T3 Code file it was written from (paths in T3 Code's repository at the revision below).

The app's harness code:

- `src/claude-agent-session.mjs`: the usage merge of a request's stream (`mergedUsage`, `promptTokens`), the task-list tools
  (`claudeTaskList`, `readClaudeTaskStore`), "Allow for session" (`claudeSessionPermissionUpdates`), the command, path or input
  an approval prompt shows (`claudePermissionPrompt`), the usage-limit windows and overage reading (`CLAUDE_USAGE_LIMIT_WINDOWS`,
  `describeClaudeUsageLimit`, `claudeRejectedLimit` and the reading of a `rate_limit_event`) and the reasons it gives for a turn
  Claude Code ended (`terminalResultError`, `claudeResultFailure`), from `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`.
- `src/claude-capabilities.mjs` and `src/claude-managed-mcp.mjs`: the capability probe's options and its never-ending prompt
  (`claudeCapabilitiesProbeOptions`, `probeClaudeCapabilities`) and the check for an administrator's `managed-mcp.json`
  (`hasClaudeManagedMcpConfig`), from `apps/server/src/provider/ClaudeProvider.ts` and
  `apps/server/src/provider/Drivers/ClaudeHome.ts`.
- `src/acp-agent-session.mjs`: Grok Build's and Antigravity's approval choices (`acpApprovalOptions`), the answers to Grok
  Build's questions (`grokQuestionResponse`), Antigravity's questions (`#antigravityQuestion`) and the attachment types and size
  limits of an Antigravity prompt (`antigravityPromptParts` and its `ANTIGRAVITY_*` sets and limits), from
  `packages/provider-grok/src/server/acpSupport.ts`, `packages/provider-grok/src/server/xaiAcpExtension.ts`,
  `apps/server/src/provider/acp/AntigravityProtocol.ts` and `apps/server/src/provider/acp/AntigravityAcpSupport.ts`.
- `src/cursor-transport-failure.mjs`, the whole file: the reading of a Cursor reply that is only Cursor's lost-connection
  diagnostic (`CursorTransportFailure`), from `packages/provider-cursor/src/server/transportFailure.ts`.
- `src/acp-model-catalog.mjs`: the default pick among a Grok Build model's reasoning levels (`grokModelCatalog`), from
  `packages/provider-grok/src/server/status.ts`.
- `src/antigravity-auth.mjs`: the Google variables an Antigravity launch leaves out (`antigravityEnvironment`), from
  `apps/server/src/provider/antigravityAuthSupport.ts`.
- `src/runtime-environment.mjs`: the list of Grok Build variables a profile may pass on, from
  `packages/provider-grok/src/server/usageLimits.ts`.
- `src/agent-usage-limits.mjs`: the Grok Build, Claude Code and Cursor usage readers and their percentages
  (`grokUsageResponseToLimits`, `claudeUsageResponseToLimits`, `cursorUsageResponseToLimits`), from
  `packages/provider-grok/src/server/usageLimits.ts`, `apps/server/src/provider/claudeUsageLimits.ts`,
  `packages/provider-cursor/src/server/usageLimits.ts` and `packages/provider-core/src/server/usageLimits.ts`.
- `src/muse-agent-session.mjs`: the tool rows (`museToolUpdate`), item statuses (`museToolStatus`, `museWorkStatus`), to-do rows
  (`musePlanEntries`), workflow agents' rows (`museWorkflowAgentUpdates`), which turn an event belongs to, the approval choices
  (`museApprovalDecision`, `museApprovalChoices`, `museApprovalOptions`), the questions and their answers (`museQuestions`,
  `museUserInputAnswers`) and the usage-limit reset (`museUsageLimitResetAt`), from
  `packages/provider-muse/src/server/itemPresentation.ts`, `protocol.ts`, `usageLimits.ts` and `adapter.ts`.
- `src/muse-host.mjs`: the `muse serve` flags for each access level and the Windows form of the workspace path
  (`museServeArgs`, `museVerbatimPath`, `museWorkspaceRoot`), from `packages/provider-muse/src/server/sdk.ts`.
- `src/muse-maintenance.mjs` and `parseMuseVersion` in `src/agent-runtime-manager.mjs`: Muse Code's release channels, its version
  form and their order (`MUSE_CHANNELS`, `museChannelRelease`, `compareMuseVersions`), the launcher check and the update switches,
  from `packages/provider-muse/src/server/maintenance.ts`.
- `src/harness-text-generation.mjs`: Muse Code's Git text turn, its replies kept by revision, the answer taken as the last reply
  not taken back and its approvals and questions refused (`museText`), from `packages/provider-muse/src/server/textGeneration.ts`.
- `src/muse-model-catalog.mjs`: a Muse model's name from a bare id, the fallback reasoning levels and the level a turn runs at
  (`museModelName`, `resolveMuseReasoningEffort`), from `packages/provider-muse/src/server/modelCatalog.ts`.
- `src/opencode-agent-session.mjs`: the reading of OpenCode's file-read output (`openCodeReadOutput`), a session's and a
  subagent's permission rules (`openCodePermissionRules`, `openCodeChildPermissionRules`), the reasoning level a provider's
  models start on (`inferOpenCodeDefaultVariant`) and the comparison of two reads of OpenCode 2's model list
  (`openCode2CatalogFingerprint`), from `packages/provider-opencode/src/server/toolItems.ts`, `adapter.ts` and `status.ts`.
- `src/opencode2-agent-session.mjs`: the reading and answering of OpenCode 2's forms (`openCode2FormQuestions`,
  `openCode2FormAnswer`) and the stop of a resumed session's leftover requests, from
  `packages/provider-opencode/src/server/v2/adapter.ts`.
- `src/agent-runtime-manager.mjs`: Grok Build's signed-in reading (`parseGrokModelsAuth`), from
  `packages/provider-grok/src/server/status.ts`.
- `src/harness-install-plan.mjs`: who installed a harness, from where its binary is: npm's global prefix, a Homebrew keg or cask,
  mise, pnpm, Yarn and Vite+ (`npmGlobalPrefix`, `homebrewKeg`, `harnessInstallOwner`), from
  `packages/provider-core/src/server/maintenanceResolver.ts`.
- `src/codex-home-layout.mjs`, the whole file: a Codex profile's home and shadow home (`resolveCodexHomeLayout`,
  `materializeCodexShadowHome`), and in `src/environment-app-server.mjs` the folders a WSL or SSH host's shadow home shares
  (`REMOTE_CODEX_SHARED_DIRECTORIES`), from `apps/server/src/provider/Drivers/CodexHomeLayout.ts`.
- `src/codex-turn-usage.mjs`: a Codex turn's usage as the growth of the thread's running total, falling back to the newest
  request's when a counter went down (`createCodexTurnUsage`), from `apps/server/src/provider/CodexTurnTokenUsage.ts`.
- `src/codex-account-probe.mjs`: the account and plan labels (`codexAccountLabel`), from
  `apps/server/src/provider/CodexProvider.ts`.
- `src/model-service-tier.mjs`: Codex's service-tier choices and the configured tier (`codexServiceTierOptions`,
  `codexConfiguredServiceTier`), from `apps/server/src/provider/CodexProvider.ts`.
- `src/codex-model-catalog.mjs`: the preferred default Codex models, a model's family and the reasoning levels' labels
  (`PREFERRED_DEFAULT_CODEX_MODELS`, `codexModelFamily`, `codexReasoningEffortLabel`), from `packages/contracts/src/model.ts`,
  `packages/shared/src/model.ts` and `apps/server/src/provider/CodexProvider.ts`.
- `ui/src/codex-goal-command.js`, the whole file: the reading of a `/goal` message (`parseCodexGoalCommand`), from
  `packages/contracts/src/orchestrationV2.ts`.
- `ui/src/codex-turn-options.js`: a goal's one-line description, a Codex error's code and a retry's attempt count
  (`describeCodexGoal`, `codexErrorInfoCode`, `parseCodexRetryProgress`), from
  `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`.
- `src/agent-history-import.mjs`: the setup text a Codex session's title leaves out (`CODEX_TITLE_PREAMBLE`), from
  `apps/server/src/project/AgentSessionScanner.ts`.
- `src/thread-history-handoff.mjs`: the order in which earlier messages fill a handoff's budget (`selectThreadHistory`), from
  `packages/provider-core/src/server/handoffBudget.ts`.
- `ui/src/tool-activity.js`: the argument names a tool call's path, query, file pattern and folder are read from, and the order
  of a search's label (`searchToolLabel`), from `packages/shared/src/toolActivity.ts`.
- `ui/src/reasoning-text.js`: the Markdown marks a collapsed thought's one-line preview leaves out, from
  `packages/client-runtime/src/work-log/presentation.ts`.

The app's other code:

- `src/document-text-extract.mjs`, the reader of attached documents' text: its Excel (.xlsx) and RTF readers, its limits, its
  checks and the headings it writes for sheets, slides, chapters and notebook cells, from
  `apps/server/src/provider/documentTextWorker.ts`.
- `src/document-text.mjs`: the reuse of a document's extracted text, the size limit and the wait after a failed extraction
  (`ensureDocumentText`), from `apps/server/src/provider/DocumentText.ts`.
- `src/secret-redactor.mjs` and `src/acp-client.mjs`: the secret and sign-in address patterns, and the tail of an agent's log
  (`appendAcpStderrTail`, `sanitizeAcpStderrExcerpt`), from `packages/provider-acp/src/server/stderr.ts`.
- `src/source-control-service.mjs`: the reading of pull request templates (`parseTemplateTreeEntries`, `readTemplateBlob`), from
  `packages/source-control-github/src/server/gitHubChangeRequestTemplate.ts`.
- `src/checkpoint-service.mjs`: the Git errors a checkpoint tries again after (`isTransientCheckpointGitError`), from
  `apps/server/src/vcs/VcsProcess.ts`.
- `src/login-shell-environment.mjs`: the reading of the login shell's variables between markers and the merge of PATH entries
  (`loginShellCommand`, `parseLoginShellOutput`, `mergePathEntries`), from `packages/shared/src/shell.ts` and
  `apps/desktop/src/shell/DesktopShellEnvironment.ts`.
- `src/windows-command-shim.mjs`: the reading of the Windows command shim npm writes for a package's binary
  (`windowsCommandShimTarget`), from `packages/shared/src/shell.ts`.
- `desktop/firefox-import.mjs`: the reading of Firefox's `profiles.ini` (`parseFirefoxProfiles`), from
  `apps/desktop/src/preview/BrowserImport/Sources.ts`.
- `desktop/chromium-import.mjs`: the reading of a Chromium profile's cookie database (`readChromiumCookieDatabase`,
  `decryptWindowsChromiumValue`, `webkitExpirySeconds`), from `apps/desktop/src/preview/BrowserImport/ChromiumCookies.ts`.

Test cases and inputs:

- `tests/claude-turn-errors.test.mjs`, `tests/claude-notices-compaction.test.mjs`, `tests/claude-forwarded-approvals.test.mjs`,
  `tests/claude-task-plan.test.mjs`, `ui/e2e/claude-plan-context.spec.js` and `ui/e2e/claude-forwarded-approvals.spec.js`: the
  Claude Code messages, errors, hook and compaction notices and approval prompts they replay, from
  `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts`.
- `tests/grok-zero-usage.test.mjs`: the Grok Build usage reports and their times, from
  `apps/server/src/provider/GrokProvider.test.ts`.
- `tests/agent-usage-limits.test.mjs`: the Cursor usage report's reset time, from
  `packages/provider-cursor/src/server/usageLimits.test.ts`.
- `tests/harness-install-plan.test.mjs`: the WinGet and Vite+ install paths and commands, from
  `packages/provider-core/src/server/maintenanceResolver.test.ts`.
- `tests/codex-history-own-sessions.test.mjs`: the Codex session setup text and titles, from
  `apps/server/src/project/AgentSessionScanner.test.ts`.
- `tests/codex-shadow-home-entries.test.mjs`: the Finder metadata cases, from
  `apps/server/src/provider/Drivers/CodexHomeLayout.test.ts`.
- `tests/opencode-read-output.test.mjs`: OpenCode's file-read outputs, from
  `packages/provider-opencode/src/server/adapter.test.ts`.
- `tests/muse-background.test.mjs`: the workflow item it starts from, from `packages/provider-muse/src/server/adapter.test.ts`;
  `tests/muse-model-catalog.test.mjs` and `tests/muse-runtime.test.mjs`: the Muse model row they list, from
  `packages/provider-muse/src/server/status.test.ts`.
- `tests/source-control-service.test.mjs`: the case of a later commit on the base branch, from
  `apps/server/src/git/GitManager.test.ts`.
- `tests/acp-sign-in-url-redaction.test.mjs`, `tests/acp-client.test.mjs` and `tests/harness-text-generation.test.mjs`: the agent
  log lines they redact (a Bearer token, a local pairing link, a sign-in address's state), from
  `packages/provider-acp/src/server/stderr.test.ts`.

Written from T3 Code's Cursor code at an earlier revision, `024d49520eadb24cc2f2cef0b0a82c33f0290813` (2026-10-02, the same
license), `apps/server/src/provider/Layers/CursorProvider.ts`:

- `src/acp-model-catalog.mjs`: Cursor's effort levels, its effort option, its Fast switch and its model list (`cursorEffortValue`,
  `cursorEffortOption`, `cursorFastOption`, `cursorModelCatalog`).
- `src/acp-agent-session.mjs`: the Cursor model options a turn applies after its model (`#applyCursorOptions`).
- `src/agent-runtime-manager.mjs`: Cursor's signed-in reading (`parseCursorAboutResult`).

Upstream: https://github.com/pingdotgg/t3code (revision `d6fb62ac3f2ab54a100202f5aea1428cfda977cd`, and
`024d49520eadb24cc2f2cef0b0a82c33f0290813` for the Cursor parts named above)  
License: MIT License, Copyright (c) 2026 T3 Tools Inc.
Local modifications: rewritten in Trebell's own JavaScript, with its own names, messages and structure around them.

The license's text:

```
MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

The exact Codex package/version used by Trebell is recorded above; upstream Codex
license/notice material remains available from the linked OpenAI source release.
