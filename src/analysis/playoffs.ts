import { setImmediate } from 'node:timers/promises';
import { throwIfRequestAborted } from '../ai/request-signal.js';
import type { LeagueAnalysis } from '../sleeper/analytics.js';
export interface RemainingMatchup { week: number; rosterA: number; rosterB: number }

export async function simulatePlayoffOdds(input: {
  analysis: LeagueAnalysis; matchups: readonly RemainingMatchup[];
  playoffTeams: number; simulations?: number; seed?: number; medianMatch?: boolean;
}) {
  const simulations = input.simulations ?? 10_000;
  const teams = [...input.analysis.teams].sort((a, b) => a.rosterId - b.rosterId);
  if (!Number.isInteger(simulations) || simulations < 100 || simulations > 50_000 ||
    !Number.isSafeInteger(input.seed ?? 42) ||
    !Number.isInteger(input.playoffTeams) || input.playoffTeams < 1 || input.playoffTeams > teams.length || teams.length > 32) {
    throw new Error('Invalid simulation count or playoff field size.');
  }
  const ids = new Set(teams.map((team) => team.rosterId));
  if (!input.analysis.historyComplete || ids.size !== teams.length || teams.some((team) => ![team.seasonAverage, team.pointsFor, team.record.wins, team.record.losses, team.record.ties, team.recentAverage ?? 0, team.weeklyVolatility ?? 0, ...team.recentScores].every(Number.isFinite) || team.recentScores.length < 2)) {
    throw new Error('Playoff simulations need distinct rosters and at least two completed scores per roster.');
  }
  const weeks = [...new Set(input.matchups.map((matchup) => matchup.week))].sort((a, b) => a - b);
  for (const week of weeks) {
    if (!Number.isInteger(week) || week <= input.analysis.throughWeek || week > 18) throw new Error('Remaining games must follow the analysis cutoff.');
    const participants = input.matchups.filter((matchup) => matchup.week === week).flatMap((matchup) => [matchup.rosterA, matchup.rosterB]);
    if (participants.length !== teams.length || new Set(participants).size !== teams.length || participants.some((id) => !ids.has(id))) {
      throw new Error('Every remaining week needs exactly one matchup for every roster.');
    }
  }
  const gamesByWeek = new Map(weeks.map((week) => [week, input.matchups.filter((game) => game.week === week)]));
  let seed = (input.seed ?? 42) >>> 0;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return (seed + 0.5) / 4294967296; };
  const normal = () => Math.sqrt(-2 * Math.log(random())) * Math.cos(2 * Math.PI * random());
  const counts = new Map(teams.map((team) => [team.rosterId, 0]));
  for (let trial = 0; trial < simulations; trial += 1) {
    if (trial % 250 === 0) { await setImmediate(); throwIfRequestAborted(); }
    const standings = new Map(teams.map((team) => [team.rosterId, {
      wins: team.record.wins + team.record.ties * 0.5, points: team.pointsFor, tie: random(),
    }]));
    for (const week of weeks) {
      const scores = new Map(teams.map((team) => [team.rosterId,
        team.seasonAverage * 0.7 + (team.recentAverage ?? team.seasonAverage) * 0.3 + Math.max(8, team.weeklyVolatility ?? 15) * normal()]));
      for (const matchup of gamesByWeek.get(week)!) {
        const a = scores.get(matchup.rosterA)!; const b = scores.get(matchup.rosterB)!;
        standings.get(matchup.rosterA)!.wins += a > b ? 1 : a === b ? 0.5 : 0;
        standings.get(matchup.rosterB)!.wins += b > a ? 1 : a === b ? 0.5 : 0;
      }
      const orderedScores = [...scores.values()].sort((a, b) => a - b);
      const middle = orderedScores.length / 2;
      const median = orderedScores.length % 2 ? orderedScores[Math.floor(middle)]!
        : (orderedScores[middle - 1]! + orderedScores[middle]!) / 2;
      for (const [id, score] of scores) {
        const record = standings.get(id)!; record.points += score;
        if (input.medianMatch) record.wins += score > median ? 1 : score === median ? 0.5 : 0;
      }
    }
    const ranked = [...standings].sort(([, a], [, b]) => b.wins - a.wins || b.points - a.points || b.tie - a.tie);
    for (const [id] of ranked.slice(0, input.playoffTeams)) counts.set(id, counts.get(id)! + 1);
  }
  return { simulations, seed: input.seed ?? 42, playoffTeams: input.playoffTeams,
    remainingWeeks: weeks, teams: teams.map((team) => {
      const probability = counts.get(team.rosterId)! / simulations;
      const z2 = 1.96 ** 2; const denominator = 1 + z2 / simulations;
      const center = (probability + z2 / (2 * simulations)) / denominator;
      const width = 1.96 * Math.sqrt(probability * (1 - probability) / simulations + z2 / (4 * simulations ** 2)) / denominator;
      return { rosterId: team.rosterId, probability, simulationInterval95: [Math.max(0, center - width), Math.min(1, center + width)] };
    }), assumptions: ['Independent normal weekly roster scores with a minimum eight-point standard deviation.',
      'Standings use wins, then points scored, then a random draw for exact ties.',
      'Intervals measure simulation sampling error only. They exclude forecast model error.',
      'The model excludes future roster changes, divisions, and custom playoff seeding.'] };
}
