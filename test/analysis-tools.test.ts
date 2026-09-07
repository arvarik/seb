import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createPlayoffTools } from '../src/analysis/playoff-tools.js';
import { createLearningTools } from '../src/learning/tools.js';
import { createProjectionTools } from '../src/projection/tools.js';
import { LearningStore } from '../src/learning/store.js';
import { LearningService } from '../src/learning/service.js';
import type { SleeperClient } from '../src/sleeper/client.js';
import type { NflverseClient } from '../src/nflverse/client.js';
import type { WeatherClient } from '../src/weather/client.js';
import { stat, league, game } from './analysis-fixtures.js';
const options = { context: {}, messages: [], toolCallId: 'test' };

describe('analysis tool integration', () => {
  const client = (settings: Record<string, number> = {}, missingSchedule = false) => ({
    getLeague: async () => league({ settings: { playoff_week_start: 4, playoff_teams: 1, ...settings } }),
    getLeagueRosters: async () => [1, 2].map((roster_id) => ({ roster_id, league_id: '123456', settings: {}, players: [], starters: [] })),
    getLeagueUsers: async () => [], getNflState: async () => ({ season: '2025', season_type: 'regular', week: 3 }),
    getLeagueMatchups: async (_id: string, week: number) => week === 3 && missingSchedule ? []
      : [1, 2].map((roster_id) => ({ roster_id, matchup_id: 1, points: 100 })),
  } as unknown as SleeperClient);
  it('reads the remaining fantasy schedule before estimating playoff odds', async () => {
    const result = await createPlayoffTools(client()).simulatePlayoffOdds.execute!({ leagueId: '123456', throughWeek: 2, simulations: 100 }, options);
    expect(result).toMatchObject({ remainingWeeks: [3], playoffTeams: 1, simulations: 100 });
  });
  it.each(['divisions', 'missing', 'start'])('rejects unsupported playoff inputs: %s', async (scenario) => {
    const settings = scenario === 'divisions' ? { divisions: 2 } : scenario === 'start' ? { playoff_week_start: 2 } : {};
    await expect(createPlayoffTools(client(settings, scenario === 'missing')).simulatePlayoffOdds.execute!({ leagueId: '123456', throughWeek: 2, simulations: 100 }, options)).rejects.toThrow();
  });
  it('updates and inspects compact local learning through the agent tools', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'seb-learning-tool-'));
    try {
      const store = new LearningStore(directory);
      const nfl = { getSchedule: async () => [game()], getPlayerWeeklyStats: async () => [stat()] } as unknown as NflverseClient;
      const service = new LearningService(nfl, store, () => new Date('2025-09-10T00:00:00Z'));
      const tools = createLearningTools(client(), store, service);
      expect(await tools.inspectLearning.execute!({ season: 2025, week: 2 }, options)).toMatchObject({ available: false });
      expect(await tools.learnCompletedWeek.execute!({ season: 2025, throughWeek: 1, leagueId: '123456' }, options)).toMatchObject({ changed: true, throughWeek: 1 });
      expect(await tools.inspectLearning.execute!({ season: 2025, week: 2, leagueId: '123456', playerId: 'p1', team: 'BUF' }, options))
        .toMatchObject({ available: true, playerCount: 1, player: { name: 'Example Runner' }, team: null });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  it('runs complete player comparisons and stops starter recommendations at kickoff', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2025-09-25T00:00:00Z'));
    try {
      const sleeper = { ...client(), getNflState: async () => ({ season: '2025', season_type: 'regular', week: 4 }),
        findPlayers: async (name: string) => [{ player_id: name, full_name: name, position: 'RB', team: 'BUF', status: 'Active' }] } as unknown as SleeperClient;
      const nfl = { getSchedule: async () => [game({ week: 4, gameDate: '2025-09-28', roof: 'dome' })],
        getPlayerWeeklyStats: async (input: { playerName?: string }) => [1, 2, 3].map((week) => stat({ week, playerId: input.playerName ?? 'peer', playerDisplayName: input.playerName ?? 'Peer' })) } as unknown as NflverseClient;
      const execute = createProjectionTools(sleeper, nfl, {} as WeatherClient).compareStartSit.execute!;
      const request = { leagueId: '123456', playerNames: ['Runner One', 'Runner Two'], season: 2025, week: 4, slot: 'RB' as const };
      expect(await execute(request, options)).toMatchObject({ recommendationEligible: true, closeDecision: true, slot: 'RB' });
      vi.setSystemTime(new Date('2025-09-28T18:00:00Z'));
      expect(await execute(request, options)).toMatchObject({ recommendationEligible: false, preferredPlayerId: null });
    } finally { vi.useRealTimers(); }
  });
});
