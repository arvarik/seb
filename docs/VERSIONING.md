# Versioning and releases

Seb uses [Semantic Versioning](https://semver.org/) with the `MAJOR.MINOR.PATCH` format.

The current version is `1.0.0`.

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
11. Create and push the annotated tag from that commit.
12. Verify that the remote tag resolves to the same commit.
13. Create a GitHub release with the exact tag as its title and clear release notes.
14. Verify the release name, tag, and final commit.

Live model checks require credentials and can incur provider charges.
News and source checks depend on external service availability. Record failures and investigate their cause before release.
`npm run deps:check` reports newer dependencies. It does not require an upgrade to every new major version.

The project does not publish an npm registry package yet. Users install the source from GitHub.
A release does not change repository visibility or publish a registry package.
