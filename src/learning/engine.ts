import { createHash } from 'node:crypto';
import type { NflversePlayerWeek } from '../nflverse/types.js';
import { scorePlayerWeek, inspectPlayerScoringSettings } from '../projection/player-projection.js';
import { DEFAULT_PROJECTION_PARAMETERS, forecastMean, mean, PROJECTION_MODEL_VERSION,
  type ProjectionParameters } from '../projection/statistics.js';
import type { SleeperSettings } from '../sleeper/types.js';
import { learningRevisionSchema, type LearningRevision } from './types.js';

export const PPR_SCORING = Object.freeze({ pass_yd: 0.04, pass_td: 4, pass_int: -2,
  rush_yd: 0.1, rush_td: 6, rec: 1, rec_yd: 0.1, rec_td: 6, fum_lost: -2, pass_2pt: 2, rush_2pt: 2, rec_2pt: 2 });
interface Sample {
  week: number; position: string; team: string; actual: number;
  history: number[]; prior: number | null;
}

export function scoringKey(scoring: SleeperSettings): string {
  return createHash('sha256').update(JSON.stringify(Object.entries(scoring)
    .filter(([, value]) => typeof value === 'number' && value !== 0)
    .sort(([a], [b]) => a.localeCompare(b)))).digest('hex').slice(0, 16);
}

export function positionPrior(
  rows: readonly NflversePlayerWeek[], position: string, playerId: string, scoring: SleeperSettings,
): number | null {
  const eligible = rows.filter((row) => row.position === position && row.playerId !== playerId);
  return eligible.length >= 20 ? mean(eligible.map((row) => scorePlayerWeek(row, scoring))) : null;
}

