## What this changes

<!-- What the change gives a person, in plain words. Link the issue it fixes, for example: Fixes #123 -->

## How it is proven

<!-- The test that fails before this change and passes after it: name it, and paste its failure without the change.
     For an interface change, add screenshots before and after, in light and dark mode. -->

## Checklist

- [ ] `npm test` passes.
- [ ] The tests I added fail without this change.
- [ ] For an interface change: the Playwright specs I touched pass, and the screenshots are above.
- [ ] For a change under `ui/src/`: `npm run test:budgets` passes.
- [ ] A change a person will notice has its line in `docs/releases/pending.md`.
- [ ] A Trebell Native change is a general improvement, not aimed at a benchmark's tasks or its hidden tests, and the app and the benchmark runner still share one Native configuration.
- [ ] No API key, token or other secret is in the code, the tests, the logs or the screenshots.
- [ ] I understand that this contribution is licensed under the Apache License 2.0, as section 5 of the license says.
