# Storage, cache, and snapshot guide

Seb uses one local SQLite database for source caches, historical snapshots, identities, and usage telemetry.

The default file is `.cache/seb.sqlite` under the current working directory.

Run Seb from a consistent directory when you want one shared local cache.

Run this command to confirm the active file.

```bash
seb cache status
```

The command also shows the schema version, byte sizes, and record counts.

The counts cover caches, snapshots, canonical identities, source links, usage runs, model steps, and tool calls.

Text output names `Canonical identities` and `Identity source links`.

JSON output uses `identities` and `identityLinks` for those counts.

## File security

Seb applies mode `0700` to the `.cache` directory on systems that support Unix permissions.

Seb creates the database with mode `0600`.

These modes restrict access to the current operating-system user.

The repository ignores `.cache/`.

Do not commit the database. It can contain league records and source responses.

## Model configuration files

Seb keeps model configuration outside the SQLite database.

The default configuration directory contains these files.

| File | Content |
| --- | --- |
| `profile.json` | The optional Sleeper username and update time. |
| `credentials.json` | Saved keys and the endpoint binding for an OpenAI-compatible key. |
| `model-settings.json` | The active provider, model IDs, fallback model IDs, and an optional compatible base URL. |

The default directory is `~/.config/seb`.

`SEB_CONFIG_HOME` or `XDG_CONFIG_HOME` can select another directory.

`SEB_PROFILE_FILE` can select the complete profile path. The two provider files stay beside that path.

`SEB_MODEL_SETTINGS_FILE` can select the complete model settings path.

Seb gives a newly created configuration directory mode `0700` on Unix systems.

Seb keeps the existing mode of a custom configuration directory.

It writes each file with mode `0600` and uses an atomic replacement.

Each provider file uses schema version `1` and has a 64 KiB limit.

One saved key has a 16 KiB limit. Model IDs have a 200-character limit.

The model settings file stores no key or authorization header.

The compatible base URL is not a secret. It can reveal a service hostname.

Do not commit any local configuration file.

Environment values override the corresponding saved credentials and settings.

Connector services read provider values from their environment only.

## SQLite configuration

Seb uses these SQLite settings.

- Write-ahead logging supports readers during a write.
- Normal synchronous mode reduces disk waits while it keeps transaction safety.
- Foreign-key checks remain active.
- A write waits up to five seconds for another writer.
- Temporary tables remain in memory.

Seb applies numbered schema migrations when it opens the database.

Version 1.0.0 uses database schema `6`.

Schema `6` rebuilds the usage tables as strict tables. It validates every saved row and preserves valid schema `5` telemetry.

Seb rejects external links to usage tables and unexpected usage indexes when it opens schema `6`.

Seb also rejects every database trigger because a cross-table trigger can change telemetry.

Schema `5` adds local usage runs, model steps, and tool calls.

Schema `4` added durable cache namespace generations.

Schema `3` added a checksum for each provenance manifest.

Schema `2` added canonical identities and provider source links.

Seb upgrades older database schemas with numbered transactions.

Seb stops when the database schema is newer than the application.

Upgrade Seb before you open a database from a newer release.

## Database tables

The database contains eight application tables.

| Table | Purpose |
| --- | --- |
| `cache_entries` | Stores normalized source values and freshness times. |
| `snapshots` | Stores historical source payloads and provenance. |
| `identities` | Stores canonical player and team records. |
| `identity_links` | Maps provider source IDs to canonical IDs. |
| `cache_generations` | Tracks durable cache namespace revisions. |
| `usage_runs` | Stores one local agent run and its final state. |
| `usage_steps` | Stores one logical AI SDK model step. |
| `usage_tool_calls` | Stores one client or provider tool call. |

The identity link table uses a foreign key to its canonical identity.

Deleting a canonical identity also deletes its source links.

Each identity payload has a SHA-256 checksum and update time.

Read the [identity guide](IDENTITIES.md) for stable canonical ID rules.

## Usage telemetry

Schema `6` stores local analytics in three strict, linked tables.

`usage_runs` stores the run identifier, session identifier, surface, agent kind, timestamps, status, finish reason, and bounded error category.

Terminal status can move from completed to failed or aborted.

It can also move from failed to aborted.

The database rejects a move in the opposite direction.

This rule preserves late AI SDK validation and cancellation callbacks.

The first terminal timestamp does not change during a status correction.

`usage_steps` stores the provider, model, finish state, token classes, latency, service tier, and grounding counts.

