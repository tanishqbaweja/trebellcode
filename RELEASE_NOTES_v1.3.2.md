# Trebell Code 1.3.2

Version 1.3.2 is a repository and release-hardening update built on Trebell's current multi-harness desktop architecture.

## Repository cleanup

- Promoted the actual Trebell Code application to the GitHub repository root.
- Removed the obsolete upstream Codex source tree from the Trebell repository root.
- Added goal.md to the repository as the product/architecture contract.
- Added an ignored release-artifacts folder for locally retained installers and updater metadata.
- Clarified that .env is developer/live-test scaffolding only; normal users configure API keys in Trebell Settings.

## Architecture and reliability audit

- Retired obsolete mobile-device control and mobile-companion surfaces.
- Moved runtime-specific behavior behind capability contracts where appropriate.
- Kept managed-inference behavior provider-aware without coupling conversation identity to provider.
- Made SQLite authoritative over the JSONL event mirror and fixed byte-bounded fallback compaction.
- Added explicit verified/unverified trust labels to repository knowledge.
- Added MCP result redaction regression coverage.
- Fixed truthful runtime-readiness reporting in Settings.
- Fixed exhausted thread-history pagination.
- Hardened UI tests against asynchronous navigation/readiness races.
- Made Playwright build the current UI automatically before local runs.

## Documentation and manual validation

- Rebuilt README.md around the current multi-harness product instead of the older Codex-only architecture.
- Added MANUAL_TESTING.md with real-world validation steps for providers, runtimes, WSL/SSH, forges, MCP, packaging, updater, persistence, secrets and long-running workflows.
- Tightened third-party attribution and provenance documentation.

## Automated validation checkpoint

At the release-housekeeping audit checkpoint:

- 782 / 782 deterministic tests passed.
- 138 / 138 visual/screenshot tests passed.
- Windows packaging/update tests passed.
- Installed-app release smoke tests remain part of the Windows release script.
