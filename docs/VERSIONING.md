# Versioning and releases

Seb uses [Semantic Versioning](https://semver.org/) with the `MAJOR.MINOR.PATCH` format.

The current version is `0.0.3`.

## Version meaning

Seb uses these version rules.

| Version part | Meaning |
| --- | --- |
| `PATCH` | Adds a compatible fix, documentation change, or small internal improvement. |
| `MINOR` | Adds a compatible user feature or a substantial capability. |
| `MAJOR` | Changes a stable public interface in an incompatible way. |

Versions below `1.0.0` describe development releases. A development release can still change an interface when the release notes identify the change.

The `0.0.x` series covers the first experimental releases. The `0.x.y` series starts when the command and connector interfaces become more stable.

Version `1.0.0` starts after Seb has a documented and supported public interface.

## Version sources

`package.json` contains the source version.

`package-lock.json` must contain the same version in both root version fields.

`CHANGELOG.md` must contain a dated heading for the source version.

The `npm run version:check` command verifies these requirements.

The CLI reads the version from `package.json`.

```bash
seb --version
```

## Release names

Git tags use a lowercase `v` prefix. Version `0.0.3` uses the `v0.0.3` tag.

Release commit subjects use this format.

```text
chore(release): v0.0.3
```

## Prepare a release

Complete these steps from a clean branch.

1. Move completed notes from `Unreleased` into a dated version section.
2. Update the package files without creating a tag.

   ```bash
   npm version 0.0.3 --no-git-tag-version
   ```

3. Run all checks.

   ```bash
   npm run check
   npm run deps:check
   npm audit
   ```

4. Commit the release with the documented subject format.
5. Put the release commit on `main` through the selected repository workflow.
6. Create the matching Git tag from the final release commit.
7. Push the tag after the release commit exists on GitHub.

Do not reuse or move a published version tag.

## Release guarantees

The `main` branch must pass the version check, the type check, and all tests.

Each release must include a changelog section.

Each release tag must point to the commit that contains the matching package version.

The project does not publish an npm package yet. The version identifies the source and the command output.