`usage_tool_calls` stores the tool identifier, tool name, execution location, outcome, duration, and dynamic flag.

One model step can own many tool-call records.

Foreign keys link model steps to runs and tool calls to model steps.

Deleting a run also deletes its model steps and tool calls.

Seb accepts at most 10,000,000,000 tokens in one stored metric.

Seb accepts at most 365 days for one stored duration.

Seb rejects larger, negative, or nonfinite values before each write.

Usage timestamps use canonical ISO 8601 UTC text. Seb rejects impossible calendar dates.

The database keeps an unavailable provider metric as `NULL`.

This rule preserves the difference between unknown usage and reported zero usage.

One model step represents one logical AI SDK call.

Provider HTTP retries can occur inside that call. Seb cannot count those retries from local events.

The tables store identifiers, timestamps, numeric metrics, and bounded categories.

They do not store prompts, answers, tool inputs, tool results, or raw errors.

They also exclude keys, authorization headers, and compatible endpoint URLs.

AI SDK DevTools stores complete content separately under `.devtools/` when a developer enables it.

## Cache records

Each cache record stores these values.

- A source namespace and cache key.
- The normalized source value.
- The retrieval, expiry, and stale-until times.
- The source URL.
- The source schema version.
- The `ETag` and `Last-Modified` validators when the source supplies them.
- A SHA-256 checksum of the stored value.

Seb deletes a cache record when its checksum or JSON value is invalid.

Seb ignores a cached value when its source schema version changes.

Seb also ignores a cached value when its source URL does not match the request.

Seb calculates freshness from the retrieval time and the current client policy.

This rule lets a policy update take effect without a database migration.

Seb writes the recalculated deadlines before a storage prune can delete the record.

## Freshness periods

The fresh period controls normal cache reads.

The stale period controls the backup window after a refresh error.

| Source value | Fresh period | Additional stale period |
| --- | ---: | ---: |
| Sleeper player catalog | 24 hours | 7 days |
| Sleeper trends and filtered players | 1 minute | 10 minutes |
| Sleeper matchups and transactions | 2 minutes | 1 day |
| Other Sleeper records | 5 minutes | 1 hour |
| nflverse schedules | 6 hours | 7 days |
| nflverse weekly statistics | 6 hours | 7 days |
| NWS point metadata | 7 days | 30 days |
| NWS hourly forecasts | 10 minutes | 6 hours |
| NWS active alerts | 2 minutes | 30 minutes |

Seb returns a fresh cache record without a network request.

Seb sends a conditional request after the fresh period ends.

A `304 Not Modified` response renews the cache times without replacing the value.

Seb uses an eligible stale record only after the refresh fails.

Seb never uses an expired record.

Seb never uses a stale record after the caller cancels the request.

The `/sources` command marks a stale fallback and shows the refresh error.

## Request resilience

Each source client uses a bounded request policy.

The default policy makes at most three attempts.

It retries status `408`, `425`, `429`, `500`, `502`, `503`, and `504`.

It also retries temporary network errors.

The delay uses exponential backoff with full jitter.

Seb honors a numeric or dated `Retry-After` value.

The maximum retry delay is five seconds.

A caller cancellation stops the active download and the retry delay.

The cancellation does not count as a source failure.

For nflverse, cancellation also stops file expansion and CSV parsing.

Five consecutive final failures open the client circuit for 30 seconds.

The circuit rejects new requests until that period ends.

Sleeper and NWS requests use a 15-second timeout.

nflverse requests use a 20-second timeout.

The doctor can use shorter source-specific limits.

Concurrent reads in one Seb process join one source refresh per database file.

Each caller waits with its own cancellation signal.

The shared refresh continues while another caller still waits for it.

Seb cancels the shared refresh when no callers remain.

One shared refresh writes one cache record and one source snapshot.

Each caller keeps its own eligible stale fallback when the shared refresh fails.

## Snapshots

Seb creates a snapshot after a successful source update.

It does not create a new snapshot after a fresh cache hit or a `304` response.

Each snapshot stores these values.

- A random snapshot ID.
- The snapshot kind and entity key.
- The snapshot and creation times.
- The source timestamp when one exists.
- The normalized source payload.
- The field-level provenance manifest.
- The source schema version.
- A SHA-256 payload checksum.
- A SHA-256 provenance checksum.

One snapshot cannot exceed 32 MiB.

One provenance manifest cannot exceed 32 MiB.

Seb keeps total snapshot payload and provenance data under 512 MiB.

