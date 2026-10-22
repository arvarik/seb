import { describe, expect, it } from 'vitest';
import { normalCdf } from '../src/projection/statistics.js';
import { analyzeLeague, predictMatchup } from '../src/sleeper/analytics.js';
import { league } from './analysis-fixtures.js';

describe('sleeper analytics calibration', () => {
  it('computes sample standard deviation with Bessel correction and normalCdf matchup win probability', () => {
    const rosters = [1, 2].map((roster_id) => ({
      roster_id,
      league_id: '123456',
      players: [],
      starters: [],
      settings: {},
    }));
    const weeklyMatchups = [
      {
        week: 1,
        matchups: [
          { roster_id: 1, matchup_id: 1, points: 110 },
          { roster_id: 2, matchup_id: 1, points: 90 },
        ],
      },
      {
        week: 2,
        matchups: [
          { roster_id: 1, matchup_id: 1, points: 130 },
          { roster_id: 2, matchup_id: 1, points: 110 },
        ],
      },
    ];

    const analysis = analyzeLeague({
      league: league(),
      rosters,
      users: [],
      weeklyMatchups,
      throughWeek: 2,
    });

    // Sample SD of [110, 130] is sqrt(((110-120)^2 + (130-120)^2) / 1) = sqrt(200) = 14.14
    expect(analysis.teams[0]?.weeklyVolatility).toBe(14.14);
    expect(analysis.teams[1]?.weeklyVolatility).toBe(14.14);

    const prediction = predictMatchup(analysis, 1, 2);
    const expectedScale = Math.hypot(14.14, 14.14);
    const expectedProb = Math.round(normalCdf(20 / expectedScale) * 1000) / 1000;
    expect(prediction.rosterAWinProbability).toBe(expectedProb);
  });
});
