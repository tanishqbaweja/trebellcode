# Notes for the next release

These lines go into the next release's notes file in this folder when it is cut, and this file is then emptied.

## Projects

- **`trebell.json` takes Trebell's own words.** A project's shared file now lists `actions`, each with a `label` and a `run`
  command, and optionally a `preview` address, `openPreview` (true to open it when the action starts) and `onNewWorktree`
  (`wait` to run it when Trebell makes a worktree and wait for it, `start` to run it then and go on). `workspace` sets where a new
  thread works (`worktree` or `current`) and `submodules` how deep a new worktree's submodules go (`all`, `first-level` or `none`).
  A `trebell.json` written for 2.1.1 or 2.1.2 (`scripts`, `defaultThreadEnvMode`, `worktreeSubmodules`) shows no actions or
  defaults until it uses these words, and the Projects page says that it found the file but reads nothing in it. To bring such a
  file over:
  - `scripts` becomes `actions`, and in each action `name` becomes `label`, `command` `run` and `previewUrl` `preview`.
  - `autoOpenPreview`: any value 2.1.2 read as on (true, or any other value but false, 0, an empty string or null) becomes
    `"openPreview": true`; otherwise leave `openPreview` out.
  - `runOnWorktreeCreate`: true with `async` false becomes `"onNewWorktree": "wait"`; any other value 2.1.2 read as on (true with
    `async` missing or anything but false, or any other value but false, 0, an empty string or null) becomes `"start"`; false (or
    0, an empty string, null) or no value means leaving `onNewWorktree` out, since 2.1.2 did not run that action on a new worktree.
    `async` is no longer read.
  - `defaultThreadEnvMode` becomes `workspace`: `"worktree"` stays `"worktree"` and `"local"` becomes `"current"`. 2.1.2 read no
    other value, so for any other leave `workspace` out.
  - `worktreeSubmodules` becomes `submodules`: `"recursive"` becomes `"all"`, `"top-level"` becomes `"first-level"` and `"none"`
    stays `"none"`. 2.1.2 read no other value, so for any other leave `submodules` out.

## Composer and harnesses

- **A message can be up to 200,000 characters.** The composer took 120,000. Codex itself takes up to 1,048,576.
- **An ACP approval card's last button reads "Cancel this request".** It answers that one request as cancelled, and the turn goes
  on; the composer's Stop ends the turn.
- **Antigravity's runtime install keeps 512 MB free on its drive**, where it kept 256 MB, and says so when the drive has less.
- **Background work keeps Muse Code's and Claude Code's process for up to eight hours**, where 2.1.2 kept it for four: Muse's
  work from its last word, Claude's from the end of the turn that started it. When the hold ends the process is closed, and any of
  that work still running stops with it.
- **Claude Code has two minutes to connect a thread's MCP servers**, where it had 90 seconds, and says so when it runs out.
- **A new thread's title holds up to 80 characters of its first message**, where it held 50. Threads titled before keep their
  titles.
