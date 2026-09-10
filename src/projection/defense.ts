import { ResearchDataError } from '../data/research-error.js';
import type { DefenseWeek } from '../nflverse/defense.js';
import type { SleeperSettings } from '../sleeper/types.js';
import type { ScoringAwarePlayerProjection } from './player-projection.js';
import { mean } from './statistics.js';

const linear = ['sack', 'int', 'ff', 'fum_rec', 'def_td', 'safe', 'blk_kick', 'def_st_td', 'def_st_ff', 'def_st_fum_rec', 'def_st_tkl_solo', 'def_kr_yd', 'def_pr_yd', 'qb_hit', 'tkl_loss', 'def_2pt', 'pts_allow', 'yds_allow'];
const pointsTiers: [number, string][] = [[0, '0'], [6, '1_6'], [13, '7_13'], [20, '14_20'], [27, '21_27'], [34, '28_34'], [Infinity, '35p']];
const yardsTiers: [number, string][] = [[99, '0_100'], [199, '100_199'], [299, '200_299'], [349, '300_349'], [399, '350_399'], [449, '400_449'], [499, '450_499'], [549, '500_549'], [Infinity, '550p']];
export const DEFENSE_SETTINGS = new Set([...linear, ...pointsTiers.map(([, k]) => `pts_allow_${k}`), ...yardsTiers.map(([, k]) => `yds_allow_${k}`)]);
const irrelevant = /^(pass_|rush_|rec(?:$|_)|bonus_(?:pass|rush|rec)|fg|xp|st_|kr_yd$|pr_yd$|fum$|fum_lost$|fum_rec_td$|idp_)/u;
export function inspectDefenseScoring(settings: SleeperSettings) {
  const active = Object.entries(settings).filter(([, value]) => typeof value === 'number' && value !== 0).map(([key]) => key).sort();
  for (const value of Object.values(settings)) if (value != null && (typeof value !== 'number' || !Number.isFinite(value))) throw new ResearchDataError('Scoring settings must be finite.');
  return { usedSettings: active.filter(k => DEFENSE_SETTINGS.has(k)), ignoredSettings: active.filter(k => !DEFENSE_SETTINGS.has(k) && !irrelevant.test(k)) };
}
export function scoreDefenseWeek(row: DefenseWeek, settings: SleeperSettings): number {
  const scoring = inspectDefenseScoring(settings);
  let score = 0;
  for (const key of linear) {
    if (!scoring.usedSettings.includes(key)) continue;
    const value = row.stats[key];
    if (value === undefined || !Number.isFinite(value)) throw new ResearchDataError(`Defense statistics lack ${key}.`);
    score += value * Number(settings[key]);
  }
  for (const [prefix, tiers] of [['pts_allow', pointsTiers], ['yds_allow', yardsTiers]] as const) {
    if (!scoring.usedSettings.some(k => k.startsWith(`${prefix}_`))) continue;
    const value = row.stats[prefix];
    if (value === undefined || !Number.isFinite(value)) throw new ResearchDataError(`Defense statistics lack ${prefix}.`);
    const key = `${prefix}_${tiers.find(([max]) => value <= max)![1]}`;
    score += Number(settings[key] ?? 0);
  }
  if (!Number.isFinite(score)) throw new ResearchDataError('The defense score is not finite.');
  return score;
}

