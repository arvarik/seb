import { describe, expect, it } from 'vitest';

import { createIdentityTools } from '../src/identity/tools.js';
import type { NflverseClient } from '../src/nflverse/client.js';
import type { SleeperClient } from '../src/sleeper/client.js';

describe('identity tools', () => {
  it('links exact Sleeper and nflverse records', async () => {
    const sleeper = {
      findPlayers: async () => [
        { player_id: 'sleeper-1', full_name: 'Josh Allen', position: 'QB', team: 'BUF' },
      ],
    } as unknown as SleeperClient;
    const nflverse = {
      getPlayerWeeklyStats: async () => [
        {
          playerId: 'nflverse-1',
          playerDisplayName: 'Josh Allen',
          position: 'QB',
          team: 'BUF',
        },
      ],
    } as unknown as NflverseClient;
    const tools = createIdentityTools(sleeper, nflverse, { repository: false });

    const result = await tools.resolvePlayerIdentity.execute?.(
      { name: 'Josh Allen', season: 2025, position: 'QB', team: 'Buffalo Bills' },
      { context: {}, messages: [], toolCallId: 'test' },
    );

    expect(result).toMatchObject({
      resolution: {
        status: 'resolved',
        identity: {
          canonicalId: 'nfl-player:nflverse:nflverse-1',
          sourceIdentities: [
            { provider: 'nflverse', id: 'nflverse-1' },
            { provider: 'sleeper', id: 'sleeper-1' },
          ],
        },
      },
    });
  });

  it('returns ambiguity for a shared city alias', async () => {
    const tools = createIdentityTools(
      {} as SleeperClient,
      {} as NflverseClient,
      { repository: false },
    );
    const result = await tools.resolveTeamIdentity.execute?.(
      { query: 'LA' },
      { context: {}, messages: [], toolCallId: 'test' },
    );

    expect(result).toMatchObject({ status: 'ambiguous' });
  });

  it('resolves a player by numeric ID and links Sleeper gsis_id to nflverse', async () => {
    const sleeper = {
      findPlayers: async () => [
        { player_id: '650', full_name: 'Nick Folk', position: 'K', team: 'ATL', gsis_id: '00-0025565' },
      ],
    } as unknown as SleeperClient;
    const nflverse = {
      getPlayerWeeklyStats: async ({ playerName }: { playerName?: string }) =>
        playerName === 'Nick Folk'
          ? [
              {
                playerId: '00-0025565',
                playerDisplayName: 'Nick Folk',
                position: 'K',
                team: 'TEN',
              },
            ]
          : [],
    } as unknown as NflverseClient;
    const tools = createIdentityTools(sleeper, nflverse, { repository: false });

    const result = await tools.resolvePlayerIdentity.execute?.(
      { name: '650', season: 2026 },
      { context: {}, messages: [], toolCallId: 'test-650' },
    );

    expect(result).toMatchObject({
      resolution: {
        status: 'resolved',
        identity: {
          canonicalId: 'nfl-player:nflverse:00-0025565',
          displayName: 'Nick Folk',
          sourceIdentities: expect.arrayContaining([
            { provider: 'nflverse', id: '00-0025565' },
            { provider: 'sleeper', id: '650' },
          ]),
        },
      },
    });
  });

  it('resolves a Sleeper player without mapped nflverse stats to their canonical identity', async () => {
    const sleeper = {
      findPlayers: async () => [
        { player_id: 'sleeper-unmapped', full_name: 'Rookie Unmapped', position: 'RB', team: 'SEA' },
      ],
    } as unknown as SleeperClient;
    const nflverse = {
      getPlayerWeeklyStats: async () => [],
    } as unknown as NflverseClient;
    const tools = createIdentityTools(sleeper, nflverse, { repository: false });

    const result = await tools.resolvePlayerIdentity.execute?.(
      { name: 'Rookie Unmapped', season: 2026 },
      { context: {}, messages: [], toolCallId: 'test-unmapped' },
    );

    expect(result).toMatchObject({
      resolution: {
        status: 'resolved',
        identity: {
          canonicalId: 'nfl-player:sleeper:sleeper-unmapped',
          displayName: 'Rookie Unmapped',
          sourceIdentities: [
            { provider: 'sleeper', id: 'sleeper-unmapped' },
          ],
        },
      },
    });
  });

  it('respects the team filter when resolving by numeric player ID', async () => {
    const sleeper = {
      findPlayers: async () => [
        { player_id: '650', full_name: 'Nick Folk', position: 'K', team: 'ATL', gsis_id: '00-0025565' },
      ],
    } as unknown as SleeperClient;
    const nflverse = {
      getPlayerWeeklyStats: async () => [],
    } as unknown as NflverseClient;
    const tools = createIdentityTools(sleeper, nflverse, { repository: false });

    const mismatch = await tools.resolvePlayerIdentity.execute?.(
      { name: '650', season: 2026, team: 'KC' },
      { context: {}, messages: [], toolCallId: 'test-mismatch' },
    );
    expect(mismatch).toMatchObject({
      resolution: { status: 'not-found' },
    });

    const match = await tools.resolvePlayerIdentity.execute?.(
      { name: '650', season: 2026, team: 'ATL' },
      { context: {}, messages: [], toolCallId: 'test-match' },
    );
    expect(match).toMatchObject({
      resolution: { status: 'resolved', identity: { displayName: 'Nick Folk' } },
    });
  });

  it('disambiguates active fantasy skill players over IDP/retired namesakes and falls back on 404 season stats', async () => {
    const { NflverseApiError } = await import('../src/nflverse/client.js');
    const sleeper = {
      findPlayers: async () => [
        { player_id: 'josh-qb', full_name: 'Josh Allen', position: 'QB', team: 'BUF', active: true, gsis_id: '00-0034857' },
        { player_id: 'josh-dl', full_name: 'Josh Allen', position: 'DL', team: 'JAX', active: true },
        { player_id: 'josh-old', full_name: 'Josh Allen', position: 'WR', team: null, active: false },
      ],
    } as unknown as SleeperClient;
    const nflverse = {
      getPlayerWeeklyStats: async ({ season }: { season: number }) => {
        if (season === 2026) throw new NflverseApiError('Not published yet', 404, 'https://example.test/2026');
        return [{
          playerId: '00-0034857',
          playerDisplayName: 'Josh Allen',
          position: 'QB',
          team: 'BUF',
        }];
      },
    } as unknown as NflverseClient;
    const tools = createIdentityTools(sleeper, nflverse, { repository: false });

    const result = await tools.resolvePlayerIdentity.execute?.(
      { name: 'Josh Allen', season: 2026 },
      { context: {}, messages: [], toolCallId: 'test-josh' },
    );

    expect(result).toMatchObject({
      resolution: {
        status: 'resolved',
        identity: {
          canonicalId: 'nfl-player:nflverse:00-0034857',
          position: 'QB',
          teamId: 'nfl-team:BUF',
        },
      },
    });
  });
});
