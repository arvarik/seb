import { describe, expect, it } from 'vitest';

import { SleeperClient } from '../src/sleeper/client.js';
import { createSleeperTools } from '../src/sleeper/tools.js';

describe('Sleeper information tools', () => {
  it('reads team names with nullable commissioner flags without fetching scores or settings', async () => {
    const urls: string[] = [];
    const client = new SleeperClient({
      database: false,
      fetch: async (url) => {
        urls.push(String(url));
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
      { userId: '1', displayName: 'Alex', teamName: 'Touchdown Team', isCommissioner: null },
      { userId: '2', displayName: 'Sam', teamName: null, isCommissioner: false },
      { userId: '3', displayName: 'Jo', teamName: null, isCommissioner: true },
    ] });
    expect(urls).toEqual(['https://api.sleeper.app/v1/league/123/users']);
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
