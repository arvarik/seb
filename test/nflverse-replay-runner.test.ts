import { describe, expect, it } from 'vitest';

import {
  formatReplaySummary,
  runNflverseBaselineReplay,
} from '../src/evaluation/nflverse-runner.js';
import type { NflverseClient } from '../src/nflverse/client.js';
import type { NflverseGame, NflversePlayerWeek } from '../src/nflverse/types.js';

describe('nflverse baseline replay runner', () => {
  it('uses prior-week participants as pre-cutoff targets', async () => {
    const games = [game(1, '2025-09-07'), game(2, '2025-09-14'), game(3, '2025-09-21')];
    const rows = [row('a', 1, 10), row('b', 1, 20), row('a', 2, 30), row('b', 2, 10), row('a', 3, 20)];
    const client = {
      getSchedule: async () => games,
      getPlayerWeeklyStats: async () => rows,
    } as unknown as NflverseClient;

    const report = await runNflverseBaselineReplay({ client, season: 2025, throughWeek: 3 });

    expect(report.periods).toHaveLength(2);
    expect(report.periods[0]?.projections).toMatchObject([
      { entityId: 'a', predicted: 10, actual: 30 },
      { entityId: 'b', predicted: 20, actual: 10 },
    ]);
    expect(report.periods[1]?.audit.missingOutcomeEntityIds).toEqual(['b']);
    expect(formatReplaySummary(report)).toContain('Mean absolute error:');
  });
});

function game(week: number, gameDate: string): NflverseGame {
  return {
    gameId: `game-${week}`,
    season: 2025,
    gameType: 'REG',
    week,
    gameDate,
    gameTime: '13:00',
    awayTeam: 'BUF',
    awayScore: null,
    homeTeam: 'KC',
    homeScore: null,
    location: null,
    awayRest: null,
    homeRest: null,
    spreadLine: null,
    totalLine: null,
    roof: null,
    surface: null,
    temperature: null,
    wind: null,
    stadiumId: null,
    stadium: null,
  };
}

function row(playerId: string, week: number, points: number): NflversePlayerWeek {
  return {
    playerId,
    playerDisplayName: playerId.toUpperCase(),
    position: 'WR',
    season: 2025,
    week,
    seasonType: 'REG',
    gameId: `game-${week}`,
    team: 'BUF',
    opponentTeam: 'KC',
    completions: 0,
    attempts: 0,
    passingYards: 0,
    passingTouchdowns: 0,
    interceptions: 0,
    carries: 0,
    rushingYards: 0,
    rushingTouchdowns: 0,
    receptions: 0,
    targets: 0,
    receivingYards: 0,
    receivingTouchdowns: 0,
    receivingAirYards: 0,
    targetShare: null,
    airYardsShare: null,
    fantasyPoints: points,
    fantasyPointsPpr: points,
  };
}
