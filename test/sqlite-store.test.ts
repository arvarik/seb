import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

import { CachedResource } from '../src/data/cached-resource.js';
import {
  getSharedSebDatabase,
  SebDatabase,
} from '../src/data/sqlite-store.js';

const databases: SebDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
});

describe('SebDatabase', () => {
  it('reopens a shared database after its caller closes it', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'seb-shared-database-'));
    const file = resolve(directory, 'seb.sqlite');
    const first = getSharedSebDatabase(file);

    first.close();
    const second = getSharedSebDatabase(file);
    databases.push(second);

    expect(second).not.toBe(first);
    expect(second.status()).toMatchObject({ file: second.file });
  });

  it.runIf(process.platform !== 'win32')('does not change an existing custom directory mode', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'seb-custom-directory-'));
    chmodSync(directory, 0o755);

    const database = new SebDatabase(resolve(directory, 'seb.sqlite'));
    databases.push(database);

    expect(statSync(directory).mode & 0o777).toBe(0o755);
    expect(statSync(database.file).mode & 0o777).toBe(0o600);
  });

  it('migrates a version 1 database to the identity schema', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'seb-sqlite-v1-'));
    const file = resolve(directory, 'seb.sqlite');
    const initial = new SebDatabase(file);
    initial.close();
    const legacy = new Database(file);
    legacy.exec(`
      DROP TABLE identity_links;
      DROP TABLE identities;
      PRAGMA user_version = 1;
    `);
    legacy.close();

    const database = new SebDatabase(file);
    databases.push(database);

    expect(database.status().schemaVersion).toBe(6);
    expect(database.putIdentity({
      canonicalId: 'nfl-team:SEA',
      entityType: 'team',
      sourceIdentities: [{ provider: 'nflverse', id: 'SEA' }],
      value: { canonicalId: 'nfl-team:SEA', code: 'SEA' },
    }).canonicalId).toBe('nfl-team:SEA');
  });

  it('migrates a version 3 database to a durable namespace generation', () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'seb-sqlite-v3-'));
    const file = resolve(directory, 'seb.sqlite');
    const initial = new SebDatabase(file);
    initial.close();
    const legacy = new Database(file);
    legacy.exec(`
      DROP TABLE cache_generations;
      PRAGMA user_version = 3;
    `);
    legacy.close();

    const database = new SebDatabase(file);
    databases.push(database);
    const revision = database.cacheRevision('test');
    database.deleteCache('test', 'migration');

    expect(database.status().schemaVersion).toBe(6);
    expect(revision).toBe(0);
    expect(database.cacheRevision('test')).toBe(1);
    const external = new Database(file, { readonly: true });
    expect(external.prepare('SELECT * FROM cache_generations').all()).toEqual([
      { namespace: 'test', revision: 1 },
    ]);
    external.close();
  });

  it('records a namespace clear before the first cache read', () => {
    const database = createDatabase();

    expect(database.deleteCache('empty', 'missing-key')).toBe(0);

    expect(database.cacheRevision('empty')).toBe(1);
  });

  it('stores versioned cache values and reports freshness', () => {
    const database = createDatabase();
    database.putCache({
      cachedAt: '2026-08-20T12:00:00.000Z',
      key: '2026',
      namespace: 'schedule',
      schemaVersion: 'v1',
      staleIfErrorMs: 2_000,
      ttlMs: 1_000,
      value: [{ gameId: 'game-1' }],
    });

    expect(
      database.getCache('schedule', '2026', new Date('2026-08-20T12:00:00.500Z')),
    ).toMatchObject({ freshness: 'fresh', value: [{ gameId: 'game-1' }] });
    expect(
      database.getCache('schedule', '2026', new Date('2026-08-20T12:00:02.000Z')),
    ).toMatchObject({ freshness: 'stale' });
    expect(
      database.getCache('schedule', '2026', new Date('2026-08-20T12:00:04.000Z')),
    ).toMatchObject({ freshness: 'expired' });
  });

  it('does not apply an old policy update to a replacement cache row', () => {
    const database = createDatabase();
    const oldEntry = database.putCache({
      cachedAt: '2026-08-20T10:00:00.000Z',
      key: 'policy-race',
      namespace: 'test',
      schemaVersion: 'v1',
      staleIfErrorMs: 1_000,
      ttlMs: 1_000,
      value: { version: 'old' },
    });
    const replacement = database.putCache({
      cachedAt: '2026-08-20T12:00:00.000Z',
      key: 'policy-race',
      namespace: 'test',
      schemaVersion: 'v1',
      staleIfErrorMs: 60_000,
      ttlMs: 60_000,
      value: { version: 'new' },
    });

    const updated = database.updateCachePolicy(
      'test',
      'policy-race',
      oldEntry.cachedAt,
      oldEntry.checksum,
      2 * 60 * 60_000,
      60_000,
    );

    expect(updated).toBe(false);
    expect(database.getCache('test', 'policy-race')).toMatchObject({
      cachedAt: replacement.cachedAt,
      expiresAt: replacement.expiresAt,
      value: { version: 'new' },
    });
  });

  it('stores snapshots with provenance and bounds their history', () => {
    const database = createDatabase();
    for (let week = 1; week <= 3; week += 1) {
      database.createSnapshot(
        {
          asOf: `2026-09-${String(week).padStart(2, '0')}T12:00:00.000Z`,
          entityKey: 'BUF',
          kind: 'team-week',
          payload: { week },
          provenance: { source: 'nflverse' },
          schemaVersion: 'v1',
        },
        2,
      );
    }

    const snapshots = database.listSnapshots<{ week: number }>({
      entityKey: 'BUF',
      kind: 'team-week',
    });
    expect(snapshots.map((item) => item.payload.week)).toEqual([3, 2]);
    expect(snapshots[0]?.provenance).toEqual({ source: 'nflverse' });
    const metadata = database.listSnapshotMetadata({ kind: 'team-week' });
    expect(metadata).toHaveLength(2);
    expect(metadata[0]).toMatchObject({
      payloadBytes: expect.any(Number),
      provenanceBytes: expect.any(Number),
      provenanceChecksum: expect.any(String),
    });
    expect(metadata[0]).not.toHaveProperty('payload');
    expect(metadata[0]).not.toHaveProperty('provenance');
  });

  it('rejects snapshot provenance that fails its checksum', () => {
    const database = createDatabase();
    const snapshot = database.createSnapshot({
      entityKey: 'BUF',
      kind: 'team-week',
      payload: { week: 1 },
      provenance: { source: 'nflverse' },
      schemaVersion: 'v1',
    });
    const external = new Database(database.file);
    external.prepare('UPDATE snapshots SET provenance_json = ? WHERE id = ?')
      .run('{"source":"changed"}', snapshot.id);
    external.close();

    expect(() => database.getSnapshot(snapshot.id)).toThrow('provenance checksum');
  });

  it('prunes expired cache records and old snapshot history', () => {
    const database = createDatabase();
    database.putCache({
      cachedAt: '2025-01-01T00:00:00.000Z',
      key: 'old',
      namespace: 'test',
      schemaVersion: 'v1',
      staleIfErrorMs: 1,
      ttlMs: 1,
      value: { old: true },
    });
    for (let index = 0; index < 3; index += 1) {
      database.createSnapshot({
        asOf: `2026-08-${String(10 + index).padStart(2, '0')}T00:00:00.000Z`,
        entityKey: 'BUF',
        kind: 'team-week',
        payload: { index },
        schemaVersion: 'v1',
      });
    }

    const result = database.pruneStorage({
      now: new Date('2026-08-20T00:00:00.000Z'),
      snapshotMaxAgeDays: 30,
      snapshotRetention: 1,
    });

    expect(result.cacheEntriesRemoved).toBe(1);
    expect(result.snapshotsRemoved).toBe(2);
    expect(database.listSnapshotMetadata()).toHaveLength(1);
  });
});

