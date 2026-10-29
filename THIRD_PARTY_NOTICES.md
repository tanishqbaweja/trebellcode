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

## T3 Code recorded Muse sessions

The test fixtures in `tests/fixtures/muse/` (`simple`, `multi_turn`, `turn_interrupt`, `permission`, `workflow`, `subagent`
and `subagent_interrupt`) are frames from T3 Code's recorded Muse Code transcripts
(`apps/server/src/orchestration-v2/testkit/fixtures/*/muse_transcript.ndjson`: `workflow` from `muse_workflow`, `subagent` from
`subagent_v2` and `subagent_interrupt` from `muse_subagent_interrupt`).

Upstream: https://github.com/pingdotgg/t3code (revision `d6fb62ac3f2ab54a100202f5aea1428cfda977cd`)  
License: MIT License, Copyright (c) 2026 T3 Tools Inc.
Local modifications: the frames T3 Code's client sent are reduced to their method names, the ids it minted are replaced by
tokens a test binds to Trebell's own, T3 Code's runtime notes are cut from the user-message items, and the first turn of the
permission transcript is left out.

The exact Codex package/version used by Trebell is recorded above; upstream Codex
license/notice material remains available from the linked OpenAI source release.
