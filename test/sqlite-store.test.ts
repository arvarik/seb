import { chmodSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { CachedResource } from '../src/data/cached-resource.js';
import { SebDatabase } from '../src/data/sqlite-store.js';

const databases: SebDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
});

describe('SebDatabase', () => {
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

    expect(database.status().schemaVersion).toBe(3);
    expect(database.putIdentity({
      canonicalId: 'nfl-team:SEA',
      entityType: 'team',
      sourceIdentities: [{ provider: 'nflverse', id: 'SEA' }],
      value: { canonicalId: 'nfl-team:SEA', code: 'SEA' },
    }).canonicalId).toBe('nfl-team:SEA');
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
  it('revalidates with conditional metadata', async () => {
    const database = createDatabase();
    database.putCache({
      cachedAt: '2026-08-20T12:00:00.000Z',
      etag: 'etag-1',
      key: 'hourly',
      namespace: 'weather',
      schemaVersion: 'v1',
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