export function learnFromCompletedRows(input: {
  rows: readonly NflversePlayerWeek[]; season: number; throughWeek: number;
  scoring?: SleeperSettings; now?: Date;
}): LearningRevision {
  const scoring = input.scoring ?? PPR_SCORING;
  const inspected = inspectPlayerScoringSettings(scoring);
  if (inspected.ignoredSettings.length || !inspected.usedSettings.length) {
    throw new Error('Learning requires supported offensive scoring settings.');
  }
  const rows = input.rows.filter((row) => row.season === input.season && row.seasonType === 'REG' &&
    row.week <= input.throughWeek && ['QB', 'RB', 'WR', 'TE'].includes(row.position))
    .sort((a, b) => a.week - b.week || a.playerId.localeCompare(b.playerId));
  const keys = new Set<string>();
  for (const row of rows) {
    const key = `${row.playerId}:${row.week}`;
    if (keys.has(key)) throw new Error(`Duplicate player-week: ${key}.`);
    keys.add(key);
  }
  if (!rows.length) throw new Error('Learning needs completed offensive player statistics.');
  const samples: Sample[] = [];
  for (let week = 2; week <= input.throughWeek; week += 1) {
    const priorRows = rows.filter((row) => row.week < week);
    const histories = new Map<string, number[]>();
    const positionTotals = new Map<string, number[]>();
    for (const row of priorRows) {
      const score = scorePlayerWeek(row, scoring);
      const history = histories.get(row.playerId) ?? [];
      history.push(score); histories.set(row.playerId, history);
      const values = positionTotals.get(row.position) ?? [];
      values.push(score); positionTotals.set(row.position, values);
    }
    for (const row of rows.filter((value) => value.week === week)) {
      const history = histories.get(row.playerId) ?? [];
      if (history.length < 3) continue;
      const peers = positionTotals.get(row.position) ?? [];
      const count = peers.length - history.length;
      samples.push({ week, history, actual: scorePlayerWeek(row, scoring), position: row.position,
        team: row.team, prior: count >= 20 ? (mean(peers) * peers.length - mean(history) * history.length) / count : null });
    }
  }
  const validationWeeks = [...new Set(samples.map((sample) => sample.week))].slice(-3);
  const validationStart = validationWeeks[0] ?? input.throughWeek;
  const train = samples.filter((sample) => sample.week < validationStart);
  const validation = samples.filter((sample) => sample.week >= validationStart);
  const incumbent = DEFAULT_PROJECTION_PARAMETERS;
  const candidates: ProjectionParameters[] = [incumbent];
  for (const recentWeight of [0, 0.25, 0.5]) {
    for (const priorGames of [0, 0.5, 2]) candidates.push({ recentWeight, priorGames, halfLife: 4 });
  }
  const candidate = train.length >= 100
    ? candidates.reduce((best, config) => (metrics(train, config).mae ?? Infinity) <
      (metrics(train, best).mae ?? Infinity) ? config : best, incumbent)
    : incumbent;
  const baseline = metrics(validation, incumbent);
  const candidateMetrics = metrics(validation, candidate);
  const enough = train.length >= 100 && validation.length >= 100 && validationWeeks.length === 3 &&
    new Set(train.map((sample) => sample.week)).size >= 3;
  const promoted = enough && candidateMetrics.mae! < baseline.mae! * 0.99 &&
    candidateMetrics.rmse! <= baseline.rmse!;
  const parameters = promoted ? candidate : incumbent;
  const residuals: Record<string, number[]> = {};
  const teamErrors = new Map<string, Array<{ actual: number; predicted: number }>>();
  // Reserve the final three weeks for both validation and reported calibration diagnostics.
  for (const sample of validation) {
    const predicted = forecastMean(sample.history, sample.prior, parameters);
    (residuals[sample.position] ??= []).push(sample.actual - predicted);
    const errors = teamErrors.get(sample.team) ?? [];
    errors.push({ actual: sample.actual, predicted }); teamErrors.set(sample.team, errors);
  }
  const playerRows = new Map<string, NflversePlayerWeek[]>();
  for (const row of rows) {
    const group = playerRows.get(row.playerId) ?? [];
    group.push(row); playerRows.set(row.playerId, group);
  }
  const players = Object.fromEntries([...playerRows].map(([id, values]) => {
    const last = values.at(-1)!;
    const recent = values.slice(-3);
    const opportunities = (row: NflversePlayerWeek) => row.attempts + row.carries + row.targets;
    return [id, { name: last.playerDisplayName, team: last.team, position: last.position,
      games: values.length, averagePoints: mean(values.map((row) => scorePlayerWeek(row, scoring))),
      recentPoints: mean(recent.map((row) => scorePlayerWeek(row, scoring))),
      averageOpportunities: mean(values.map(opportunities)), recentOpportunities: mean(recent.map(opportunities)) }];
  }));
  return learningRevisionSchema.parse({
    schemaVersion: 1, modelVersion: PROJECTION_MODEL_VERSION, season: input.season,
    throughWeek: input.throughWeek, createdAt: (input.now ?? new Date()).toISOString(),
    dataChecksum: createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
    scoring: Object.fromEntries(Object.entries(scoring).filter(([, value]) => typeof value === 'number' && value !== 0)),
    parameters, candidate, promoted,
    reason: promoted ? 'The candidate improved validation MAE by more than 1% without increasing RMSE.'
      : enough ? 'The candidate did not clear both validation gates. Keep the default parameters.'
        : 'The training or validation sample is too small. Keep the default parameters.',
    validationWeeks, baseline, candidateMetrics, residuals, players,
    teams: Object.fromEntries([...teamErrors].map(([team, errors]) => [team, summarizeErrors(errors)])),
    sources: [`https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_${input.season}.csv.gz`,
      'https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv.gz'],
  });
}

function metrics(samples: readonly Sample[], parameters: ProjectionParameters) {
  return summarizeErrors(samples.map((sample) => ({ actual: sample.actual,
    predicted: forecastMean(sample.history, sample.prior, parameters) })));
}
function summarizeErrors(values: readonly { actual: number; predicted: number }[]) {
  const errors = values.map((value) => value.predicted - value.actual);
  return { samples: errors.length, mae: errors.length ? mean(errors.map(Math.abs)) : null,
    rmse: errors.length ? Math.sqrt(mean(errors.map((value) => value ** 2))) : null,
    bias: errors.length ? mean(errors) : null };
}