Seb retains eight Sleeper player snapshots for the player catalog.

Seb retains eight nflverse schedule snapshots for the schedule key.

Seb retains four nflverse statistics snapshots for each season key.

Other Sleeper streams retain eight or sixteen records for each key.

NWS point streams retain eight records for each key.

NWS forecast and alert streams retain sixteen records for each key.

Snapshot creation errors do not hide a valid source response.

List recent snapshots.

```bash
seb snapshots
seb snapshots --kind nflverse-player-stats
seb snapshots --entity player-stats-v1-2025
seb snapshots --id SNAPSHOT_ID
seb snapshots --id SNAPSHOT_ID --json
seb snapshots --limit 100 --json
```

List mode returns snapshot metadata without source payloads.

The `--id` option shows freshness and the tracked field paths.

Add `--json` with `--id` to receive the complete provenance manifest.

Use `/snapshots` inside chat to list the latest 20 records.

Use `/provenance SNAPSHOT_ID` to inspect up to 50 field paths and source IDs.

## Cache maintenance

Show cache status.

```bash
seb cache status
seb cache status --json
```

Prune expired cache rows and old snapshots.

```bash
seb cache prune
seb cache prune --max-size-mb 256 --max-age-days 90 --retain 8
```

The default prune keeps sixteen snapshots per source key for 180 days.

The default snapshot size limit is 512 MiB.

The prune command checkpoints SQLite and runs `VACUUM`.

Clear source caches while you preserve every snapshot.

```bash
seb cache clear
```

The clear command also preserves canonical identities and source links.

Interactive refresh commands clear one source namespace.

```text
/refresh sleeper
/refresh nflverse
/refresh weather
/refresh all
```

The next source request downloads fresh data.

When a shared database closes, Seb removes it from the shared registry.

A later open creates a working database connection for the same file.

### Usage retention

Keep the latest 90 days and remove older usage runs.

```bash
seb stats prune
```

Select another retention period.

```bash
seb stats prune --retain-days 30
seb stats prune --retain-days 30 --json
seb stats prune --retain-days 30 --include-unfinished
```

The prune command deletes finished runs that started before the exclusive cutoff.

SQLite also deletes each matching model-step and tool-call record.

The default prune preserves unfinished runs. Another Seb process can still write to these rows.

Stop every other Seb process before you use `--include-unfinished`.

An active recorder can recreate its run after this command deletes the row.

Remove all saved usage telemetry.

```bash
seb stats clear
seb stats clear --json
seb stats clear --include-unfinished
```

The default clear command preserves unfinished runs. It deletes all other usage runs and their child records.

Use `--include-unfinished` to delete every usage run that exists during the command.

Stop every other Seb process first. An active recorder can recreate its run after deletion.

This option also removes stale rows from interrupted processes.

These commands act immediately. Back up the database first when you need the records.

The commands preserve source caches, snapshots, canonical identities, and source links.

`seb cache prune` does not delete usage telemetry.

## Migration from version 0.0.1

Version `0.0.1` stored the Sleeper player catalog in `.cache/sleeper/players-nfl.json`.

Some development builds stored other source values as JSON files under `.cache/`.

Version `0.0.10` does not import those JSON files.

It creates `.cache/seb.sqlite` and downloads each source again when necessary.

Use this migration sequence.

1. Upgrade the dependencies.

   ```bash
   npm install
   ```

2. Start Seb once to create the SQLite database.

   ```bash
   seb cache status
   ```

3. Confirm that public sources work.

   ```bash
   seb doctor
   ```

4. List old JSON cache files.

   ```bash
   find .cache -type f -name '*.json' -print
   ```

5. Remove only the old Seb JSON files after you inspect the list.

The old JSON files do not affect version `0.0.10` reads.

Do not delete `.cache/seb.sqlite` when you need the stored snapshots.

Deleting the database also deletes persistent identity mappings.

It also deletes all local usage telemetry.

## Recovery

Run `seb cache status` when the database does not open.

Check the directory and file permissions first.

Restore a database backup when you need historical snapshots.

Move an unreadable database to a safe backup path when snapshots do not matter.

Start Seb again to create a new database.

## Forecast learning

Seb stores optional football learning in `.cache/learning`, separately from source caches and usage telemetry.
Revisions use scoring-profile directories, content checksums, and a bounded correction history.
The override file controls whether future forecasts use learned or manual parameters.
Read the [learning storage guide](ANALYSIS.md#storage-and-privacy) before changing these files.
