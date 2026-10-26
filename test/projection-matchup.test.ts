import { describe, expect, it, vi } from 'vitest';
import { optimizeRosterLineup, projectLeagueMatchup } from '../src/projection/matchup.js';
import { compareProjections, sameGameCorrelation } from '../src/projection/comparison.js';
import { buildRecommendationEvidence } from '../src/analysis/recommendation-eligibility.js';
import type { ScoringAwarePlayerProjection } from '../src/projection/player-projection.js';
import type { SleeperMatchup, SleeperPlayerMap, SleeperRoster } from '../src/sleeper/types.js';
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
    expect((await f.run()).rosters[0]).toMatchObject({ completedPoints: 0, inProgressPoints: 7.25, projectedSubtotal: 10.55, complete: false });
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

  it('computes correlated matchup win probability and stack correlations when uncertainty bounds exist', async () => {
    expect(sameGameCorrelation({ position: 'QB', team: 'BUF' }, { position: 'WR', team: 'BUF' })).toBe(0.3);
    expect(sameGameCorrelation({ position: 'RB', team: 'BUF' }, { position: 'WR', team: 'BUF' })).toBe(-0.1);
    expect(sameGameCorrelation({ position: 'QB', team: 'BUF', opponent: 'MIA' }, { position: 'DEF', team: 'MIA', opponent: 'BUF' })).toBe(-0.25);
    expect(sameGameCorrelation({ position: 'QB', team: 'BUF', opponent: 'MIA' }, { position: 'WR', team: 'MIA', opponent: 'BUF' })).toBe(0.12);

    const f = fixture();
    f.sides[0]!.starters = ['qb', 'wr'];
    f.sides[1]!.starters = ['b', 'D'];
    f.profiles.qb = { player_id: 'qb', full_name: 'Josh Allen', position: 'QB', team: 'BUF' };
    f.profiles.wr = { player_id: 'wr', full_name: 'Khalil Shakir', position: 'WR', team: 'BUF' };
    f.service.project.mockImplementation(async ({ playerName }: { playerName: string }) => ({
      expectedPoints: playerName === 'Josh Allen' ? 18 : playerName === 'Khalil Shakir' ? 12 : 16,
      floor: 6,
      ceiling: 26,
      scoreScope: 'weekly-estimate',
      scoring: { usedSettings: ['rec'], ignoredSettings: [] },
    } as unknown as ScoringAwarePlayerProjection));

    const stacked = await f.run();
    expect(stacked.winProbability).not.toBeNull();
    expect(stacked.stackCorrelations).toContainEqual({
      players: ['Josh Allen', 'Khalil Shakir'],
      relationship: 'same-roster',
      correlation: 0.3,
    });
    expect(stacked.stackCorrelations).toContainEqual({
      players: ['Josh Allen', 'Miami Dolphins'],
      relationship: 'opposing-roster',
      correlation: -0.25,
    });

    const p1 = {
      expectedPoints: 18, floor: 10, ceiling: 26, season: 2026, week: 1,
      league: { leagueId: '123', name: 'Test' }, opponent: 'MIA', recommendationEligible: true,
      player: { playerId: 'qb', name: 'Josh Allen', position: 'QB', team: 'BUF' },
    } as unknown as ScoringAwarePlayerProjection;
    const p2 = {
      ...p1, expectedPoints: 15,
      player: { playerId: 'wr', name: 'Khalil Shakir', position: 'WR', team: 'BUF' },
    } as unknown as ScoringAwarePlayerProjection;
    const comp = compareProjections([p1, p2], 'SUPER_FLEX');
    expect(comp.correlation).toBe(0.3);
  });
});

