# Trebell Code Desktop v1.2.0

This development release rolls the large post-1.1 feature batch into the next minor version and validates it directly on Windows.

## Highlights

- Project actions with saved commands, `t3.json` import, package-script discovery, preview URLs, and worktree setup actions.
- Live worktree setup flow with completion-aware PTYs, blocking setup support, visible progress, success/failure states, and terminal access.
- Delegated-agent fleet backed by real Codex thread state plus live per-thread activity, waiting flags, token/context usage, last activity, and errors.
- Rich workspace previews for images, video, audio, PDF, Markdown, CSV, and TSV.
- Open-in-editor integration for common desktop editors and file-manager fallback.
- Automatic localhost preview discovery and one-click project previews.
- Multi-forge source control, remote WSL/SSH environments, conditional keybindings, browser automation, computer use, review workflows, and Codex capability surfaces retained from the earlier parity work.
- Windows development now launches the bundled native `codex.exe` directly, avoiding `.cmd` path failures in folders containing spaces.
- Playwright validation is isolated from the user's real Trebell profile and can use an installed browser channel such as Chrome.
- Vyce supports both `VYCEAI_API_KEY` and `VYCE_API_KEY`, and local validation loads the repository `.env` automatically.

## Validation

- Node unit/integration suite: 59/59 passing.
- Playwright desktop-style harness flow: passing in installed Chrome.
- Live Vyce `deepseek-v4.1` model discovery and direct inference: passing.
- Live end-to-end Vyce + Codex + Trebell browser tool loop: passing (`open -> snapshot -> click -> snapshot`), including writing and reading the observed proof token from the workspace.

Run the live checks from `trebell-code`:

```powershell
npm run test:vyce
$env:TREBELL_E2E_BROWSER_CHANNEL="chrome"
npm run test:vyce:agent
```

The live scripts automatically load `../.env` when it exists.
