import { describe, expect, it } from 'vitest';
import { optimizeLineup, type LineupPlayer } from '../src/analysis/lineup.js';
import { simulatePlayoffOdds } from '../src/analysis/playoffs.js';
import { resolveCompletedAnalysisWindow } from '../src/analysis/window.js';
import { analyzeLeague } from '../src/sleeper/analytics.js';
import { SleeperAnalysisService } from '../src/sleeper/analysis-service.js';
import type { SleeperClient } from '../src/sleeper/client.js';
import type { SleeperNflState, SleeperRoster } from '../src/sleeper/types.js';
import { runWithRequestSignal } from '../src/ai/request-signal.js';
import { league } from './analysis-fixtures.js';

const player = (id: string, points: number, positions = ['RB']): LineupPlayer => ({ id, name: id, points, positions });
const rosters: SleeperRoster[] = [1, 2].map((id) => ({ roster_id: id, league_id: '123456', players: [], starters: [],
  settings: { wins: 99, losses: 99, fpts: 9999 } }));
const history = [1, 2].map((week) => ({ week, matchups: [1, 2].map((roster_id) => ({ roster_id, matchup_id: 1, points: 100 })) }));
const analysis = () => analyzeLeague({ league: league(), rosters, users: [], weeklyMatchups: history, throughWeek: 2 });
const state = (phase: string, week: number): SleeperNflState => ({ season: '2026', season_type: phase, week } as SleeperNflState);

describe('legal lineup optimization', () => {
  it('assigns a scarce position before filling overlapping FLEX slots', () => {
    const result = optimizeLineup([player('best', 20), player('receiver', 19, ['WR']), player('backup', 1)], ['FLEX', 'RB']);
    expect(result.expectedPoints).toBe(39);
    expect(result.assignments.map((entry) => entry.player.id)).toEqual(['receiver', 'best']);
  });
  it('does not count one player twice and reports missing slots', () => {
    const result = optimizeLineup([player('one', 20, ['RB', 'WR'])], ['RB', 'WR', 'BN']);
    expect(result.complete).toBe(false);
    expect(result.expectedPoints).toBe(20);
    expect(result.missingSlots).toHaveLength(1);
  });
  it('fills required slots even when a legal player has negative expected points', () => {
    const result = optimizeLineup([player('negative', -2), player('qb', 10, ['QB'])], ['RB', 'SUPER_FLEX', 'IR']);
    expect(result.complete).toBe(true);
    expect(result.expectedPoints).toBe(8);
  });
  it('matches an exhaustive independent assignment search', () => {
    for (let trial = 0; trial < 20; trial += 1) {
      const candidates = Array.from({ length: 5 }, (_, i) => player(`${i}`, (trial * (i + 3)) % 19 - 3, [i % 2 ? 'WR' : 'RB']));
      const totals: number[] = [];
      for (const rb of candidates.filter((p) => p.positions.includes('RB'))) {
        for (const wr of candidates.filter((p) => p.positions.includes('WR'))) {
          for (const flex of candidates.filter((p) => p.id !== rb.id && p.id !== wr.id)) totals.push(rb.points + wr.points + flex.points);
        }
      }
      expect(optimizeLineup(candidates, ['RB', 'WR', 'FLEX']).expectedPoints).toBe(Math.max(...totals));
    }
  });
  it('rejects duplicate identities and unbounded requests', () => {
    expect(() => optimizeLineup([player('a', 1), player('a', 2)], ['RB'])).toThrow('unique');
    expect(() => optimizeLineup([player('a', NaN)], ['RB'])).toThrow('finite');
    expect(() => optimizeLineup([], Array(13).fill('RB'))).toThrow('12');
  });
});

describe('completed league history', () => {
  it('does not leak current standings or future scores into a historical cutoff', () => {
    const result = analyzeLeague({ league: league(), rosters, users: [], throughWeek: 2,
      weeklyMatchups: [...history, { week: 3, matchups: [{ roster_id: 1, matchup_id: 1, points: 10000 }] }] });
    expect(result.teams[0]).toMatchObject({ pointsFor: 200, seasonAverage: 100, record: { wins: 0, losses: 0, ties: 2 } });
  });
  it('counts median matchups without halving the weekly scoring average', () => {
    const weeks = history.map((week) => ({ ...week, matchups: week.matchups.map((game) => ({ ...game, custom_points: game.roster_id === 1 ? 120 : 80 })) }));
    const result = analyzeLeague({ league: league({ settings: { league_average_match: 1 } }), rosters, users: [], weeklyMatchups: weeks, throughWeek: 2 });
    expect(result.teams[0]).toMatchObject({ pointsFor: 240, seasonAverage: 120, record: { wins: 4 } });
  });
  it('rejects duplicate historical weeks or roster scores', () => {
    expect(() => analyzeLeague({ league: league(), rosters, users: [], weeklyMatchups: [...history, history[0]!], throughWeek: 2 })).toThrow('duplicate');
  });
  it('rejects an in-progress week before reading matchup scores', async () => {
    let reads = 0;
    const client = { getLeague: async () => league({ season: '2026' }), getLeagueRosters: async () => rosters,
      getLeagueUsers: async () => [], getNflState: async () => state('regular', 3),
      getLeagueMatchups: async () => { reads += 1; return []; } } as unknown as SleeperClient;
    await expect(new SleeperAnalysisService(client).analyzeLeague('123456', 3)).rejects.toThrow('completed');
    expect(reads).toBe(0);
  });
  it('uses prior-season results in preseason and limits current-season cutoffs', () => {
    expect(resolveCompletedAnalysisWindow('2026', state('pre', 1), {})).toEqual({ analysisSeason: 2025, throughWeek: 18 });
    expect(resolveCompletedAnalysisWindow('2026', state('off', 0), {})).toEqual({ analysisSeason: 2025, throughWeek: 18 });
    expect(resolveCompletedAnalysisWindow('2026', state('post', 2), {})).toEqual({ analysisSeason: 2026, throughWeek: 18 });
    expect(() => resolveCompletedAnalysisWindow('2026', state('regular', 5), { throughWeek: 5 })).toThrow('completed');
  });
});

