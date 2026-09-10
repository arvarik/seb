# Versioning and releases

Seb uses [Semantic Versioning](https://semver.org/) with the `MAJOR.MINOR.PATCH` format.

The current version is `1.0.2`.

## Supported public interfaces

Version 1 supports the commands and options in the [CLI guide](CLI.md).
It also supports the documented interactive commands and connector webhook routes.
JSON commands expose their schema versions. Consumers must ignore additional object fields.

Patch releases fix compatible behavior. Minor releases add compatible features or fields.
A major release changes an existing command or documented output contract incompatibly.

Model prose, provider catalogs, forecast values, news sources, and table layouts can change without a major version.
Internal TypeScript exports and SQLite tables do not form a stable library API.
Use the CLI JSON commands when integrating another program.

## Version sources

`package.json` contains the source version. The CLI reads it for `seb --version`.
Both root version fields in `package-lock.json` must match it.
`CHANGELOG.md` needs a dated heading for the same version.
The NWS examples in `.env.example` and `docs/SETUP.md` must use that version.
This guide must state the same current version.

Run `npm run version:check` to verify these requirements.

## Release names

Git tags use a lowercase `v` prefix. Version `1.0.0` uses the `v1.0.0` tag.
The GitHub release title must exactly match the tag, such as `v1.0.0`.
Use an annotated tag. Do not reuse or move a published tag.

Use a Conventional Commit subject for release preparation:

```text
chore(release): v1.0.0
```

## Prepare a release

1. Create a branch from current `main`.
2. Consolidate completed `Unreleased` notes into one dated version section.
3. Run `npm version 1.0.0 --no-git-tag-version` with the intended version.
4. Update the environment example, setup guide, and version guide to match.
5. Run the local checks:

   ```bash
   npm run check
   npm run test:coverage
   npm audit --omit=dev
   npm run doctor
   npm run contract:sources
   npm run contract:answer
   npm run news:smoke
   npm pack --dry-run
   ```

6. Inspect the package file list for credentials, caches, and unrelated files.
7. Verify a clean production install from the package archive.
8. Open a pull request with the changes and exact verification results.
9. Wait for every required Linux and macOS check to pass, then squash merge.
10. Sync local `main` and verify that its commit matches GitHub.
11. Create and push the annotated tag from that commit:

    ```bash
    git tag -a v1.0.0 -m "Release v1.0.0"
    git push origin v1.0.0
    ```

12. The automated [Release workflow](../.github/workflows/release.yml) triggers on the tag push to execute:
    - Verification: Runs `npm run version:check`, `lint`, `typecheck`, `test`, and `npm audit --omit=dev`.
    - Package archiving: Generates the npm release tarball (`arvarik-seb-*.tgz`).
    - npm registry: Publishes `@arvarik/seb` with cryptographic SLSA provenance (`--provenance`).
    - Container registry: Builds and publishes the Docker image to GitHub Container Registry (`ghcr.io/arvarik/seb`).
    - GitHub Release: Publishes the official GitHub release with notes generated from merged pull requests and the packaged tarball attached.
13. Verify the release on GitHub, npm, and GHCR.
