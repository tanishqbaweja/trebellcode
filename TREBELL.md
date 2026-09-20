# Trebell Code

Trebell Code is a Freebuff-enabled distribution built on the Apache-2.0 OpenAI Codex source tree.

The user-facing launcher lives in `trebell-code/` and provides:

- `trebell` and `trebell-code` commands
- Trebell state under `~/.trebell-code`
- Freebuff signup/login through freebuff2api's device-code flow
- a localhost-only OpenAI-compatible bridge
- automatic Codex custom-provider configuration
- Codex filesystem, shell, diff, approval, history and MCP tooling

## Install

```bash
cd trebell-code
npm install
npm link
trebell
```

Upstream Apache-2.0 license and NOTICE files are intentionally preserved.