describe('full-roster optimal lineup solver', () => {
  it('promotes a higher-projected bench player across FLEX and flags injured starters', async () => {
    const f = fixture();
    const rosters: SleeperRoster[] = [{
      roster_id: 1,
      league_id: '123',
      starters: ['a', 'out_wr'],
      players: ['a', 'out_wr', 'bench', 'ir_guy'],
      reserve: ['ir_guy'],
      settings: {},
    }];
    f.sides[0]!.starters = ['a', 'out_wr'];
    f.sides[0]!.players = ['a', 'out_wr', 'bench', 'ir_guy'];
    f.profiles.out_wr = { player_id: 'out_wr', full_name: 'Injured Receiver', position: 'WR', fantasy_positions: ['WR'], team: 'BUF', injury_status: 'Out' };
    f.profiles.a = { player_id: 'a', full_name: 'Player A', position: 'RB', fantasy_positions: ['RB'], team: 'BUF' };
    f.profiles.bench = { player_id: 'bench', full_name: 'Bench Player', position: 'RB', fantasy_positions: ['RB'], team: 'BUF' };
    f.profiles.ir_guy = { player_id: 'ir_guy', full_name: 'IR Player', position: 'WR', fantasy_positions: ['WR'], team: 'BUF' };
    const sleeperWithRosters = {
      ...f.sleeper,
      getLeague: vi.fn(async () => league({ season: '2026', roster_positions: ['RB', 'FLEX', 'BN', 'IR'] })),
      getLeagueRosters: vi.fn(async () => rosters),
    };
    f.service.project.mockImplementation(async ({ playerName }: { playerName: string }) => ({
      expectedPoints: playerName === 'Bench Player' ? 16.4 : 11.2,
      floor: 6,
      ceiling: 22,
      scoreScope: 'weekly-estimate',
      recommendationEligible: true,
      limitations: [],
      player: { playerId: playerName === 'Bench Player' ? 'bench' : 'a', name: playerName, position: 'RB', team: 'BUF' },
      league: { leagueId: '123', name: 'Test League' },
      scoring: { usedSettings: ['rec'], ignoredSettings: [] },
    } as unknown as ScoringAwarePlayerProjection));

    const optimized = await optimizeRosterLineup(sleeperWithRosters, f.nflverse, f.service, request, now);
    expect(optimized.currentProjectedPoints).toBe(11.2);
    expect(optimized.optimalProjectedPoints).toBe(27.6);
    expect(optimized.pointsDelta).toBe(16.4);
    expect(optimized.complete).toBe(true);
    expect(optimized.recommendationEligible).toBe(true);
    expect(optimized.recommendedSwaps).toEqual([{
      slot: 'FLEX',
      startPlayer: { playerId: 'bench', name: 'Bench Player', position: 'RB', points: 16.4 },
      sitPlayer: { playerId: 'out_wr', name: 'Injured Receiver', position: 'WR', points: null, injuryStatus: 'Out' },
      pointsGain: 16.4,
    }]);
    expect(optimized.warnings.some((warning) => warning.includes('Injured Receiver'))).toBe(true);

    const evidence = buildRecommendationEvidence({
      analysis: {
        schemaVersion: 1, kind: 'player', subject: 'Bench Player', summary: 'Swap Bench Player in.',
        recommendation: { action: 'Start Bench Player.', rationale: 'Higher projection.' },
        confidence: { level: 'high', score: 0.9, rationale: 'Verified.' },
        metrics: [], strengths: [], weaknesses: [], risks: [], assumptions: [], limitations: [],
      },
      question: 'Optimize my starting lineup for Week 1 in league 123',
      sources: [
        { id: 'sleeper', label: 'Sleeper', url: 'https://api.sleeper.app', accessedAt: '2026-09-10T22:00:00Z', cacheOutcome: 'source-updated' },
        { id: 'web:1', label: 'News', url: 'https://example.com', accessedAt: '2026-09-10T22:00:00Z' },
      ],
      toolResults: [
        { toolName: 'optimizeRosterLineup', input: request, output: optimized },
        { toolName: 'searchCurrentNews', output: { result: 'Bench Player is healthy and active.' } },
      ],
    });
    expect(evidence).toEqual({
      currentEvidence: 'fresh',
      identity: 'resolved',
      injury: 'present',
      leagueScoring: 'present',
      projection: 'eligible',
    });
  });

  it('locks bench players whose games already started and rejects duplicate starters', async () => {
    const f = fixture();
    f.sides[0]!.starters = ['a', 'done'];
    f.sides[0]!.players = ['a', 'done', 'locked_bench'];
    f.profiles.locked_bench = { player_id: 'locked_bench', full_name: 'Locked Bench', position: 'WR', fantasy_positions: ['WR'], team: 'SEA' };
    f.sides[0]!.players_points = { done: 7.25, locked_bench: 30 };
    const rosters: SleeperRoster[] = [{
      roster_id: 1,
      league_id: '123',
      starters: ['a', 'done'],
      players: ['a', 'done', 'locked_bench'],
      settings: {},
    }];
    const sleeperWithRosters = {
      ...f.sleeper,
      getLeague: vi.fn(async () => league({ season: '2026', roster_positions: ['RB', 'WR', 'BN'] })),
      getLeagueRosters: vi.fn(async () => rosters),
    };
    f.service.project.mockResolvedValue({
      expectedPoints: 10.55,
      floor: 6,
      ceiling: 18,
      scoreScope: 'weekly-estimate',
      recommendationEligible: true,
      limitations: [],
      player: { playerId: 'a', name: 'Player A', position: 'RB', team: 'BUF' },
      league: { leagueId: '123', name: 'Test League' },
      scoring: { usedSettings: ['rec'], ignoredSettings: [] },
    } as unknown as ScoringAwarePlayerProjection);

    const result = await optimizeRosterLineup(sleeperWithRosters, f.nflverse, f.service, request, now);
    expect(result.recommendedSwaps).toEqual([]);
    expect(result.optimalProjectedPoints).toBe(17.8);

    f.sides[0]!.starters = ['a', 'a'];
    await expect(optimizeRosterLineup(sleeperWithRosters, f.nflverse, f.service, request, now)).rejects.toBeInstanceOf(ResearchDataError);
  });

  it('honors multi-position fantasy_positions eligibility when filling secondary lineup slots', async () => {
    const f = fixture();
    f.sides[0]!.starters = ['a', '0'];
    f.sides[0]!.players = ['a', 'dual'];
    f.profiles.dual = { player_id: 'dual', full_name: 'Taysom Hill', position: 'QB', team: 'BUF' };
    const rosters: SleeperRoster[] = [{
      roster_id: 1,
      league_id: '123',
      starters: ['a', '0'],
      players: ['a', 'dual'],
      settings: {},
    }];
    const sleeperWithRosters = {
      ...f.sleeper,
      getLeague: vi.fn(async () => league({ season: '2026', roster_positions: ['RB', 'TE', 'BN'] })),
      getLeagueRosters: vi.fn(async () => rosters),
    };
    f.service.project.mockImplementation(async ({ playerName }: { playerName: string }) => ({
      expectedPoints: playerName === 'Taysom Hill' ? 12.5 : 10.55,
      floor: 6,
      ceiling: 18,
      scoreScope: 'weekly-estimate',
      recommendationEligible: true,
      limitations: [],
      player: {
        playerId: playerName === 'Taysom Hill' ? 'dual' : 'a',
        name: playerName,
        position: playerName === 'Taysom Hill' ? 'QB' : 'RB',
        fantasy_positions: playerName === 'Taysom Hill' ? ['QB', 'TE'] : ['RB'],
        team: 'BUF',
      },
      league: { leagueId: '123', name: 'Test League' },
      scoring: { usedSettings: ['rec'], ignoredSettings: [] },
    } as unknown as ScoringAwarePlayerProjection));

    const result = await optimizeRosterLineup(sleeperWithRosters, f.nflverse, f.service, request, now);
    expect(result.complete).toBe(true);
    expect(result.optimalLineup.find((entry) => entry.slot === 'TE')?.playerId).toBe('dual');
  });

  it('pins in-progress starters while keeping unlocked mid-week swaps recommendation-eligible and scores completed-week win probability', async () => {
    const f = fixture();
    // Make 'done' an in-progress starter (< 8h since kickoff) and 'a' an unlocked 4pm starter beat by 'bench'
    f.schedule[1]!.gameDate = '2026-09-10';
    f.schedule[1]!.gameTime = '16:00';
    f.sides[0]!.starters = ['done', 'a'];
    f.sides[0]!.players = ['done', 'a', 'bench'];
    const rosters: SleeperRoster[] = [{
      roster_id: 1,
      league_id: '123',
      starters: ['done', 'a'],
      players: ['done', 'a', 'bench'],
      settings: {},
    }];
    const sleeperWithRosters = {
      ...f.sleeper,
      getLeague: vi.fn(async () => league({ season: '2026', roster_positions: ['WR', 'FLEX', 'BN'] })),
      getLeagueRosters: vi.fn(async () => rosters),
    };
    f.service.project.mockImplementation(async ({ playerName }: { playerName: string }) => ({
      expectedPoints: playerName === 'Bench Player' ? 16.5 : 10.0,
      floor: 6,
      ceiling: 22,
      scoreScope: 'weekly-estimate',
      recommendationEligible: true,
      limitations: [],
      player: {
        playerId: playerName === 'Bench Player' ? 'bench' : 'a',
        name: playerName,
        position: 'RB',
        fantasy_positions: ['RB'],
        team: 'BUF',
      },
      league: { leagueId: '123', name: 'Test League' },
      scoring: { usedSettings: ['rec'], ignoredSettings: [] },
    } as unknown as ScoringAwarePlayerProjection));

    const midWeek = await optimizeRosterLineup(sleeperWithRosters, f.nflverse, f.service, request, now);
    expect(midWeek.complete).toBe(false);
    expect(midWeek.recommendationEligible).toBe(true);
    expect(midWeek.optimalLineup[0]?.playerId).toBe('done');
    expect(midWeek.recommendedSwaps).toEqual([{
      slot: 'FLEX',
      startPlayer: { playerId: 'bench', name: 'Bench Player', position: 'RB', points: 16.5 },
      sitPlayer: { playerId: 'a', name: 'Player A', position: 'RB', points: 10, injuryStatus: null },
      pointsGain: 6.5,
    }]);

    // Infer FLEX automatically when rosterPositions are supplied to compareProjections
    const rbProj = {
      expectedPoints: 15, floor: 9, ceiling: 21, season: 2026, week: 1,
      league: { leagueId: '123', name: 'Test' }, opponent: 'MIA', recommendationEligible: true,
      player: { playerId: 'rb1', name: 'Runner', position: 'RB', team: 'BUF' },
    } as unknown as ScoringAwarePlayerProjection;
    const wrProj = {
      ...rbProj, expectedPoints: 13,
      player: { playerId: 'wr1', name: 'Receiver', position: 'WR', team: 'MIA' },
    } as unknown as ScoringAwarePlayerProjection;
    expect(compareProjections([rbProj, wrProj], undefined, ['QB', 'RB', 'WR', 'FLEX', 'BN'])).toMatchObject({
      slot: 'FLEX',
      recommendationEligible: true,
      preferredPlayerId: 'rb1',
    });

    // Completed-week matchup deterministic winProbability
    const completedFixture = fixture();
    completedFixture.sides[0]!.starters = ['done'];
    completedFixture.sides[1]!.starters = ['D'];
    completedFixture.profiles.D!.team = 'NE';
    completedFixture.sides[0]!.players_points = { done: 18.5 };
    completedFixture.sides[1]!.players_points = { D: 9.0 };
    const finalMatchup = await completedFixture.run();
    expect(finalMatchup.winProbability).toBe(1);
  });
});

