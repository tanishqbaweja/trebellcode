# Trebell Code 1.3.6

Version 1.3.6 is a focused Native reliability and efficiency follow-up to v1.3.5. It keeps the v1.3.5 architecture intact while removing several avoidable recovery turns caused by conventional model path/tool-call mistakes.

## Native recovery without guessing

- Relative `workspace/...` paths now receive the same bounded workspace-root fallback as `/workspace/...` **only when the literal path does not exist**. A real `workspace` directory still wins, so Trebell does not silently reinterpret valid user paths.
- When `trebell_repo/read_source` hits a known "file is not indexed" boundary and `trebell_workspace/read_file` is already exposed, Native can perform that bounded read internally rather than spending another model turn asking for the same file through a second tool. The model still sees the original repository tool lifecycle plus explicit fallback provenance.
- Provider-flattened Trebell tool aliases are repaired only when they identify exactly one exposed tool. Ambiguous names are left untouched instead of being fuzzy-guessed.
- If a later same-turn `trebell_terminal/run` call loses only its executable, Native may restore the command **only** when exactly one earlier successful terminal call in that same turn has identical args and cwd. Failed executions, timed-out commands, signal-killed runs, empty-args calls, and ambiguous command matches are never used as repair templates.
- Recipe tool allowlists now also filter the schemas sent to the model. Disallowed tools remain blocked by the execution gateway even if a provider hallucinates a hidden call, so this reduces prompt cost without weakening the policy boundary.
- Large virtualized tool output keeps its persistent retrieval handle and signal-aware failure lines while using a smaller hot preview, reducing repeated noisy context without discarding the full stored output.

## Measured behavior

- The earlier `/workspace/...` normalization had already reduced one failure-repair regression from **31,920 input tokens / 10 model turns / 17 tool calls** to **8,826 input / 4 turns / 5 calls** while independently passing verification.
- On the current v1.3.6 candidate, the same failure-repair benchmark again completed successfully in **4 model turns / 6 tool calls / 9,191 provider input tokens**, with **0 failed tool calls** and independent verification passing. Model/provider behavior remains stochastic; this is a measured run, not a fixed guarantee.
- A repository-tool-description compression experiment was rejected: although it reduced the provider-visible schema from **5,117 to 4,793 JSON characters**, a reproduced three-scenario run still used **44,968 input tokens / 17 model turns / 21 tool calls**, worse than the cleaner **35,397 input / 14 turns / 17 calls** baseline. The fuller descriptions remain in place.
- The live Native benchmark now exposes per-turn input/output/cache usage and request-cost evidence so future optimizations can be judged from the expensive turn instead of only aggregate totals.
- On the same 92 KB noisy-output repair task, the earlier full-schema / 6,000-character-preview run used **18,745 provider input tokens / 6 model turns / 4 tool calls**. The current combined allowlist-filtering + bounded-preview build used **15,345 input / 6 turns / 4 calls** with independent verification passing, about **18% less provider input** in that measured pair. On the first recipe-restricted request specifically, the visible tool surface fell from **11 functions / 5,117 schema characters / ~1,280 estimated schema tokens** to **1 function / 772 characters / ~193 estimated schema tokens**. Both runs reported zero cached input tokens; provider/model behavior is stochastic, so these are measurements rather than a fixed guarantee.

## Validation status before release

- Focused Native loop/session/path coverage passed, including negative cases that prove recovery does not cross permission/tool exposure boundaries or reuse ambiguous/failed terminal evidence.
- Latest full deterministic suite on the candidate: **838 passed, 0 failed**.
- v1.3.5 remains untouched; v1.3.6 is a new release and will receive its own installer, updater metadata, blockmap, release metadata, and Git tag.

The release pipeline performs the deterministic suite again plus packaged Codex, desktop/browser, real-model Trebell Native, and Windows NSIS validation before publication.
