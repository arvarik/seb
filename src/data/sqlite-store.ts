import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import Database from 'better-sqlite3';

const DATABASE_SCHEMA_VERSION = 3;
const DEFAULT_DATABASE_FILE = resolve(process.cwd(), '.cache/seb.sqlite');
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const MAX_PROVENANCE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_SNAPSHOT_BYTES = 512 * 1024 * 1024;
const DEFAULT_SNAPSHOT_LIMIT = 64;

export type CacheFreshness = 'fresh' | 'stale' | 'expired';

export interface CacheEntry<T> {
  cachedAt: string;
  checksum: string;
  etag: string | null;
  expiresAt: string;
  freshness: CacheFreshness;
  key: string;
  lastModified: string | null;
  namespace: string;
  schemaVersion: string;
  sourceUrl: string | null;
  staleUntil: string;
  value: T;
}

export interface CacheWrite<T> {
  cachedAt?: string;
  etag?: string | null;
  key: string;
  lastModified?: string | null;
  namespace: string;
  schemaVersion: string;
  sourceUrl?: string | null;
  staleIfErrorMs: number;
  ttlMs: number;
  value: T;
}

export interface SnapshotWrite<T> {
  asOf?: string;
  entityKey: string;
  kind: string;
  payload: T;
  provenance?: unknown;
  schemaVersion: string;
  sourceTimestamp?: string | null;
}

export interface SnapshotRecord<T = unknown> {
  asOf: string;
  checksum: string;
  createdAt: string;
  entityKey: string;
  id: string;
  kind: string;
  payload: T;
  provenance: unknown;
  provenanceChecksum: string;
  schemaVersion: string;
  sourceTimestamp: string | null;
}

export interface SnapshotMetadata {
  asOf: string;
  checksum: string;
  createdAt: string;
  entityKey: string;
  id: string;
  kind: string;
  payloadBytes: number;
  provenanceBytes: number;
  provenanceChecksum: string;
  schemaVersion: string;
  sourceTimestamp: string | null;
}

export interface DatabaseStatus {
  cacheEntries: number;
  cacheValueBytes: number;
  file: string;
  fileBytes: number;
  identities: number;
  identityLinks: number;
  schemaVersion: number;
  snapshotPayloadBytes: number;
  snapshotProvenanceBytes: number;
  snapshots: number;
}

export interface StoragePruneResult {
  after: DatabaseStatus;
  before: DatabaseStatus;
  cacheEntriesRemoved: number;
  snapshotsRemoved: number;
}

export interface IdentityWrite<T> {
  canonicalId: string;
  entityType: 'player' | 'team';
  sourceIdentities: readonly { id: string; provider: string }[];
  value: T;
}

export interface IdentityRecord<T = unknown> extends IdentityWrite<T> {
  checksum: string;
  updatedAt: string;
}

interface DatabaseRow {
  [column: string]: unknown;
}

export class SebDatabase {
  private readonly database: Database.Database;
  readonly file: string;

