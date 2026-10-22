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

  it('caps default throughWeek before playoff_week_start while allowing explicit playoff week requests', async () => {
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
        return [
          { roster_id: 1, matchup_id: week <= 14 ? 1 : null, points: 100 },
          { roster_id: 2, matchup_id: week <= 14 ? 1 : null, points: 95 },
        ];
      },
    } as unknown as SleeperClient;

    const service = new SleeperAnalysisService(client);
    const defaultAnalysis = await service.analyzeLeague('123456');
    expect(defaultAnalysis.throughWeek).toBe(14);
    expect(defaultAnalysis.historyComplete).toBe(true);
    expect(Math.max(...requestedWeeks)).toBe(14);

    const explicitAnalysis = await service.analyzeLeague('123456', 16);
    expect(explicitAnalysis.throughWeek).toBe(16);
    expect(explicitAnalysis.historyComplete).toBe(false);
  });
});
