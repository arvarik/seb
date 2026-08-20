import { describe, expect, it } from 'vitest';

import {
  analyzeLeague,
  predictMatchup,
  type WeeklyMatchups,
} from '../src/sleeper/analytics.js';
import type {
  SleeperLeague,
  SleeperRoster,
  SleeperUser,
} from '../src/sleeper/types.js';

const league: SleeperLeague = {
  league_id: '123',
  name: 'Test League',
  season: '2025',
  season_type: 'regular',
  sport: 'nfl',
  status: 'complete',
  total_rosters: 3,
  roster_positions: ['QB', 'RB', 'WR', 'FLEX'],
  scoring_settings: { rec: 1 },
  settings: { leg: 4 },
};

const rosters: SleeperRoster[] = [
  roster(1, 'u1', 3, 0, 375, 300),
  roster(2, 'u2', 2, 1, 318, 320),
  roster(3, 'u3', 0, 3, 270, 343),
];

const users: SleeperUser[] = [
  user('u1', 'Alpha'),
  user('u2', 'Bravo'),
  user('u3', 'Charlie'),
];

const weeklyMatchups: WeeklyMatchups[] = [
  week(1, [120, 108, 90]),
  week(2, [130, 100, 92]),
  week(3, [125, 110, 88]),
];

describe('league analytics', () => {
  it('ranks strong and weak rosters from league results', () => {
    const result = analyzeLeague({
      league,
      rosters,
      users,
      weeklyMatchups,
      throughWeek: 3,
    });

    expect(result.teams.map((team) => team.rosterId)).toEqual([1, 2, 3]);
    expect(result.teams[0]).toMatchObject({
      rank: 1,
      teamName: 'Alpha',
      seasonAverage: 125,
      recentAverage: 125,
    });
    expect(result.teams[0]?.strengths.join(' ')).toContain('top third');
    expect(result.teams[2]?.weaknesses.join(' ')).toContain('bottom third');
  });

  it('favors the higher-scoring roster without claiming certainty', () => {
    const analysis = analyzeLeague({
      league,
      rosters,
      users,
      weeklyMatchups,
      throughWeek: 3,
    });

    const prediction = predictMatchup(analysis, 1, 3);

    expect(prediction.favoredRosterId).toBe(1);
    expect(prediction.rosterAWinProbability).toBeGreaterThan(0.5);
    expect(
      prediction.rosterAWinProbability + prediction.rosterBWinProbability,
    ).toBeCloseTo(1);
    expect(prediction.disclaimer).toContain('past Sleeper league scores only');
  });

  it('rejects a comparison with a missing roster', () => {
    const analysis = analyzeLeague({
      league,
      rosters,
      users,
      weeklyMatchups,
      throughWeek: 3,
    });

    expect(() => predictMatchup(analysis, 1, 99)).toThrow(
      'One or both roster IDs do not exist',
    );
  });
});

function roster(
  rosterId: number,
  ownerId: string,
  wins: number,
  losses: number,
  pointsFor: number,
  pointsAgainst: number,
): SleeperRoster {
  return {
    roster_id: rosterId,
    league_id: '123',
    owner_id: ownerId,
    players: [],
    starters: [],
    settings: {
      wins,
      losses,
      ties: 0,
      fpts: pointsFor,
      fpts_decimal: 0,
      fpts_against: pointsAgainst,
      fpts_against_decimal: 0,
    },
  };
}

function user(userId: string, teamName: string): SleeperUser {
  return {
    user_id: userId,
    display_name: teamName,
    metadata: { team_name: teamName },
  };
}

function week(number: number, points: number[]): WeeklyMatchups {
  return {
    week: number,
    matchups: points.map((score, index) => ({
      roster_id: index + 1,
      matchup_id: index === 2 ? 2 : 1,
      points: score,
    })),
  };
}
