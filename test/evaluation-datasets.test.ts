import { describe, expect, it } from 'vitest';

import {
  createNflversePlayerWeekDataset,
  createSleeperRosterWeekDataset,
} from '../src/evaluation/index.js';
import type { NflversePlayerWeek } from '../src/nflverse/types.js';

describe('evaluation datasets', () => {
  it('converts nflverse player rows with explicit availability', () => {
    const result = createNflversePlayerWeekDataset([playerWeek()], {
      availableAtByGameId: { g1: '2025-09-08T04:00:00.000Z' },
      createdAt: '2025-12-01T00:00:00.000Z',
    });

    expect(result).toMatchObject({
      kind: 'nflverse-player-week',
      metric: 'fantasyPointsPpr',
    });
    expect(result.observations[0]).toMatchObject({
      entityId: 'p1',
      actual: 21.5,
      segment: 'WR',
      metadata: { gameId: 'g1', team: 'BUF' },
    });
  });

  it('converts Sleeper matchup scores and honors custom points', () => {
    const result = createSleeperRosterWeekDataset(
      [
        {
          week: 1,
          matchups: [
            {
              roster_id: 7,
              matchup_id: 2,
              points: 100,
              custom_points: 105,
            },
          ],
        },
      ],
      {
        leagueId: 'league-1',
        season: 2025,
        availableAtByWeek: { 1: '2025-09-09T12:00:00.000Z' },
        createdAt: '2025-12-01T00:00:00.000Z',
      },
    );

    expect(result.observations[0]).toMatchObject({
      entityId: '7',
      actual: 105,
      segment: 'league-1',
    });
  });

  it('requires a fact availability time', () => {
    expect(() =>
      createNflversePlayerWeekDataset([playerWeek()], {
        availableAtByGameId: {},
      }),
    ).toThrow('needs an availability time');
  });
});

function playerWeek(): NflversePlayerWeek {
  return {
    airYardsShare: 0.2,
    attempts: 0,
    carries: 1,
    completions: 0,
    fantasyPoints: 16.5,
    fantasyPointsPpr: 21.5,
    gameId: 'g1',
    interceptions: 0,
    opponentTeam: 'MIA',
    passingTouchdowns: 0,
    passingYards: 0,
    playerDisplayName: 'Test Receiver',
    playerId: 'p1',
    position: 'WR',
    receivingAirYards: 80,
    receivingTouchdowns: 1,
    receivingYards: 100,
    receptions: 5,
    rushingTouchdowns: 0,
    rushingYards: 0,
    season: 2025,
    seasonType: 'REG',
    targetShare: 0.25,
    targets: 8,
    team: 'BUF',
    week: 1,
  };
}
