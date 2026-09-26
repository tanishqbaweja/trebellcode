# Trebell Code 1.3.4

Version 1.3.4 is a reliability and runtime-integration release built from the post-1.3.3 verification work.

## Runtime and harness reliability

- OpenCode, Grok Build, and Antigravity runtime detection/authentication now report their real state instead of borrowing readiness from another harness.
- Managed Antigravity ACP installation is pinned to the curated supported runtime and launches from the correct process directory.
- OpenCode live validation prefers the free `opencode/muse-spark-1.3-contributor-free` model when available, while still preserving connected-provider discovery.
- External ACP/OpenCode permission behavior, runtime environment filtering, and process teardown were hardened and covered by integration tests.

## UI and thread reliability

- Settings and secondary pages scale more consistently against the sidebar at narrower effective viewport sizes.
- Runtime capability surfaces now stay truthful about unsupported controls, including background-process support.
- Signed-in-but-blocked Freebuff sessions are shown as unavailable instead of falsely ready.
- Stale Codex catalog rows whose underlying rollout no longer exists are hidden from normal history navigation.
- Long-history pagination and virtualized conversation anchoring were tightened and verified in headless Google Chrome.
- Diagnostics refresh failures preserve the last valid log while surfacing the new error.

## Persistence and security hardening

- Thread catalog/state handling was tightened around SQLite-backed metadata and runtime identity.
- Secret redaction and runtime child-process environments were hardened so unrelated host credentials are not inherited or persisted.
- Terminal command construction and runtime shutdown behavior received additional Windows coverage.

## Verification performed for this release

- `npm test`: 824 passed, 0 failed.
- Full Playwright UI suite in headless Google Chrome: 193 passed, 0 failed.
- Live coding-tool smoke passed through:
  - Grok Build 1.0.41 with `grok-4.7`
  - Antigravity ACP 1.2.1 with `gemini-3.8-flash-high`
  - OpenCode 1.18.32 with `opencode/muse-spark-1.3-contributor-free`
- Live provider transport smoke passed for JustWorker, HCNSec, and VyceAI.
- AgentRouter transport remained blocked by its upstream HTTP 402 budget-pool quota state.

## Release-pipeline hardening

- Packaged Windows validation now runs from an isolated deterministic Trebell home instead of inheriting whichever harness/provider the developer last selected.
- The native Codex queue integration test now validates stable real-app-server behavior without racing Codex's own idle queue auto-dispatch.
