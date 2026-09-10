import { describe, expect, it, vi } from 'vitest';
import { projectLeagueMatchup } from '../src/projection/matchup.js';
import type { ScoringAwarePlayerProjection } from '../src/projection/player-projection.js';
import type { SleeperMatchup, SleeperPlayerMap } from '../src/sleeper/types.js';
import { ResearchDataError } from '../src/data/research-error.js';
import { runWithRequestSignal } from '../src/ai/request-signal.js';
import { game, league } from './analysis-fixtures.js';

const request = { leagueId: '123', rosterId: 1, season: 2026, week: 1 };
const now = new Date('2026-09-10T22:00:00Z');

function fixture() {
  const sides: SleeperMatchup[] = [
    { roster_id: 1, matchup_id: 1, starters: ['a', 'done'], players: ['a', 'done', 'bench'], points: 7.25, players_points: { done: 7.25, bench: 99 } },
    { roster_id: 2, matchup_id: 1, starters: ['b', 'D'], points: 0, players_points: {} },
  ];
  const profiles: SleeperPlayerMap = {
    a: { player_id: 'a', full_name: 'Player A', position: 'RB', team: 'BUF' },
    b: { player_id: 'b', full_name: 'Player B', position: 'K', team: 'MIA' },
    done: { player_id: 'done', full_name: 'Completed Player', position: 'WR', team: 'SEA' },
    D: { player_id: 'D', full_name: 'Miami Dolphins', position: 'DEF', team: 'MIA' },
    bench: { player_id: 'bench', full_name: 'Bench Player', position: 'RB', team: 'BUF' },
  };
  const schedule = [
    game({ season: 2026, week: 1, gameDate: '2026-09-13', homeScore: null, awayScore: null }),
    game({ season: 2026, week: 1, gameDate: '2026-09-09', gameTime: '20:20', homeTeam: 'SEA', awayTeam: 'NE', homeScore: 13, awayScore: 10 }),
  ];
  const sleeper = { getLeague: vi.fn(async () => league({ season: '2026' })),
    getLeagueMatchups: vi.fn(async () => sides), getPlayers: vi.fn(async () => profiles) };
  const nflverse = { getSchedule: vi.fn(async () => schedule) };
  const service = { project: vi.fn(async ({ playerName }: { playerName: string }) => ({
    expectedPoints: playerName === 'Player A' ? 10.55 : 20.1, scoreScope: 'weekly-estimate',
    scoring: { usedSettings: ['rec'], ignoredSettings: [] },
  } as unknown as ScoringAwarePlayerProjection)) };
  return { sides, profiles, schedule, sleeper, nflverse, service,
    run: () => projectLeagueMatchup(sleeper, nflverse, service, request, now) };
}

describe('deterministic matchup totals', () => {
  it('adds only selected starters and counts completed scores exactly once', async () => {
    const f = fixture(); const result = await f.run();
    expect(result.rosters[0]).toMatchObject({ rosterId: 1, completedPoints: 7.25,
      remainingProjectedPoints: 10.55, projectedSubtotal: 17.8, complete: true });
    expect(result.rosters[1]).toMatchObject({ rosterId: 2, projectedSubtotal: 40.2, complete: true,
      missingStarters: [] });
    expect(f.service.project.mock.calls.map(([input]) => input.playerName)).toEqual(['Player A', 'Player B', 'Miami Dolphins']);
    expect(f.sleeper.getLeagueMatchups).toHaveBeenCalledWith('123', 1);
    expect(result.winProbability).toBeNull();
  });
  it('preserves zero and negative completed scores, including a completed defense', async () => {
    const f = fixture();
    f.profiles.D!.team = 'NE';
    f.sides[0]!.players_points = { done: -2 };
    f.sides[1]!.players_points = { D: 0 };
    const result = await f.run();
    expect(result.rosters[0]!.projectedSubtotal).toBe(8.55);
    expect(result.rosters[1]).toMatchObject({ completedPoints: 0, complete: true });
    expect(result.rosters[1]!.players[1]).toMatchObject({ status: 'completed', points: 0 });
  });
  it('does not mistake in-progress points for a completed final score', async () => {
    const f = fixture(); f.schedule[1]!.gameDate = '2026-09-10'; f.schedule[1]!.gameTime = '13:00';
    expect((await f.run()).rosters[0]).toMatchObject({ completedPoints: 0, projectedSubtotal: 10.55, complete: false });
  });
  it('keeps a completed player unavailable when the individual score is missing', async () => {
    const f = fixture(); f.sides[0]!.players_points = {};
    expect((await f.run()).rosters[0]!.missingStarters[0]!.name).toBe('Completed Player');
  });
  it('keeps missing profiles, empty slots, missing schedules, and unknown kickoffs explicit', async () => {
    const f = fixture(); f.sides[0]!.starters = ['absent', '0', 'a']; f.profiles.a!.team = 'DET';
    f.schedule[0]!.gameTime = null;
    const result = await f.run();
    expect(result.rosters[0]!.missingStarters).toHaveLength(3);
    expect(result.rosters[1]!.missingStarters).toHaveLength(2);
    expect(f.service.project).not.toHaveBeenCalled();
  });
  it('preserves successful projections when another player lacks data', async () => {
    const f = fixture(); f.service.project.mockRejectedValueOnce(new ResearchDataError('No prior games.'));
    const result = await f.run();
    expect(result.rosters[0]).toMatchObject({ projectedSubtotal: 7.25, complete: false });
    expect(result.rosters[1]!.projectedSubtotal).toBe(40.2);
  });
  it('excludes historical baselines and labels unsupported scoring rules', async () => {
    const f = fixture(); f.service.project.mockResolvedValueOnce({ expectedPoints: 99, scoreScope: 'historical-baseline' } as ScoringAwarePlayerProjection);
    f.service.project.mockResolvedValueOnce({ expectedPoints: 20.1, scoreScope: 'partial-scoring',
      scoring: { usedSettings: ['fgm'], ignoredSettings: ['st_ff'] } } as ScoringAwarePlayerProjection);
    const result = await f.run();
    expect(result.rosters[0]!.projectedSubtotal).toBe(7.25);
    expect(result.rosters[1]).toMatchObject({ projectedSubtotal: 40.2, ignoredSettings: ['st_ff'], complete: false });
  });
  it('marks commissioner score overrides separately from projected totals', async () => {
    const f = fixture(); f.sides[0]!.custom_points = 100;
    expect((await f.run()).rosters[0]).toMatchObject({ projectedSubtotal: 17.8, customPoints: 100, complete: false });
  });
  it.each(['duplicate', 'missing', 'no-opponent', 'season'] as const)('rejects inconsistent matchup data: %s', async (kind) => {
    const f = fixture();
    if (kind === 'duplicate') f.sides[0]!.starters = ['a', 'a'];
    if (kind === 'missing') f.sides[0]!.starters = [];
    if (kind === 'no-opponent') f.sides[0]!.matchup_id = null;
    if (kind === 'season') f.sleeper.getLeague.mockResolvedValue(league({ season: '2025' }));
    await expect(f.run()).rejects.toBeInstanceOf(ResearchDataError);
  });
  it('stops after cancellation before it starts player projections', async () => {
    const f = fixture(); const controller = new AbortController();
    f.nflverse.getSchedule.mockImplementation(async () => { controller.abort(); return f.schedule; });
    await expect(runWithRequestSignal(controller.signal, f.run)).rejects.toThrow();
    expect(f.service.project).not.toHaveBeenCalled();
  });
});
