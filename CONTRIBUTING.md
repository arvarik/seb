# Contributing to Seb

Seb is a read-only NFL and fantasy football assistant. Contributions use the [Apache-2.0 license](LICENSE).
Follow the [Code of Conduct](CODE_OF_CONDUCT.md). Send security reports through [SECURITY.md](SECURITY.md).

## Local setup

1. Install Node.js 22 or later and npm.
2. Fork the repository and clone your fork.
3. Run `npm ci` to install the locked dependencies.
4. Run `npm link` to add the local `seb` command.
5. Run `seb configure` for live model access. Unit tests use mocks and require no provider key.
6. Run `npm run doctor -- --offline` to check local configuration.

The native SQLite dependency can require a C++ compiler, Python, and platform build tools when npm cannot use a prebuilt binary.
See [SETUP.md](docs/SETUP.md) for provider configuration.

## Changes and tests

Create a branch from current `main`. Use `fix/`, `feat/`, `docs/`, or `chore/` plus a short description.
Use Conventional Commits, such as `fix(sleeper): filter the canonical player map`.
Add regression tests under `test/` for each bug fix. Keep tests deterministic and independent of live credentials.
Preserve source evidence, recommendation checks, cancellation, and credential privacy.

Run these commands before you open a pull request:

```bash
npm run check
npm run test:coverage
npm run doctor
```

`npm run check` checks version parity, lint, types, and tests. Coverage uses the thresholds in `vitest.config.ts`.
Doctor calls live services and can fail when a provider key or source is unavailable. State the exact result in the pull request.
Do not include keys, private league data, local databases, or raw provider errors in reports.

## Pull requests

1. Push your branch to your fork.
2. Open a pull request against `main` with the repository template.
3. Describe the problem, the resulting behavior, and the test results.
4. Wait for the Linux and macOS checks to pass.
5. Resolve review comments. A maintainer uses a squash merge after review.

Keep version values consistent across the package, lockfile, changelog, environment example, setup guide, and version guide.
Run `npm run version:check` after any version change.
