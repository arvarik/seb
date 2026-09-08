import { describe, expect, it } from 'vitest';

import { SourceTracker } from '../src/sources.js';

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
          active: true,
          search_rank: 1,
        },
        '2': {
          player_id: '2',
          full_name: 'Josh Johnson',
          position: 'QB',
          active: true,
          search_rank: 50,
        },
        '3': {
          player_id: '3',
          full_name: 'John Smith',
          position: 'QB',
          active: true,
          search_rank: 2,
        },
      });
    };
    const client = new SleeperClient({ fetch, playerCacheFile: false });

    const players = await client.findPlayers('Josh Allen', {
      position: 'qb',
      limit: 5,
    });

    expect(requestedUrl).toBe('https://api.sleeper.app/v1/players/nfl');
    expect(players.map((player) => player.player_id)).toEqual(['1']);
  });

  it('keeps the position filter when inactive players are included', async () => {
    const client = new SleeperClient({
      database: false,
      fetch: async () => jsonResponse({
        '1': { player_id: '1', full_name: 'Test Player', position: 'WR', active: false },
        '2': { player_id: '2', full_name: 'Test Player', position: 'QB', active: true },
      }),
    });
    const players = await client.findPlayers('Test Player', { active: false, position: 'wr' });
    expect(players.map((player) => player.player_id)).toEqual(['1']);
  });

  it('retains citations for different player filters and trending windows', async () => {
    const sources = new SourceTracker();
    const client = new SleeperClient({
      database: false,
      onSource: sources.record,
      fetch: async (url) => jsonResponse(String(url).includes('trending') ? [] : {}),
    });
    await client.getPlayers({ position: 'QB' });
    await client.getPlayers({ position: 'WR' });
    await client.getTrendingPlayers('add', 24);
    await client.getTrendingPlayers('add', 48);
    expect(sources.list()).toHaveLength(3);
    expect(new Set(sources.list().map((source) => source.url)).size).toBe(3);
  });

  it('keeps provider context when a failed response body exceeds the limit', async () => {
    const fetch: typeof globalThis.fetch = async () =>
      new Response('missing', {
        status: 404,
        headers: { 'content-length': '5000' },
      });
    const client = new SleeperClient({ fetch, playerCacheFile: false });

    await expect(client.getLeague('missing')).rejects.toMatchObject({
      name: 'SleeperApiError',
      status: 404,
      url: 'https://api.sleeper.app/v1/league/missing',
      message: expect.stringContaining('exceeds 4096 bytes'),
    } satisfies Partial<SleeperApiError>);
  });

  it('keeps provider context when a failed response stream breaks', async () => {
    const client = new SleeperClient({
      fetch: async () => new Response(new ReadableStream({
        start(controller) {
          controller.error(new Error('socket closed'));
        },
      }), { status: 503 }),
      playerCacheFile: false,
      policy: { maxAttempts: 1 },
    });

    await expect(client.getLeague('unavailable')).rejects.toMatchObject({
      name: 'SleeperApiError',
      status: 503,
      url: 'https://api.sleeper.app/v1/league/unavailable',
      message: expect.stringContaining('Response body unavailable: socket closed'),
    } satisfies Partial<SleeperApiError>);
  });

  it('rejects a successful response with an invalid endpoint schema', async () => {
    const client = new SleeperClient({
      fetch: async () => jsonResponse({ season: '2026', week: 1 }),
      playerCacheFile: false,
    });

    await expect(client.getNflState()).rejects.toThrow();
  });

  it('rejects a response body that exceeds the client limit', async () => {
    const client = new SleeperClient({
      fetch: async () => new Response('{}', {
        headers: { 'content-length': String(33 * 1024 * 1024) },
      }),
      playerCacheFile: false,
    });

    await expect(client.getNflState()).rejects.toThrow('exceeds');
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