describe('CachedResource', () => {
  it('rejects stale data that expires while a refresh fails', async () => {
    const database = createDatabase();
    const startedAt = Date.now();
    database.putCache({
      cachedAt: new Date(startedAt - 1500).toISOString(),
      key: 'expiring', namespace: 'weather', schemaVersion: 'v1',
      sourceUrl: 'https://weather.test/expiring',
      ttlMs: 1000, staleIfErrorMs: 1000, value: ['old forecast'],
    });
    const resource = new CachedResource(database, 'weather', 'expiring',
      'https://weather.test/expiring',
      { schemaVersion: 'v1', ttlMs: 1000, staleIfErrorMs: 1000 });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(startedAt);
    try {
      await expect(resource.read(async () => {
        clock.mockReturnValue(startedAt + 501);
        throw new Error('refresh failed');
      })).rejects.toThrow('refresh failed');
    } finally {
      clock.mockRestore();
    }
  });

  it('revalidates with conditional metadata', async () => {
    const database = createDatabase();
    database.putCache({
      cachedAt: '2026-08-20T12:00:00.000Z',
      etag: 'etag-1',
      key: 'hourly',
      namespace: 'weather',
      schemaVersion: 'v1',
      sourceUrl: 'https://weather.test/hourly',
      staleIfErrorMs: 100_000_000,
      ttlMs: 1,
      value: { periods: 10 },
    });
    const resource = new CachedResource<{ periods: number }>(
      database,
      'weather',
      'hourly',
      'https://weather.test/hourly',
      { schemaVersion: 'v1', staleIfErrorMs: 60_000, ttlMs: 10_000 },
    );

    const result = await resource.read(async (context) => {
      expect(context.etag).toBe('etag-1');
      return { notModified: true };
    });

    expect(result.outcome).toBe('source-not-modified');
    expect(result.value.periods).toBe(10);
  });

  it('uses a stale value after a temporary source failure', async () => {
    const database = createDatabase();
    database.putCache({
      cachedAt: new Date(Date.now() - 60_000).toISOString(),
      key: 'alerts',
      namespace: 'weather',
      schemaVersion: 'v1',
      sourceUrl: 'https://weather.test/alerts',
      staleIfErrorMs: 100_000_000,
      ttlMs: 1,
      value: ['cached alert'],
    });
    const resource = new CachedResource<string[]>(
      database,
      'weather',
      'alerts',
      'https://weather.test/alerts',
      { schemaVersion: 'v1', staleIfErrorMs: 60_000, ttlMs: 10_000 },
    );

    const result = await resource.read(async () => {
      throw new Error('temporary outage');
    });

    expect(result.outcome).toBe('stale-if-error');
    expect(result.value).toEqual(['cached alert']);
    expect(result.error).toContain('temporary outage');
  });

  it('does not reuse a cache entry from a different source URL', async () => {
    const database = createDatabase();
    database.putCache({
      cachedAt: new Date().toISOString(),
      etag: 'source-a-etag',
      key: 'shared-key',
      namespace: 'test',
      schemaVersion: 'v1',
      sourceUrl: 'https://source-a.test/data',
      staleIfErrorMs: 60_000,
      ttlMs: 60_000,
      value: { source: 'a' },
    });
    const resource = new CachedResource<{ source: string }>(
      database,
      'test',
      'shared-key',
      'https://source-b.test/data',
      { schemaVersion: 'v1', staleIfErrorMs: 60_000, ttlMs: 60_000 },
    );
    let loads = 0;

    const result = await resource.read(async (context) => {
      loads += 1;
      expect(context.etag).toBeNull();
      return { value: { source: 'b' } };
    });

    expect(loads).toBe(1);
    expect(result).toMatchObject({
      outcome: 'source-updated',
      value: { source: 'b' },
    });
    expect(database.getCache<{ source: string }>('test', 'shared-key')).toMatchObject({
      sourceUrl: 'https://source-b.test/data',
      value: { source: 'b' },
    });
  });

  it('does not renew or return a replacement row after a 304 response', async () => {
    const database = createDatabase();
    database.putCache({
      cachedAt: new Date(Date.now() - 30_000).toISOString(),
      etag: 'source-a-etag',
      key: 'conditional-race',
      namespace: 'test',
      schemaVersion: 'v1',
      sourceUrl: 'https://source-a.test/data',
      staleIfErrorMs: 60_000,
      ttlMs: 1_000,
      value: { source: 'a' },
    });
    const policy = { schemaVersion: 'v1', staleIfErrorMs: 60_000, ttlMs: 1_000 };
    const sourceA = new CachedResource<{ source: string }>(
      database,
      'test',
      'conditional-race',
      'https://source-a.test/data',
      policy,
    );
    const sourceB = new CachedResource<{ source: string }>(
      database,
      'test',
      'conditional-race',
      'https://source-b.test/data',
      policy,
    );
    let markSourceAStarted!: () => void;
    let releaseSourceA!: () => void;
    const sourceAStarted = new Promise<void>((resolveStarted) => {
      markSourceAStarted = resolveStarted;
    });
    const sourceAGate = new Promise<void>((resolveSourceA) => {
      releaseSourceA = resolveSourceA;
    });

    const pendingSourceA = sourceA.read(async (context) => {
      expect(context.etag).toBe('source-a-etag');
      markSourceAStarted();
      await sourceAGate;
      return { notModified: true };
    });
    await sourceAStarted;
    const sourceBResult = await sourceB.read(async () => ({
      etag: 'source-b-etag',
      value: { source: 'b' },
    }));
    releaseSourceA();
    const sourceAResult = await pendingSourceA;

    expect(sourceAResult).toMatchObject({
      cache: { sourceUrl: 'https://source-a.test/data' },
      outcome: 'source-not-modified',
      value: { source: 'a' },
    });
    expect(sourceBResult.value).toEqual({ source: 'b' });
    expect(database.getCache<{ source: string }>('test', 'conditional-race')).toMatchObject({
      etag: 'source-b-etag',
      sourceUrl: 'https://source-b.test/data',
      value: { source: 'b' },
    });
  });

  it('does not renew a 304 response after the namespace revision changes', async () => {
    const database = createDatabase();
    const oldCachedAt = new Date(Date.now() - 30_000).toISOString();
    database.putCache({
      cachedAt: oldCachedAt,
      etag: 'etag-1',
      key: 'conditional-clear',
      namespace: 'test',
      schemaVersion: 'v1',
      sourceUrl: 'https://example.test/conditional-clear',
      staleIfErrorMs: 60_000,
      ttlMs: 1_000,
      value: { version: 'cached' },
    });
    const resource = new CachedResource<{ version: string }>(
      database,
      'test',
      'conditional-clear',
      'https://example.test/conditional-clear',
      { schemaVersion: 'v1', staleIfErrorMs: 60_000, ttlMs: 1_000 },
    );
    let markLoadStarted!: () => void;
    let releaseLoad!: () => void;
    const loadStarted = new Promise<void>((resolveStarted) => {
      markLoadStarted = resolveStarted;
    });
    const loadGate = new Promise<void>((resolveLoad) => {
      releaseLoad = resolveLoad;
    });

    const pending = resource.read(async () => {
      markLoadStarted();
      await loadGate;
      return { notModified: true };
    });
    await loadStarted;
    database.deleteCache('test', 'another-key');
    releaseLoad();
    const result = await pending;

    expect(result).toMatchObject({
      outcome: 'source-not-modified',
      value: { version: 'cached' },
    });
    expect(result.cache.cachedAt).not.toBe(oldCachedAt);
    expect(database.getCache('test', 'conditional-clear')).toMatchObject({
      cachedAt: oldCachedAt,
      value: { version: 'cached' },
    });
  });

  it('continues with a live load after a cache read fails', async () => {
    const database = createDatabase();
    vi.spyOn(database, 'getCache').mockImplementationOnce(() => {
      throw new Error('disk read failed');
    });
    const resource = new CachedResource<{ ok: boolean }>(
      database,
      'test',
      'read-failure',
      'https://example.test/read-failure',
      { schemaVersion: 'v1', staleIfErrorMs: 60_000, ttlMs: 60_000 },
    );

    const result = await resource.read(async () => ({ value: { ok: true } }));

    expect(result).toMatchObject({
      outcome: 'source-updated',
      value: { ok: true },
      warnings: ['Seb could not read the local cache: disk read failed'],
    });
    expect(database.getCache('test', 'read-failure')).toMatchObject({
      value: { ok: true },
    });
  });

  it('applies the current resource TTL to an existing cache entry', async () => {
    const database = createDatabase();
    const cachedAt = new Date(Date.now() - 60_000).toISOString();
    database.putCache({
      cachedAt,
      key: 'policy-change',
      namespace: 'test',
      schemaVersion: 'v1',
      sourceUrl: 'https://example.test/policy-change',
      staleIfErrorMs: 60 * 60_000,
      ttlMs: 24 * 60 * 60_000,
      value: { version: 'old' },
    });
    expect(database.getCache('test', 'policy-change')).toMatchObject({
      freshness: 'fresh',
    });
    const resource = new CachedResource<{ version: string }>(
      database,
      'test',
      'policy-change',
      'https://example.test/policy-change',
      { schemaVersion: 'v1', staleIfErrorMs: 1_000, ttlMs: 1_000 },
    );
    let loads = 0;

    const result = await resource.read(async () => {
      loads += 1;
      return { value: { version: 'new' } };
    });

    expect(loads).toBe(1);
    expect(result).toMatchObject({
      outcome: 'source-updated',
      value: { version: 'new' },
    });
  });

  it('persists the current resource TTL before storage pruning', async () => {
    const database = createDatabase();
    const cachedAt = new Date(Date.now() - 60_000).toISOString();
    database.putCache({
      cachedAt,
      key: 'longer-policy',
      namespace: 'test',
      schemaVersion: 'v1',
      sourceUrl: 'https://example.test/longer-policy',
      staleIfErrorMs: 1,
      ttlMs: 1,
      value: { version: 'cached' },
    });
    const resource = new CachedResource<{ version: string }>(
      database,
      'test',
      'longer-policy',
      'https://example.test/longer-policy',
      {
        schemaVersion: 'v1',
        staleIfErrorMs: 60 * 60_000,
        ttlMs: 60 * 60_000,
      },
    );
    const load = vi.fn(async () => ({ value: { version: 'live' } }));

    const result = await resource.read(load);
    const pruned = database.pruneStorage({ now: new Date() });

    expect(result).toMatchObject({
      outcome: 'cache-fresh',
      value: { version: 'cached' },
    });
    expect(load).not.toHaveBeenCalled();
    expect(pruned.cacheEntriesRemoved).toBe(0);
    expect(database.getCache('test', 'longer-policy')).toMatchObject({
      freshness: 'fresh',
      value: { version: 'cached' },
    });
  });

  it('returns fresh in-memory timestamps when a 304 cache renewal fails', async () => {
    const database = createDatabase();
    const oldCachedAt = new Date(Date.now() - 120_000).toISOString();
    const ttlMs = 60_000;
    const staleIfErrorMs = 10 * 60_000;
    database.putCache({
      cachedAt: oldCachedAt,
      etag: 'etag-1',
      key: 'touch-failure',
      namespace: 'test',
      schemaVersion: 'v1',
      sourceUrl: 'https://example.test/touch-failure',
      staleIfErrorMs,
      ttlMs,
      value: { ok: true },
    });
    vi.spyOn(database, 'touchCache').mockImplementationOnce(() => {
      throw new Error('disk full');
    });
    const resource = new CachedResource<{ ok: boolean }>(
      database,
      'test',
      'touch-failure',
      'https://example.test/touch-failure',
      { schemaVersion: 'v1', staleIfErrorMs, ttlMs },
    );
    const before = Date.now();

    const result = await resource.read(async () => ({ notModified: true }));
    const after = Date.now();
    const refreshedAt = Date.parse(result.cache.cachedAt);

    expect(result.outcome).toBe('source-not-modified');
    expect(result.cache.freshness).toBe('fresh');
    expect(result.cache.cachedAt).not.toBe(oldCachedAt);
    expect(refreshedAt).toBeGreaterThanOrEqual(before);
    expect(refreshedAt).toBeLessThanOrEqual(after);
    expect(Date.parse(result.cache.expiresAt) - refreshedAt).toBe(ttlMs);
    expect(Date.parse(result.cache.staleUntil) - refreshedAt).toBe(
      ttlMs + staleIfErrorMs,
    );
    expect(result.warnings).toEqual([
      'Seb could not renew the local cache: disk full',
    ]);
  });

  it('shares one load while one single-flight waiter cancels', async () => {
    const database = createDatabase();
    const policy = {
      schemaVersion: 'v1',
      snapshotKind: 'single-flight-test',
      staleIfErrorMs: 60_000,
      ttlMs: 60_000,
    };
    const firstResource = new CachedResource<{ ok: boolean }>(
      database,
      'test',
      'single-flight',
      'https://example.test/single-flight',
      policy,
    );
    const secondResource = new CachedResource<{ ok: boolean }>(
      database,
      'test',
      'single-flight',
      'https://example.test/single-flight',
      policy,
    );
    let releaseLoad!: () => void;
    const loadGate = new Promise<void>((resolveGate) => {
      releaseLoad = resolveGate;
    });
    let sharedSignal!: AbortSignal;
    const load = vi.fn(async (context: { signal: AbortSignal }) => {
      sharedSignal = context.signal;
      await loadGate;
      return { value: { ok: true } };
    });
    const firstController = new AbortController();
    const secondController = new AbortController();

    const first = firstResource.read(load, { signal: firstController.signal });
    const second = secondResource.read(load, { signal: secondController.signal });
    const reason = new DOMException('The first waiter stopped.', 'AbortError');
    const firstRejection = expect(first).rejects.toBe(reason);
    firstController.abort(reason);

    await firstRejection;
    expect(sharedSignal.aborted).toBe(false);
    releaseLoad();
    await expect(second).resolves.toMatchObject({ value: { ok: true } });
    expect(load).toHaveBeenCalledTimes(1);
    expect(database.listSnapshots({ kind: 'single-flight-test' })).toHaveLength(1);
  });

  it('does not join or persist a source load that started before a cache clear', async () => {
    const database = createDatabase();
    const resource = new CachedResource<{ version: number }>(
      database,
      'test',
      'clear-flight',
      'https://example.test/clear-flight',
      {
        schemaVersion: 'v1',
        snapshotKind: 'clear-flight-test',
        staleIfErrorMs: 60_000,
        ttlMs: 60_000,
      },
    );
    let markFirstLoadStarted!: () => void;
    let releaseFirstLoad!: () => void;
    const firstLoadStarted = new Promise<void>((resolveStarted) => {
      markFirstLoadStarted = resolveStarted;
    });
    const firstLoadGate = new Promise<void>((resolveLoad) => {
      releaseFirstLoad = resolveLoad;
    });
    let loads = 0;
    const load = vi.fn(async () => {
      loads += 1;
      const version = loads;
      if (version === 1) {
        markFirstLoadStarted();
        await firstLoadGate;
      }
      return { value: { version } };
    });

    const first = resource.read(load);
    await firstLoadStarted;
    database.deleteCache('test');
    const secondResult = await resource.read(load);
    releaseFirstLoad();
    const firstResult = await first;

    expect(load).toHaveBeenCalledTimes(2);
    expect(firstResult.value).toEqual({ version: 1 });
    expect(secondResult.value).toEqual({ version: 2 });
    expect(database.getCache<{ version: number }>('test', 'clear-flight')).toMatchObject({
      value: { version: 2 },
    });
    expect(database.listSnapshots<{ version: number }>({
      kind: 'clear-flight-test',
    })).toMatchObject([{ payload: { version: 2 } }]);
  });

  it('honors a cache clear from another process while a source load runs', async () => {
    const database = createDatabase();
    const resource = new CachedResource<{ version: number }>(
      database,
      'test',
      'cross-process-clear',
      'https://example.test/cross-process-clear',
      {
        schemaVersion: 'v1',
        snapshotKind: 'cross-process-clear-test',
        staleIfErrorMs: 60_000,
        ttlMs: 60_000,
      },
    );
    let markFirstLoadStarted!: () => void;
    let releaseFirstLoad!: () => void;
    const firstLoadStarted = new Promise<void>((resolveStarted) => {
      markFirstLoadStarted = resolveStarted;
    });
    const firstLoadGate = new Promise<void>((resolveLoad) => {
      releaseFirstLoad = resolveLoad;
    });
    let loads = 0;
    const load = vi.fn(async () => {
      loads += 1;
      const version = loads;
      if (version === 1) {
        markFirstLoadStarted();
        await firstLoadGate;
      }
      return { value: { version } };
    });

    const first = resource.read(load);
    await firstLoadStarted;
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '--eval',
        [
          "import { SebDatabase } from './src/data/sqlite-store.ts';",
          'const database = new SebDatabase(process.argv[1]);',
          "database.deleteCache('test');",
          'database.close();',
        ].join('\n'),
        database.file,
      ],
      { cwd: process.cwd(), encoding: 'utf8' },
    );
    const second = resource.read(load);
    releaseFirstLoad();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(child.stderr).toBe('');
    expect(child.status).toBe(0);
    expect(load).toHaveBeenCalledTimes(2);
    expect(firstResult.value).toEqual({ version: 1 });
    expect(secondResult.value).toEqual({ version: 2 });
    expect(database.getCache<{ version: number }>('test', 'cross-process-clear'))
      .toMatchObject({ value: { version: 2 } });
    expect(database.listSnapshots<{ version: number }>({
      kind: 'cross-process-clear-test',
    })).toMatchObject([{ payload: { version: 2 } }]);
  });

  it('shares one load across database objects for the same file', async () => {
    const directory = mkdtempSync(resolve(tmpdir(), 'seb-shared-flight-'));
    const file = resolve(directory, 'seb.sqlite');
    const firstDatabase = new SebDatabase(file);
    const secondDatabase = new SebDatabase(file);
    databases.push(firstDatabase, secondDatabase);
    const policy = {
      schemaVersion: 'v1',
      snapshotKind: 'database-flight-test',
      staleIfErrorMs: 60_000,
      ttlMs: 60_000,
    };
    const firstResource = new CachedResource<{ version: string }>(
      firstDatabase,
      'test',
      'database-flight',
      'https://example.test/database-flight',
      policy,
    );
    const secondResource = new CachedResource<{ version: string }>(
      secondDatabase,
      'test',
      'database-flight',
      'https://example.test/database-flight',
      policy,
    );
    let releaseLoad!: () => void;
    let markLoadStarted!: () => void;
    const loadStarted = new Promise<void>((resolveStarted) => {
      markLoadStarted = resolveStarted;
    });
    const loadGate = new Promise<void>((resolveLoad) => {
      releaseLoad = resolveLoad;
    });
    const load = vi.fn(async () => {
      markLoadStarted();
      await loadGate;
      return { value: { version: 'new' } };
    });

    const first = firstResource.read(load);
    await loadStarted;
    const second = secondResource.read(load);
    releaseLoad();

    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { value: { version: 'new' } },
      { value: { version: 'new' } },
    ]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(secondDatabase.getCache('test', 'database-flight')).toMatchObject({
      value: { version: 'new' },
    });
    expect(firstDatabase.listSnapshots({ kind: 'database-flight-test' })).toHaveLength(1);
  });

  it('shares a 304 result with a waiter whose cache read failed', async () => {
    const database = createDatabase();
    database.putCache({
      cachedAt: new Date(Date.now() - 30_000).toISOString(),
      etag: 'etag-1',
      key: 'shared-not-modified',
      namespace: 'test',
      schemaVersion: 'v1',
      sourceUrl: 'https://example.test/shared-not-modified',
      staleIfErrorMs: 60_000,
      ttlMs: 1_000,
      value: { version: 'cached' },
    });
    const policy = { schemaVersion: 'v1', staleIfErrorMs: 60_000, ttlMs: 1_000 };
    const firstResource = new CachedResource<{ version: string }>(
      database,
      'test',
      'shared-not-modified',
      'https://example.test/shared-not-modified',
      policy,
    );
    const secondResource = new CachedResource<{ version: string }>(
      database,
      'test',
      'shared-not-modified',
      'https://example.test/shared-not-modified',
      policy,
    );
    let markLoadStarted!: () => void;
    let releaseLoad!: () => void;
    const loadStarted = new Promise<void>((resolveStarted) => {
      markLoadStarted = resolveStarted;
    });
    const loadGate = new Promise<void>((resolveLoad) => {
      releaseLoad = resolveLoad;
    });
    const load = vi.fn(async () => {
      markLoadStarted();
      await loadGate;
      return { notModified: true as const };
    });

    const first = firstResource.read(load);
    await loadStarted;
    vi.spyOn(database, 'getCache').mockImplementationOnce(() => {
      throw new Error('second cache read failed');
    });
    const second = secondResource.read(load);
    releaseLoad();

    await expect(Promise.all([first, second])).resolves.toMatchObject([
      { outcome: 'source-not-modified', value: { version: 'cached' } },
      {
        outcome: 'source-not-modified',
        value: { version: 'cached' },
        warnings: ['Seb could not read the local cache: second cache read failed'],
      },
    ]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('uses each waiters stale value after a shared source failure', async () => {
    const database = createDatabase();
    database.putCache({
      cachedAt: new Date(Date.now() - 30_000).toISOString(),
      key: 'isolated-stale',
      namespace: 'test',
      schemaVersion: 'v1',
      sourceUrl: 'https://example.test/isolated-stale',
      staleIfErrorMs: 60_000,
      ttlMs: 1_000,
      value: { version: 'stale' },
    });
    vi.spyOn(database, 'getCache').mockImplementationOnce(() => {
      throw new Error('first cache read failed');
    });
    const policy = { schemaVersion: 'v1', staleIfErrorMs: 60_000, ttlMs: 1_000 };
    const firstResource = new CachedResource<{ version: string }>(
      database,
      'test',
      'isolated-stale',
      'https://example.test/isolated-stale',
      policy,
    );
    const secondResource = new CachedResource<{ version: string }>(
      database,
      'test',
      'isolated-stale',
      'https://example.test/isolated-stale',
      policy,
    );
    let markLoadStarted!: () => void;
    let releaseLoad!: () => void;
    const loadStarted = new Promise<void>((resolveStarted) => {
      markLoadStarted = resolveStarted;
    });
    const loadGate = new Promise<void>((resolveLoad) => {
      releaseLoad = resolveLoad;
    });
    const load = vi.fn(async () => {
      markLoadStarted();
      await loadGate;
      throw new Error('shared source failed');
    });

    const first = firstResource.read(load);
    const firstRejection = expect(first).rejects.toThrow('shared source failed');
    await loadStarted;
    const second = secondResource.read(load);
    releaseLoad();

    await firstRejection;
    await expect(second).resolves.toMatchObject({
      error: 'shared source failed',
      outcome: 'stale-if-error',
      value: { version: 'stale' },
    });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('clears a single flight after every waiter cancels', async () => {
    const database = createDatabase();
    const policy = { schemaVersion: 'v1', staleIfErrorMs: 60_000, ttlMs: 60_000 };
    const firstResource = new CachedResource<{ ok: boolean }>(
      database,
      'test',
      'cancelled-flight',
      'https://example.test/cancelled-flight',
      policy,
    );
    const secondResource = new CachedResource<{ ok: boolean }>(
      database,
      'test',
      'cancelled-flight',
      'https://example.test/cancelled-flight',
      policy,
    );
    let sharedSignal!: AbortSignal;
    const blockedLoad = vi.fn(async (context: { signal: AbortSignal }) => {
      sharedSignal = context.signal;
      return await new Promise<{ value: { ok: boolean } }>((_resolve, reject) => {
        context.signal.addEventListener(
          'abort',
          () => reject(context.signal.reason),
          { once: true },
        );
      });
    });
    const firstController = new AbortController();
    const secondController = new AbortController();
    const firstReason = new DOMException('The first waiter stopped.', 'AbortError');
    const secondReason = new DOMException('The second waiter stopped.', 'AbortError');

    const first = firstResource.read(blockedLoad, { signal: firstController.signal });
    const second = secondResource.read(blockedLoad, { signal: secondController.signal });
    const firstRejection = expect(first).rejects.toBe(firstReason);
    const secondRejection = expect(second).rejects.toBe(secondReason);
    firstController.abort(firstReason);
    expect(sharedSignal.aborted).toBe(false);
    secondController.abort(secondReason);

    await Promise.all([firstRejection, secondRejection]);
    expect(sharedSignal.aborted).toBe(true);
    expect(blockedLoad).toHaveBeenCalledTimes(1);
    await expect(
      firstResource.read(async () => ({ value: { ok: true } })),
    ).resolves.toMatchObject({ value: { ok: true } });
  });

  it('captures field lineage in each source snapshot', async () => {
    const database = createDatabase();
    const resource = new CachedResource<{ player: { id: string; points: number } }>(
      database,
      'nflverse',
      'player-week-2025',
      'https://example.test/player-week.csv',
      {
        schemaVersion: 'v1',
        snapshotKind: 'nflverse-player-week',
        staleIfErrorMs: 60_000,
        ttlMs: 60_000,
      },
    );

    await resource.read(async () => ({
      value: { player: { id: '00-1', points: 24.5 } },
    }));

    const snapshot = database.listSnapshots({ kind: 'nflverse-player-week' })[0];
    expect(snapshot?.provenance).toMatchObject({
      schemaVersion: 1,
      fields: {
        '/player/id': { sourceIds: ['nflverse:player-week-2025'] },
        '/player/points': { sourceIds: ['nflverse:player-week-2025'] },
      },
    });
  });

  it('returns a valid source response when the cache write fails', async () => {
    const failingDatabase = {
      cacheRevision: () => 0,
      file: 'failing-database',
      getCache: () => null,
      putCache: () => {
        throw new Error('disk full');
      },
    } as unknown as SebDatabase;
    const resource = new CachedResource(
      failingDatabase,
      'test',
      'key',
      'https://example.test/data',
      { schemaVersion: 'v1', staleIfErrorMs: 60_000, ttlMs: 60_000 },
    );

    const result = await resource.read(async () => ({ value: { ok: true } }));

    expect(result).toMatchObject({ outcome: 'source-updated', value: { ok: true } });
    expect(result.warnings).toEqual([
      'Seb could not save the local cache: disk full',
    ]);
  });

  it('deletes an invalid cached value before it requests the source', async () => {
    const database = createDatabase();
    database.putCache({
      key: 'validated',
      namespace: 'test',
      schemaVersion: 'v1',
      sourceUrl: 'https://example.test/data',
      staleIfErrorMs: 60_000,
      ttlMs: 60_000,
      value: { ok: 'wrong' },
    });
    const resource = new CachedResource<{ ok: boolean }>(
      database,
      'test',
      'validated',
      'https://example.test/data',
      {
        schemaVersion: 'v1',
        staleIfErrorMs: 60_000,
        ttlMs: 60_000,
        validate: (value) => {
          if (!value || typeof value !== 'object' || typeof (value as { ok?: unknown }).ok !== 'boolean') {
            throw new Error('invalid value');
          }
          return value as { ok: boolean };
        },
      },
    );

    const result = await resource.read(async () => ({ value: { ok: true } }));

    expect(result.outcome).toBe('source-updated');
    expect(result.value).toEqual({ ok: true });
  });
});

function createDatabase(): SebDatabase {
  const directory = mkdtempSync(resolve(tmpdir(), 'seb-sqlite-'));
  const database = new SebDatabase(resolve(directory, 'seb.sqlite'));
  databases.push(database);
  return database;
}
