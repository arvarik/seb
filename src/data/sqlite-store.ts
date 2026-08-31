import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import Database from 'better-sqlite3';

import {
  MAX_USAGE_DURATION_MS,
  MAX_USAGE_TOKEN_COUNT,
  type UsageDataset,
  type UsageQuery,
  type UsageRunFinishWrite,
  type UsageRunRecord,
  type UsageRunStatus,
  type UsageRunWrite,
  type UsageStepRecord,
  type UsageStepWrite,
  type UsageToolCallRecord,
  type UsageToolCallWrite,
  type UsageToolExecutionLocation,
  type UsageToolOutcome,
} from '../usage/types.js';

export type {
  UsageDataset,
  UsageQuery,
  UsageRunFinishWrite,
  UsageRunRecord,
  UsageRunStatus,
  UsageRunWrite,
  UsageStepRecord,
  UsageStepWrite,
  UsageToolCallRecord,
  UsageToolCallWrite,
  UsageToolExecutionLocation,
  UsageToolOutcome,
} from '../usage/types.js';

const DATABASE_SCHEMA_VERSION = 6;
const DEFAULT_DATABASE_FILE = resolve(process.cwd(), '.cache/seb.sqlite');
const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;
const MAX_PROVENANCE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_SNAPSHOT_BYTES = 512 * 1024 * 1024;
const DEFAULT_SNAPSHOT_LIMIT = 64;
const DEFAULT_USAGE_QUERY_LIMIT = 10_000;
const MAX_USAGE_QUERY_LIMIT = 50_000;

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

type CacheRenewalCondition = Pick<
  CacheEntry<unknown>,
  'cachedAt' | 'checksum' | 'schemaVersion' | 'sourceUrl'
>;

interface CacheRevisionCondition {
  namespace: string;
  revision: number;
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
  usageRuns: number;
  usageSteps: number;
  usageToolCalls: number;
}

export interface UsageDeleteResult {
  removed: number;
  unfinishedPreserved: number;
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
    try {
      this.configure();
      this.migrate();
    } catch (error) {
      this.database.close();
      throw error;
    }
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

