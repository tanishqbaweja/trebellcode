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

Parts of Trebell Code were written from T3 Code's source, and some of its tests use cases and inputs from T3 Code's tests:

- `src/document-text-extract.mjs`, the reader of attached documents' text: its Excel (.xlsx) and RTF readers, its limits and its
  checks follow `apps/server/src/provider/documentTextWorker.ts`.
- `src/muse-agent-session.mjs`: the tool rows, item statuses, approval choices and usage-limit reading follow
  `packages/provider-muse/src/server/itemPresentation.ts`, `protocol.ts` and `usageLimits.ts`.
- `src/opencode-agent-session.mjs`: the reading of OpenCode's file-read output follows
  `packages/provider-opencode/src/server/toolItems.ts`.
- `src/acp-agent-session.mjs`: Grok Build's approval choices follow `packages/provider-grok/src/server/acpSupport.ts`.
- `src/agent-usage-limits.mjs`: the Grok Build and Claude Code usage readers follow
  `packages/provider-grok/src/server/usageLimits.ts` and `apps/server/src/provider/claudeUsageLimits.ts`.
- `src/claude-agent-session.mjs`: the usage merge and the task-list tools follow
  `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts`.
- `src/secret-redactor.mjs`: the secret patterns follow `packages/provider-acp/src/server/stderr.ts`.
- `src/source-control-service.mjs`: the reading of pull request templates follows
  `packages/source-control-github/src/server/gitHubChangeRequestTemplate.ts`.
- Tests: the tool-row, verbatim-path and question cases of `tests/muse-agent-session.test.mjs`, the refusal and quota sentences
  of `tests/muse-failures.test.mjs` and `tests/fixtures/muse/fake-muse.cjs`, the approval subject and answers of
  `tests/muse-approvals.test.mjs`, the recorded session id in `tests/muse-compact-fork.test.mjs`,
  `tests/muse-model-catalog.test.mjs` and `tests/muse-runtime.test.mjs` (from
  `packages/provider-muse/src/server/itemPresentation.test.ts`, `sdk.test.ts`, `adapter.test.ts`, `usageLimits.test.ts` and
  `apps/server/src/orchestration-v2/testkit/fixtures/simple/muse_transcript.ndjson`), and the notebook, OpenDocument,
  spreadsheet, RTF and limit inputs of `tests/document-text.test.mjs` and `tests/fixtures/documents/make-fixtures.mjs`, with
  the documents it makes (from `apps/server/src/provider/userInputAttachments.test.ts`).

Upstream: https://github.com/pingdotgg/t3code (revision `d6fb62ac3f2ab54a100202f5aea1428cfda977cd`)  
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
