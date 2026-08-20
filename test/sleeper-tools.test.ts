import { describe, expect, it } from 'vitest';

import { SleeperClient } from '../src/sleeper/client.js';
import { createSleeperTools } from '../src/sleeper/tools.js';

describe('Sleeper information tools', () => {
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
