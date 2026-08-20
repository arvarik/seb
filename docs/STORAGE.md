# Storage, cache, and snapshot guide

Seb uses one local SQLite database for source caches and historical snapshots.

The default file is `.cache/seb.sqlite` under the current working directory.

Run Seb from a consistent directory when you want one shared local cache.

Run this command to confirm the active file.

```bash
seb cache status
```

The command also shows the schema version and record counts.

The counts cover caches, snapshots, canonical identities, and source links.

Text output names `Canonical identities` and `Identity source links`.

JSON output uses `identities` and `identityLinks` for those counts.

## File security

Seb creates the `.cache` directory with mode `0700` on systems that support Unix permissions.

Seb creates the database with mode `0600`.

These modes restrict access to the current operating-system user.

The repository ignores `.cache/`.

Do not commit the database. It can contain league records and source responses.

## SQLite configuration

Seb uses these SQLite settings.

- Write-ahead logging supports readers during a write.
- Normal synchronous mode reduces disk waits while it keeps transaction safety.
- Foreign-key checks remain active.
- A write waits up to five seconds for another writer.
- Temporary tables remain in memory.

Seb applies numbered schema migrations when it opens the database.

Version `0.0.2` uses database schema `2`.

Schema `2` adds canonical identities and provider source links.

Seb upgrades a schema `1` database inside one transaction.

Seb stops when the database schema is newer than the application.

Upgrade Seb before you open a database from a newer release.

## Database tables

The database contains four primary tables.

| Table | Purpose |
| --- | --- |
| `cache_entries` | Stores normalized source values and freshness times. |
| `snapshots` | Stores historical source payloads and provenance. |
| `identities` | Stores canonical player and team records. |
| `identity_links` | Maps provider source IDs to canonical IDs. |

The identity link table uses a foreign key to its canonical identity.

Deleting a canonical identity also deletes its source links.

Each identity payload has a SHA-256 checksum and update time.

Read the [identity guide](IDENTITIES.md) for stable canonical ID rules.

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

The `/sources` command marks a stale fallback and shows the refresh error.

## Request resilience

Each source client uses a bounded request policy.

The default policy makes at most three attempts.

It retries status `408`, `425`, `429`, `500`, `502`, `503`, and `504`.

It also retries temporary network errors.

The delay uses exponential backoff with full jitter.

Seb honors a numeric or dated `Retry-After` value.

The maximum retry delay is five seconds.

Five consecutive final failures open the client circuit for 30 seconds.

The circuit rejects new requests until that period ends.

Sleeper and NWS requests use a 15-second timeout.

nflverse requests use a 20-second timeout.

The doctor can use shorter source-specific limits.

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

One snapshot cannot exceed 32 MiB.

Seb retains eight Sleeper player snapshots for the player catalog.

Seb retains eight nflverse schedule snapshots for the schedule key.

Seb retains four nflverse statistics snapshots for each season key.

Other snapshot streams retain up to 64 records for each kind and entity key.

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

## Migration from version 0.0.1

Version `0.0.1` stored the Sleeper player catalog in `.cache/sleeper/players-nfl.json`.

Some development builds stored other source values as JSON files under `.cache/`.

Version `0.0.2` does not import those JSON files.

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

The old JSON files do not affect version `0.0.2` reads.

Do not delete `.cache/seb.sqlite` when you need the stored snapshots.

Deleting the database also deletes persistent identity mappings.

## Recovery

Run `seb cache status` when the database does not open.

Check the directory and file permissions first.

Restore a database backup when you need historical snapshots.

Move an unreadable database to a safe backup path when snapshots do not matter.

Start Seb again to create a new database.