/** Average scored game outcomes, not the score of average yards or points allowed. */
export function projectDefense(input: {
  rows: readonly DefenseWeek[]; team: string; name: string; opponent: string | null;
  analysisSeason: number; throughWeek: number; season: number; week: number;
  leagueId: string; leagueName: string; scoringSettings: SleeperSettings; scheduled: boolean; gameStarted: boolean;
}): ScoringAwarePlayerProjection {
  if (![input.season, input.analysisSeason].every(n => Number.isInteger(n) && n >= 1999 && n <= 2100) || ![input.week, input.throughWeek].every(n => Number.isInteger(n) && n >= 1 && n <= 18)) throw new ResearchDataError('Defense projections require valid seasons and weeks.');
  if (input.analysisSeason > input.season || input.analysisSeason === input.season && input.throughWeek >= input.week) throw new ResearchDataError('Defense training must end before the projected week.');
  const rows = input.rows.filter(r => r.season === input.analysisSeason && r.week <= input.throughWeek);
  if (new Set(rows.map(r => `${r.gameId}:${r.team}`)).size !== rows.length) throw new ResearchDataError('Defense data contains duplicate team games.');
  const team = rows.filter(r => r.team === input.team), opponent = rows.filter(r => r.opponent === input.opponent);
  if (!team.length || !rows.length) throw new ResearchDataError('The defense projection needs completed team games.');
  const scoring = inspectDefenseScoring(input.scoringSettings);
  const teamWeight = 0.5 * team.length / (team.length + 8);
  const opponentWeight = 0.5 * opponent.length / (opponent.length + 8);
  const weighted = rows.map(r => ({ row: r, weight: (1 - teamWeight - opponentWeight) / rows.length +
    (r.team === input.team ? teamWeight / team.length : 0) + (r.opponent === input.opponent && opponent.length ? opponentWeight / opponent.length : 0) }));
  const rare = { ...input.scoringSettings, def_td: 0, def_st_td: 0 };
  // Rare touchdowns receive a stronger league prior than sacks and points allowed.
  const tdScore = (r: DefenseWeek) => scoreDefenseWeek(r, input.scoringSettings) - scoreDefenseWeek(r, rare);
  const tdMean = (team.reduce((sum, r) => sum + tdScore(r), 0) + 24 * mean(rows.map(tdScore))) / (team.length + 24);
  const expectedPoints = weighted.reduce((sum, r) => sum + r.weight * scoreDefenseWeek(r.row, rare), 0) + tdMean;
  const outcomes = weighted.map(r => ({ score: scoreDefenseWeek(r.row, input.scoringSettings), weight: r.weight })).sort((a, b) => a.score - b.score);
  const percentile = (p: number) => { let mass = 0; for (const r of outcomes) { mass += r.weight; if (mass >= p) return r.score; } return outcomes.at(-1)!.score; };
  const round = (n: number) => Math.round(n * 100) / 100;
  const lower = round(Math.min(percentile(0.1), expectedPoints));
  const upper = round(Math.max(percentile(0.9), expectedPoints));
  const weekly = input.scheduled && !input.gameStarted;
  const limitations = ['The range uses weighted historical game outcomes. It does not guarantee 80% forecast coverage.',
    'The model shrinks team and opponent results toward NFL averages. Rare touchdowns use a stronger prior.',
    'The model does not adjust for current defensive injuries, coaching changes, or weather.'];
  if (input.analysisSeason < input.season) limitations.push('The baseline comes from the prior season.');
  if (!weekly) limitations.push('No verified future kickoff exists. This result is a historical baseline.');
  if (scoring.ignoredSettings.length) limitations.push(`Unsupported active defense settings: ${scoring.ignoredSettings.join(', ')}.`);
  return { adjustments: [{ factor: 1, label: 'Defense and opponent blend', reason: `${team.length} team games and ${opponent.length} opponent games, with an NFL prior. Scoring tiers apply to each game.` }],
    analysisSeason: input.analysisSeason, season: input.season, throughWeek: input.throughWeek, week: input.week,
    games: team.length, league: { leagueId: input.leagueId, name: input.leagueName },
    player: { name: `${input.name} D/ST`, playerId: input.team, position: 'DEF', team: input.team }, opponent: input.opponent,
    expectedPoints: round(expectedPoints), median: round(percentile(0.5)), floor: lower, ceiling: upper,
    interval: { lower, upper, level: 0.8, calibrationSamples: 0, method: 'weighted-historical-outcomes' },
    confidence: { label: 'low', score: 0.45, reasons: ['Defense scoring depends on rare events. Current personnel changes remain uncertain.'] },
    scoreScope: !weekly ? 'historical-baseline' : scoring.ignoredSettings.length || !scoring.usedSettings.length ? 'partial-scoring' : 'weekly-estimate',
    recommendationEligible: weekly && !scoring.ignoredSettings.length && scoring.usedSettings.length > 0, scoring, limitations,
    model: { version: 'defense-opponent-mixture-v1', parameters: { teamPriorGames: 8, touchdownPriorGames: 24, maximumTeamWeight: 0.5, maximumOpponentWeight: 0.5 }, learningThroughWeek: null, learningSeason: null, manualOverride: false } };
}
