import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SebDatabase } from '../src/data/sqlite-store.js';
import { IdentityRepository } from '../src/identity/repository.js';

describe('IdentityRepository', () => {
  it('keeps the first canonical player ID after a later cross-source match', () => {
    const database = new SebDatabase(
      resolve(mkdtempSync(resolve(tmpdir(), 'seb-identity-')), 'seb.sqlite'),
    );
    const repository = new IdentityRepository(database);
    const first = repository.savePlayer({
      aliases: ['Josh Allen'],
      canonicalId: 'nfl-player:sleeper:4984',
      displayName: 'Josh Allen',
      normalizedName: 'josh allen',
      position: 'QB',
      sourceIdentities: [{ provider: 'sleeper', id: '4984' }],
      teamId: 'nfl-team:BUF',
    });
    const linked = repository.savePlayer({
      aliases: ['Josh Allen'],
      canonicalId: 'nfl-player:nflverse:00-0034857',
      displayName: 'Josh Allen',
      normalizedName: 'josh allen',
      position: 'QB',
      sourceIdentities: [
        { provider: 'nflverse', id: '00-0034857' },
        { provider: 'sleeper', id: '4984' },
      ],
      teamId: 'nfl-team:BUF',
    });

    expect(first.canonicalId).toBe('nfl-player:sleeper:4984');
    expect(linked.canonicalId).toBe(first.canonicalId);
    expect(repository.getPlayerBySource('nflverse', '00-0034857')).toMatchObject({
      canonicalId: first.canonicalId,
      sourceIdentities: [
        { provider: 'nflverse', id: '00-0034857' },
        { provider: 'sleeper', id: '4984' },
      ],
    });
    database.close();
  });
});
