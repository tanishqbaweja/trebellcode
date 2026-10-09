# Third-party notices

## OpenAI Codex

Trebell Code uses the exact npm runtime release `@openai/codex@0.155.1`.

Upstream: https://github.com/openai/codex  
License: Apache License 2.0
Revision used by Trebell: npm package version `0.155.1`
Destination/integration: dependency in `package.json`; packaged native binaries are resolved by `desktop/bundled-codex.mjs`; Trebell communicates with Codex through its app-server/protocol integration rather than maintaining a renamed fork of the Codex implementation.
Local modifications: Trebell wraps/configures the upstream runtime and provides its own provider compatibility, persistence, UI, policy, verification and desktop layers. Trebell does not claim ownership of the upstream Codex implementation.

The Trebell repository root contains Trebell's Apache-2.0 LICENSE and NOTICE. The
exact Codex package/version used by Trebell is recorded above; upstream Codex
license/notice material remains available from the linked OpenAI source release.
