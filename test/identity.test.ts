import { describe, expect, it } from 'vitest';

import {
  PlayerIdentityRegistry,
  TeamIdentityRegistry,
  buildPlayerIdentityRegistry,
  normalizePlayerName,
  normalizeTeamText,
  playerSeedFromNflverse,
  playerSeedFromSleeper,
} from '../src/identity/index.js';
import type { NflversePlayerWeek } from '../src/nflverse/types.js';

describe('identity normalization', () => {
  it('normalizes punctuation, accents, suffixes, and comma-order names', () => {
    expect(normalizePlayerName('D.J. Moore Jr.')).toBe('dj moore');
    expect(normalizePlayerName('St. Brown, Amon-Ra')).toBe('amon ra st brown');
    expect(normalizePlayerName('José Núñez III')).toBe('jose nunez');
    expect(normalizeTeamText('  Tampa-Bay   Buccaneers ')).toBe(
      'tampa bay buccaneers',
    );
  });
});

describe('TeamIdentityRegistry', () => {
  it('contains each current NFL franchise and resolves common aliases', () => {
    const registry = new TeamIdentityRegistry();

    expect(registry.list()).toHaveLength(32);
    expect(registry.resolve('JAC')).toMatchObject({
      status: 'resolved',
      identity: { canonicalId: 'nfl-team:JAX', code: 'JAX' },
    });
    expect(registry.resolve('Washington Football Team')).toMatchObject({
      status: 'resolved',
      identity: { canonicalId: 'nfl-team:WAS' },
    });
  });

  it('maps historic provider codes to the current franchise identity', () => {
    const registry = new TeamIdentityRegistry();

    expect(registry.resolveSource('nflverse', 'LA')).toMatchObject({ status: 'resolved', identity: { code: 'LAR' } });
    expect(registry.resolveSource('nflverse', 'OAK')).toMatchObject({
      status: 'resolved',
      matchKind: 'source-id',
      identity: { code: 'LV' },
    });
    expect(registry.resolveSource('sleeper', 'STL')).toMatchObject({
      status: 'resolved',
      identity: { code: 'LAR' },
    });
  });

  it('reports an ambiguous city abbreviation instead of guessing', () => {
    const result = new TeamIdentityRegistry().resolve('LA');

    expect(result.status).toBe('ambiguous');
    if (result.status === 'ambiguous') {
      expect(result.candidates.map((team) => team.code)).toEqual([
        'LV',
        'LAC',
        'LAR',
      ]);
      expect(result.reason).toContain('Use a team code');
    }
  });

  it('round-trips a catalog without sharing mutable arrays', () => {
    const original = new TeamIdentityRegistry();
    const restored = TeamIdentityRegistry.deserialize(original.serialize());
    const team = restored.get('nfl-team:BUF');

    expect(restored.list()).toEqual(original.list());
    team?.aliases.push('Mutation');
    expect(restored.resolve('Mutation').status).toBe('not-found');
    expect(() => TeamIdentityRegistry.deserialize('{"schemaVersion":2}')).toThrow(
      'invalid',
    );
  });
});

