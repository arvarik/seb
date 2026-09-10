import { describe, expect, it, vi } from 'vitest';
import { projectPlayer, scorePlayerWeek } from '../src/projection/player-projection.js';
import { PlayerProjectionService } from '../src/projection/service.js';
import { compareProjections } from '../src/projection/comparison.js';
import { NflverseApiError, type NflverseClient } from '../src/nflverse/client.js';
import type { SleeperClient } from '../src/sleeper/client.js';
import type { WeatherClient } from '../src/weather/client.js';
import type { LearningStore } from '../src/learning/store.js';
import { runWithRequestSignal } from '../src/ai/request-signal.js';
import { stat, league, game } from './analysis-fixtures.js';

const kicker = stat({ position: 'K', rushingYards: 0, kicking: {
  fieldGoalsMade: 6, fieldGoalsAttempted: 8, extraPointsMade: 2, extraPointsAttempted: 3,
  madeDistances: [19, 20, 30, 40, 50, 61], missedDistances: [25, 52],
} });
const input = { analysisSeason: 2025, projectionSeason: 2026, leagueId: '123', leagueName: 'Test',
  throughWeek: 18, week: 1, rows: [1, 2, 3].map((week) => ({ ...kicker, week })),
  scoringSettings: { fgm_0_19: 3, fgm_20_29: 3, fgm_30_39: 3, fgm_40_49: 4, fgm_50p: 5, fgmiss: -1, xpm: 1, xpmiss: -1 } };

describe('kicker scoring audit', () => {
  it('supports separate 50-59 and 60-plus rules from current Sleeper leagues', () => {
    expect(scorePlayerWeek(kicker, { fgm_50_59: 5, fgm_60p: 6 })).toBe(11);
    expect(scorePlayerWeek({ ...kicker, kicking: { ...kicker.kicking!, missedDistances: [59, 60] } }, { fgmiss_50_59: -2, fgmiss_60p: -1 })).toBe(-3);
    expect(projectPlayer({ ...input, scoringSettings: { fgm_50_59: 5, fgm_60p: 6 } }).scoring.ignoredSettings).toEqual([]);
  });
  it('scores every made-distance boundary, missed field goals, and missed PATs', () => {
    expect(scorePlayerWeek(kicker, input.scoringSettings)).toBe(22);
    const projection = projectPlayer(input);
    expect(projection.expectedPoints).toBe(22);
    expect(projection.recommendationEligible).toBe(true);
    expect(projection.scoring.ignoredSettings).toEqual([]);
  });
  it('adds base points, distance points, and yards over 30 only for the qualifying yards', () => {
    expect(scorePlayerWeek(kicker, { fgm: 3, fgm_yds: 0.1, fgm_yds_over_30: 0.1 })).toBe(46.1);
  });
  it('counts blocked attempts as misses and applies only one missed-distance range', () => {
    expect(scorePlayerWeek(kicker, { fgmiss: -1, fgmiss_20_29: -2, fgmiss_50p: -0.5 })).toBe(-4.5);
  });
  it('allows verified zero attempts without inventing missing kicking data', () => {
    const row = { ...kicker, kicking: { fieldGoalsMade: 0, fieldGoalsAttempted: 0, extraPointsMade: 0,
      extraPointsAttempted: 0, madeDistances: [], missedDistances: [] } };
    expect(scorePlayerWeek(row, input.scoringSettings)).toBe(0);
    expect(() => scorePlayerWeek({ ...row, kicking: undefined }, input.scoringSettings)).toThrow('Do not treat missing');
  });
  it('rejects incomplete distances only when the scoring rules require them', () => {
    const row = { ...kicker, kicking: { ...kicker.kicking!, madeDistances: null } };
    expect(scorePlayerWeek(row, { fgm: 3 })).toBe(18);
    expect(() => scorePlayerWeek(row, { fgm_50p: 5 })).toThrow('fgm_50p');
  });
  it('rejects impossible counts and missing blocked-kick distances', () => {
    expect(() => scorePlayerWeek({ ...kicker, kicking: { ...kicker.kicking!, fieldGoalsAttempted: 1 } }, { fgmiss: -1 })).toThrow('fgmiss');
    expect(() => scorePlayerWeek({ ...kicker, kicking: { ...kicker.kicking!, missedDistances: [25] } }, { fgmiss_50p: -1 })).toThrow('fgmiss_50p');
  });
  it('does not make a kicker eligible from offensive settings alone', () => {
    expect(projectPlayer({ ...input, scoringSettings: { pass_yd: 0.04 } }).recommendationEligible).toBe(false);
    expect(projectPlayer({ ...input, scoringSettings: { ...input.scoringSettings, unsupported_kick_rule: 2 } }).recommendationEligible).toBe(false);
  });
  it('does not invalidate offensive scoring because the league uses distance kicking rules', () => {
    const projection = projectPlayer({ ...input, rows: [1, 2, 3].map((week) => stat({ week })), scoringSettings: { rush_yd: 0.1, fgm_yds_over_30: 0.1, fgmiss_20_29: -1 } });
    expect(projection.expectedPoints).toBe(10);
    expect(projection.recommendationEligible).toBe(true);
  });
});