  constructor(file = DEFAULT_DATABASE_FILE) {
    this.file = resolve(file);
    const directory = dirname(this.file);
    const directoryExisted = existsSync(directory);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!directoryExisted || directory === dirname(DEFAULT_DATABASE_FILE)) {
      chmodSync(directory, 0o700);
    }
    this.database = new Database(this.file);
    chmodSync(this.file, 0o600);
    this.configure();
    this.migrate();
  }

  getCache<T>(namespace: string, key: string, now = new Date()): CacheEntry<T> | null {
    const row = this.database
      .prepare(`
        SELECT namespace, cache_key, value_json, cached_at, expires_at,
               stale_until, etag, last_modified, source_url, schema_version,
               checksum
        FROM cache_entries
        WHERE namespace = ? AND cache_key = ?
      `)
      .get(namespace, key) as DatabaseRow | undefined;
    if (!row) {
      return null;
    }

    const expiresAt = requiredText(row.expires_at);
    const staleUntil = requiredText(row.stale_until);
    const valueJson = requiredText(row.value_json);
    const checksum = requiredText(row.checksum);
    if (sha256(valueJson) !== checksum) {
      this.deleteCache(namespace, key);
      return null;
    }
    const nowMs = now.getTime();
    const freshness: CacheFreshness =
      nowMs < Date.parse(expiresAt)
        ? 'fresh'
        : nowMs <= Date.parse(staleUntil)
          ? 'stale'
          : 'expired';
    try {
      return {
        cachedAt: requiredText(row.cached_at),
        checksum,
        etag: optionalText(row.etag),
        expiresAt,
        freshness,
        key: requiredText(row.cache_key),
        lastModified: optionalText(row.last_modified),
        namespace: requiredText(row.namespace),
        schemaVersion: requiredText(row.schema_version),
        sourceUrl: optionalText(row.source_url),
        staleUntil,
        value: JSON.parse(valueJson) as T,
      };
    } catch {
      this.deleteCache(namespace, key);
      return null;
    }
  }

  putCache<T>(write: CacheWrite<T>): CacheEntry<T> {
    validateDuration(write.ttlMs, 'cache TTL');
    validateDuration(write.staleIfErrorMs, 'stale-if-error period');
    const cachedAt = write.cachedAt ?? new Date().toISOString();
    const cachedAtMs = Date.parse(cachedAt);
    if (!Number.isFinite(cachedAtMs)) {
      throw new TypeError('The cache retrieval time must use ISO 8601 format.');
    }
    const valueJson = stableJson(write.value);
    const checksum = sha256(valueJson);
    const expiresAt = new Date(cachedAtMs + write.ttlMs).toISOString();
    const staleUntil = new Date(
      cachedAtMs + write.ttlMs + write.staleIfErrorMs,
    ).toISOString();
    this.database
      .prepare(`
        INSERT INTO cache_entries (
          namespace, cache_key, value_json, cached_at, expires_at, stale_until,
          etag, last_modified, source_url, schema_version, checksum
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(namespace, cache_key) DO UPDATE SET
          value_json = excluded.value_json,
          cached_at = excluded.cached_at,
          expires_at = excluded.expires_at,
          stale_until = excluded.stale_until,
          etag = excluded.etag,
          last_modified = excluded.last_modified,
          source_url = excluded.source_url,
          schema_version = excluded.schema_version,
          checksum = excluded.checksum
      `)
      .run(
        write.namespace,
        write.key,
        valueJson,
        cachedAt,
        expiresAt,
        staleUntil,
        write.etag ?? null,
        write.lastModified ?? null,
        write.sourceUrl ?? null,
        write.schemaVersion,
        checksum,
      );
    const entry = this.getCache<T>(write.namespace, write.key, new Date(cachedAt));
    if (!entry) {
      throw new Error('Seb could not read the cache entry after it saved the entry.');
    }
    return entry;
  }

  touchCache(
    namespace: string,
    key: string,
    ttlMs: number,
    staleIfErrorMs: number,
    cachedAt = new Date().toISOString(),
  ): CacheEntry<unknown> | null {
    validateDuration(ttlMs, 'cache TTL');
    validateDuration(staleIfErrorMs, 'stale-if-error period');
    const cachedAtMs = Date.parse(cachedAt);
    this.database
      .prepare(`
        UPDATE cache_entries
        SET cached_at = ?, expires_at = ?, stale_until = ?
        WHERE namespace = ? AND cache_key = ?
      `)
      .run(
        cachedAt,
        new Date(cachedAtMs + ttlMs).toISOString(),
        new Date(cachedAtMs + ttlMs + staleIfErrorMs).toISOString(),
        namespace,
        key,
      );
    return this.getCache(namespace, key, new Date(cachedAt));
  }

  updateCachePolicy(
    namespace: string,
    key: string,
    cachedAt: string,
    checksum: string,
    ttlMs: number,
    staleIfErrorMs: number,
  ): boolean {
    validateDuration(ttlMs, 'cache TTL');
    validateDuration(staleIfErrorMs, 'stale-if-error period');
    const cachedAtMs = Date.parse(cachedAt);
    if (!Number.isFinite(cachedAtMs)) {
      throw new TypeError('The cache retrieval time must use ISO 8601 format.');
    }
    const result = this.database
      .prepare(`
        UPDATE cache_entries
        SET expires_at = ?, stale_until = ?
        WHERE namespace = ? AND cache_key = ?
          AND cached_at = ? AND checksum = ?
      `)
      .run(
        new Date(cachedAtMs + ttlMs).toISOString(),
        new Date(cachedAtMs + ttlMs + staleIfErrorMs).toISOString(),
        namespace,
        key,
        cachedAt,
        checksum,
      );
    return Number(result.changes) > 0;
  }

  deleteCache(namespace: string, key?: string): number {
    const result = key === undefined
      ? this.database.prepare('DELETE FROM cache_entries WHERE namespace = ?').run(namespace)
      : this.database
          .prepare('DELETE FROM cache_entries WHERE namespace = ? AND cache_key = ?')
          .run(namespace, key);
    return Number(result.changes);
  }

  deleteCachePrefix(namespace: string, keyPrefix: string): number {
    const escaped = keyPrefix.replace(/[\\%_]/g, (value) => `\\${value}`);
    const result = this.database
      .prepare(`DELETE FROM cache_entries WHERE namespace = ? AND cache_key LIKE ? ESCAPE '\\'`)
      .run(namespace, `${escaped}%`);
    return Number(result.changes);
  }

  createSnapshot<T>(write: SnapshotWrite<T>, retain = DEFAULT_SNAPSHOT_LIMIT): SnapshotRecord<T> {
    if (!Number.isInteger(retain) || retain < 1 || retain > 10_000) {
      throw new RangeError('The snapshot retention count must be from 1 through 10000.');
    }
    const payloadJson = stableJson(write.payload);
    if (Buffer.byteLength(payloadJson) > MAX_SNAPSHOT_BYTES) {
      throw new RangeError(`The snapshot exceeds ${MAX_SNAPSHOT_BYTES} bytes.`);
    }
    const provenanceJson = stableJson(write.provenance ?? null);
    if (Buffer.byteLength(provenanceJson) > MAX_PROVENANCE_BYTES) {
      throw new RangeError(`The snapshot provenance exceeds ${MAX_PROVENANCE_BYTES} bytes.`);
    }
    const id = randomUUID();
    const asOf = write.asOf ?? new Date().toISOString();
    const createdAt = new Date().toISOString();
    const checksum = sha256(payloadJson);
    const provenanceChecksum = sha256(provenanceJson);

    this.transaction(() => {
      this.database
        .prepare(`
          INSERT INTO snapshots (
            id, kind, entity_key, as_of, source_timestamp, payload_json,
            provenance_json, schema_version, checksum, created_at,
            provenance_checksum
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          id,
          write.kind,
          write.entityKey,
          asOf,
          write.sourceTimestamp ?? null,
          payloadJson,
          provenanceJson,
          write.schemaVersion,
          checksum,
          createdAt,
          provenanceChecksum,
        );
      this.database
        .prepare(`
          DELETE FROM snapshots
          WHERE id IN (
            SELECT id FROM snapshots
            WHERE kind = ? AND entity_key = ?
            ORDER BY as_of DESC, created_at DESC
            LIMIT -1 OFFSET ?
          )
        `)
        .run(write.kind, write.entityKey, retain);
      this.enforceSnapshotByteLimit(MAX_TOTAL_SNAPSHOT_BYTES);
    });

    return {
      asOf,
      checksum,
      createdAt,
      entityKey: write.entityKey,
      id,
      kind: write.kind,
      payload: write.payload,
      provenance: write.provenance ?? null,
      provenanceChecksum,
      schemaVersion: write.schemaVersion,
      sourceTimestamp: write.sourceTimestamp ?? null,
    };
  }

  getSnapshot<T>(id: string): SnapshotRecord<T> | null {
    const row = this.database
      .prepare('SELECT * FROM snapshots WHERE id = ?')
      .get(id) as DatabaseRow | undefined;
    return row ? parseSnapshot<T>(row) : null;
  }

  listSnapshots<T = unknown>(filter: {
    entityKey?: string;
    kind?: string;
    limit?: number;
  } = {}): SnapshotRecord<T>[] {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 1_000);
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (filter.kind) {
      clauses.push('kind = ?');
      values.push(filter.kind);
    }
    if (filter.entityKey) {
      clauses.push('entity_key = ?');
      values.push(filter.entityKey);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.database
      .prepare(`SELECT * FROM snapshots ${where} ORDER BY as_of DESC, created_at DESC LIMIT ?`)
      .all(...values, limit) as DatabaseRow[];
    return rows.map((row) => parseSnapshot<T>(row));
  }

  listSnapshotMetadata(filter: {
    entityKey?: string;
    kind?: string;
    limit?: number;
  } = {}): SnapshotMetadata[] {
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 1_000);
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (filter.kind) {
      clauses.push('kind = ?');
      values.push(filter.kind);
    }
    if (filter.entityKey) {
      clauses.push('entity_key = ?');
      values.push(filter.entityKey);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.database.prepare(`
      SELECT id, kind, entity_key, as_of, source_timestamp, schema_version,
             checksum, provenance_checksum, created_at,
             length(CAST(payload_json AS BLOB)) AS payload_bytes,
             length(CAST(provenance_json AS BLOB)) AS provenance_bytes
      FROM snapshots ${where}
      ORDER BY as_of DESC, created_at DESC
      LIMIT ?
    `).all(...values, limit) as DatabaseRow[];
    return rows.map(parseSnapshotMetadata);
  }

  deleteSnapshots(kind?: string, entityKey?: string): number {
    let result;
    if (kind && entityKey) {
      result = this.database
        .prepare('DELETE FROM snapshots WHERE kind = ? AND entity_key = ?')
        .run(kind, entityKey);
    } else if (kind) {
      result = this.database.prepare('DELETE FROM snapshots WHERE kind = ?').run(kind);
    } else {
      result = this.database.prepare('DELETE FROM snapshots').run();
    }
    return Number(result.changes);
  }

  putIdentity<T>(write: IdentityWrite<T>): IdentityRecord<T> {
    if (!write.canonicalId.trim()) throw new Error('The canonical identity ID is required.');
    if (write.sourceIdentities.length === 0) {
      throw new Error('A canonical identity needs at least one source identity.');
    }
    const links = uniqueSourceIdentities(write.sourceIdentities);
    let canonicalId = write.canonicalId;
    const existingIds = new Set<string>();
    for (const link of links) {
      const row = this.database
        .prepare(`
          SELECT canonical_id FROM identity_links
          WHERE entity_type = ? AND provider = ? AND source_id = ?
        `)
        .get(write.entityType, link.provider, link.id) as DatabaseRow | undefined;
      if (row) existingIds.add(requiredText(row.canonical_id));
    }
    if (existingIds.size > 1) {
      throw new Error('The source identities already map to conflicting canonical IDs.');
    }
    canonicalId = [...existingIds][0] ?? canonicalId;
    const priorLinks = this.database
      .prepare(`
        SELECT provider, source_id FROM identity_links
        WHERE entity_type = ? AND canonical_id = ?
      `)
      .all(write.entityType, canonicalId) as DatabaseRow[];
    const allLinks = uniqueSourceIdentities([
      ...links,
      ...priorLinks.map((link) => ({
        id: requiredText(link.source_id),
        provider: requiredText(link.provider),
      })),
    ]);
    const value = replaceIdentityFields(write.value, canonicalId, allLinks);
    const payloadJson = stableJson(value);
    const checksum = sha256(payloadJson);
    const updatedAt = new Date().toISOString();
    this.transaction(() => {
      this.database
        .prepare(`
          INSERT INTO identities (
            entity_type, canonical_id, payload_json, checksum, updated_at
          ) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(entity_type, canonical_id) DO UPDATE SET
            payload_json = excluded.payload_json,
            checksum = excluded.checksum,
            updated_at = excluded.updated_at
        `)
        .run(write.entityType, canonicalId, payloadJson, checksum, updatedAt);
      for (const link of allLinks) {
        this.database
          .prepare(`
            INSERT INTO identity_links (
              entity_type, provider, source_id, canonical_id, created_at
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(entity_type, provider, source_id) DO UPDATE SET
              canonical_id = excluded.canonical_id
          `)
          .run(
            write.entityType,
            link.provider,
            link.id,
            canonicalId,
            updatedAt,
          );
      }
    });
    return {
      canonicalId,
      checksum,
      entityType: write.entityType,
      sourceIdentities: allLinks,
      updatedAt,
      value,
    };
  }

  getIdentityBySource<T>(
    entityType: 'player' | 'team',
    provider: string,
    sourceId: string,
  ): IdentityRecord<T> | null {
    const row = this.database
      .prepare(`
        SELECT i.entity_type, i.canonical_id, i.payload_json, i.checksum, i.updated_at
        FROM identity_links l
        JOIN identities i
          ON i.entity_type = l.entity_type AND i.canonical_id = l.canonical_id
        WHERE l.entity_type = ? AND l.provider = ? AND l.source_id = ?
      `)
      .get(entityType, provider, sourceId) as DatabaseRow | undefined;
    return row ? this.parseIdentity<T>(row) : null;
  }

  getIdentity<T>(
    entityType: 'player' | 'team',
    canonicalId: string,
  ): IdentityRecord<T> | null {
    const row = this.database
      .prepare(`
        SELECT entity_type, canonical_id, payload_json, checksum, updated_at
        FROM identities WHERE entity_type = ? AND canonical_id = ?
      `)
      .get(entityType, canonicalId) as DatabaseRow | undefined;
    return row ? this.parseIdentity<T>(row) : null;
  }

  status(): DatabaseStatus {
    const cache = this.database.prepare(`
      SELECT COUNT(*) AS count,
             COALESCE(SUM(length(CAST(value_json AS BLOB))), 0) AS value_bytes
      FROM cache_entries
    `).get() as DatabaseRow;
    const snapshots = this.database.prepare(`
      SELECT COUNT(*) AS count,
             COALESCE(SUM(length(CAST(payload_json AS BLOB))), 0) AS payload_bytes,
             COALESCE(SUM(length(CAST(provenance_json AS BLOB))), 0) AS provenance_bytes
      FROM snapshots
    `).get() as DatabaseRow;
    const identities = this.database.prepare('SELECT COUNT(*) AS count FROM identities').get() as DatabaseRow;
    const identityLinks = this.database.prepare('SELECT COUNT(*) AS count FROM identity_links').get() as DatabaseRow;
    return {
      cacheEntries: Number(cache.count),
      cacheValueBytes: Number(cache.value_bytes),
      file: this.file,
      fileBytes: databaseFileBytes(this.file),
      identities: Number(identities.count),
      identityLinks: Number(identityLinks.count),
      schemaVersion: DATABASE_SCHEMA_VERSION,
      snapshotPayloadBytes: Number(snapshots.payload_bytes),
      snapshotProvenanceBytes: Number(snapshots.provenance_bytes),
      snapshots: Number(snapshots.count),
    };
  }

  pruneStorage(options: {
    maxBytes?: number;
    now?: Date;
    snapshotMaxAgeDays?: number;
    snapshotRetention?: number;
  } = {}): StoragePruneResult {
    const before = this.status();
    const now = options.now ?? new Date();
    const maxBytes = options.maxBytes ?? MAX_TOTAL_SNAPSHOT_BYTES;
    const snapshotMaxAgeDays = options.snapshotMaxAgeDays ?? 180;
    const snapshotRetention = options.snapshotRetention ?? 16;
    validateByteLimit(maxBytes);
    validateRetention(snapshotRetention);
    if (!Number.isFinite(snapshotMaxAgeDays) || snapshotMaxAgeDays < 1) {
      throw new RangeError('The snapshot maximum age must be at least one day.');
    }
    const cacheEntriesRemoved = Number(this.database
      .prepare('DELETE FROM cache_entries WHERE stale_until < ?')
      .run(now.toISOString()).changes);
    const cutoff = new Date(now.getTime() - snapshotMaxAgeDays * 24 * 60 * 60 * 1_000)
      .toISOString();
    let snapshotsRemoved = Number(this.database
      .prepare('DELETE FROM snapshots WHERE as_of < ?')
      .run(cutoff).changes);
    snapshotsRemoved += Number(this.database.prepare(`
      DELETE FROM snapshots
      WHERE id IN (
        SELECT id FROM (
          SELECT id,
                 ROW_NUMBER() OVER (
                   PARTITION BY kind, entity_key
                   ORDER BY as_of DESC, created_at DESC
                 ) AS row_number
          FROM snapshots
        )
        WHERE row_number > ?
      )
    `).run(snapshotRetention).changes);
    snapshotsRemoved += this.enforceSnapshotByteLimit(maxBytes);
    this.database.pragma('wal_checkpoint(TRUNCATE)');
    this.database.exec('VACUUM');
    return {
      after: this.status(),
      before,
      cacheEntriesRemoved,
      snapshotsRemoved,
    };
  }

  private parseIdentity<T>(row: DatabaseRow): IdentityRecord<T> {
    const entityType = requiredText(row.entity_type) as 'player' | 'team';
    const canonicalId = requiredText(row.canonical_id);
    const payloadJson = requiredText(row.payload_json);
    const checksum = requiredText(row.checksum);
    if (sha256(payloadJson) !== checksum) {
      throw new Error(`The canonical identity ${canonicalId} failed its checksum validation.`);
    }
    const links = this.database
      .prepare(`
        SELECT provider, source_id FROM identity_links
        WHERE entity_type = ? AND canonical_id = ?
        ORDER BY provider, source_id
      `)
      .all(entityType, canonicalId) as DatabaseRow[];
    return {
      canonicalId,
      checksum,
      entityType,
      sourceIdentities: links.map((link) => ({
        id: requiredText(link.source_id),
        provider: requiredText(link.provider),
      })),
      updatedAt: requiredText(row.updated_at),
      value: JSON.parse(payloadJson) as T,
    };
  }

  close(): void {
    this.database.close();
    if (sharedDatabases.get(this.file) === this) {
      sharedDatabases.delete(this.file);
    }
  }

  private configure(): void {
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      PRAGMA temp_store = MEMORY;
    `);
  }

  private migrate(): void {
    const versionRow = this.database
      .prepare('PRAGMA user_version')
      .get() as { user_version: number } | undefined;
    const version = Number(versionRow?.user_version ?? 0);
    if (version > DATABASE_SCHEMA_VERSION) {
      throw new Error(`The Seb database schema ${version} is newer than this application supports.`);
    }
    if (version < 1) {
      this.transaction(() => {
        this.database.exec(`
          CREATE TABLE IF NOT EXISTS cache_entries (
            namespace TEXT NOT NULL,
            cache_key TEXT NOT NULL,
            value_json TEXT NOT NULL,
            cached_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            stale_until TEXT NOT NULL,
            etag TEXT,
            last_modified TEXT,
            source_url TEXT,
            schema_version TEXT NOT NULL,
            checksum TEXT NOT NULL,
            PRIMARY KEY (namespace, cache_key)
          );
          CREATE INDEX IF NOT EXISTS cache_expiry_idx ON cache_entries(expires_at);
          CREATE TABLE IF NOT EXISTS snapshots (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL,
            entity_key TEXT NOT NULL,
            as_of TEXT NOT NULL,
            source_timestamp TEXT,
            payload_json TEXT NOT NULL,
            provenance_json TEXT NOT NULL,
            schema_version TEXT NOT NULL,
            checksum TEXT NOT NULL,
            created_at TEXT NOT NULL,
            provenance_checksum TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS snapshot_lookup_idx
            ON snapshots(kind, entity_key, as_of DESC);
          PRAGMA user_version = 1;
        `);
      });
    }
    if (version < 2) {
      this.transaction(() => {
        this.database.exec(`
          CREATE TABLE IF NOT EXISTS identities (
            entity_type TEXT NOT NULL CHECK(entity_type IN ('player', 'team')),
            canonical_id TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            checksum TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (entity_type, canonical_id)
          );
          CREATE TABLE IF NOT EXISTS identity_links (
            entity_type TEXT NOT NULL,
            provider TEXT NOT NULL,
            source_id TEXT NOT NULL,
            canonical_id TEXT NOT NULL,
            created_at TEXT NOT NULL,
            PRIMARY KEY (entity_type, provider, source_id),
            FOREIGN KEY (entity_type, canonical_id)
              REFERENCES identities(entity_type, canonical_id) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS identity_canonical_idx
            ON identity_links(entity_type, canonical_id);
          PRAGMA user_version = 2;
        `);
      });
    }
    if (version < 3) {
      this.transaction(() => {
        const columns = this.database
          .prepare('PRAGMA table_info(snapshots)')
          .all() as DatabaseRow[];
        if (!columns.some((column) => column.name === 'provenance_checksum')) {
          this.database.exec(
            "ALTER TABLE snapshots ADD COLUMN provenance_checksum TEXT NOT NULL DEFAULT ''",
          );
        }
        const rows = this.database
          .prepare('SELECT id, provenance_json FROM snapshots')
          .all() as DatabaseRow[];
        const update = this.database.prepare(
          'UPDATE snapshots SET provenance_checksum = ? WHERE id = ?',
        );
        for (const row of rows) {
          update.run(sha256(requiredText(row.provenance_json)), requiredText(row.id));
        }
        this.database.pragma('user_version = 3');
      });
    }
  }

  private transaction(run: () => void): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      run();
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private enforceSnapshotByteLimit(maxBytes: number): number {
    validateByteLimit(maxBytes);
    const size = this.database.prepare(`
      SELECT COALESCE(
        SUM(length(CAST(payload_json AS BLOB)) + length(CAST(provenance_json AS BLOB))),
        0
      ) AS bytes
      FROM snapshots
    `).get() as DatabaseRow;
    let total = Number(size.bytes);
    if (total <= maxBytes) return 0;
    const rows = this.database.prepare(`
      SELECT id,
             length(CAST(payload_json AS BLOB)) +
             length(CAST(provenance_json AS BLOB)) AS bytes
      FROM snapshots
      ORDER BY as_of ASC, created_at ASC
    `).all() as DatabaseRow[];
    let removed = 0;
    const remove = this.database.prepare('DELETE FROM snapshots WHERE id = ?');
    for (const row of rows) {
      if (total <= maxBytes) break;
      remove.run(requiredText(row.id));
      total -= Number(row.bytes);
      removed += 1;
    }
    return removed;
  }
}

const sharedDatabases = new Map<string, SebDatabase>();

export function getSharedSebDatabase(file = DEFAULT_DATABASE_FILE): SebDatabase {
  const path = resolve(file);
  const existing = sharedDatabases.get(path);
  if (existing) {
    return existing;
  }
  const database = new SebDatabase(path);
  sharedDatabases.set(path, database);
  return database;
}

export function defaultDatabaseFile(): string {
  return DEFAULT_DATABASE_FILE;
}

function parseSnapshot<T>(row: DatabaseRow): SnapshotRecord<T> {
  const payloadJson = requiredText(row.payload_json);
  const provenanceJson = requiredText(row.provenance_json);
  const checksum = requiredText(row.checksum);
  const provenanceChecksum = requiredText(row.provenance_checksum);
  if (sha256(payloadJson) !== checksum) {
    throw new Error(`The snapshot ${requiredText(row.id)} failed its checksum validation.`);
  }
  if (sha256(provenanceJson) !== provenanceChecksum) {
    throw new Error(`The snapshot ${requiredText(row.id)} failed its provenance checksum validation.`);
  }
  return {
    asOf: requiredText(row.as_of),
    checksum,
    createdAt: requiredText(row.created_at),
    entityKey: requiredText(row.entity_key),
    id: requiredText(row.id),
    kind: requiredText(row.kind),
    payload: JSON.parse(payloadJson) as T,
    provenance: JSON.parse(provenanceJson) as unknown,
    provenanceChecksum,
    schemaVersion: requiredText(row.schema_version),
    sourceTimestamp: optionalText(row.source_timestamp),
  };
}

function parseSnapshotMetadata(row: DatabaseRow): SnapshotMetadata {
  return {
    asOf: requiredText(row.as_of),
    checksum: requiredText(row.checksum),
    createdAt: requiredText(row.created_at),
    entityKey: requiredText(row.entity_key),
    id: requiredText(row.id),
    kind: requiredText(row.kind),
    payloadBytes: Number(row.payload_bytes),
    provenanceBytes: Number(row.provenance_bytes),
    provenanceChecksum: requiredText(row.provenance_checksum),
    schemaVersion: requiredText(row.schema_version),
    sourceTimestamp: optionalText(row.source_timestamp),
  };
}

function databaseFileBytes(file: string): number {
  return [file, `${file}-wal`, `${file}-shm`].reduce((total, path) => {
    try {
      return total + statSync(path).size;
    } catch {
      return total;
    }
  }, 0);
}

function validateByteLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError('The storage byte limit must be a positive safe integer.');
  }
}

