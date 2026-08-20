import { describe, expect, it } from 'vitest';

import { SleeperApiError, SleeperClient } from '../src/sleeper/client.js';

describe('SleeperClient', () => {
  it('builds a league matchup request', async () => {
    let requestedUrl = '';
    const fetch: typeof globalThis.fetch = async (input) => {
      requestedUrl = String(input);
      return jsonResponse([{ roster_id: 1, matchup_id: 2, points: 105.5 }]);
    };
    const client = new SleeperClient({ fetch, playerCacheFile: false });

    const matchups = await client.getLeagueMatchups('123456', 4);

    expect(requestedUrl).toBe(
      'https://api.sleeper.app/v1/league/123456/matchups/4',
    );
    expect(matchups[0]?.points).toBe(105.5);
  });

  it('finds and ranks matching active players', async () => {
    let requestedUrl = '';
    const fetch: typeof globalThis.fetch = async (input) => {
      requestedUrl = String(input);
      return jsonResponse({
        '1': {
          player_id: '1',
          full_name: 'Josh Allen',
          position: 'QB',
          search_rank: 1,
        },
        '2': {
          player_id: '2',
          full_name: 'Josh Johnson',
          position: 'QB',
          search_rank: 50,
        },
        '3': {
          player_id: '3',
          full_name: 'John Smith',
          position: 'QB',
          search_rank: 2,
        },
      });
    };
    const client = new SleeperClient({ fetch, playerCacheFile: false });

    const players = await client.findPlayers('Josh Allen', {
      position: 'qb',
      limit: 5,
    });

    expect(requestedUrl).toContain('/players/nfl?');
    expect(requestedUrl).toContain('active=true');
    expect(requestedUrl).toContain('position=QB');
    expect(players.map((player) => player.player_id)).toEqual(['1']);
  });

  it('returns a typed error for a failed request', async () => {
    const fetch: typeof globalThis.fetch = async () =>
      new Response('missing', { status: 404 });
    const client = new SleeperClient({ fetch, playerCacheFile: false });

    await expect(client.getLeague('missing')).rejects.toMatchObject({
      name: 'SleeperApiError',
      status: 404,
    } satisfies Partial<SleeperApiError>);
  });

  it('rejects an invalid NFL week before it sends a request', async () => {
    let called = false;
    const fetch: typeof globalThis.fetch = async () => {
      called = true;
      return jsonResponse([]);
    };
    const client = new SleeperClient({ fetch, playerCacheFile: false });

    expect(() => client.getLeagueMatchups('123', 19)).toThrow(RangeError);
    expect(called).toBe(false);
  });
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
