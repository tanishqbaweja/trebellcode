# Third-party notices

## OpenAI Codex

Trebell Code uses the exact npm runtime release `@openai/codex@0.155.1`.

Upstream: https://github.com/openai/codex  
License: Apache License 2.0
Revision used by Trebell: npm package version `0.155.1`
Destination/integration: dependency in `package.json`; packaged native binaries are resolved by `desktop/bundled-codex.mjs`; Trebell communicates with Codex through its app-server/protocol integration rather than maintaining a renamed fork of the Codex implementation.
Local modifications: Trebell wraps/configures the upstream runtime and provides its own provider compatibility, persistence, UI, policy, verification and desktop layers. Trebell does not claim ownership of the upstream Codex implementation.

The upstream repository's LICENSE and NOTICE files remain at the repository root.

## freebuff2api

A pinned source copy is vendored under `trebell-code/vendor/freebuff2api/`.

Upstream: https://github.com/chenjh16/freebuff2api  
License: MIT
Trebell vendor-import revision: `01ab3599b2bb06eccb423d54481e282db68994a3` (2026-09-20)
Upstream Git revision: not recorded in the repository at import time; do not infer one from Trebell's later client-version strings.
Destination: `vendor/freebuff2api/src/`
Local modifications: Trebell added/updated Responses compatibility and client identity handling, model-catalog behavior, and disables the optional anonymous public-upstream routes by default. The exact local history is preserved in Git under `vendor/freebuff2api/`.

The original MIT license is retained at
`trebell-code/vendor/freebuff2api/LICENSE`.

Trebell Code uses the authenticated Freebuff route by default.