function serviceFixture(options: { status?: number; learning?: LearningStore; history?: boolean } = {}) {
  const request = { leagueId: '123', playerName: 'Example Runner', season: 2026, week: 2 };
  const nflverse = {
    getPlayerWeeklyStats: vi.fn(async ({ season }: { season: number }) => {
      if (season === 2026) throw new NflverseApiError('private source error', options.status ?? 404, 'https://example.com/stats');
      return [1, 2, 3].map((week) => stat({ week }));
    }),
    getSchedule: vi.fn(async () => [game({ season: 2026, week: 2, gameDate: '2099-09-10', roof: 'dome' })]),
  };
  const sleeper = {
    getNflState: async () => ({ season: '2026', season_type: 'regular', week: options.history ? 3 : 2 }),
    getLeague: async () => league({ season: '2026' }),
    findPlayers: async () => [{ full_name: 'Example Runner', player_id: 's1', position: 'RB', team: 'MIA', injury_status: 'Out', active: true }],
  };
  return { request, nflverse, service: new PlayerProjectionService(sleeper as unknown as SleeperClient,
    nflverse as unknown as NflverseClient, {} as WeatherClient, options.learning ?? false) };
}

describe('projection service recovery and evidence', () => {
  it.each(['DET', 'JAX', 'PHI', 'NE', 'Detroit Lions'])('recognizes %s as a defense instead of a partial player name', async (playerName) => {
    const { service, request, nflverse } = serviceFixture();
    await expect(service.project({ ...request, playerName })).rejects.toThrow('Team defense projections are unavailable');
    expect(nflverse.getPlayerWeeklyStats).not.toHaveBeenCalled();
  });
  it('falls back to prior-season history when the new-season file does not exist', async () => {
    const { service, request, nflverse } = serviceFixture();
    const projection = await service.project(request);
    expect(projection.analysisSeason).toBe(2025);
    expect(projection.throughWeek).toBe(18);
    expect(nflverse.getPlayerWeeklyStats.mock.calls.map(([filter]) => filter.season)).toEqual([2026, 2025, 2025]);
  });
  it.each([429, 500])('keeps source failures visible for HTTP %s', async (status) => {
    const { service, request, nflverse } = serviceFixture({ status });
    await expect(service.project(request)).rejects.toMatchObject({ status });
    expect(nflverse.getPlayerWeeklyStats).toHaveBeenCalledTimes(1);
  });
  it('does not replace an explicitly requested season with older data', async () => {
    const { service, request, nflverse } = serviceFixture();
    await expect(service.project({ ...request, analysisSeason: 2026, throughWeek: 1 })).rejects.toMatchObject({ status: 404 });
    expect(nflverse.getPlayerWeeklyStats).toHaveBeenCalledTimes(1);
  });
  it('does not apply current injuries or a later team to a historical projection', async () => {
    const { service, request, nflverse } = serviceFixture({ history: true });
    const projection = await service.project(request);
    expect(projection.expectedPoints).toBeGreaterThan(0);
    expect(projection.player.team).toBe('BUF');
    expect(projection.recommendationEligible).toBe(false);
    expect(nflverse.getSchedule).toHaveBeenCalledWith(expect.objectContaining({ team: 'BUF' }));
  });
  it('reports invalid learning data without exposing the raw error', async () => {
    const learning = { overrides: async () => { throw new Error('private file contents'); } } as unknown as LearningStore;
    const { service, request } = serviceFixture({ learning });
    await expect(service.project(request)).rejects.toThrow('Run /doctor');
    await expect(service.project(request)).rejects.not.toThrow('private file');
  });
  it('does not fetch data after cancellation', async () => {
    const { service, request, nflverse } = serviceFixture();
    const controller = new AbortController(); controller.abort();
    expect(() => runWithRequestSignal(controller.signal, () => service.project(request))).toThrow();
    expect(nflverse.getPlayerWeeklyStats).not.toHaveBeenCalled();
  });
  it('rejects duplicate opponent weeks instead of inflating defensive points allowed', () => {
    const row = { ...kicker, opponentTeam: 'MIA' };
    expect(() => projectPlayer({ ...input, opponent: 'MIA', opponentRows: [row, row] })).toThrow('duplicate');
  });
  it.each([NaN, Infinity])('rejects invalid comparison scores: %s', (expectedPoints) => {
    const first = projectPlayer(input);
    expect(() => compareProjections([first, { ...first, expectedPoints, player: { ...first.player, playerId: 'other' } }])).toThrow('finite scores');
  });
});
