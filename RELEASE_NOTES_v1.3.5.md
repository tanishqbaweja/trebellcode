# Trebell Code 1.3.5

Version 1.3.5 separates Trebell Native cleanly from external coding harnesses, expands direct provider support, and adds measured context/tool-loop optimizations without trading away coding quality or verification.

## Native vs external harness architecture

- Trebell Native now owns its own agent loop, prompt, context, tools, persistence and direct provider transport instead of treating Codex as an inference bridge.
- Codex uses the real Codex app-server, native account/config/model catalog and native continuation identity. Selecting a Trebell Native provider no longer changes Codex inference.
- Claude Code, OpenCode and ACP-backed runtimes keep their native prompt/session semantics and receive only a small Trebell application-context addition.
- Cross-runtime thread ownership stays truthful: saved external-harness threads resume through the harness that owns them rather than being silently converted to another runtime.
- AgentRouter still receives its required Codex-compatible client fingerprint at the provider-transport layer; this is compatibility metadata, not Codex harness substitution.

## Direct provider support

- Trebell Native has first-class direct adapters for official OpenAI, Anthropic and Gemini APIs in addition to AgentRouter, JustWorker, HCNSec and VyceAI.
- Official OpenAI uses the Responses API and preserves Trebell namespaced function-tool identity.
- Anthropic uses the Messages API with Anthropic-native authentication semantics.
- Gemini currently uses Google's OpenAI-compatible endpoint; native cached-content behavior remains intentionally unclaimed until measured.
- Provider telemetry records request/response bytes, latency, normalized usage, cached-input fields when exposed, endpoint and wire API without persisting secrets.

## Measured Native efficiency improvements

- ACP runtime context is injected once per external ACP session instead of being repeated on every prompt.
- The obsolete provider compatibility bridge and Responses-to-Chat bridge path were removed from normal architecture.
- Conventional `/workspace/...` model paths are normalized to the active Trebell workspace, eliminating repeated failed tool calls on Windows. A failure-repair benchmark dropped from **31,920 input tokens / 10 model turns / 17 tool calls** during the regression to **8,826 input / 4 turns / 5 calls** after the path fix while still independently passing verification.
- Repeated virtualized tool output is cooled across later user turns to a compact receipt plus searchable handle and high-signal failure lines. On the 92 KB noisy-output benchmark this measured **23,063 input tokens / 7 turns / 6 calls**, versus **29,696 input** immediately before the change and **37,526 input** in the preserved v1.3.3 baseline.
- Native now performs one bounded recovery when the user explicitly names an exact exposed tool and the model tries to answer without calling it. Negated, vague and stale-context tool mentions do not trigger this behavior.
- A tool-order experiment showed the requested tool was called with both normal and reordered schemas, so Trebell keeps schema ordering stable rather than shuffling tools and breaking stable schema hashes.
- A proposed reduction of the baseline repository manifest to only `search_code` was rejected after it caused three focused regressions. `search_symbols`, `search_files` and `read_source` remain directly available until a lower-cost migration is proven without behavior loss.

## Current prompt/context telemetry

One real Vyce Native coding smoke on the release candidate measured:

- **4 model turns** and **8,082 provider input tokens** total;
- **582 estimated system-prompt tokens**;
- **11 baseline tool functions** and **1,280 estimated tool-schema tokens**;
- one stable prefix hash and one stable tool-schema hash across all four requests;
- **0 provider-reported cached input tokens**;
- real workspace edit plus terminal verification;
- independent verification passed;
- **no Codex app-server** in the Native request path.

These are measurements, not fixed guarantees; model behavior and provider routing remain stochastic.

## Live/runtime validation

- Real Codex live smoke passed with the Codex-owned model catalog and `gpt-6-luna`, while Trebell Native remained configured for a different provider.
- OpenCode 1.18.32 passed a real tool/coding smoke with `opencode/muse-spark-1.3-contributor-free`.
- Antigravity ACP 1.2.1 passed a real tool/coding smoke with `gemini-3.8-flash-high`.
- Grok reached its real runtime but was blocked by an upstream `Rate limited` response during the latest rerun.
- Claude Code remained installed but unauthenticated; Cursor's launcher remained unavailable on this machine, so neither is claimed as a live pass.
- Real Trebell Native provider smoke passed for JustWorker, HCNSec and VyceAI. AgentRouter reached the real route but remained blocked by upstream HTTP 402 budget-pool exhaustion.
- Official OpenAI, Anthropic and Gemini adapters are contract-tested; no live success is claimed because those API keys were not configured in the test environment.

## Packaged Windows validation

- A real unpacked Electron build passed the installed Codex relay and command-execution smoke.
- Packaged Codex reported its bundled runtime as authenticated through ChatGPT and kept a Codex-owned model catalog even while the Trebell Native provider was switched to VyceAI.
- The packaged desktop/browser smoke passed browser navigation, typing/clicking, cookies, screenshots, video recording, desktop capture, SnapShot persistence, zoom controls, notifications and background/startup toggling.
- A real packaged Trebell Native `deepseek-v4.1` run called packaged computer screenshot plus browser open/snapshot/type/click capabilities and created/verified a filesystem proof file.
- Windows packaging now builds unpacked and NSIS artifacts in unique isolated temp directories, uses the already-installed Electron distribution to avoid archive-extraction races, retries once in a fresh isolated directory for observed Windows materialization races, and only copies completed installer/update artifacts into `desktop-dist`.

## Automated regression baseline

- `npm test`: **829 passed, 0 failed** on the consolidated pre-release tree.
- Latest full Playwright UI suite in headless Google Chrome: **193 passed, 0 failed**.
- Production UI build succeeds.

The release pipeline still performs its own deterministic tests and packaged smoke before publishing.
