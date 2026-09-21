# Trebell Code Desktop v1.1.0

This release packages the source-backed harness parity work already landed on main and finishes Trebell Code's product identity.

## Highlights

- Official Trebell Code icon across the Windows app, taskbar/window identity, system tray, notifications, sidebar, welcome screen, favicon and Settings/About.
- Electron Builder uses the same official artwork as the Windows application icon, so installed shortcuts inherit Trebell Code branding.
- One streamlined model selector in chat and first-class folder/workspace switching.
- Windows computer use, browser automation, Codex capabilities/skills/MCP/apps/hooks, review workflows, Git/worktrees, and WSL/SSH/remote environments.
- Vyce AI live-validation target updated to `deepseek-v4.1`.

## Live validation

Run:

```powershell
$env:TREBELL_TEST_VYCE_API_KEY="..."
npm run test:vyce
```

The smoke test verifies that Vyce advertises `deepseek-v4.1` and then sends a real chat request through Trebell's provider adapter.
