import { describe, expect, it } from 'vitest';

import { SleeperClient } from '../src/sleeper/client.js';
import { createSleeperTools } from '../src/sleeper/tools.js';

describe('Sleeper information tools', () => {
  it('reads team names with nullable commissioner flags and roster IDs without fetching scores or settings', async () => {
    const urls: string[] = [];
    const client = new SleeperClient({
      database: false,
      fetch: async (url) => {
        const href = String(url);
        urls.push(href);
        if (href.endsWith('/rosters')) {
          return Response.json([
            { league_id: '123', roster_id: 1, owner_id: '1', players: [], settings: {} },
            { league_id: '123', roster_id: 2, owner_id: '2', players: [], settings: {} },
          ]);
        }
        return Response.json([
          { user_id: '1', display_name: 'Alex', metadata: { team_name: 'Touchdown Team' }, is_owner: null },
          { user_id: '2', display_name: 'Sam', metadata: null, is_owner: false },
          { user_id: '3', username: 'Jo', metadata: { team_name: '' }, is_owner: true },
        ]);
      },
    });
    const execute = createSleeperTools(client).getLeagueTeams.execute!;
    const result = await execute({ leagueId: '123' }, { toolCallId: 'teams', messages: [], context: {} });
    expect(result).toEqual({ leagueId: '123', teams: [
      { userId: '1', rosterId: 1, displayName: 'Alex', teamName: 'Touchdown Team', isCommissioner: null },
      { userId: '2', rosterId: 2, displayName: 'Sam', teamName: null, isCommissioner: false },
      { userId: '3', rosterId: null, displayName: 'Jo', teamName: null, isCommissioner: true },
    ] });
    expect(urls).toEqual([
      'https://api.sleeper.app/v1/league/123/users',
      'https://api.sleeper.app/v1/league/123/rosters',
    ]);
  });

  it('strips bench players and players_points from getLeagueMatchups model output', () => {
    const tool = createSleeperTools({} as SleeperClient).getLeagueMatchups;
    const projected = tool.toModelOutput!({
      toolCallId: 'm1',
      input: { leagueId: '123', week: 1 },
      output: {
        leagueId: '123',
        week: 1,
        matchups: [
          {
            roster_id: 1,
            matchup_id: 2,
            points: 112.4,
            custom_points: null,
            starters: ['4046'],
            players: ['4046', '9999'],
            players_points: { '4046': 24.2, '9999': 0 },
          },
        ],
      },
    });
    expect(projected).toEqual({
      type: 'json',
      value: {
        leagueId: '123',
        week: 1,
        matchups: [
          {
            roster_id: 1,
            matchup_id: 2,
            points: 112.4,
            custom_points: null,
            starters: ['4046'],
          },
        ],
      },
    });
  });

  it('lists one team player set and states the source limit', async () => {
    const client = new SleeperClient({
      fetch: async () => Response.json({
        '1': {
          player_id: '1',
          full_name: 'Seattle Quarterback',
          position: 'QB',
          team: 'SEA',
          active: true,
        },
        '2': {
          player_id: '2',
          full_name: 'Seattle Receiver',
          position: 'WR',
          team: 'SEA',
          active: true,
        },
        '3': {
          player_id: '3',
          full_name: 'Other Receiver',
          position: 'WR',
          team: 'SF',
          active: true,
        },
      }),
      playerCacheFile: false,
    });
    const execute = createSleeperTools(client).getTeamPlayers.execute as unknown as (
      input: { includeInactive: boolean; limit: number; team: string },
    ) => Promise<{
      players: Array<{ name: string }>;
      sourceLimit: string;
      totalPlayers: number;
    }>;

    const result = await execute({ team: 'SEA', includeInactive: false, limit: 100 });

    expect(result.totalPlayers).toBe(2);
    expect(result.players.map((player) => player.name)).toEqual([
      'Seattle Quarterback',
      'Seattle Receiver',
    ]);
    expect(result.sourceLimit).toContain('not an official NFL roster');
  });
});
