import { describe, expect, it } from 'vitest';

import {
  summarizeDefenseAgainstPosition,
  summarizePlayerTrends,
  summarizeTeamPerformance,
} from '../src/nflverse/analytics.js';
import type { NflverseGame, NflversePlayerWeek } from '../src/nflverse/types.js';

describe('nflverse analytics', () => {
  it('summarizes recent player usage and volatility', () => {
    const trends = summarizePlayerTrends([
      stat({ week: 1, fantasyPointsPpr: 10, targets: 4, receptions: 2, carries: 8 }),
      stat({ week: 2, fantasyPointsPpr: 20, targets: 6, receptions: 3, carries: 10 }),
      stat({ week: 3, fantasyPointsPpr: 30, targets: 8, receptions: 4, carries: 12 }),
      stat({ week: 4, fantasyPointsPpr: 40, targets: 10, receptions: 6, carries: 14 }),
    ]);

    expect(trends[0]).toMatchObject({
      averagePprPoints: 25,
      recentAveragePprPoints: 30,
      averageTouches: 14.75,
      recentAverageTouches: 16.33,
    });
    expect(trends[0]?.volatility).toBeGreaterThan(11);
  });

  it('summarizes team results and defense results by position', () => {
    const games: NflverseGame[] = [
      game({ homeTeam: 'BUF', awayTeam: 'MIA', homeScore: 28, awayScore: 20 }),
      game({ homeTeam: 'KC', awayTeam: 'BUF', homeScore: 24, awayScore: 21 }),
    ];
    const stats = [
      stat({ team: 'BUF', opponentTeam: 'MIA', gameId: 'g1', passingYards: 250 }),
      stat({ team: 'MIA', opponentTeam: 'BUF', gameId: 'g1', position: 'WR', targets: 10, fantasyPointsPpr: 20 }),
      stat({ team: 'KC', opponentTeam: 'BUF', gameId: 'g2', position: 'WR', targets: 8, fantasyPointsPpr: 16 }),
    ];

    expect(summarizeTeamPerformance('BUF', games, stats)).toMatchObject({
      wins: 1,
      losses: 1,
      averagePointsScored: 24.5,
      passingYards: 250,
    });
    expect(summarizeDefenseAgainstPosition('BUF', 'WR', stats)).toMatchObject({
      games: 2,
      averagePprPointsAllowed: 18,
      averageTargetsAllowed: 9,
    });
  });
});

function stat(overrides: Partial<NflversePlayerWeek>): NflversePlayerWeek {
  return {
    airYardsShare: 0.2,
    attempts: 0,
    carries: 0,
    completions: 0,
    fantasyPoints: 0,
    fantasyPointsPpr: 0,
    gameId: 'game',
    interceptions: 0,
    opponentTeam: 'MIA',
    passingTouchdowns: 0,
    passingYards: 0,
    playerDisplayName: 'Test Player',
    playerId: 'player-1',
    position: 'RB',
    receivingAirYards: 0,
    receivingTouchdowns: 0,
    receivingYards: 0,
    receptions: 0,
    rushingTouchdowns: 0,
    rushingYards: 0,
    season: 2025,
    seasonType: 'REG',
    targetShare: 0.2,
    targets: 0,
    team: 'BUF',
    week: 1,
    ...overrides,
  };
}

function game(overrides: Partial<NflverseGame>): NflverseGame {
  return {
    awayRest: 7,
    awayScore: null,
    awayTeam: 'MIA',
    gameDate: '2025-09-01',
    gameId: 'game',
    gameTime: '13:00',
    gameType: 'REG',
    homeRest: 7,
    homeScore: null,
    homeTeam: 'BUF',
    location: 'Home',
    roof: 'outdoors',
    season: 2025,
    spreadLine: null,
    stadium: null,
    stadiumId: null,
    surface: 'grass',
    temperature: null,
    totalLine: null,
    week: 1,
    wind: null,
    ...overrides,
  };
}
