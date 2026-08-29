import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SebDatabase } from '../src/data/sqlite-store.js';
import { SleeperClient } from '../src/sleeper/client.js';
import { SourceTracker } from '../src/sources.js';

const databases: SebDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('source client resilience', () => {
  it('returns an eligible stale Sleeper value and records the failed refresh', async () => {
    const database = createDatabase();
    const url = 'https://api.sleeper.app/v1/league/123';
    database.putCache({
      cachedAt: new Date(Date.now() - 10 * 60 * 1_000).toISOString(),
      key: url,
      namespace: 'sleeper',
      schemaVersion: 'sleeper-v2',
      sourceUrl: url,
      staleIfErrorMs: 60 * 60 * 1_000,
      ttlMs: 5 * 60 * 1_000,
      value: {
        league_id: '123',
        name: 'Reliable League',
        roster_positions: [],
        scoring_settings: {},
        season: '2026',
        season_type: 'regular',
        settings: {},
        sport: 'nfl',
        status: 'in_season',
        total_rosters: 12,
      },
    });
    const sources = new SourceTracker();
    const client = new SleeperClient({
      database,
      fetch: async () => {
        throw new Error('temporary network outage');
      },
      onSource: sources.record,
      policy: { maxAttempts: 1 },
    });

    const league = await client.getLeague('123');

    expect(league).toMatchObject({ league_id: '123', name: 'Reliable League' });
    expect(sources.list()[0]).toMatchObject({
      cacheOutcome: 'stale-if-error',
      retrievedAt: expect.any(String),
      error: expect.stringContaining('temporary network outage'),
    });
  });
});

function createDatabase(): SebDatabase {
  const directory = mkdtempSync(resolve(tmpdir(), 'seb-client-resilience-'));
  const database = new SebDatabase(resolve(directory, 'seb.sqlite'));
  databases.push(database);
  return database;
}
