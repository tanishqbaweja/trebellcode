# Governance

Trebell Code is a maintainer-led project. This page says who decides, how proposals and pull requests are reviewed, how releases and benchmark claims are made, and how this page itself can change. It describes how the project works today.

## The maintainer

Trebell Code has one maintainer: the owner of this repository, who commits as Trebell16. There are no other roles today, such as committers or a steering group. The maintainer:

- decides which issues and pull requests are accepted, and merges them;
- keeps the [roadmap](ROADMAP.md);
- cuts and publishes releases;
- decides which benchmark results are published;
- enforces the [Code of Conduct](CODE_OF_CONDUCT.md).

Decisions follow the [project's principles](CONTRIBUTING.md#the-projects-principles) and the product and architecture contract in [docs/technical/PRODUCT_PRINCIPLES.md](docs/technical/PRODUCT_PRINCIPLES.md).

## Proposals

A proposal starts as an issue: a [feature request](https://github.com/tanishqbaweja/trebellcode/issues/new?template=feature_request.yml), or a [bug report](https://github.com/tanishqbaweja/trebellcode/issues/new?template=bug_report.yml) for something that does not work as it should. The maintainer answers in the issue: the proposal is accepted, declined with the reason, or needs more information. Accepted work that is planned goes into [ROADMAP.md](ROADMAP.md).

For a large change, agree on the approach in the issue before writing the code, so that the work fits and is not wasted.

## Pull requests

The maintainer reviews every pull request. A pull request is merged when:

- it is in scope and fits the project's principles;
- its CI checks pass;
- it comes with the proof [CONTRIBUTING.md](CONTRIBUTING.md#how-a-change-is-proven) asks for: a test that fails before the change and passes after it, and screenshots for an interface change;
- the maintainer approves it.

The maintainer may ask for changes, or close a pull request that does not fit, and says why. There is no fixed review time.

## Releases

The maintainer cuts every release:

- the version in `package.json` goes up, and the lines in [docs/releases/pending.md](docs/releases/pending.md) move into that version's release notes in [docs/releases/](docs/releases/);
- the release commit is tagged `vX.Y.Z`;
- the release script, [scripts/make-windows-release.ps1](scripts/make-windows-release.ps1), runs the unit tests, builds the interface, smoke-tests the unpacked Windows app with its bundled Codex, and builds the installer with its update metadata;
- the Windows x64 installer, `Trebell-Code-Setup-X.Y.Z.exe`, is published with its release notes on [trebellcode-releases](https://github.com/tanishqbaweja/trebellcode-releases/releases), where the in-app updater finds it, and on this repository's releases page. An update installs only when the person chooses.

## Benchmark claims

Benchmark results are published in [BENCHMARKS.md](BENCHMARKS.md), and only under its rules:

- every harness in a comparison runs the same task and model, with equivalent reasoning settings;
- an independent verifier decides the result, not the agent;
- quality comes first: lower cost with a worse verifier result is not a win;
- the Native that is benchmarked is the Native the app ships, from one configuration, [`src/native-configuration.mjs`](src/native-configuration.mjs);
- Native improves only through general harness changes, never through fixes aimed at a benchmark's tasks or its hidden tests;
- a run made invalid by infrastructure is not headline evidence, and a task inspected while diagnosing a run is not reused as fresh evidence.

The maintainer decides which results are published.

## Changing this page

This page changes by pull request, like any other file, and the maintainer decides on it. If the project takes on more maintainers, this page will name their roles and say how decisions are made between them.
