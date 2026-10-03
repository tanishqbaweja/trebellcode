# Security policy

Trebell Code is an agentic developer tool: it can interact with repositories, terminals, credentials, external runtimes, browsers, and remote environments. Security issues in those boundaries are treated as product issues, not just implementation bugs.

## Reporting a vulnerability

Please **do not open a public GitHub issue** for a vulnerability that could expose credentials, execute unintended commands, cross a permission boundary, escape a workspace/environment boundary, or compromise the update/install path.

Use the repository's **GitHub Security Advisory** flow to report the issue privately. Include:

- the affected Trebell Code version or commit;
- the runtime/provider/environment involved;
- clear reproduction steps;
- the expected and observed permission boundary;
- the potential impact;
- logs or screenshots with secrets removed.

## Scope

Security-sensitive surfaces include:

- provider and runtime credentials;
- tool authorization and permission profiles;
- terminal/process execution;
- repository/worktree path isolation;
- MCP/plugin/tool output handling;
- browser and desktop automation;
- remote WSL/SSH environments;
- updater and release integrity;
- persisted thread/event/verification data.

## Supported versions

The latest release and current `main` branch receive fixes. Older development snapshots may not receive backports.

Please avoid including real API keys, access tokens, private repository contents, or other secrets in reports.
