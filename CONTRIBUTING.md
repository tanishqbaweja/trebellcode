# Contributing to Trebell Code

Thank you for helping with Trebell Code. This guide says how the project is set up, how to build, run and test it from source, and what a change needs before it can be merged.

## What Trebell Code is

Trebell Code is a desktop app for software engineering with AI coding agents. Its core is **Trebell Native**, Trebell's own agent harness: Trebell runs the model and tool loop itself and calls the model provider you choose with your own API key. The app also runs other agents as their real harnesses (Codex, Claude Code, OpenCode, Cursor, Grok Build, Antigravity and Muse Code), so they can be used, and compared, in one workspace. The [README](README.md) and the [technical overview](docs/technical/TECHNICAL_OVERVIEW.md) describe it in more detail.

The code is JavaScript: Node.js modules for the local server and the agent harnesses, React and Vite for the interface, and Electron for the desktop shell.

| Folder | What is in it |
| --- | --- |
| `src/` | The local server, Trebell Native, the other harnesses' integrations, model providers, tool policy and persistence |
| `ui/src/` | The React interface |
| `ui/e2e/` | Playwright tests of the interface |
| `tests/` | Unit and integration tests, run with Node's test runner |
| `desktop/` | The Electron shell |
| `benchmarks/`, `scripts/` | Benchmark runners, release scripts and live tests |
| `docs/` | Technical documents and release notes |

## Ways to contribute

