import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { throwIfRequestAborted } from '../ai/request-signal.js';
import type { NflversePlayerWeek } from '../nflverse/types.js';
import { forecastMean, forecastInterval, mean, normalCdf, DEFAULT_PROJECTION_PARAMETERS, type ProjectionParameters } from '../projection/statistics.js';
import { scorePlayerWeek } from '../projection/player-projection.js';
import { learnFromCompletedRows, PPR_SCORING, positionPrior } from '../learning/engine.js';
import { calculateRegressionMetrics, calculateIntervalMetrics, calculateRankMetrics, calculateProbabilityMetrics, calculateDecisionRegret } from './metrics.js';
import type { SleeperSettings } from '../sleeper/types.js';

/** Compare production forecasts with the previous mean/recent baseline at weekly time boundaries. */
export async function evaluateProjectionModels(
  input: { rows: readonly NflversePlayerWeek[]; season: number; throughWeek: number; scoring?: SleeperSettings; parameters?: ProjectionParameters },
) {
  if (!Number.isInteger(input.season) || input.season < 1999 || input.season > 2100 ||
    !Number.isInteger(input.throughWeek) || input.throughWeek < 1 || input.throughWeek > 18) {
    throw new Error('Evaluation requires a valid season and a week from 1 through 18.');
  }
  const scoring = input.scoring ?? PPR_SCORING;
  const rows = input.rows.filter((row) => row.season === input.season && row.seasonType === 'REG' &&
    row.week <= input.throughWeek && ['QB', 'RB', 'WR', 'TE'].includes(row.position));
  if (new Set(rows.map((row) => `${row.playerId}:${row.week}`)).size !== rows.length) throw new Error('Evaluation rejects duplicate player-week outcomes.');
  type Result = { week: number; actual: number; predicted: number; lower: number; upper: number; groupId: string; itemId: string; position: string };
  const results: Record<'legacy' | 'ensemble' | 'adaptive', Result[]> = { legacy: [], ensemble: [], adaptive: [] };
  let missingOutcomes = 0;
  const updates: Array<{ throughWeek: number; promoted: boolean; reason: string }> = [];
  for (let week = 4; week <= input.throughWeek; week += 1) {
    throwIfRequestAborted(); await setImmediate();
    const historyRows = rows.filter((row) => row.week < week);
    if (!historyRows.length) continue;
    const learned = learnFromCompletedRows({ rows: historyRows, season: input.season, throughWeek: week - 1, scoring });
    updates.push({ throughWeek: week - 1, promoted: learned.promoted, reason: learned.reason });
    const histories = new Map<string, NflversePlayerWeek[]>();
    for (const row of historyRows) {
      const group = histories.get(row.playerId) ?? []; group.push(row); histories.set(row.playerId, group);
    }
    const outcomes = new Map(rows.filter((row) => row.week === week).map((row) => [row.playerId, row]));
    for (const [id, history] of histories) {
      if (history.length < 3) continue;
      const outcome = outcomes.get(id);
      if (!outcome) { missingOutcomes += 1; continue; }
      const ordered = history.sort((a, b) => a.week - b.week);
      const values = ordered.map((row) => scorePlayerWeek(row, scoring));
      const latest = ordered.at(-1)!;
      const prior = positionPrior(historyRows, latest.position, id, scoring);
      const actual = scorePlayerWeek(outcome, scoring);
      const legacy = Math.max(0, mean(values) * 0.55 + mean(values.slice(-3)) * 0.45);
      const ensemble = forecastMean(values, prior, input.parameters ?? DEFAULT_PROJECTION_PARAMETERS);
      const adaptive = forecastMean(values, prior, learned.parameters);
      for (const [name, predicted] of Object.entries({ legacy, ensemble, adaptive }) as Array<[keyof typeof results, number]>) {
        const residuals = results[name].filter((value) => value.week < week && value.week >= week - 3 && value.position === latest.position)
          .map((value) => value.actual - value.predicted);
        const legacyWidth = Math.max(Math.sqrt(mean(values.map((value) => (value - mean(values)) ** 2))) * 0.85, predicted * 0.2, 1);
        const interval = name === 'legacy' ? { lower: Math.max(0, predicted - legacyWidth), upper: predicted + legacyWidth }
          : forecastInterval(predicted, residuals, values);
        results[name].push({ week, actual, predicted, lower: interval.lower, upper: interval.upper,
          itemId: id, groupId: `${week}:${latest.position}`, position: latest.position });
      }
    }
  }
  const summarize = (values: Result[]) => {
    const groups = new Map<string, Result[]>();
    for (const value of values) {
      const group = groups.get(value.groupId) ?? []; group.push(value); groups.set(value.groupId, group);
    }
    const decisions: Array<{ decisionId: string; optionId: string; predicted: number; actual: number }> = [];
    const probabilities: Array<{ outcome: boolean; predictedProbability: number }> = [];
    for (const [groupId, group] of groups) {
      group.sort((a, b) => b.predicted - a.predicted || a.itemId.localeCompare(b.itemId));
      // Disjoint neighbors compare alternatives with similar projected ranks, without using outcomes to select pairs.
      for (let index = 0; index + 1 < group.length; index += 2) {
        const a = group[index]!; const b = group[index + 1]!;
        const decisionId = `${groupId}:${index}`;
        decisions.push({ decisionId, optionId: a.itemId, predicted: a.predicted, actual: a.actual },
          { decisionId, optionId: b.itemId, predicted: b.predicted, actual: b.actual });
        if (a.actual === b.actual) continue;
        const sigma = Math.hypot(Math.max(1, (a.upper - a.lower) / (2 * 1.282)), Math.max(1, (b.upper - b.lower) / (2 * 1.282)));
        probabilities.push({ outcome: a.actual > b.actual, predictedProbability: normalCdf((a.predicted - b.predicted) / sigma) });
      }
    }
    return { regression: calculateRegressionMetrics(values),
    neighborDecisions: { regret: calculateDecisionRegret(decisions), probability: calculateProbabilityMetrics(probabilities) },
    intervals: calculateIntervalMetrics(values), ranks: calculateRankMetrics(values),
    intervalScore: values.length ? mean(values.map((value) => value.upper - value.lower +
      10 * Math.max(value.lower - value.actual, value.actual - value.upper, 0))) : null };
  };
  return { season: input.season, throughWeek: input.throughWeek, scoring, modelVersion: 'ensemble-v1',
    dataChecksum: createHash('sha256').update(JSON.stringify([...rows].sort((a, b) => a.week - b.week || a.playerId.localeCompare(b.playerId)))).digest('hex'),
    parameters: input.parameters ?? DEFAULT_PROJECTION_PARAMETERS,
    models: Object.fromEntries(Object.entries(results).map(([name, values]) => [name, summarize(values)])),
    byPosition: Object.fromEntries(['QB', 'RB', 'WR', 'TE'].map((position) => [position,
      Object.fromEntries(Object.entries(results).map(([name, values]) => [name, summarize(values.filter((value) => value.position === position))]))])),
    missingOutcomes, updates,
    limitations: ['The target pool uses players with at least three earlier games. Missing outcomes remain missing, not zero.',
      'Metrics condition on observed player outcomes. Byes and absent stat rows do not measure lineup availability accuracy.',
      'The replay uses revised historical statistics. It does not reconstruct original injury reports or source publication delays.',
      'Production context adjustments and live news are excluded. This report measures the statistical base forecast.',
      'Rank metrics compare players within the same position and week.',
      'Neighbor decision tests pair adjacent projected ranks within each week and position. These are synthetic choices, not saved user decisions.',
      'Each model selects its own neighbor pairs. Regret values are diagnostics, not a shared-decision comparison. Tied outcomes do not enter probability scores.',
      'Legacy reproduces the previous point formula and heuristic range with corrected scoring. New ranges use prior-week errors only.',
      'Interval scores use an 80% target level. Coverage under changing season conditions has no per-player guarantee.'] };
}