describe('PlayerIdentityRegistry', () => {
  it('automatically joins unique cross-provider identities', () => {
    const built = buildPlayerIdentityRegistry([
      {
        sourceProvider: 'sleeper',
        sourceId: '4984',
        displayName: 'Josh Allen',
        position: 'qb',
        team: 'BUF',
      },
      {
        sourceProvider: 'nflverse',
        sourceId: '00-0034857',
        displayName: 'Josh Allen',
        position: 'QB',
        team: 'BUF',
      },
    ]);

    expect(built.issues).toEqual([]);
    expect(built.registry.list()).toHaveLength(1);
    expect(built.registry.resolveSource('sleeper', '4984')).toMatchObject({
      status: 'resolved',
      identity: {
        canonicalId: 'nfl-player:nflverse:00-0034857',
        teamId: 'nfl-team:BUF',
      },
    });
  });

  it('uses explicit links when a trade prevents a strict automatic match', () => {
    const sleeper = {
      provider: 'sleeper',
      id: '100',
    } as const;
    const nflverse = {
      provider: 'nflverse',
      id: '00-100',
    } as const;
    const built = buildPlayerIdentityRegistry(
      [
        { sourceProvider: sleeper.provider, sourceId: sleeper.id, displayName: 'Trade Player', position: 'WR', team: 'BUF' },
        { sourceProvider: nflverse.provider, sourceId: nflverse.id, displayName: 'Trade Player', position: 'WR', team: 'KC' },
      ],
      {
        links: [{ canonicalId: 'player:trade-player', members: [sleeper, nflverse] }],
      },
    );

    expect(built.registry.list()).toHaveLength(1);
    expect(built.registry.get('player:trade-player')?.sourceIdentities).toHaveLength(2);
  });

  it('reports same-provider ambiguity and keeps the identities separate', () => {
    const built = buildPlayerIdentityRegistry([
      { sourceProvider: 'sleeper', sourceId: 'one', displayName: 'Chris Smith', position: 'WR', team: 'BUF' },
      { sourceProvider: 'sleeper', sourceId: 'two', displayName: 'Chris Smith', position: 'WR', team: 'BUF' },
      { sourceProvider: 'nflverse', sourceId: 'three', displayName: 'Chris Smith', position: 'WR', team: 'BUF' },
    ]);

    expect(built.issues).toContainEqual(
      expect.objectContaining({ code: 'ambiguous-automatic-match' }),
    );
    expect(built.registry.list()).toHaveLength(3);
    const resolution = built.registry.resolveName('Chris Smith');
    expect(resolution.status).toBe('ambiguous');
    if (resolution.status === 'ambiguous') {
      expect(resolution.candidates).toHaveLength(3);
    }
  });

  it('resolves normalized aliases with optional position and team filters', () => {
    const built = buildPlayerIdentityRegistry([
      {
        sourceProvider: 'sleeper',
        sourceId: 'wr-1',
        displayName: 'D.J. Moore Jr.',
        aliases: ['Denniston Moore'],
        position: 'WR',
        team: 'CHI',
      },
    ]);

    expect(built.registry.resolveName('DJ Moore')).toMatchObject({
      status: 'resolved',
      confidence: 'normalized',
      identity: { normalizedName: 'dj moore' },
    });
    expect(
      built.registry.resolveName({ name: 'Denniston Moore', team: 'CHI', position: 'wr' }),
    ).toMatchObject({ status: 'resolved' });
    expect(
      built.registry.resolveName({ name: 'DJ Moore', team: 'BUF' }),
    ).toMatchObject({ status: 'not-found' });
  });

  it('reports conflicting input and canonical identity data', () => {
    const source = { provider: 'sleeper', id: 'duplicate' };
    const built = buildPlayerIdentityRegistry(
      [
        { sourceProvider: 'sleeper', sourceId: 'duplicate', displayName: 'First Name', position: 'RB' },
        { sourceProvider: 'sleeper', sourceId: 'duplicate', displayName: 'Second Name', position: 'WR' },
        { sourceProvider: 'nflverse', sourceId: 'other', displayName: 'First Name', position: 'RB' },
      ],
      {
        links: [
          { canonicalId: 'player:first', members: [source] },
          { canonicalId: 'player:second', members: [source] },
        ],
      },
    );

    expect(built.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'duplicate-source-identity',
        'conflicting-canonical-ids',
      ]),
    );
  });

  it('serializes player mappings and rejects invalid data', () => {
    const built = buildPlayerIdentityRegistry([
      { sourceProvider: 'sleeper', sourceId: '1', displayName: 'A Player', position: 'RB', team: 'NYJ' },
    ]);
    const restored = PlayerIdentityRegistry.deserialize(built.registry.serialize());

    expect(restored.list()).toEqual(built.registry.list());
    expect(() => PlayerIdentityRegistry.deserialize('{"schemaVersion":1,"players":[{}]}')).toThrow(
      'invalid',
    );
  });

  it('adapts current Sleeper and nflverse player records', () => {
    const sleeper = playerSeedFromSleeper({
      player_id: 's1',
      first_name: 'Amon-Ra',
      last_name: 'St. Brown',
      search_full_name: 'amonra stbrown',
      position: 'WR',
      team: 'DET',
    });
    const nflverse = playerSeedFromNflverse({
      playerId: 'n1',
      playerDisplayName: 'Amon-Ra St. Brown',
      position: 'WR',
      team: 'DET',
    } as NflversePlayerWeek);

    expect(sleeper).toMatchObject({ sourceProvider: 'sleeper', displayName: 'Amon-Ra St. Brown' });
    expect(nflverse).toMatchObject({ sourceProvider: 'nflverse', sourceId: 'n1' });
  });
});