- **Report a bug** with the [bug report form](https://github.com/tanishqbaweja/trebellcode/issues/new?template=bug_report.yml).
- **Suggest a feature or a change** with the [feature request form](https://github.com/tanishqbaweja/trebellcode/issues/new?template=feature_request.yml).
- **Fix an issue.** Issues labelled [good first issue](https://github.com/tanishqbaweja/trebellcode/labels/good%20first%20issue) are small and well scoped. Say in the issue that you are working on it, so that two people do not do the same work.
- **Improve the documentation** where it is wrong, missing or hard to follow.

For anything bigger than a small fix, open an issue first and agree on the approach before you write the code. [GOVERNANCE.md](GOVERNANCE.md) says how decisions are made, and [ROADMAP.md](ROADMAP.md) lists the work that is planned.

## Setting up on Windows

Trebell Code is released for Windows x64, and that is where it is developed and tested. You need:

- Windows 10 or 11 (x64);
- [Node.js](https://nodejs.org/) 22 or newer, as `engines` in `package.json` says (the maintainer and CI use Node.js 24), with the npm that comes with it;
- [Git for Windows](https://git-scm.com/download/win).

Then, in PowerShell or any terminal:

```powershell
git clone https://github.com/tanishqbaweja/trebellcode.git
cd trebellcode
npm ci
```

`npm ci` installs the exact versions that `package-lock.json` records, Electron and the Codex runtime for Windows x64 among them. Use `npm install <package>` only for a change that adds or updates a dependency, and commit the `package-lock.json` it writes with it.

macOS and Linux packages are configured but not yet validated on real machines (see [Platform support](docs/technical/TECHNICAL_OVERVIEW.md#platform-support)).

## Running the app from source

Build the interface, then start the local server:

```powershell
npm run ui:build
npm run gui:server
```

Open http://127.0.0.1:3210 in your browser. This is the interface and the server the desktop app runs; the Electron shell adds the desktop window and its integrations.

To work on the interface with hot reload, start the server in one terminal and Vite's development server in another, then open http://127.0.0.1:5173 (it sends `/api` requests to the server on port 3210):

```powershell
npm run gui:server
npm run ui:dev
```

Trebell Native needs a model provider API key, which you add in **Settings, Agents & models**. Each other harness signs in with its own CLI, or runs on its vendor's key when you choose that. The [README](README.md#model-provider) explains both.

Building the installer is described in [Building a Windows release](docs/technical/TECHNICAL_OVERVIEW.md#building-a-windows-release).

## Tests

### Unit and integration tests

```powershell
npm test
```

This runs every file in `tests/` with Node's test runner, two files at a time. It needs no API key. Before you open a pull request, run it in full.

While you work, run only the files you touched:

```powershell
node --import tsx --test tests/license-service.test.mjs
```

`npm run test:fast` runs the whole suite in one process, one file at a time. It starts faster but isolates the files less, so `npm test` is the one that counts.

### Interface tests

```powershell
npm run ui:test
```

This builds the interface, starts the local server on a free port with mock harnesses, offline and with a fresh home folder in your temp folder, and runs every spec in `ui/e2e/` in one worker. No API key or harness is needed. The whole suite takes long, so while you work run the specs you touched:

```powershell
npx playwright test -c ui/playwright.config.mjs ui/e2e/licenses.spec.js
```

Playwright needs its Chromium once (`npx playwright install chromium`). To use your installed Google Chrome instead, set `TREBELL_E2E_BROWSER_CHANNEL=chrome`. Many specs save screenshots under `visual-audit/`, which Git ignores.

### Bundle budgets

```powershell
npm run test:budgets
```

This builds the interface and checks budget B11 in [`tests/bundle-budgets.test.mjs`](tests/bundle-budgets.test.mjs): the kilobytes of JavaScript and CSS the first paint loads, and those of the chunks that load later, raw and gzipped. A change that makes the first paint load more code usually has to load that code later instead. The comments in that test say how earlier changes did it.

### Live tests

The `test:*:live` and `bench:*` scripts call real providers and harnesses with real credentials. They are opt-in, they cost money, and CI never runs them. Never commit a `.env` file or any key.

## How a change is proven

A change is merged on evidence, not on description:

- **A bug fix comes with a test that fails before the fix and passes after it.** Say in the pull request which test that is, and show its failure without your fix.
- **New behavior comes with tests:** in `tests/` for server and harness code, in `ui/e2e/` for the interface.
- **An interface change comes with screenshots,** before and after, in light and dark mode, and in a narrow window when the layout changes. Test every control you add or change the way a person uses it: click it, type in it, use it with the keyboard.
- **A performance claim comes with measurements** before and after the change.
- **A benchmark claim follows [BENCHMARKS.md](BENCHMARKS.md).**

## The project's principles

These decide what is accepted:

- **Quality first.** Trebell Native must match or beat each model maker's own harness on resolved tasks, and do it at lower cost. Lower cost never makes up for fewer resolved tasks.
- **General improvements, backed by measurement.** Native gets better through changes that help any task: context, caching, tool use, verification, recovery. A change aimed at a benchmark's tasks or its hidden tests is not accepted.
- **The Native the app ships is the Native that gets benchmarked.** Both read one configuration, [`src/native-configuration.mjs`](src/native-configuration.mjs), and [`tests/native-one-config-parity.test.mjs`](tests/native-one-config-parity.test.mjs) compares what each sends. A Native change keeps that true.
- **Honest capabilities.** A control works or is not shown. The app says what a harness can and cannot do, and never fakes a result.
- **Plain words in the interface.** Labels and messages say what happened and what to do, in everyday words.

[docs/technical/PRODUCT_PRINCIPLES.md](docs/technical/PRODUCT_PRINCIPLES.md) is the full product and architecture contract.

## Commits and pull requests

- Keep a pull request to one change, and each commit to one logical step of it.
- Write the commit subject as one line that says what the change gives a person, with its words joined by hyphens, as `git log` shows, for example `Read-Bitbucket-credentials-only-from-the-TREBELL_BITBUCKET-variables`. No body is needed.
- Add a line for every change a person will notice to [docs/releases/pending.md](docs/releases/pending.md). Those lines go into the next release's notes.
- Do not commit build output or test output (`ui/dist/`, `desktop-dist/`, `release-artifacts/`, `visual-audit/`, `test-results/`) or any secret.
- Fill in the pull request template. CI runs the unit suite and the interface build with its bundle budgets on Windows, and both must pass.
- The maintainer reviews every pull request, as [GOVERNANCE.md](GOVERNANCE.md) says.

## License of contributions

Trebell Code's own code is licensed under the [Apache License 2.0](LICENSE). As section 5 of that license says, any contribution you intentionally submit for inclusion in Trebell Code is under the terms and conditions of the Apache License 2.0, without any additional terms or conditions, unless you explicitly state otherwise. There is no separate contributor agreement to sign.

Material from other projects keeps its own license. It can come in only under a license that is compatible with Apache-2.0, with its notice added to [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), and its license files to `third-party-licenses/` when its npm release ships none.

## Where to ask and report

- **Bugs and feature requests:** the [issue forms](https://github.com/tanishqbaweja/trebellcode/issues/new/choose).
- **Questions:** open a blank issue, or e-mail founder@trebell.dev.
- **Security vulnerabilities:** never in a public issue. [SECURITY.md](SECURITY.md) says how to report one privately.
- **Conduct:** everyone who takes part follows the [Code of Conduct](CODE_OF_CONDUCT.md). Report unacceptable behavior to founder@trebell.dev.