function validateRetention(value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > 10_000) {
    throw new RangeError('The snapshot retention count must be from 1 through 10000.');
  }
}

function stableJson(value: unknown): string {
  const serialized = JSON.stringify(value, (_key, item: unknown) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      );
    }
    return item;
  });
  if (serialized === undefined) {
    throw new TypeError('Seb cannot store an undefined value.');
  }
  return serialized;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function requiredText(value: unknown): string {
  if (typeof value !== 'string') {
    throw new TypeError('The SQLite row contains an invalid text value.');
  }
  return value;
}

function optionalText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function validateDuration(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`The ${label} must be a nonnegative number.`);
  }
}

function uniqueSourceIdentities(
  values: readonly { id: string; provider: string }[],
): { id: string; provider: string }[] {
  const identities = new Map<string, { id: string; provider: string }>();
  for (const value of values) {
    const provider = value.provider.trim();
    const id = value.id.trim();
    if (!provider || !id) throw new Error('A source identity needs a provider and an ID.');
    identities.set(`${provider}\u0000${id}`, { provider, id });
  }
  return [...identities.values()].sort((left, right) =>
    left.provider.localeCompare(right.provider) || left.id.localeCompare(right.id),
  );
}

function replaceIdentityFields<T>(
  value: T,
  canonicalId: string,
  sourceIdentities: readonly { id: string; provider: string }[],
): T {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return {
      ...record,
      canonicalId,
      ...(Array.isArray(record.sourceIdentities)
        ? { sourceIdentities: sourceIdentities.map((identity) => ({ ...identity })) }
        : {}),
    } as T;
  }
  return value;
}
