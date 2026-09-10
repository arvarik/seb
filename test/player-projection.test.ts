import { describe, expect, it } from 'vitest';

import type { NflverseClient } from '../src/nflverse/client.js';
import { PlayerProjectionService } from '../src/projection/service.js';
import {
  projectPlayer,
  scorePlayerWeek,
} from '../src/projection/player-projection.js';
import type { NflversePlayerWeek } from '../src/nflverse/types.js';
import type { SleeperClient } from '../src/sleeper/client.js';
import type { WeatherClient } from '../src/weather/client.js';

const scoring = {
  pass_yd: 0.04,
  pass_td: 4,
  pass_int: -2,
  rush_yd: 0.1,
  rush_td: 6,
  rec: 1,
  rec_yd: 0.1,
  rec_td: 6,
};

describe('scoring-aware player projections', () => {
  it.each(['DEF', 'LB'])('does not return a zero estimate for the unsupported %s position', (position) => {
    expect(() => projectPlayer({
      analysisSeason: 2025, projectionSeason: 2026, leagueId: '123', leagueName: 'Test',
      rows: [1, 2, 3].map((week) => stat({ week, position })),
      scoringSettings: { fgm: 3, pts_allow_0: 10 }, throughWeek: 3, week: 1,
    })).toThrow('Do not count them as zero');
  });

  it('calculates completed games from the selected league scoring rules', () => {
    const row = stat({
      attempts: 30,
      passingYards: 300,
      passingTouchdowns: 2,
      interceptions: 1,
      carries: 5,
      rushingYards: 20,
      rushingTouchdowns: 1,
      receptions: 6,
      receivingYards: 80,
      receivingTouchdowns: 1,
    });

    expect(scorePlayerWeek(row, scoring)).toBe(46);
  });

  it('returns a bounded range, confidence, and transparent adjustments', () => {
    const rows = [10, 14, 18, 22, 16, 24].map((points, index) => stat({
      week: index + 1,
      rushingYards: points * 10,
      targets: 3 + index,
    }));
    const opponentRows = [
      opponentStat('MIA', 'm1', 120),
      opponentStat('MIA', 'm2', 140),
      opponentStat('BUF', 'b1', 60),
      opponentStat('BUF', 'b2', 70),
      opponentStat('KC', 'k1', 80),
      opponentStat('KC', 'k2', 90),
      opponentStat('NYJ', 'n1', 90),
      opponentStat('NYJ', 'n2', 100),
    ];

    const result = projectPlayer({
      analysisSeason: 2025,
      injuryStatus: 'Healthy',
      leagueId: '123',
      leagueName: 'Test League',
      opponent: 'MIA',
      opponentRows,
      rows,
      scoringSettings: scoring,
      throughWeek: 6,
      weatherRisk: 'medium',
      weatherStatus: 'available',
      week: 7,
    });

    expect(result.median).toBeGreaterThan(0);
    expect(result.floor).toBeLessThan(result.median);
    expect(result.ceiling).toBeGreaterThan(result.median);
    expect(result.adjustments.map((value) => value.label)).toEqual([
      'Opponent adjustment',
      'Weather adjustment',
    ]);
    expect(result.recommendationEligible).toBe(true);
    expect(result.scoring.usedSettings).toContain('rush_yd');
  });

  it('blocks an active recommendation for an unavailable player', () => {
    const result = projectPlayer({
      analysisSeason: 2025,
      injuryStatus: 'Out',
      leagueId: '123',
      leagueName: 'Test League',
      rows: [stat({ week: 1 }), stat({ week: 2 }), stat({ week: 3 })],
      scoringSettings: scoring,
      throughWeek: 3,
      weatherStatus: 'unavailable',
      week: 4,
    });

    expect(result.median).toBe(0);
    expect(result.floor).toBe(0);
    expect(result.ceiling).toBe(0);
    expect(result.recommendationEligible).toBe(false);
    expect(result.adjustments).toContainEqual(expect.objectContaining({
      factor: 0,
      label: 'Availability adjustment',
    }));
  });

  it('blocks a recommendation when an active scoring rule is unsupported', () => {
    const result = projectPlayer({
      analysisSeason: 2025,
      injuryStatus: 'Healthy',
      leagueId: '123',
      leagueName: 'Test League',
      rows: [1, 2, 3].map((week) => stat({
        position: 'TE',
        receptions: 10,
        rushingYards: 0,
        week,
      })),
      scoringSettings: { unsupported_rule: 100, rec: 1 },
      throughWeek: 3,
      week: 4,
    });

    expect(result.median).toBe(10);
    expect(result.scoring.ignoredSettings).toEqual(['unsupported_rule']);
    expect(result.recommendationEligible).toBe(false);
  });

  it('rejects mixed player identities', () => {
    expect(() => projectPlayer({
      analysisSeason: 2025,
      leagueId: '123',
      leagueName: 'Test League',
      rows: [stat({ playerId: 'one' }), stat({ playerId: 'two', week: 2 })],
      scoringSettings: scoring,
      throughWeek: 2,
      week: 3,
    })).toThrow('one resolved player identity');
  });

  it('uses the prior season when the current season has no completed rows', async () => {
    const calls: Array<{ playerName?: string; position?: string; season: number }> = [];
    const sleeper = {
      getNflState: async () => ({ season: '2026', season_type: 'regular', week: 2 }),
      findPlayers: async () => [{
        full_name: 'Test Player',
        injury_status: null,
        player_id: 'player-1',
        position: 'RB',
        status: 'Active',
        team: 'BUF',
      }],
      getLeague: async () => ({
        league_id: '123',
        name: 'Test League',
        roster_positions: ['RB'],
        scoring_settings: scoring,
        season: '2026',
        season_type: 'regular',
        settings: {},
        sport: 'nfl',
        status: 'in_season',
        total_rosters: 1,
      }),
    } as unknown as SleeperClient;
    const nflverse = {
      getPlayerWeeklyStats: async (input: {
        playerName?: string;
        position?: string;
        season: number;
      }) => {
        calls.push(input);
        if (input.season === 2026) return [];
        return [1, 2, 3].map((week) => stat({ season: 2025, week }));
      },
      getSchedule: async () => [],
    } as unknown as NflverseClient;
    const service = new PlayerProjectionService(
      sleeper,
      nflverse,
      {} as WeatherClient,
    );

    const result = await service.project({
      leagueId: '123',
      playerName: 'Test Player',
      season: 2026,
      week: 2,
    });

    expect(calls.map((call) => call.season)).toEqual([2026, 2025, 2025]);
    expect(result.analysisSeason).toBe(2025);
    expect(result.throughWeek).toBe(18);
    expect(result.games).toBe(3);
  });
});

function opponentStat(opponentTeam: string, gameId: string, rushingYards: number) {
  return stat({
    gameId,
    opponentTeam,
    playerDisplayName: `${opponentTeam} Opponent`,
    playerId: `${opponentTeam}-${gameId}`,
    rushingYards,
  });
}

function stat(overrides: Partial<NflversePlayerWeek> = {}): NflversePlayerWeek {
  return {
    airYardsShare: 0.2,
    attempts: 0,
    carries: 10,
    completions: 0,
    fantasyPoints: 0,
    fantasyPointsPpr: 0,
    gameId: 'game-1',
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
    rushingYards: 100,
    season: 2025,
    seasonType: 'REG',
    targetShare: 0.2,
    targets: 4,
    team: 'BUF',
    week: 1,
    ...overrides,
  };
}
