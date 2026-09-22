# Trebell Code 1.3.1

This patch release fixes the desktop theme/runtime issues discovered during final Windows validation.

## Fixes

- Trebell now defaults to **Dark** instead of inheriting Windows Light through the old implicit System setting.
- Existing version-1 profiles using the old implicit `System` appearance migrate once to Dark; users can still explicitly choose System or Light afterward.
- The modern Trebell workspace now keeps sidebar, canvas, header, provider footer, and composer in one coherent appearance instead of mixing dark chrome with a white workspace.
- Release validation now keeps Trebell Code and the Agent Browser hidden while native desktop/browser capabilities are tested, avoiding repeated windows appearing during builds.
- Windows release validation relaunches a fresh packaged Trebell instance for model-driven agent checks and cleans stale packaged process trees safely.

## Validation

- Headless Playwright verifies Dark is the initial appearance and checks the exact sidebar/workspace/header/composer colors.
- State migration tests verify legacy System defaults migrate only once.
- Native packaged validation remains enabled for Codex, Vyce `deepseek-v4.1`, computer use, Agent Browser actions, snapshots, recording, and updater metadata.
