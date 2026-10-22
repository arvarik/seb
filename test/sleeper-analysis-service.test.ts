import { describe, expect, it } from 'vitest';
import { SleeperAnalysisService } from '../src/sleeper/analysis-service.js';
import type { SleeperClient } from '../src/sleeper/client.js';
import type { SleeperNflState, SleeperRoster } from '../src/sleeper/types.js';
import { league } from './analysis-fixtures.js';

describe('SleeperAnalysisService regular-season windowing', () => {
  const rosters: SleeperRoster[] = [1, 2].map((roster_id) => ({
    roster_id,
    league_id: '123456',
    players: [],
    starters: [],
    settings: { wins: 7, losses: 7 },
  }));

  it('keeps completed playoff weeks for scoring and matchup predictions while capping regular-season records', async () => {
    const requestedWeeks: number[] = [];
    const client = {
      getLeague: async () =>
        league({
          season: '2026',
          settings: { leg: 17, playoff_week_start: 15 },
        }),
      getLeagueRosters: async () => rosters,
      getLeagueUsers: async () => [],
      getNflState: async () =>
        ({ season: '2026', season_type: 'post', week: 1 }) as SleeperNflState,
      getLeagueMatchups: async (_leagueId: string, week: number) => {
        requestedWeeks.push(week);
        if (week <= 14) {
          return [
            { roster_id: 1, matchup_id: 1, points: 100 },
            { roster_id: 2, matchup_id: 1, points: 95 },
          ];
        }
        return [
          { roster_id: 1, matchup_id: null, points: 130 },
          { roster_id: 2, matchup_id: null, points: 0 },
        ];
      },
    } as unknown as SleeperClient;

    const service = new SleeperAnalysisService(client);
    const defaultAnalysis = await service.analyzeLeague('123456');
    expect(defaultAnalysis.throughWeek).toBe(18);
    expect(defaultAnalysis.historyComplete).toBe(true);
    expect(Math.max(...requestedWeeks)).toBe(18);

    const team1 = defaultAnalysis.teams.find((t) => t.rosterId === 1)!;
    const team2 = defaultAnalysis.teams.find((t) => t.rosterId === 2)!;
    // Regular-season record is capped at weeks 1-14 (playoff_week_start - 1)
    expect(team1.record).toEqual({ wins: 14, losses: 0, ties: 0, winRate: 1 });
    expect(team2.record).toEqual({ wins: 0, losses: 14, ties: 0, winRate: 0 });
    // Completed playoff scores (> 0) are kept for recent form, while unscheduled 0s are ignored
    expect(team1.recentAverage).toBe(130);
    expect(team2.recentAverage).toBe(95);

    const prediction = await service.predictMatchup('123456', 1, 2, 16);
    expect(prediction.favoredRosterId).toBe(1);
  });
});