    try {
      return parseCacheEntry<T>(row, now);
    } catch {
      this.deleteCache(namespace, key);
      return null;
    }
  }

  putCache<T>(write: CacheWrite<T>): CacheEntry<T>;
  putCache<T>(write: CacheWrite<T>, expectedRevision: number): CacheEntry<T> | null;
  putCache<T>(
    write: CacheWrite<T>,
    expectedRevision?: number,
  ): CacheEntry<T> | null {
    validateDuration(write.ttlMs, 'cache TTL');
    validateDuration(write.staleIfErrorMs, 'stale-if-error period');
    if (expectedRevision !== undefined) validateCacheRevision(expectedRevision);
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
    const revisionSql = expectedRevision === undefined
      ? ''
      : `
          WHERE EXISTS (
            SELECT 1 FROM cache_generations
            WHERE namespace = ? AND revision = ?
          )
        `;
    const row = this.database
      .prepare(`
        INSERT INTO cache_entries (
          namespace, cache_key, value_json, cached_at, expires_at, stale_until,
          etag, last_modified, source_url, schema_version, checksum
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        ${revisionSql}
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
        RETURNING namespace, cache_key, value_json, cached_at, expires_at,
                  stale_until, etag, last_modified, source_url, schema_version,
                  checksum
      `)
      .get(
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
        ...(expectedRevision === undefined
          ? []
          : [write.namespace, expectedRevision]),
      ) as DatabaseRow | undefined;
    if (!row && expectedRevision === undefined) {
      throw new Error('Seb could not read the cache entry after it saved the entry.');
    }
    return row ? parseCacheEntry<T>(row, new Date(cachedAt)) : null;
  }

  touchCache(
    namespace: string,
    key: string,
    ttlMs: number,
    staleIfErrorMs: number,
    cachedAt = new Date().toISOString(),
    condition?: CacheRenewalCondition,
    expectedRevision?: number,
  ): CacheEntry<unknown> | null {
    return this.touchCacheRow(
      namespace,
      key,
      ttlMs,
      staleIfErrorMs,
      cachedAt,
      condition,
      expectedRevision,
    );
  }

  cacheRevision(namespace: string): number {
    const existing = this.database.prepare(`
      SELECT revision FROM cache_generations
      WHERE namespace = ?
    `).get(namespace) as DatabaseRow | undefined;
    if (existing) {
      const revision = Number(existing.revision);
      validateCacheRevision(revision);
      return revision;
    }
    this.database.prepare(`
      INSERT INTO cache_generations (namespace, revision)
      VALUES (?, 0)
      ON CONFLICT(namespace) DO NOTHING
    `).run(namespace);
    const row = this.database.prepare(`
      SELECT revision FROM cache_generations
      WHERE namespace = ?
    `).get(namespace) as DatabaseRow | undefined;
    const revision = Number(row?.revision);
    validateCacheRevision(revision);
    return revision;
  }

  private touchCacheRow(
    namespace: string,
    key: string,
    ttlMs: number,
    staleIfErrorMs: number,
    cachedAt: string,
    condition?: CacheRenewalCondition,
    expectedRevision?: number,
  ): CacheEntry<unknown> | null {
    validateDuration(ttlMs, 'cache TTL');
    validateDuration(staleIfErrorMs, 'stale-if-error period');
    if (expectedRevision !== undefined) validateCacheRevision(expectedRevision);
    const cachedAtMs = Date.parse(cachedAt);
    if (!Number.isFinite(cachedAtMs)) {
      throw new TypeError('The cache retrieval time must use ISO 8601 format.');
    }
    const conditionSql = condition
      ? `
          AND cached_at = ?
          AND checksum = ?
          AND source_url IS ?
          AND schema_version = ?
        `
      : '';
    const revisionSql = expectedRevision === undefined
      ? ''
      : `
          AND EXISTS (
            SELECT 1 FROM cache_generations
            WHERE namespace = ? AND revision = ?
          )
        `;
    const row = this.database
      .prepare(`
        UPDATE cache_entries
        SET cached_at = ?, expires_at = ?, stale_until = ?
        WHERE namespace = ? AND cache_key = ?
        ${conditionSql}
        ${revisionSql}
        RETURNING namespace, cache_key, value_json, cached_at, expires_at,
                  stale_until, etag, last_modified, source_url, schema_version,
                  checksum
      `)
      .get(
        cachedAt,
        new Date(cachedAtMs + ttlMs).toISOString(),
        new Date(cachedAtMs + ttlMs + staleIfErrorMs).toISOString(),
        namespace,
        key,
        ...(condition
          ? [
              condition.cachedAt,
              condition.checksum,
              condition.sourceUrl,
              condition.schemaVersion,
            ]
          : []),
        ...(expectedRevision === undefined
          ? []
          : [namespace, expectedRevision]),
      ) as DatabaseRow | undefined;
    if (!row) return null;
    try {
      return parseCacheEntry(row, new Date(cachedAt));
    } catch {
      this.database
        .prepare(`
          DELETE FROM cache_entries
          WHERE namespace = ? AND cache_key = ? AND cached_at = ? AND checksum = ?
        `)
        .run(
          namespace,
          key,
          cachedAt,
          requiredText(row.checksum),
        );
      return null;
    }
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
    return this.transaction(() => {
      this.database.prepare(`
        INSERT INTO cache_generations (namespace, revision)
        VALUES (?, 1)
        ON CONFLICT(namespace) DO UPDATE SET revision = revision + 1
      `).run(namespace);
      const result = key === undefined
        ? this.database.prepare('DELETE FROM cache_entries WHERE namespace = ?').run(namespace)
        : this.database
            .prepare('DELETE FROM cache_entries WHERE namespace = ? AND cache_key = ?')
            .run(namespace, key);
      return Number(result.changes);
    });
  }

  deleteCachePrefix(namespace: string, keyPrefix: string): number {
    const escaped = keyPrefix.replace(/[\\%_]/g, (value) => `\\${value}`);
    return this.transaction(() => {
      this.database.prepare(`
        INSERT INTO cache_generations (namespace, revision)
        VALUES (?, 1)
        ON CONFLICT(namespace) DO UPDATE SET revision = revision + 1
      `).run(namespace);
      const result = this.database
        .prepare(`DELETE FROM cache_entries WHERE namespace = ? AND cache_key LIKE ? ESCAPE '\\'`)
        .run(namespace, `${escaped}%`);
      return Number(result.changes);
    });
  }

  createSnapshot<T>(
    write: SnapshotWrite<T>,
    retain?: number,
  ): SnapshotRecord<T>;
  createSnapshot<T>(
    write: SnapshotWrite<T>,
    retain: number | undefined,
    cacheCondition: CacheRevisionCondition,
  ): SnapshotRecord<T> | null;
  createSnapshot<T>(
    write: SnapshotWrite<T>,
    retain = DEFAULT_SNAPSHOT_LIMIT,
    cacheCondition?: CacheRevisionCondition,
  ): SnapshotRecord<T> | null {
    if (!Number.isInteger(retain) || retain < 1 || retain > 10_000) {
      throw new RangeError('The snapshot retention count must be from 1 through 10000.');
    }
    if (cacheCondition) validateCacheRevision(cacheCondition.revision);
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

    const stored = this.transaction(() => {
      if (
        cacheCondition &&
        !this.cacheRevisionMatches(cacheCondition)
      ) {
        return false;
      }
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
      return true;
    });

    if (!stored) return null;

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

  startUsageRun(write: UsageRunWrite): UsageRunRecord {
    const callId = normalizeUsageIdentifier(write.callId, 'usage call ID', 512);
    const sessionId = normalizeUsageIdentifier(write.sessionId, 'usage session ID', 512);
    const surface = normalizeUsageCode(write.surface, 'usage surface', 128);
    const agentKind = normalizeUsageCode(write.agentKind, 'usage agent kind', 128);
    const suppliedStartedAt = write.startedAt === undefined
      ? null
      : normalizeUsageTimestamp(write.startedAt, 'usage start time');

    this.database.prepare(`
      INSERT INTO usage_runs (
        call_id, session_id, surface, agent_kind, started_at, status
      ) VALUES (?, ?, ?, ?, ?, 'running')
      ON CONFLICT(call_id) DO NOTHING
    `).run(
      callId,
      sessionId,
      surface,
      agentKind,
      suppliedStartedAt ?? new Date().toISOString(),
    );

    const row = this.database
      .prepare('SELECT * FROM usage_runs WHERE call_id = ?')
      .get(callId) as DatabaseRow | undefined;
    if (!row) {
      throw new Error('Seb could not read the usage run after it saved the run.');
    }
    const record = parseUsageRun(row);
    if (
      record.sessionId !== sessionId ||
      record.surface !== surface ||
      record.agentKind !== agentKind ||
      (suppliedStartedAt !== null && record.startedAt !== suppliedStartedAt)
    ) {
      throw new Error(`The usage call ID ${callId} already has different run metadata.`);
    }
    return record;
  }

  putUsageStep(write: UsageStepWrite): UsageStepRecord {
    const incoming = normalizeUsageStepWrite(write);
    return this.transaction(() => {
      const run = this.database
        .prepare('SELECT 1 FROM usage_runs WHERE call_id = ?')
        .get(incoming.callId);
      if (!run) {
        throw new Error(`The usage run ${incoming.callId} does not exist.`);
      }
      const row = this.database.prepare(`
        SELECT * FROM usage_steps
        WHERE call_id = ? AND step_number = ?
      `).get(incoming.callId, incoming.stepNumber) as DatabaseRow | undefined;
      const record = row
        ? mergeUsageStep(parseUsageStep(row), incoming)
        : incoming;
      this.database.prepare(`
        INSERT INTO usage_steps (
          call_id, step_number, provider, model_id, finish_reason,
          raw_finish_reason, input_tokens, no_cache_input_tokens,
          cache_read_input_tokens, cache_write_input_tokens, output_tokens,
          text_tokens, reasoning_tokens, total_tokens, provider_total_tokens,
          tool_use_tokens, response_time_ms, time_to_first_output_ms,
          step_time_ms, service_tier, grounding_counts_json
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
        ON CONFLICT(call_id, step_number) DO UPDATE SET
          finish_reason = excluded.finish_reason,
          raw_finish_reason = excluded.raw_finish_reason,
          input_tokens = excluded.input_tokens,
          no_cache_input_tokens = excluded.no_cache_input_tokens,
          cache_read_input_tokens = excluded.cache_read_input_tokens,
          cache_write_input_tokens = excluded.cache_write_input_tokens,
          output_tokens = excluded.output_tokens,
          text_tokens = excluded.text_tokens,
          reasoning_tokens = excluded.reasoning_tokens,
          total_tokens = excluded.total_tokens,
          provider_total_tokens = excluded.provider_total_tokens,
          tool_use_tokens = excluded.tool_use_tokens,
          response_time_ms = excluded.response_time_ms,
          time_to_first_output_ms = excluded.time_to_first_output_ms,
          step_time_ms = excluded.step_time_ms,
          service_tier = excluded.service_tier,
          grounding_counts_json = excluded.grounding_counts_json
      `).run(...usageStepValues(record));
      return record;
    });
  }

  putUsageToolCall(write: UsageToolCallWrite): UsageToolCallRecord {
    const incoming = normalizeUsageToolCallWrite(write);
    return this.transaction(() => {
      const step = this.database.prepare(`
        SELECT 1 FROM usage_steps
        WHERE call_id = ? AND step_number = ?
      `).get(incoming.callId, incoming.stepNumber);
      if (!step) {
        throw new Error(
          `The usage step ${incoming.callId}:${incoming.stepNumber} does not exist.`,
        );
      }
      const row = this.database.prepare(`
        SELECT * FROM usage_tool_calls
        WHERE call_id = ? AND step_number = ? AND tool_call_id = ?
      `).get(
        incoming.callId,
        incoming.stepNumber,
        incoming.toolCallId,
      ) as DatabaseRow | undefined;
      const record = row
        ? mergeUsageToolCall(parseUsageToolCall(row), incoming)
        : incoming;
      this.database.prepare(`
        INSERT INTO usage_tool_calls (
          call_id, step_number, tool_call_id, tool_name, execution_location,
          outcome, execution_ms, dynamic
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(call_id, step_number, tool_call_id) DO UPDATE SET
          outcome = excluded.outcome,
          execution_ms = excluded.execution_ms,
          dynamic = excluded.dynamic
      `).run(
        record.callId,
        record.stepNumber,
        record.toolCallId,
        record.toolName,
        record.executionLocation,
        record.outcome,
        record.executionMs,
        record.dynamic === null ? null : Number(record.dynamic),
      );
      return record;
    });
  }

  finishUsageRun(callIdValue: string, write: UsageRunFinishWrite): UsageRunRecord {
    const callId = normalizeUsageIdentifier(callIdValue, 'usage call ID', 512);
    const status = normalizeUsageFinalStatus(write.status);
    const suppliedEndedAt = write.endedAt === undefined
      ? null
      : normalizeUsageTimestamp(write.endedAt, 'usage end time');
    const finalFinishReason = normalizeOptionalUsageCode(
      write.finalFinishReason,
      'usage finish reason',
      128,
    );
    const errorKind = normalizeOptionalUsageCode(
      write.errorKind,
      'usage error kind',
      128,
    );

    return this.transaction(() => {
      const row = this.database
        .prepare('SELECT * FROM usage_runs WHERE call_id = ?')
        .get(callId) as DatabaseRow | undefined;
      if (!row) throw new Error(`The usage run ${callId} does not exist.`);
      const current = parseUsageRun(row);
      const correctsTerminalStatus = current.status !== 'running' &&
        current.status !== status &&
        usageTerminalStatusRank(status) > usageTerminalStatusRank(current.status);
      if (
        current.status !== 'running' &&
        current.status !== status &&
        !correctsTerminalStatus
      ) {
        throw new Error(
          `The usage run ${callId} already has the final status ${current.status}.`,
        );
      }
      if (
        !correctsTerminalStatus &&
        current.endedAt !== null &&
        suppliedEndedAt !== null &&
        current.endedAt !== suppliedEndedAt
      ) {
        throw new Error(`The usage run ${callId} already has a different end time.`);
      }
      const endedAt = current.endedAt ?? suppliedEndedAt ?? new Date().toISOString();
      if (Date.parse(endedAt) < Date.parse(current.startedAt)) {
        throw new RangeError('The usage end time must not occur before the start time.');
      }
      const mergedFinishReason = correctsTerminalStatus
        ? finalFinishReason
        : mergeNullableUsageValue(
            current.finalFinishReason,
            finalFinishReason,
            'usage finish reason',
          );
      const mergedErrorKind = correctsTerminalStatus
        ? errorKind
        : mergeNullableUsageValue(
            current.errorKind,
            errorKind,
            'usage error kind',
          );
      this.database.prepare(`
        UPDATE usage_runs
        SET ended_at = ?, status = ?, final_finish_reason = ?, error_kind = ?
        WHERE call_id = ?
      `).run(endedAt, status, mergedFinishReason, mergedErrorKind, callId);
      const saved = this.database
        .prepare('SELECT * FROM usage_runs WHERE call_id = ?')
        .get(callId) as DatabaseRow | undefined;
      if (!saved) throw new Error(`The usage run ${callId} disappeared during its update.`);
      return parseUsageRun(saved);
    });
  }

  readUsageDataset(query: UsageQuery = {}): UsageDataset {
    const limit = normalizeUsageQueryLimit(query.limit);
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (query.sessionId !== undefined) {
      clauses.push('session_id = ?');
      values.push(normalizeUsageIdentifier(query.sessionId, 'usage session ID', 512));
    }
    const since = query.since === undefined
      ? null
      : normalizeUsageTimestamp(query.since, 'usage query start time');
    const until = query.until === undefined
      ? null
      : normalizeUsageTimestamp(query.until, 'usage query end time');
    if (since !== null) {
      clauses.push('started_at >= ?');
      values.push(since);
    }
    if (until !== null) {
      clauses.push('started_at < ?');
      values.push(until);
    }
    if (since !== null && until !== null && since > until) {
      throw new RangeError('The usage query start time must not occur after its end time.');
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.readTransaction(() => {
      const selectedRows = this.database.prepare(`
        SELECT * FROM usage_runs
        ${where}
        ORDER BY started_at DESC, call_id DESC
        LIMIT ?
      `).all(...values, limit + 1) as DatabaseRow[];
      const truncated = selectedRows.length > limit;
      const runs = selectedRows
        .slice(0, limit)
        .map(parseUsageRun)
        .reverse();
      if (runs.length === 0) {
        return { runs, steps: [], toolCalls: [], truncated };
      }
      const selectedRunCte = `
        SELECT call_id, started_at FROM usage_runs
        ${where}
        ORDER BY started_at DESC, call_id DESC
        LIMIT ?
      `;
      const stepRows = this.database.prepare(`
        WITH selected_runs AS (${selectedRunCte})
        SELECT usage_steps.*
        FROM usage_steps
        JOIN selected_runs USING (call_id)
        ORDER BY selected_runs.started_at, usage_steps.call_id,
                 usage_steps.step_number
      `).all(...values, limit) as DatabaseRow[];
      const toolRows = this.database.prepare(`
        WITH selected_runs AS (${selectedRunCte})
        SELECT usage_tool_calls.*
        FROM usage_tool_calls
        JOIN selected_runs USING (call_id)
        ORDER BY selected_runs.started_at, usage_tool_calls.call_id,
                 usage_tool_calls.step_number, usage_tool_calls.tool_call_id
      `).all(...values, limit) as DatabaseRow[];
      return {
        runs,
        steps: stepRows.map(parseUsageStep),
        toolCalls: toolRows.map(parseUsageToolCall),
        truncated,
      };
    });
  }

  clearUsage(includeUnfinished = false): UsageDeleteResult {
    validateIncludeUnfinished(includeUnfinished);
    return this.transaction(() => {
      const unfinished = this.database.prepare(`
        SELECT COUNT(*) AS count FROM usage_runs
        WHERE status = 'running'
      `).get() as DatabaseRow;
      const result = includeUnfinished
        ? this.database.prepare('DELETE FROM usage_runs').run()
        : this.database.prepare(`
            DELETE FROM usage_runs WHERE status != 'running'
          `).run();
      return {
        removed: Number(result.changes),
        unfinishedPreserved: includeUnfinished ? 0 : Number(unfinished.count),
      };
    });
  }

  pruneUsage(
    beforeExclusiveValue: string,
    includeUnfinished = false,
  ): UsageDeleteResult {
    validateIncludeUnfinished(includeUnfinished);
    const beforeExclusive = normalizeUsageTimestamp(
      beforeExclusiveValue,
      'usage prune time',
    );
    return this.transaction(() => {
      const unfinished = this.database.prepare(`
        SELECT COUNT(*) AS count FROM usage_runs
        WHERE started_at < ? AND status = 'running'
      `).get(beforeExclusive) as DatabaseRow;
      const result = includeUnfinished
        ? this.database.prepare(`
            DELETE FROM usage_runs WHERE started_at < ?
          `).run(beforeExclusive)
        : this.database.prepare(`
            DELETE FROM usage_runs
            WHERE started_at < ? AND status != 'running'
          `).run(beforeExclusive);
      return {
        removed: Number(result.changes),
        unfinishedPreserved: includeUnfinished ? 0 : Number(unfinished.count),
      };
    });
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
    const usageRuns = this.database.prepare('SELECT COUNT(*) AS count FROM usage_runs').get() as DatabaseRow;
    const usageSteps = this.database.prepare('SELECT COUNT(*) AS count FROM usage_steps').get() as DatabaseRow;
    const usageToolCalls = this.database.prepare('SELECT COUNT(*) AS count FROM usage_tool_calls').get() as DatabaseRow;
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
      usageRuns: Number(usageRuns.count),
      usageSteps: Number(usageSteps.count),
      usageToolCalls: Number(usageToolCalls.count),
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

  private cacheRevisionMatches(condition: CacheRevisionCondition): boolean {
    const row = this.database.prepare(`
      SELECT revision FROM cache_generations
      WHERE namespace = ?
    `).get(condition.namespace) as DatabaseRow | undefined;
    return Number(row?.revision) === condition.revision;
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
        const lockedVersion = databaseSchemaVersion(this.database);
        if (lockedVersion >= 1) return;
        if (lockedVersion !== 0) {
          throw new Error(`Seb cannot migrate database schema ${lockedVersion} to schema 1.`);
        }
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
        const lockedVersion = databaseSchemaVersion(this.database);
        if (lockedVersion >= 2) return;
        if (lockedVersion !== 1) {
          throw new Error(`Seb cannot migrate database schema ${lockedVersion} to schema 2.`);
        }
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
        const lockedVersion = databaseSchemaVersion(this.database);
        if (lockedVersion >= 3) return;
        if (lockedVersion !== 2) {
          throw new Error(`Seb cannot migrate database schema ${lockedVersion} to schema 3.`);
        }
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
    if (version < 4) {
      this.transaction(() => {
        const lockedVersion = databaseSchemaVersion(this.database);
        if (lockedVersion >= 4) return;
        if (lockedVersion !== 3) {
          throw new Error(`Seb cannot migrate database schema ${lockedVersion} to schema 4.`);
        }
        this.database.exec(`
          CREATE TABLE IF NOT EXISTS cache_generations (
            namespace TEXT NOT NULL PRIMARY KEY,
            revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
            CHECK(length(namespace) > 0)
          );
          PRAGMA user_version = 4;
        `);
      });
    }
    if (version < 5) {
      this.transaction(() => {
        const lockedVersion = databaseSchemaVersion(this.database);
        if (lockedVersion >= 5) return;
        if (lockedVersion !== 4) {
          throw new Error(`Seb cannot migrate database schema ${lockedVersion} to schema 5.`);
        }
        assertCompatibleUsageSchemaVersion5(this.database, true);
        this.database.exec(`
          CREATE TABLE IF NOT EXISTS usage_runs (
            call_id TEXT NOT NULL PRIMARY KEY,
            session_id TEXT NOT NULL,
            surface TEXT NOT NULL,
            agent_kind TEXT NOT NULL,
            started_at TEXT NOT NULL,
            ended_at TEXT,
            status TEXT NOT NULL
              CHECK(status IN ('running', 'completed', 'aborted', 'failed')),
            final_finish_reason TEXT,
            error_kind TEXT,
            CHECK(length(call_id) BETWEEN 1 AND 512),
            CHECK(length(session_id) BETWEEN 1 AND 512),
            CHECK(length(surface) BETWEEN 1 AND 128),
            CHECK(length(agent_kind) BETWEEN 1 AND 128),
            CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', started_at) IS started_at),
            CHECK(
              ended_at IS NULL OR
              strftime('%Y-%m-%dT%H:%M:%fZ', ended_at) IS ended_at
            ),
            CHECK(
              (status = 'running' AND ended_at IS NULL) OR
              (status != 'running' AND ended_at IS NOT NULL)
            )
          );
          CREATE INDEX IF NOT EXISTS usage_run_started_idx
            ON usage_runs(started_at DESC);
          CREATE INDEX IF NOT EXISTS usage_run_session_started_idx
            ON usage_runs(session_id, started_at DESC);

          CREATE TABLE IF NOT EXISTS usage_steps (
            call_id TEXT NOT NULL,
            step_number INTEGER NOT NULL
              CHECK(typeof(step_number) = 'integer' AND step_number >= 0),
            provider TEXT NOT NULL,
            model_id TEXT NOT NULL,
            finish_reason TEXT,
            raw_finish_reason TEXT,
            input_tokens INTEGER
              CHECK(input_tokens IS NULL OR
                    (typeof(input_tokens) = 'integer' AND input_tokens >= 0 AND
                     input_tokens <= ${MAX_USAGE_TOKEN_COUNT})),
            no_cache_input_tokens INTEGER
              CHECK(no_cache_input_tokens IS NULL OR
                    (typeof(no_cache_input_tokens) = 'integer' AND
                     no_cache_input_tokens >= 0 AND
                     no_cache_input_tokens <= ${MAX_USAGE_TOKEN_COUNT})),
            cache_read_input_tokens INTEGER
              CHECK(cache_read_input_tokens IS NULL OR
                    (typeof(cache_read_input_tokens) = 'integer' AND
                     cache_read_input_tokens >= 0 AND
                     cache_read_input_tokens <= ${MAX_USAGE_TOKEN_COUNT})),
            cache_write_input_tokens INTEGER
              CHECK(cache_write_input_tokens IS NULL OR
                    (typeof(cache_write_input_tokens) = 'integer' AND
                     cache_write_input_tokens >= 0 AND
                     cache_write_input_tokens <= ${MAX_USAGE_TOKEN_COUNT})),
            output_tokens INTEGER
              CHECK(output_tokens IS NULL OR
                    (typeof(output_tokens) = 'integer' AND output_tokens >= 0 AND
                     output_tokens <= ${MAX_USAGE_TOKEN_COUNT})),
            text_tokens INTEGER
              CHECK(text_tokens IS NULL OR
                    (typeof(text_tokens) = 'integer' AND text_tokens >= 0 AND
                     text_tokens <= ${MAX_USAGE_TOKEN_COUNT})),
            reasoning_tokens INTEGER
              CHECK(reasoning_tokens IS NULL OR
                    (typeof(reasoning_tokens) = 'integer' AND
                     reasoning_tokens >= 0 AND
                     reasoning_tokens <= ${MAX_USAGE_TOKEN_COUNT})),
            total_tokens INTEGER
              CHECK(total_tokens IS NULL OR
                    (typeof(total_tokens) = 'integer' AND total_tokens >= 0 AND
                     total_tokens <= ${MAX_USAGE_TOKEN_COUNT})),
            provider_total_tokens INTEGER
              CHECK(provider_total_tokens IS NULL OR
                    (typeof(provider_total_tokens) = 'integer' AND
                     provider_total_tokens >= 0 AND
                     provider_total_tokens <= ${MAX_USAGE_TOKEN_COUNT})),
            tool_use_tokens INTEGER
              CHECK(tool_use_tokens IS NULL OR
                    (typeof(tool_use_tokens) = 'integer' AND tool_use_tokens >= 0 AND
                     tool_use_tokens <= ${MAX_USAGE_TOKEN_COUNT})),
            response_time_ms REAL
              CHECK(response_time_ms IS NULL OR
                    (typeof(response_time_ms) IN ('integer', 'real') AND
                     response_time_ms >= 0 AND
                     response_time_ms <= ${MAX_USAGE_DURATION_MS})),
            time_to_first_output_ms REAL
              CHECK(time_to_first_output_ms IS NULL OR
                    (typeof(time_to_first_output_ms) IN ('integer', 'real') AND
                     time_to_first_output_ms >= 0 AND
                     time_to_first_output_ms <= ${MAX_USAGE_DURATION_MS})),
            step_time_ms REAL
              CHECK(step_time_ms IS NULL OR
                    (typeof(step_time_ms) IN ('integer', 'real') AND
                     step_time_ms >= 0 AND
                     step_time_ms <= ${MAX_USAGE_DURATION_MS})),
            service_tier TEXT,
            grounding_counts_json TEXT
              CHECK(grounding_counts_json IS NULL OR
                    (length(grounding_counts_json) <= 16384 AND
                     json_valid(grounding_counts_json) AND
                     json_type(grounding_counts_json) = 'object')),
            PRIMARY KEY (call_id, step_number),
            FOREIGN KEY (call_id)
              REFERENCES usage_runs(call_id) ON DELETE CASCADE,
            CHECK(length(provider) BETWEEN 1 AND 128),
            CHECK(length(model_id) BETWEEN 1 AND 256)
          );
          CREATE INDEX IF NOT EXISTS usage_step_model_idx
            ON usage_steps(provider, model_id);

          CREATE TABLE IF NOT EXISTS usage_tool_calls (
            call_id TEXT NOT NULL,
            step_number INTEGER NOT NULL,
            tool_call_id TEXT NOT NULL,
            tool_name TEXT NOT NULL,
            execution_location TEXT NOT NULL
              CHECK(execution_location IN ('client', 'provider')),
            outcome TEXT NOT NULL
              CHECK(outcome IN (
                'returned', 'error', 'invalid', 'cancelled', 'unresolved'
            )),
            execution_ms REAL
              CHECK(execution_ms IS NULL OR
                    (typeof(execution_ms) IN ('integer', 'real') AND
                     execution_ms >= 0 AND
                     execution_ms <= ${MAX_USAGE_DURATION_MS})),
            dynamic INTEGER CHECK(dynamic IS NULL OR dynamic IN (0, 1)),
            PRIMARY KEY (call_id, step_number, tool_call_id),
            FOREIGN KEY (call_id, step_number)
              REFERENCES usage_steps(call_id, step_number) ON DELETE CASCADE,
            CHECK(length(tool_call_id) BETWEEN 1 AND 512),
            CHECK(length(tool_name) BETWEEN 1 AND 128)
          );
          CREATE INDEX IF NOT EXISTS usage_tool_name_idx
            ON usage_tool_calls(tool_name);
        `);
        assertNoForeignKeyViolations(this.database);
        this.database.pragma('user_version = 5');
      });
    }
    if (version < 6) {
      this.transaction(() => {
        const lockedVersion = databaseSchemaVersion(this.database);
        if (lockedVersion === 6) {
          assertCompatibleUsageTables(this.database);
          assertNoForeignKeyViolations(this.database);
          validateSavedUsageRows(this.database);
          return;
        }
        if (lockedVersion !== 5) {
          throw new Error(
            `Seb cannot migrate database schema ${lockedVersion} to schema 6.`,
          );
        }
        migrateUsageSchemaToVersion6(this.database);
        this.database.pragma('user_version = 6');
      });
    }
    assertCompatibleUsageTables(this.database);
    assertNoForeignKeyViolations(this.database);
    validateSavedUsageRows(this.database);
  }

  private transaction<T>(run: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = run();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private readTransaction<T>(run: () => T): T {
    this.database.exec('BEGIN');
    try {
      const result = run();
      this.database.exec('COMMIT');
      return result;
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

function databaseSchemaVersion(database: Database.Database): number {
  return Number(database.pragma('user_version', { simple: true }));
}

interface UsageSchemaTableNames {
  runs: string;
  steps: string;
  toolCalls: string;
}

const FINAL_USAGE_SCHEMA_TABLES: UsageSchemaTableNames = {
  runs: 'usage_runs',
  steps: 'usage_steps',
  toolCalls: 'usage_tool_calls',
};

const SHADOW_USAGE_SCHEMA_TABLES: UsageSchemaTableNames = {
  runs: 'usage_runs_v6',
  steps: 'usage_steps_v6',
  toolCalls: 'usage_tool_calls_v6',
};

function usageSchemaVersion6Sql(names: UsageSchemaTableNames): string {
  return `
    CREATE TABLE ${names.runs} (
      call_id TEXT NOT NULL PRIMARY KEY,
      session_id TEXT NOT NULL,
      surface TEXT NOT NULL,
      agent_kind TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      status TEXT NOT NULL
        CHECK(status IN ('running', 'completed', 'aborted', 'failed')),
      final_finish_reason TEXT,
      error_kind TEXT,
      CHECK(length(call_id) BETWEEN 1 AND 512 AND call_id = trim(call_id)),
      CHECK(length(session_id) BETWEEN 1 AND 512 AND session_id = trim(session_id)),
      CHECK(length(surface) BETWEEN 1 AND 128 AND surface = trim(surface)),
      CHECK(length(agent_kind) BETWEEN 1 AND 128 AND agent_kind = trim(agent_kind)),
      CHECK(final_finish_reason IS NULL OR
            (length(final_finish_reason) BETWEEN 1 AND 128 AND
             final_finish_reason = trim(final_finish_reason))),
      CHECK(error_kind IS NULL OR
            (length(error_kind) BETWEEN 1 AND 128 AND error_kind = trim(error_kind))),
      CHECK(strftime('%Y-%m-%dT%H:%M:%fZ', started_at) IS started_at),
      CHECK(ended_at IS NULL OR
            strftime('%Y-%m-%dT%H:%M:%fZ', ended_at) IS ended_at),
      CHECK(ended_at IS NULL OR ended_at >= started_at),
      CHECK(
        (status = 'running' AND ended_at IS NULL) OR
        (status != 'running' AND ended_at IS NOT NULL)
      )
    ) STRICT;

    CREATE TABLE ${names.steps} (
      call_id TEXT NOT NULL,
      step_number INTEGER NOT NULL
        CHECK(step_number BETWEEN 0 AND 1000000),
      provider TEXT NOT NULL,
      model_id TEXT NOT NULL,
      finish_reason TEXT,
      raw_finish_reason TEXT,
      input_tokens INTEGER
        CHECK(input_tokens IS NULL OR
              input_tokens BETWEEN 0 AND ${MAX_USAGE_TOKEN_COUNT}),
      no_cache_input_tokens INTEGER
        CHECK(no_cache_input_tokens IS NULL OR
              no_cache_input_tokens BETWEEN 0 AND ${MAX_USAGE_TOKEN_COUNT}),
      cache_read_input_tokens INTEGER
        CHECK(cache_read_input_tokens IS NULL OR
              cache_read_input_tokens BETWEEN 0 AND ${MAX_USAGE_TOKEN_COUNT}),
      cache_write_input_tokens INTEGER
        CHECK(cache_write_input_tokens IS NULL OR
              cache_write_input_tokens BETWEEN 0 AND ${MAX_USAGE_TOKEN_COUNT}),
      output_tokens INTEGER
        CHECK(output_tokens IS NULL OR
              output_tokens BETWEEN 0 AND ${MAX_USAGE_TOKEN_COUNT}),
      text_tokens INTEGER
        CHECK(text_tokens IS NULL OR
              text_tokens BETWEEN 0 AND ${MAX_USAGE_TOKEN_COUNT}),
      reasoning_tokens INTEGER
        CHECK(reasoning_tokens IS NULL OR
              reasoning_tokens BETWEEN 0 AND ${MAX_USAGE_TOKEN_COUNT}),
      total_tokens INTEGER
        CHECK(total_tokens IS NULL OR
              total_tokens BETWEEN 0 AND ${MAX_USAGE_TOKEN_COUNT}),
      provider_total_tokens INTEGER
        CHECK(provider_total_tokens IS NULL OR
              provider_total_tokens BETWEEN 0 AND ${MAX_USAGE_TOKEN_COUNT}),
      tool_use_tokens INTEGER
        CHECK(tool_use_tokens IS NULL OR
              tool_use_tokens BETWEEN 0 AND ${MAX_USAGE_TOKEN_COUNT}),
      response_time_ms REAL
        CHECK(response_time_ms IS NULL OR
              response_time_ms BETWEEN 0 AND ${MAX_USAGE_DURATION_MS}),
      time_to_first_output_ms REAL
        CHECK(time_to_first_output_ms IS NULL OR
              time_to_first_output_ms BETWEEN 0 AND ${MAX_USAGE_DURATION_MS}),
      step_time_ms REAL
        CHECK(step_time_ms IS NULL OR
              step_time_ms BETWEEN 0 AND ${MAX_USAGE_DURATION_MS}),
      service_tier TEXT,
      grounding_counts_json TEXT
        CHECK(grounding_counts_json IS NULL OR
              (length(grounding_counts_json) <= 16384 AND
               json_valid(grounding_counts_json) AND
               json_type(grounding_counts_json) = 'object')),
      PRIMARY KEY (call_id, step_number),
      FOREIGN KEY (call_id)
        REFERENCES ${names.runs}(call_id) ON DELETE CASCADE,
      CHECK(length(provider) BETWEEN 1 AND 128 AND provider = trim(provider)),
      CHECK(length(model_id) BETWEEN 1 AND 256 AND model_id = trim(model_id)),
      CHECK(finish_reason IS NULL OR
            (length(finish_reason) BETWEEN 1 AND 128 AND
             finish_reason = trim(finish_reason))),
      CHECK(raw_finish_reason IS NULL OR
            (length(raw_finish_reason) BETWEEN 1 AND 128 AND
             raw_finish_reason = trim(raw_finish_reason))),
      CHECK(service_tier IS NULL OR
            (length(service_tier) BETWEEN 1 AND 128 AND
             service_tier = trim(service_tier)))
    ) STRICT;

    CREATE TABLE ${names.toolCalls} (
      call_id TEXT NOT NULL,
      step_number INTEGER NOT NULL
        CHECK(step_number BETWEEN 0 AND 1000000),
      tool_call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      execution_location TEXT NOT NULL
        CHECK(execution_location IN ('client', 'provider')),
      outcome TEXT NOT NULL
        CHECK(outcome IN (
          'returned', 'error', 'invalid', 'cancelled', 'unresolved'
        )),
      execution_ms REAL
        CHECK(execution_ms IS NULL OR
              execution_ms BETWEEN 0 AND ${MAX_USAGE_DURATION_MS}),
      dynamic INTEGER CHECK(dynamic IS NULL OR dynamic IN (0, 1)),
      PRIMARY KEY (call_id, step_number, tool_call_id),
      FOREIGN KEY (call_id, step_number)
        REFERENCES ${names.steps}(call_id, step_number) ON DELETE CASCADE,
      CHECK(length(tool_call_id) BETWEEN 1 AND 512 AND
            tool_call_id = trim(tool_call_id)),
      CHECK(length(tool_name) BETWEEN 1 AND 128 AND tool_name = trim(tool_name))
    ) STRICT;
  `;
}

function migrateUsageSchemaToVersion6(database: Database.Database): void {
  assertDatabaseQuickCheck(database);
  assertCompatibleUsageSchemaVersion5(database, false);
  assertNoForeignKeyViolations(database);
  validateSavedUsageRows(database);
  assertUsageShadowTablesAbsent(database);

  database.exec(usageSchemaVersion6Sql(SHADOW_USAGE_SCHEMA_TABLES));

  database.exec(`
    INSERT INTO usage_runs_v6 (
      call_id, session_id, surface, agent_kind, started_at, ended_at, status,
      final_finish_reason, error_kind
    )
    SELECT call_id, session_id, surface, agent_kind, started_at, ended_at, status,
           final_finish_reason, error_kind
    FROM usage_runs;

    INSERT INTO usage_steps_v6 (
      call_id, step_number, provider, model_id, finish_reason,
      raw_finish_reason, input_tokens, no_cache_input_tokens,
      cache_read_input_tokens, cache_write_input_tokens, output_tokens,
      text_tokens, reasoning_tokens, total_tokens, provider_total_tokens,
      tool_use_tokens, response_time_ms, time_to_first_output_ms,
      step_time_ms, service_tier, grounding_counts_json
    )
    SELECT call_id, step_number, provider, model_id, finish_reason,
           raw_finish_reason, input_tokens, no_cache_input_tokens,
           cache_read_input_tokens, cache_write_input_tokens, output_tokens,
           text_tokens, reasoning_tokens, total_tokens, provider_total_tokens,
           tool_use_tokens, response_time_ms, time_to_first_output_ms,
           step_time_ms, service_tier, grounding_counts_json
    FROM usage_steps;

    INSERT INTO usage_tool_calls_v6 (
      call_id, step_number, tool_call_id, tool_name, execution_location,
      outcome, execution_ms, dynamic
    )
    SELECT call_id, step_number, tool_call_id, tool_name, execution_location,
           outcome, execution_ms, dynamic
    FROM usage_tool_calls;
  `);

  assertUsageCopyCounts(database);
  assertNoForeignKeyViolations(database);
  database.exec(`
    DROP TABLE usage_tool_calls;
    DROP TABLE usage_steps;
    DROP TABLE usage_runs;
    ALTER TABLE usage_runs_v6 RENAME TO usage_runs;
    ALTER TABLE usage_steps_v6 RENAME TO usage_steps;
    ALTER TABLE usage_tool_calls_v6 RENAME TO usage_tool_calls;
    CREATE INDEX usage_run_started_idx ON usage_runs(started_at DESC);
    CREATE INDEX usage_run_session_started_idx
      ON usage_runs(session_id, started_at DESC);
    CREATE INDEX usage_step_model_idx ON usage_steps(provider, model_id);
    CREATE INDEX usage_tool_name_idx ON usage_tool_calls(tool_name);
  `);
  assertCompatibleUsageTables(database);
  assertNoForeignKeyViolations(database);
  assertDatabaseQuickCheck(database);
}

function assertCompatibleUsageSchemaVersion5(
  database: Database.Database,
  allowMissing: boolean,
): void {
  const rows = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN (
      'usage_runs', 'usage_steps', 'usage_tool_calls'
    )
  `).all() as DatabaseRow[];
  if (rows.length === 0 && allowMissing) return;
  if (rows.length !== 3) {
    throw new Error('The existing usage tables do not form a complete schema.');
  }
  assertNoDatabaseTriggers(database);
  assertNoInboundUsageForeignKeys(database);
  const runColumns = usageColumnSignatures(database, 'usage_runs');
  const expectedRunSuffix = [
    'session_id:TEXT:1:0',
    'surface:TEXT:1:0',
    'agent_kind:TEXT:1:0',
    'started_at:TEXT:1:0',
    'ended_at:TEXT:0:0',
    'status:TEXT:1:0',
    'final_finish_reason:TEXT:0:0',
    'error_kind:TEXT:0:0',
  ].map(expectedUsageColumnSignature);
  if (
    !['call_id:TEXT:0:1', 'call_id:TEXT:1:1']
      .map(expectedUsageColumnSignature)
      .includes(runColumns[0] ?? '') ||
    runColumns.slice(1).join('|') !== expectedRunSuffix.join('|')
  ) {
    throw new Error('The existing usage table usage_runs cannot migrate to schema version 6.');
  }
  assertUsageColumns(database, 'usage_steps', [
    'call_id:TEXT:1:1',
    'step_number:INTEGER:1:2',
    'provider:TEXT:1:0',
    'model_id:TEXT:1:0',
    'finish_reason:TEXT:0:0',
    'raw_finish_reason:TEXT:0:0',
    'input_tokens:INTEGER:0:0',
    'no_cache_input_tokens:INTEGER:0:0',
    'cache_read_input_tokens:INTEGER:0:0',
    'cache_write_input_tokens:INTEGER:0:0',
    'output_tokens:INTEGER:0:0',
    'text_tokens:INTEGER:0:0',
    'reasoning_tokens:INTEGER:0:0',
    'total_tokens:INTEGER:0:0',
    'provider_total_tokens:INTEGER:0:0',
    'tool_use_tokens:INTEGER:0:0',
    'response_time_ms:REAL:0:0',
    'time_to_first_output_ms:REAL:0:0',
    'step_time_ms:REAL:0:0',
    'service_tier:TEXT:0:0',
    'grounding_counts_json:TEXT:0:0',
  ], 6);
  assertUsageColumns(database, 'usage_tool_calls', [
    'call_id:TEXT:1:1',
    'step_number:INTEGER:1:2',
    'tool_call_id:TEXT:1:3',
    'tool_name:TEXT:1:0',
    'execution_location:TEXT:1:0',
    'outcome:TEXT:1:0',
    'execution_ms:REAL:0:0',
    'dynamic:INTEGER:0:0',
  ], 6);
  assertUsageForeignKeys(database);
  assertCompatibleUsageIndexesVersion5(database);
  if (!usageSchemaVersion6DefinitionsMatch(database)) {
    assertCompatibleUsageTableDefinitionsVersion5(database);
  }
}

function validateSavedUsageRows(database: Database.Database): void {
  for (const row of database.prepare('SELECT * FROM usage_runs').iterate() as Iterable<DatabaseRow>) {
    parseUsageRun(row);
  }
  for (const row of database.prepare('SELECT * FROM usage_steps').iterate() as Iterable<DatabaseRow>) {
    parseUsageStep(row);
  }
  for (const row of database.prepare('SELECT * FROM usage_tool_calls').iterate() as Iterable<DatabaseRow>) {
    parseUsageToolCall(row);
  }
}

function assertUsageShadowTablesAbsent(database: Database.Database): void {
  const row = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN (
      'usage_runs_v6', 'usage_steps_v6', 'usage_tool_calls_v6'
    )
    LIMIT 1
  `).get() as DatabaseRow | undefined;
  if (row) {
    throw new Error(`The database contains an unexpected migration table ${requiredText(row.name)}.`);
  }
}

function assertUsageCopyCounts(database: Database.Database): void {
  for (const [source, target] of [
    ['usage_runs', 'usage_runs_v6'],
    ['usage_steps', 'usage_steps_v6'],
    ['usage_tool_calls', 'usage_tool_calls_v6'],
  ] as const) {
    const sourceCount = database.prepare(`SELECT COUNT(*) AS count FROM ${source}`).get() as DatabaseRow;
    const targetCount = database.prepare(`SELECT COUNT(*) AS count FROM ${target}`).get() as DatabaseRow;
    if (Number(sourceCount.count) !== Number(targetCount.count)) {
      throw new Error(`The schema 6 migration did not copy every ${source} row.`);
    }
  }
}

function assertDatabaseQuickCheck(database: Database.Database): void {
  const rows = database.prepare('PRAGMA quick_check').all() as DatabaseRow[];
  if (rows.length !== 1 || rows[0]?.quick_check !== 'ok') {
    throw new Error('The database failed its SQLite quick check.');
  }
}

function assertCompatibleUsageTables(database: Database.Database): void {
  const expected = new Map<string, readonly string[]>([
    ['usage_runs', [
      'call_id:TEXT:1:1',
      'session_id:TEXT:1:0',
      'surface:TEXT:1:0',
      'agent_kind:TEXT:1:0',
      'started_at:TEXT:1:0',
      'ended_at:TEXT:0:0',
      'status:TEXT:1:0',
      'final_finish_reason:TEXT:0:0',
      'error_kind:TEXT:0:0',
    ]],
    ['usage_steps', [
      'call_id:TEXT:1:1',
      'step_number:INTEGER:1:2',
      'provider:TEXT:1:0',
      'model_id:TEXT:1:0',
      'finish_reason:TEXT:0:0',
      'raw_finish_reason:TEXT:0:0',
      'input_tokens:INTEGER:0:0',
      'no_cache_input_tokens:INTEGER:0:0',
      'cache_read_input_tokens:INTEGER:0:0',
      'cache_write_input_tokens:INTEGER:0:0',
      'output_tokens:INTEGER:0:0',
      'text_tokens:INTEGER:0:0',
      'reasoning_tokens:INTEGER:0:0',
      'total_tokens:INTEGER:0:0',
      'provider_total_tokens:INTEGER:0:0',
      'tool_use_tokens:INTEGER:0:0',
      'response_time_ms:REAL:0:0',
      'time_to_first_output_ms:REAL:0:0',
      'step_time_ms:REAL:0:0',
      'service_tier:TEXT:0:0',
      'grounding_counts_json:TEXT:0:0',
    ]],
    ['usage_tool_calls', [
      'call_id:TEXT:1:1',
      'step_number:INTEGER:1:2',
      'tool_call_id:TEXT:1:3',
      'tool_name:TEXT:1:0',
      'execution_location:TEXT:1:0',
      'outcome:TEXT:1:0',
      'execution_ms:REAL:0:0',
      'dynamic:INTEGER:0:0',
    ]],
  ]);
  const rows = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name IN (
      'usage_runs', 'usage_steps', 'usage_tool_calls'
    )
  `).all() as DatabaseRow[];
  if (rows.length !== expected.size) {
    throw new Error('The existing usage tables do not form a complete schema.');
  }
  assertNoInboundUsageForeignKeys(database);
  for (const [table, expectedColumns] of expected) {
    assertUsageColumns(database, table, expectedColumns, 6);
  }
  assertExactUsageSchemaVersion6Definitions(database);
  assertStrictUsageTables(database);
  assertUsageForeignKeys(database);
  assertUsageIndexes(database);
  assertNoDatabaseTriggers(database);
}

function usageColumnSignatures(
  database: Database.Database,
  table: string,
): string[] {
  const columns = database.prepare(`PRAGMA table_xinfo(${table})`).all() as DatabaseRow[];
  return columns.map((column) => [
    requiredText(column.name),
    requiredText(column.type).toUpperCase(),
    Number(column.notnull),
    Number(column.pk),
    column.dflt_value == null ? '<none>' : String(column.dflt_value),
    Number(column.hidden),
  ].join(':'));
}

function expectedUsageColumnSignature(signature: string): string {
  return `${signature}:<none>:0`;
}

function assertUsageColumns(
  database: Database.Database,
  table: string,
  expected: readonly string[],
  version: number,
): void {
  const expectedSignatures = expected.map(expectedUsageColumnSignature);
  if (usageColumnSignatures(database, table).join('|') !== expectedSignatures.join('|')) {
    throw new Error(
      `The existing usage table ${table} does not match schema version ${version}.`,
    );
  }
}

function assertStrictUsageTables(database: Database.Database): void {
  for (const table of ['usage_runs', 'usage_steps', 'usage_tool_calls']) {
    const row = database.prepare(`
      SELECT strict FROM pragma_table_list
      WHERE schema = 'main' AND name = ? AND type = 'table'
    `).get(table) as DatabaseRow | undefined;
    if (Number(row?.strict) !== 1) {
      throw new Error(`The existing usage table ${table} is not strict.`);
    }
  }
}

function assertUsageForeignKeys(database: Database.Database): void {
  const stepForeignKeys = database
    .prepare('PRAGMA foreign_key_list(usage_steps)')
    .all() as DatabaseRow[];
  if (foreignKeySignatures(stepForeignKeys).join('|') !== [
    'usage_runs:NO ACTION:CASCADE:NONE:0:call_id>call_id',
  ].join('|')) {
    throw new Error('The existing usage step table has an invalid run link.');
  }
  const toolForeignKeys = database
    .prepare('PRAGMA foreign_key_list(usage_tool_calls)')
    .all() as DatabaseRow[];
  if (foreignKeySignatures(toolForeignKeys).join('|') !== [
    'usage_steps:NO ACTION:CASCADE:NONE:0:call_id>call_id,1:step_number>step_number',
  ].join('|')) {
    throw new Error('The existing usage tool table has an invalid step link.');
  }
}

function assertNoInboundUsageForeignKeys(database: Database.Database): void {
  const usageTables = new Set([
    FINAL_USAGE_SCHEMA_TABLES.runs,
    FINAL_USAGE_SCHEMA_TABLES.steps,
    FINAL_USAGE_SCHEMA_TABLES.toolCalls,
  ].map(sqliteIdentifierKey));
  const tables = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
  `).all() as DatabaseRow[];
  for (const row of tables) {
    const table = requiredText(row.name);
    if (usageTables.has(sqliteIdentifierKey(table))) continue;
    const links = database.prepare(`
      SELECT "table" AS target FROM pragma_foreign_key_list(?)
    `).all(table) as DatabaseRow[];
    if (links.some((link) => usageTables.has(
      sqliteIdentifierKey(requiredText(link.target)),
    ))) {
      throw new Error(
        `The external table ${table} cannot link to a Seb usage table.`,
      );
    }
  }
}

function sqliteIdentifierKey(value: string): string {
  return value.replace(/[A-Z]/gu, (character) => character.toLowerCase());
}

function foreignKeySignatures(
  rows: readonly DatabaseRow[],
): string[] {
  const ids = [...new Set(rows.map((row) => Number(row.id)))];
  return ids.map((id) => {
    const group = rows
      .filter((row) => Number(row.id) === id)
      .sort((left, right) => Number(left.seq) - Number(right.seq));
    const first = group[0];
    const mappings = group.map((row) =>
      `${Number(row.seq)}:${requiredText(row.from)}>${requiredText(row.to)}`
    ).join(',');
    return [
      requiredText(first?.table),
      requiredText(first?.on_update),
      requiredText(first?.on_delete),
      requiredText(first?.match),
      mappings,
    ].join(':');
  }).sort();
}

function expectedUsageIndexSignatures(): Map<string, readonly string[]> {
  return new Map([
    ['usage_runs', [
      'sqlite_autoindex_usage_runs_1:pk:1:0:call_id:0:BINARY',
      'usage_run_session_started_idx:c:0:0:session_id:0:BINARY,started_at:1:BINARY',
      'usage_run_started_idx:c:0:0:started_at:1:BINARY',
    ]],
    ['usage_steps', [
      'sqlite_autoindex_usage_steps_1:pk:1:0:call_id:0:BINARY,step_number:0:BINARY',
      'usage_step_model_idx:c:0:0:provider:0:BINARY,model_id:0:BINARY',
    ]],
    ['usage_tool_calls', [
      'sqlite_autoindex_usage_tool_calls_1:pk:1:0:' +
        'call_id:0:BINARY,step_number:0:BINARY,tool_call_id:0:BINARY',
      'usage_tool_name_idx:c:0:0:tool_name:0:BINARY',
    ]],
  ]);
}

function usageIndexSignatures(
  database: Database.Database,
  table: string,
): string[] {
  const indexes = database.prepare(`PRAGMA index_list(${table})`).all() as DatabaseRow[];
  return indexes
    .map((index) => {
      const name = requiredText(index.name);
      const columns = (database.prepare(`
        SELECT * FROM pragma_index_xinfo(?)
      `).all(name) as DatabaseRow[])
        .filter((column) => Number(column.key) === 1)
        .sort((left, right) => Number(left.seqno) - Number(right.seqno))
        .map((column) => [
          requiredText(column.name),
          Number(column.desc),
          requiredText(column.coll),
        ].join(':'))
        .join(',');
      return [
        name,
        requiredText(index.origin),
        Number(index.unique),
        Number(index.partial),
        columns,
      ].join(':');
    })
    .sort();
}

function assertCompatibleUsageIndexesVersion5(database: Database.Database): void {
  for (const [table, expectedIndexes] of expectedUsageIndexSignatures()) {
    const actual = usageIndexSignatures(database, table);
    const allowed = new Set(expectedIndexes);
    const required = expectedIndexes.filter((index) => index.includes(':pk:'));
    if (
      actual.some((index) => !allowed.has(index)) ||
      required.some((index) => !actual.includes(index))
    ) {
      throw new Error(
        `The existing usage table ${table} has indexes that cannot migrate to schema version 6.`,
      );
    }
  }
}

function assertCompatibleUsageTableDefinitionsVersion5(
  database: Database.Database,
): void {
  const allowedChecks = allowedUsageChecksVersion5();
  const forbiddenKeywords = new Set([
    'ALWAYS',
    'AUTOINCREMENT',
    'COLLATE',
    'CONSTRAINT',
    'DEFERRABLE',
    'GENERATED',
    'INITIALLY',
    'MATCH',
    'STORED',
    'UNIQUE',
    'VIRTUAL',
  ]);
  for (const [table, expectedChecks] of allowedChecks) {
    const metadata = database.prepare(`
      SELECT strict, wr FROM pragma_table_list
      WHERE schema = 'main' AND name = ? AND type = 'table'
    `).get(table) as DatabaseRow | undefined;
    if (Number(metadata?.strict) !== 0 || Number(metadata?.wr) !== 0) {
      throw incompatibleUsageTableDefinitionError(table);
    }
    const row = database.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'table' AND name = ?
    `).get(table) as DatabaseRow | undefined;
    const sql = requiredText(row?.sql);
    const keywords = usageSqlKeywords(sql);
    if (
      keywords.some((keyword) => forbiddenKeywords.has(keyword)) ||
      usageSqlHasKeywordPair(keywords, 'ON', 'CONFLICT') ||
      usageSqlHasKeywordPair(keywords, 'ON', 'UPDATE') ||
      usageSqlHasKeywordPair(keywords, 'WITHOUT', 'ROWID')
    ) {
      throw incompatibleUsageTableDefinitionError(table);
    }
    const remainingChecks = new Set(expectedChecks);
    for (const expression of usageCheckExpressions(sql)) {
      const normalized = normalizeUsageConstraintSql(expression);
      if (!remainingChecks.delete(normalized)) {
        throw incompatibleUsageTableDefinitionError(table);
      }
    }
  }
}

function incompatibleUsageTableDefinitionError(table: string): Error {
  return new Error(
    `The existing usage table ${table} has a definition that cannot migrate ` +
    'to schema version 6.',
  );
}

function allowedUsageChecksVersion5(): Map<string, ReadonlySet<string>> {
  const normalize = (value: string): string => normalizeUsageConstraintSql(value);
  const runChecks = [
    "status IN ('running', 'completed', 'aborted', 'failed')",
    'length(call_id) BETWEEN 1 AND 512',
    'length(session_id) BETWEEN 1 AND 512',
    'length(surface) BETWEEN 1 AND 128',
    'length(agent_kind) BETWEEN 1 AND 128',
    "strftime('%Y-%m-%dT%H:%M:%fZ', started_at) IS started_at",
    "ended_at IS NULL OR strftime('%Y-%m-%dT%H:%M:%fZ', ended_at) IS ended_at",
    "(status = 'running' AND ended_at IS NULL) OR " +
      "(status != 'running' AND ended_at IS NOT NULL)",
  ];
  const stepChecks = [
    "typeof(step_number) = 'integer' AND step_number >= 0",
    ...[
      'input_tokens',
      'no_cache_input_tokens',
      'cache_read_input_tokens',
      'cache_write_input_tokens',
      'output_tokens',
      'text_tokens',
      'reasoning_tokens',
      'total_tokens',
      'provider_total_tokens',
      'tool_use_tokens',
    ].map((column) =>
      `${column} IS NULL OR (typeof(${column}) = 'integer' AND ` +
      `${column} >= 0 AND ${column} <= ${MAX_USAGE_TOKEN_COUNT})`
    ),
    ...[
      'response_time_ms',
      'time_to_first_output_ms',
      'step_time_ms',
    ].map((column) =>
      `${column} IS NULL OR (typeof(${column}) IN ('integer', 'real') AND ` +
      `${column} >= 0 AND ${column} <= ${MAX_USAGE_DURATION_MS})`
    ),
    'grounding_counts_json IS NULL OR ' +
      '(length(grounding_counts_json) <= 16384 AND ' +
      "json_valid(grounding_counts_json) AND " +
      "json_type(grounding_counts_json) = 'object')",
    'length(provider) BETWEEN 1 AND 128',
    'length(model_id) BETWEEN 1 AND 256',
  ];
  const toolChecks = [
    "execution_location IN ('client', 'provider')",
    "outcome IN ('returned', 'error', 'invalid', 'cancelled', 'unresolved')",
    'execution_ms IS NULL OR ' +
      "(typeof(execution_ms) IN ('integer', 'real') AND " +
      `execution_ms >= 0 AND execution_ms <= ${MAX_USAGE_DURATION_MS})`,
    'dynamic IS NULL OR dynamic IN (0, 1)',
    'length(tool_call_id) BETWEEN 1 AND 512',
    'length(tool_name) BETWEEN 1 AND 128',
  ];
  return new Map([
    ['usage_runs', new Set(runChecks.map(normalize))],
    ['usage_steps', new Set(stepChecks.map(normalize))],
    ['usage_tool_calls', new Set(toolChecks.map(normalize))],
  ]);
}

function usageCheckExpressions(sql: string): string[] {
  const expressions: string[] = [];
  let index = 0;
  while (index < sql.length) {
    const next = nextUsageSqlToken(sql, index);
    if (!next) break;
    index = next.end;
    if (next.kind !== 'word' || next.value.toUpperCase() !== 'CHECK') continue;
    const opening = skipUsageSqlTrivia(sql, index);
    if (sql[opening] !== '(') {
      throw new Error('The usage table contains an invalid CHECK constraint.');
    }
    const closing = matchingUsageSqlParenthesis(sql, opening);
    expressions.push(sql.slice(opening + 1, closing));
    index = closing + 1;
  }
  return expressions;
}

function usageSqlKeywords(sql: string): string[] {
  const keywords: string[] = [];
  let index = 0;
  while (index < sql.length) {
    const next = nextUsageSqlToken(sql, index);
    if (!next) break;
    index = next.end;
    if (next.kind === 'word') keywords.push(next.value.toUpperCase());
  }
  return keywords;
}

function usageSqlHasKeywordPair(
  keywords: readonly string[],
  first: string,
  second: string,
): boolean {
  return keywords.some((keyword, index) =>
    keyword === first && keywords[index + 1] === second
  );
}

interface UsageSqlToken {
  end: number;
  kind: 'quoted' | 'word';
  value: string;
}

function nextUsageSqlToken(sql: string, start: number): UsageSqlToken | null {
  const index = skipUsageSqlTrivia(sql, start);
  if (index >= sql.length) return null;
  const character = sql[index] ?? '';
  if (character === "'" || character === '"' || character === '`' || character === '[') {
    const end = skipUsageSqlQuotedToken(sql, index);
    return { end, kind: 'quoted', value: sql.slice(index, end) };
  }
  if (/[A-Za-z_]/u.test(character)) {
    let end = index + 1;
    while (end < sql.length && /[A-Za-z0-9_$]/u.test(sql[end] ?? '')) end += 1;
    return { end, kind: 'word', value: sql.slice(index, end) };
  }
  return { end: index + 1, kind: 'quoted', value: character };
}

function skipUsageSqlTrivia(sql: string, start: number): number {
  let index = start;
  while (index < sql.length) {
    if (/\s/u.test(sql[index] ?? '')) {
      index += 1;
      continue;
    }
    if (sql.startsWith('--', index)) {
      const lineEnd = sql.indexOf('\n', index + 2);
      index = lineEnd < 0 ? sql.length : lineEnd + 1;
      continue;
    }
    if (sql.startsWith('/*', index)) {
      const commentEnd = sql.indexOf('*/', index + 2);
      if (commentEnd < 0) {
        throw new Error('The usage table contains an unterminated SQL comment.');
      }
      index = commentEnd + 2;
      continue;
    }
    break;
  }
  return index;
}

function skipUsageSqlQuotedToken(sql: string, start: number): number {
  const opening = sql[start] ?? '';
  const closing = opening === '[' ? ']' : opening;
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] !== closing) {
      index += 1;
      continue;
    }
    if (opening !== '[' && sql[index + 1] === closing) {
      index += 2;
      continue;
    }
    return index + 1;
  }
  throw new Error('The usage table contains an unterminated SQL quote.');
}

function matchingUsageSqlParenthesis(sql: string, opening: number): number {
  let depth = 0;
  let index = opening;
  while (index < sql.length) {
    const character = sql[index] ?? '';
    if (character === "'" || character === '"' || character === '`' || character === '[') {
      index = skipUsageSqlQuotedToken(sql, index);
      continue;
    }
    if (sql.startsWith('--', index) || sql.startsWith('/*', index)) {
      index = skipUsageSqlTrivia(sql, index);
      continue;
    }
    if (character === '(') depth += 1;
    if (character === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
    index += 1;
  }
  throw new Error('The usage table contains an unclosed CHECK constraint.');
}

function normalizeUsageConstraintSql(value: string): string {
  return value
    .replace(/"([a-z_][a-z0-9_]*)"/giu, '$1')
    .replace(/\s+/gu, ' ')
    .replace(/\s*([(),])\s*/gu, '$1')
    .trim();
}

function assertUsageIndexes(database: Database.Database): void {
  for (const [table, expectedIndexes] of expectedUsageIndexSignatures()) {
    const actual = usageIndexSignatures(database, table);
    if (actual.join('|') !== [...expectedIndexes].sort().join('|')) {
      throw new Error(`The existing usage table ${table} has invalid indexes.`);
    }
  }
}

function assertNoDatabaseTriggers(database: Database.Database): void {
  const row = database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'trigger'
    LIMIT 1
  `).get() as DatabaseRow | undefined;
  if (row) {
    throw new Error(
      `The existing usage schema has an unexpected trigger ${requiredText(row.name)}.`,
    );
  }
}

function assertNoForeignKeyViolations(database: Database.Database): void {
  const violations = database
    .prepare('PRAGMA foreign_key_check')
    .all() as DatabaseRow[];
  if (violations.length > 0) {
    throw new Error(
      `The database contains ${violations.length} orphaned record` +
      `${violations.length === 1 ? '' : 's'}.`,
    );
  }
}

function assertExactUsageSchemaVersion6Definitions(database: Database.Database): void {
  if (!usageSchemaVersion6DefinitionsMatch(database)) {
    throw new Error('The existing usage tables do not match schema version 6.');
  }
}

function usageSchemaVersion6DefinitionsMatch(database: Database.Database): boolean {
  const actual = [
    FINAL_USAGE_SCHEMA_TABLES.runs,
    FINAL_USAGE_SCHEMA_TABLES.steps,
    FINAL_USAGE_SCHEMA_TABLES.toolCalls,
  ].map((table) => {
    const row = database.prepare(`
      SELECT sql FROM sqlite_master
      WHERE type = 'table' AND name = ?
    `).get(table) as DatabaseRow | undefined;
    return requiredText(row?.sql);
  }).join(';\n') + ';';
  const expected = usageSchemaVersion6Sql(FINAL_USAGE_SCHEMA_TABLES);
  return normalizeUsageSchemaSql(actual) === normalizeUsageSchemaSql(expected);
}

function normalizeUsageSchemaSql(value: string): string {
  return value
    .replace(/"(usage_runs|usage_steps|usage_tool_calls)"/gu, '$1')
    .replace(/\s+/gu, ' ')
    .trim();
}

function normalizeUsageStepWrite(write: UsageStepWrite): UsageStepRecord {
  return {
    cacheReadInputTokens: normalizeUsageCount(
      write.cacheReadInputTokens,
      'cache-read input token count',
    ),
    cacheWriteInputTokens: normalizeUsageCount(
      write.cacheWriteInputTokens,
      'cache-write input token count',
    ),
    callId: normalizeUsageIdentifier(write.callId, 'usage call ID', 512),
    finishReason: normalizeOptionalUsageCode(
      write.finishReason,
      'usage finish reason',
      128,
    ),
    groundingCounts: normalizeGroundingCounts(write.groundingCounts),
    inputTokens: normalizeUsageCount(write.inputTokens, 'input token count'),
    modelId: normalizeUsageCode(write.modelId, 'usage model ID', 256),
    noCacheInputTokens: normalizeUsageCount(
      write.noCacheInputTokens,
      'uncached input token count',
    ),
    outputTokens: normalizeUsageCount(write.outputTokens, 'output token count'),
    provider: normalizeUsageCode(write.provider, 'usage provider', 128),
    providerTotalTokens: normalizeUsageCount(
      write.providerTotalTokens,
      'provider total token count',
    ),
    rawFinishReason: normalizeOptionalUsageCode(
      write.rawFinishReason,
      'raw usage finish reason',
      128,
    ),
    reasoningTokens: normalizeUsageCount(
      write.reasoningTokens,
      'reasoning token count',
    ),
    responseTimeMs: normalizeUsageDuration(
      write.responseTimeMs,
      'model response time',
    ),
    serviceTier: normalizeOptionalUsageCode(
      write.serviceTier,
      'usage service tier',
      128,
    ),
    stepNumber: normalizeUsageStepNumber(write.stepNumber),
    stepTimeMs: normalizeUsageDuration(write.stepTimeMs, 'model step time'),
    textTokens: normalizeUsageCount(write.textTokens, 'text token count'),
    timeToFirstOutputMs: normalizeUsageDuration(
      write.timeToFirstOutputMs,
      'time to first output',
    ),
    toolUseTokens: normalizeUsageCount(write.toolUseTokens, 'tool-use token count'),
    totalTokens: normalizeUsageCount(write.totalTokens, 'total token count'),
  };
}

function usageStepValues(record: UsageStepRecord): Array<string | number | null> {
  return [
    record.callId,
    record.stepNumber,
    record.provider,
    record.modelId,
    record.finishReason,
    record.rawFinishReason,
    record.inputTokens,
    record.noCacheInputTokens,
    record.cacheReadInputTokens,
    record.cacheWriteInputTokens,
    record.outputTokens,
    record.textTokens,
    record.reasoningTokens,
    record.totalTokens,
    record.providerTotalTokens,
    record.toolUseTokens,
    record.responseTimeMs,
    record.timeToFirstOutputMs,
    record.stepTimeMs,
    record.serviceTier,
    record.groundingCounts === null ? null : stableJson(record.groundingCounts),
  ];
}

function mergeUsageStep(
  current: UsageStepRecord,
  incoming: UsageStepRecord,
): UsageStepRecord {
  if (
    current.callId !== incoming.callId ||
    current.stepNumber !== incoming.stepNumber ||
    current.provider !== incoming.provider ||
    current.modelId !== incoming.modelId
  ) {
    throw new Error(
      `The usage step ${incoming.callId}:${incoming.stepNumber} has different identity metadata.`,
    );
  }
  return {
    ...current,
    cacheReadInputTokens: mergeNullableUsageValue(
      current.cacheReadInputTokens,
      incoming.cacheReadInputTokens,
      'cache-read input token count',
    ),
    cacheWriteInputTokens: mergeNullableUsageValue(
      current.cacheWriteInputTokens,
      incoming.cacheWriteInputTokens,
      'cache-write input token count',
    ),
    finishReason: mergeNullableUsageValue(
      current.finishReason,
      incoming.finishReason,
      'usage finish reason',
    ),
    groundingCounts: mergeNullableUsageValue(
      current.groundingCounts,
      incoming.groundingCounts,
      'grounding counts',
      (left, right) => stableJson(left) === stableJson(right),
    ),
    inputTokens: mergeNullableUsageValue(
      current.inputTokens,
      incoming.inputTokens,
      'input token count',
    ),
    noCacheInputTokens: mergeNullableUsageValue(
      current.noCacheInputTokens,
      incoming.noCacheInputTokens,
      'uncached input token count',
    ),
    outputTokens: mergeNullableUsageValue(
      current.outputTokens,
      incoming.outputTokens,
      'output token count',
    ),
    providerTotalTokens: mergeNullableUsageValue(
      current.providerTotalTokens,
      incoming.providerTotalTokens,
      'provider total token count',
    ),
    rawFinishReason: mergeNullableUsageValue(
      current.rawFinishReason,
      incoming.rawFinishReason,
      'raw usage finish reason',
    ),
    reasoningTokens: mergeNullableUsageValue(
      current.reasoningTokens,
      incoming.reasoningTokens,
      'reasoning token count',
    ),
    responseTimeMs: mergeNullableUsageValue(
      current.responseTimeMs,
      incoming.responseTimeMs,
      'model response time',
    ),
    serviceTier: mergeNullableUsageValue(
      current.serviceTier,
      incoming.serviceTier,
      'usage service tier',
    ),
    stepTimeMs: mergeNullableUsageValue(
      current.stepTimeMs,
      incoming.stepTimeMs,
      'model step time',
    ),
    textTokens: mergeNullableUsageValue(
      current.textTokens,
      incoming.textTokens,
      'text token count',
    ),
    timeToFirstOutputMs: mergeNullableUsageValue(
      current.timeToFirstOutputMs,
      incoming.timeToFirstOutputMs,
      'time to first output',
    ),
    toolUseTokens: mergeNullableUsageValue(
      current.toolUseTokens,
      incoming.toolUseTokens,
      'tool-use token count',
    ),
    totalTokens: mergeNullableUsageValue(
      current.totalTokens,
      incoming.totalTokens,
      'total token count',
    ),
  };
}

function normalizeUsageToolCallWrite(
  write: UsageToolCallWrite,
): UsageToolCallRecord {
  return {
    callId: normalizeUsageIdentifier(write.callId, 'usage call ID', 512),
    dynamic: write.dynamic === undefined || write.dynamic === null
      ? null
      : normalizeUsageBoolean(write.dynamic, 'dynamic tool flag'),
    executionLocation: normalizeUsageToolExecutionLocation(write.executionLocation),
    executionMs: normalizeUsageDuration(write.executionMs, 'tool execution time'),
    outcome: normalizeUsageToolOutcome(write.outcome),
    stepNumber: normalizeUsageStepNumber(write.stepNumber),
    toolCallId: normalizeUsageIdentifier(write.toolCallId, 'usage tool-call ID', 512),
    toolName: normalizeUsageCode(write.toolName, 'usage tool name', 128),
  };
}

function mergeUsageToolCall(
  current: UsageToolCallRecord,
  incoming: UsageToolCallRecord,
): UsageToolCallRecord {
  if (
    current.callId !== incoming.callId ||
    current.stepNumber !== incoming.stepNumber ||
    current.toolCallId !== incoming.toolCallId ||
    current.toolName !== incoming.toolName ||
    current.executionLocation !== incoming.executionLocation
  ) {
    throw new Error(`The usage tool call ${incoming.toolCallId} has different identity metadata.`);
  }
  let outcome = current.outcome;
  if (current.outcome === 'unresolved') outcome = incoming.outcome;
  else if (incoming.outcome !== 'unresolved' && incoming.outcome !== current.outcome) {
    throw new Error(`The usage tool call ${incoming.toolCallId} has a conflicting outcome.`);
  }
  return {
    ...current,
    dynamic: mergeNullableUsageValue(
      current.dynamic,
      incoming.dynamic,
      'dynamic tool flag',
    ),
    executionMs: mergeNullableUsageValue(
      current.executionMs,
      incoming.executionMs,
      'tool execution time',
    ),
    outcome,
  };
}

function parseUsageRun(row: DatabaseRow): UsageRunRecord {
  const startedAt = normalizeUsageTimestamp(
    requiredText(row.started_at),
    'saved usage start time',
  );
  const endedAt = row.ended_at === null
    ? null
    : normalizeUsageTimestamp(requiredText(row.ended_at), 'saved usage end time');
  const status = normalizeUsageRunStatus(requiredText(row.status));
  if ((status === 'running') !== (endedAt === null)) {
    throw new Error('The saved usage run has an invalid status and end-time pair.');
  }
  if (endedAt !== null && endedAt < startedAt) {
    throw new Error('The saved usage run ends before it starts.');
  }
  return {
    agentKind: normalizeUsageCode(requiredText(row.agent_kind), 'saved usage agent kind', 128),
    callId: normalizeUsageIdentifier(requiredText(row.call_id), 'saved usage call ID', 512),
    endedAt,
    errorKind: normalizeOptionalUsageCode(
      row.error_kind === null ? null : requiredText(row.error_kind),
      'saved usage error kind',
      128,
    ),
    finalFinishReason: normalizeOptionalUsageCode(
      row.final_finish_reason === null ? null : requiredText(row.final_finish_reason),
      'saved usage finish reason',
      128,
    ),
    sessionId: normalizeUsageIdentifier(
      requiredText(row.session_id),
      'saved usage session ID',
      512,
    ),
    startedAt,
    status,
    surface: normalizeUsageCode(requiredText(row.surface), 'saved usage surface', 128),
  };
}

function parseUsageStep(row: DatabaseRow): UsageStepRecord {
  return {
    cacheReadInputTokens: parseNullableUsageCount(
      row.cache_read_input_tokens,
      'saved cache-read input token count',
    ),
    cacheWriteInputTokens: parseNullableUsageCount(
      row.cache_write_input_tokens,
      'saved cache-write input token count',
    ),
    callId: normalizeUsageIdentifier(requiredText(row.call_id), 'saved usage call ID', 512),
    finishReason: parseNullableUsageCode(
      row.finish_reason,
      'saved usage finish reason',
      128,
    ),
    groundingCounts: parseGroundingCounts(row.grounding_counts_json),
    inputTokens: parseNullableUsageCount(row.input_tokens, 'saved input token count'),
    modelId: normalizeUsageCode(requiredText(row.model_id), 'saved usage model ID', 256),
    noCacheInputTokens: parseNullableUsageCount(
      row.no_cache_input_tokens,
      'saved uncached input token count',
    ),
    outputTokens: parseNullableUsageCount(row.output_tokens, 'saved output token count'),
    provider: normalizeUsageCode(requiredText(row.provider), 'saved usage provider', 128),
    providerTotalTokens: parseNullableUsageCount(
      row.provider_total_tokens,
      'saved provider total token count',
    ),
    rawFinishReason: parseNullableUsageCode(
      row.raw_finish_reason,
      'saved raw usage finish reason',
      128,
    ),
    reasoningTokens: parseNullableUsageCount(
      row.reasoning_tokens,
      'saved reasoning token count',
    ),
    responseTimeMs: parseNullableUsageDuration(
      row.response_time_ms,
      'saved model response time',
    ),
    serviceTier: parseNullableUsageCode(
      row.service_tier,
      'saved usage service tier',
      128,
    ),
    stepNumber: parseUsageStepNumber(row.step_number),
    stepTimeMs: parseNullableUsageDuration(row.step_time_ms, 'saved model step time'),
    textTokens: parseNullableUsageCount(row.text_tokens, 'saved text token count'),
    timeToFirstOutputMs: parseNullableUsageDuration(
      row.time_to_first_output_ms,
      'saved time to first output',
    ),
    toolUseTokens: parseNullableUsageCount(
      row.tool_use_tokens,
      'saved tool-use token count',
    ),
    totalTokens: parseNullableUsageCount(row.total_tokens, 'saved total token count'),
  };
}

function parseUsageToolCall(row: DatabaseRow): UsageToolCallRecord {
  return {
    callId: normalizeUsageIdentifier(requiredText(row.call_id), 'saved usage call ID', 512),
    dynamic: parseNullableUsageBoolean(row.dynamic, 'saved dynamic tool flag'),
    executionLocation: normalizeUsageToolExecutionLocation(
      requiredText(row.execution_location),
    ),
    executionMs: parseNullableUsageDuration(
      row.execution_ms,
      'saved tool execution time',
    ),
    outcome: normalizeUsageToolOutcome(requiredText(row.outcome)),
    stepNumber: parseUsageStepNumber(row.step_number),
    toolCallId: normalizeUsageIdentifier(
      requiredText(row.tool_call_id),
      'saved usage tool-call ID',
      512,
    ),
    toolName: normalizeUsageCode(requiredText(row.tool_name), 'saved usage tool name', 128),
  };
}

function normalizeUsageRunStatus(value: string): UsageRunStatus {
  if (!['running', 'completed', 'aborted', 'failed'].includes(value)) {
    throw new TypeError('The usage run status is invalid.');
  }
  return value as UsageRunStatus;
}

function normalizeUsageFinalStatus(
  value: UsageRunFinishWrite['status'],
): UsageRunFinishWrite['status'] {
  if (!['completed', 'aborted', 'failed'].includes(value)) {
    throw new TypeError('The final usage run status is invalid.');
  }
  return value;
}

function usageTerminalStatusRank(value: UsageRunStatus): number {
  if (value === 'completed') return 1;
  if (value === 'failed') return 2;
  if (value === 'aborted') return 3;
  return 0;
}

function normalizeUsageToolExecutionLocation(
  value: string,
): UsageToolExecutionLocation {
  if (value !== 'client' && value !== 'provider') {
    throw new TypeError('The tool execution location is invalid.');
  }
  return value;
}

function normalizeUsageToolOutcome(value: string): UsageToolOutcome {
  if (!['returned', 'error', 'invalid', 'cancelled', 'unresolved'].includes(value)) {
    throw new TypeError('The tool outcome is invalid.');
  }
  return value as UsageToolOutcome;
}

function normalizeUsageStepNumber(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000) {
    throw new RangeError('The usage step number must be from 0 through 1000000.');
  }
  return value;
}

function parseUsageStepNumber(value: unknown): number {
  if (typeof value !== 'number') {
    throw new TypeError('The saved usage step number is not a number.');
  }
  return normalizeUsageStepNumber(value);
}

function normalizeUsageCount(value: number | null | undefined, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_USAGE_TOKEN_COUNT
  ) {
    throw new RangeError(
      `The ${label} must be a nonnegative safe integer no greater than ${MAX_USAGE_TOKEN_COUNT}.`,
    );
  }
  return value;
}

function parseNullableUsageCount(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number') {
    throw new TypeError(`The ${label} is not a number.`);
  }
  return normalizeUsageCount(value, label);
}

function normalizeUsageDuration(
  value: number | null | undefined,
  label: string,
): number | null {
  if (value === null || value === undefined) return null;
  if (!Number.isFinite(value) || value < 0 || value > MAX_USAGE_DURATION_MS) {
    throw new RangeError(
      `The ${label} must be a nonnegative finite number no greater than ` +
      `${MAX_USAGE_DURATION_MS} milliseconds (365 days).`,
    );
  }
  return value;
}

function parseNullableUsageDuration(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number') {
    throw new TypeError(`The ${label} is not a number.`);
  }
  return normalizeUsageDuration(value, label);
}

function normalizeUsageBoolean(value: boolean, label: string): boolean {
  if (typeof value !== 'boolean') throw new TypeError(`The ${label} must be a Boolean.`);
  return value;
}

function parseNullableUsageBoolean(value: unknown, label: string): boolean | null {
  if (value === null) return null;
  if (value !== 0 && value !== 1) throw new TypeError(`The ${label} is invalid.`);
  return value === 1;
}

function normalizeUsageText(value: string, label: string, maximumLength: number): string {
  if (typeof value !== 'string') throw new TypeError(`The ${label} must be text.`);
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`The ${label} is required.`);
  if (normalized.length > maximumLength) {
    throw new RangeError(`The ${label} exceeds ${maximumLength} characters.`);
  }
  if (/[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new TypeError(`The ${label} contains a control character.`);
  }
  return normalized;
}

function normalizeUsageCode(value: string, label: string, maximumLength: number): string {
  const normalized = normalizeUsageText(value, label, maximumLength);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+-]*$/u.test(normalized)) {
    throw new TypeError(`The ${label} must use a metadata code.`);
  }
  return normalized;
}

function normalizeUsageIdentifier(
  value: string,
  label: string,
  maximumLength: number,
): string {
  const normalized = normalizeUsageText(value, label, maximumLength);
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:/@+=-]*$/u.test(normalized) &&
    !/^~id-[a-f0-9]{64}$/u.test(normalized)
  ) {
    throw new TypeError(`The ${label} must use an opaque identifier.`);
  }
  return normalized;
}

function normalizeOptionalUsageCode(
  value: string | null | undefined,
  label: string,
  maximumLength: number,
): string | null {
  return value === null || value === undefined
    ? null
    : normalizeUsageCode(value, label, maximumLength);
}

function parseNullableUsageCode(
  value: unknown,
  label: string,
  maximumLength: number,
): string | null {
  if (value === null) return null;
  return normalizeUsageCode(requiredText(value), label, maximumLength);
}

function normalizeUsageTimestamp(value: string, label: string): string {
  const normalized = normalizeUsageText(value, label, 64);
  if (
    normalized !== value ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(normalized)
  ) {
    throw new TypeError(`The ${label} must use canonical ISO 8601 UTC format.`);
  }
  const milliseconds = Date.parse(normalized);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== normalized
  ) {
    throw new TypeError(`The ${label} must use canonical ISO 8601 UTC format.`);
  }
  return normalized;
}

function normalizeGroundingCounts(
  value: Readonly<Record<string, number>> | null | undefined,
): Readonly<Record<string, number>> | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('The grounding counts must use a key and count record.');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 64) {
    throw new RangeError('The grounding counts exceed 64 metric types.');
  }
  const counts = new Map<string, number>();
  for (const [rawKey, rawCount] of entries) {
    const key = normalizeUsageCode(rawKey, 'grounding metric type', 128);
    if (counts.has(key)) throw new TypeError(`The grounding metric ${key} is duplicated.`);
    if (typeof rawCount !== 'number') {
      throw new TypeError(`The grounding metric ${key} is not a number.`);
    }
    const count = normalizeUsageCount(rawCount, `grounding metric ${key}`);
    if (count === null) throw new TypeError(`The grounding metric ${key} is missing.`);
    counts.set(key, count);
  }
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
}

function parseGroundingCounts(value: unknown): Readonly<Record<string, number>> | null {
  if (value === null) return null;
  const json = requiredText(value);
  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    throw new TypeError('The saved grounding counts contain invalid JSON.');
  }
  return normalizeGroundingCounts(parsed as Readonly<Record<string, number>>);
}

function mergeNullableUsageValue<T>(
  current: T | null,
  incoming: T | null,
  label: string,
  equals: (left: T, right: T) => boolean = (left, right) => left === right,
): T | null {
  if (current === null) return incoming;
  if (incoming === null) return current;
  if (!equals(current, incoming)) throw new Error(`The ${label} conflicts with its saved value.`);
  return current;
}

function normalizeUsageQueryLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_USAGE_QUERY_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_USAGE_QUERY_LIMIT) {
    throw new RangeError(
      `The usage query limit must be from 1 through ${MAX_USAGE_QUERY_LIMIT}.`,
    );
  }
  return limit;
}

function validateIncludeUnfinished(value: boolean): void {
  if (typeof value !== 'boolean') {
    throw new TypeError('The include-unfinished option must be a Boolean.');
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

function parseCacheEntry<T>(row: DatabaseRow, now: Date): CacheEntry<T> {
  const expiresAt = requiredText(row.expires_at);
  const staleUntil = requiredText(row.stale_until);
  const valueJson = requiredText(row.value_json);
  const checksum = requiredText(row.checksum);
  if (sha256(valueJson) !== checksum) {
    throw new Error('The cache entry failed its checksum validation.');
  }
  const nowMs = now.getTime();
  const freshness: CacheFreshness =
    nowMs < Date.parse(expiresAt)
      ? 'fresh'
      : nowMs <= Date.parse(staleUntil)
        ? 'stale'
        : 'expired';
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

function validateCacheRevision(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError('The cache revision must be a nonnegative safe integer.');
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