describe('playoff probability simulation', () => {
  const matchups = [{ week: 3, rosterA: 1, rosterB: 2 }];
  it('reproduces seeded results and allocates exactly the available playoff spots', async () => {
    const input = { analysis: analysis(), matchups, playoffTeams: 1, simulations: 3000, seed: 42 };
    const result = await simulatePlayoffOdds(input);
    expect(await simulatePlayoffOdds(input)).toEqual(result);
    expect(result.teams.reduce((sum, team) => sum + team.probability, 0)).toBeCloseTo(1);
    expect(result.teams[0]!.probability).toBeCloseTo(0.5, 1);
    expect(result.teams[0]!.simulationInterval95[0]).toBeLessThan(result.teams[0]!.probability);
  });
  it('uses completed standings when no regular-season games remain', async () => {
    const data = analysis(); data.teams[0]!.record.wins = 3;
    const result = await simulatePlayoffOdds({ analysis: data, matchups: [], playoffTeams: 1, simulations: 100 });
    expect(result.teams.map((team) => team.probability)).toEqual([1, 0]);
  });
  it('rejects partial schedules and invalid simulation inputs', async () => {
    await expect(simulatePlayoffOdds({ analysis: analysis(), matchups: [{ week: 3, rosterA: 1, rosterB: 99 }], playoffTeams: 1 })).rejects.toThrow('every roster');
    await expect(simulatePlayoffOdds({ analysis: analysis(), matchups: [{ week: 2, rosterA: 1, rosterB: 2 }], playoffTeams: 1 })).rejects.toThrow('cutoff');
    await expect(simulatePlayoffOdds({ analysis: analysis(), matchups, playoffTeams: 1, seed: NaN })).rejects.toThrow('Invalid');
  });
  it('allows cancellation between simulation batches', async () => {
    const controller = new AbortController();
    const run = runWithRequestSignal(controller.signal, () => simulatePlayoffOdds({ analysis: analysis(), matchups, playoffTeams: 1, simulations: 50000 }));
    controller.abort();
    await expect(run).rejects.toThrow();
  });
});

it('recognizes a completed season when Sleeper moves league creation into the next year', () => {
  expect(resolveCompletedAnalysisWindow('2026', { ...state('off', 0), season: '2025', league_season: '2026' }, {}))
    .toEqual({ analysisSeason: 2025, throughWeek: 18 });
});

it.each(['unpaired', 'missing', 'null'])('withholds predictions for %s historical pairings', (kind) => {
  const incomplete = history.map((week) => ({ ...week, matchups: kind === 'missing' ? week.matchups.slice(0, 1) :
    week.matchups.map((game) => ({ ...game, matchup_id: kind === 'null' ? null : game.roster_id })) }));
  const data = analyzeLeague({ league: league(), rosters, users: [], weeklyMatchups: incomplete, throughWeek: 2 });
  expect(data.historyComplete).toBe(false);
  return expect(simulatePlayoffOdds({ analysis: data, matchups: [], playoffTeams: 1 })).rejects.toThrow('completed scores');
});
it('rejects non-finite historical scores and duplicate rosters', () => {
  expect(() => analyzeLeague({ league: league(), rosters, users: [], throughWeek: 1,
    weeklyMatchups: [{ week: 1, matchups: [{ roster_id: 1, matchup_id: 1, points: NaN }] }] })).toThrow('invalid score');
  expect(() => analyzeLeague({ league: league(), rosters: [rosters[0]!, rosters[0]!], users: [], throughWeek: 0, weeklyMatchups: [] })).toThrow('distinct');
});
it('uses higher points against after tied records and points for', async () => {
  const data = analysis(); data.teams[1]!.pointsAgainst += 1;
  const result = await simulatePlayoffOdds({ analysis: data, matchups: [], playoffTeams: 1, simulations: 100 });
  expect(result.teams.map((team) => team.probability)).toEqual([0, 1]);
});
it('rejects missing entire weeks in the remaining schedule', async () => {
  await expect(simulatePlayoffOdds({ analysis: analysis(), playoffTeams: 1,
    matchups: [{ week: 3, rosterA: 1, rosterB: 2 }, { week: 5, rosterA: 1, rosterB: 2 }] })).rejects.toThrow('skip');
});
