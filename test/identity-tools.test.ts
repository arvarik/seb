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
});
