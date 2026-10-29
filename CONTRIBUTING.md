# Contributing to Seb

Seb is a source-grounded, read-only NFL and fantasy football AI agent. All contributions are licensed under the [Apache-2.0 License](LICENSE). Please follow our [Code of Conduct](CODE_OF_CONDUCT.md) and report vulnerabilities through [SECURITY.md](SECURITY.md).

## Local Development Setup

1. Install **Node.js 22+** and `npm`.
2. Fork the repository, clone your fork, and install locked dependencies:
   ```bash
   npm ci
   npm link
   ```
3. Run `seb configure` if you want live model access (unit tests use deterministic mocks and require no API keys).
4. Verify your local setup offline:
   ```bash
   npm run doctor -- --offline
   ```

> [!NOTE]
> `better-sqlite3` uses prebuilt binaries on supported platforms, falling back to `node-gyp` (Python 3 + C++ toolchain) when a prebuilt binary is unavailable. See [docs/SETUP.md](docs/SETUP.md) for full setup details.

## Making Changes & Running Verification

Create a feature branch from `main` (`feat/...`, `fix/...`, `docs/...`, or `chore/...`) and use Conventional Commits (for example, `fix(sleeper): filter canonical player map`).

- Add deterministic regression tests under `test/` for every bug fix or behavioral change.
- Preserve source provenance, Decision Gate verification, `AbortSignal` cancellation, and credential privacy.
- Run the full CI verification suite locally before opening a pull request:

```bash
npm run version:check
npm run lint
npm run typecheck
npm run test:coverage
npm audit --omit=dev
```

Optionally run `npm run doctor` when live provider credentials and public APIs are reachable, and note the result in your pull request description. Never commit or paste API keys, `.cache/` databases, private league exports, or raw provider errors.

## Pull Requests & Versioning

1. Push your branch to your fork and open a pull request against `main` using the repository template.
2. Summarize the root cause, user-visible behavior change, and local verification results.
3. Ensure both `ubuntu-latest` and `macos-latest` GitHub Actions CI checks pass before squash merge.

When bumping the release version, keep version strings synchronized across `package.json`, `package-lock.json`, `CHANGELOG.md`, `.env.example`, `docs/SETUP.md`, `docs/VERSIONING.md`, `docs/DATA_SOURCES.md`, and the `README.md` badge, then verify with `npm run version:check`. GitHub releases must always be titled in exact `vX.Y.Z` format (for example, `v1.1.2`).
