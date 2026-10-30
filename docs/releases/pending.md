# Notes for the next release

These lines go into the next release's notes file in this folder when it is cut, and this file is then emptied.

## Projects and source control

- **A project's shared settings file is `trebell.json`.** Trebell reads a project's shared actions and workspace defaults from
  `trebell.json` at the project's root, and no longer from `t3.json`. A project that keeps them in `t3.json` shows none on the
  Projects page until the file is renamed to `trebell.json`.
- **Bitbucket credentials come only from Trebell's own variables.** Trebell reads them from `TREBELL_BITBUCKET_ACCESS_TOKEN`, or
  from `TREBELL_BITBUCKET_EMAIL` with `TREBELL_BITBUCKET_API_TOKEN`, and no longer from the `T3CODE_BITBUCKET_ACCESS_TOKEN`,
  `T3CODE_BITBUCKET_EMAIL` and `T3CODE_BITBUCKET_API_TOKEN` variables. Set the Trebell names to keep Bitbucket working.
