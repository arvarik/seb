import { createEvaluationDataset } from './datasets.js';
import {
  calculateDecisionRegret,
  calculateIntervalMetrics,
  calculateProbabilityMetrics,
  calculateRankMetrics,
  calculateRegressionMetrics,
  type ProbabilityOutcome,
  type RankedPrediction,
} from './metrics.js';
import {
  REPLAY_REPORT_SCHEMA_VERSION,
  type BaselineConfiguration,
  type BaselineProjection,
  type DecisionOption,
  type EvaluationObservation,
  type HistoricalReplayInput,
  type ProbabilityForecast,
  type ReplayBoundary,
  type ReplayMetrics,
  type ReplayPeriodInput,
  type ReplayPeriodResult,
  type ReplayReport,
  type ReplayTarget,
} from './types.js';

export const DEFAULT_BASELINE_CONFIGURATION: BaselineConfiguration = {
  intervalLevel: 0.8,
  minimumEntityHistory: 1,
  recentWeight: 0.3,
  recentWindow: 3,
};

export class FutureLeakageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FutureLeakageError';
  }
}

export function runHistoricalReplay(input: HistoricalReplayInput): ReplayReport {
  const dataset = createEvaluationDataset(input.dataset);
  const configuration = normalizeConfiguration(input.baseline);
  const binCount = input.calibrationBins ?? 10;
  const periods = [...input.periods].sort(comparePeriods);
  validateUniquePeriods(periods);
  const probabilityForecasts = input.probabilityForecasts ?? [];
  validateProbabilityForecastPeriods(probabilityForecasts, periods);

  const results = periods.map((period) =>
    runPeriod(
      dataset.observations,
      period,
      configuration,
      probabilityForecasts.filter((forecast) =>
        sameBoundary(forecast.boundary, period.boundary),
      ),
      binCount,
    ),
  );
  const allProjections = results.flatMap((result) => result.projections);
  const allRankGroupIds = results.flatMap((result) =>
    result.projections.map(() => periodKey(result.boundary)),
  );
  const allProbabilities = probabilityForecasts.map(toProbabilityOutcome);
  return {
    schemaVersion: REPLAY_REPORT_SCHEMA_VERSION,
    generatedAt: validInstant(
      input.generatedAt ?? new Date().toISOString(),
      'The report generation time',
    ),
    dataset: {
      id: dataset.id,
      kind: dataset.kind,
      label: dataset.label,
      metric: dataset.metric,
      source: dataset.source,
    },
    baseline: configuration,
    periods: results,
    metrics: buildMetrics(
      allProjections,
      allProbabilities,
      binCount,
      allRankGroupIds,
    ),
  };
}

export function createWeeklyReplayPeriods(input: {
  cutoffsByWeek: Readonly<Record<number, string>>;
  season: number;
  targetsByWeek: Readonly<Record<number, readonly ReplayTarget[]>>;
  weeks: readonly number[];
}): ReplayPeriodInput[] {
  return input.weeks.map((week) => {
    const knowledgeCutoff = input.cutoffsByWeek[week];
    const targets = input.targetsByWeek[week];
    if (!knowledgeCutoff) {
      throw new Error(`Season ${input.season} Week ${week} needs a knowledge cutoff.`);
    }
    if (!targets) {
      throw new Error(`Season ${input.season} Week ${week} needs a target list.`);
    }
    return {
      boundary: { season: input.season, week, knowledgeCutoff },
      targets,
    };
  });
}

function runPeriod(
  observations: readonly EvaluationObservation[],
  period: ReplayPeriodInput,
  configuration: BaselineConfiguration,
  probabilityForecasts: readonly ProbabilityForecast[],
  binCount: number,
): ReplayPeriodResult {
  validateBoundary(period.boundary);
  validateTargets(period.targets, period.boundary);
  const cutoff = timestamp(period.boundary.knowledgeCutoff);
  const chronologicalHistory = observations.filter((observation) =>
    beforeBoundary(observation, period.boundary),
  );
  const training = chronologicalHistory.filter(
    (observation) => timestamp(observation.availableAt) <= cutoff,
  );
  const outcomes = observations.filter(
    (observation) =>
      observation.season === period.boundary.season &&
      observation.week === period.boundary.week,
  );
  const outcomesByEntity = new Map(
    outcomes.map((outcome) => [outcome.entityId, outcome]),
  );
  const projections: BaselineProjection[] = [];
  const missingOutcomeEntityIds: string[] = [];
  for (const target of [...period.targets].sort((left, right) =>
    left.entityId.localeCompare(right.entityId),
  )) {
    const outcome = outcomesByEntity.get(target.entityId);
    if (!outcome) {
      missingOutcomeEntityIds.push(target.entityId);
      continue;
    }
    if (timestamp(outcome.availableAt) <= cutoff) {
      throw new FutureLeakageError(
        `The result for ${target.entityId} was available at or before the forecast cutoff.`,
      );
    }
    projections.push(
      projectBaseline(target, outcome.actual, training, configuration),
    );
  }

  const probabilityOutcomes = probabilityForecasts.map((forecast) => {
    validateProbabilityForecast(forecast);
    return toProbabilityOutcome(forecast);
  });
  return {
    boundary: period.boundary,
    audit: {
      targetCount: period.targets.length,
      evaluatedTargets: projections.length,
      missingOutcomeEntityIds,
      trainingObservations: training.length,
      excludedAfterCutoff: chronologicalHistory.length - training.length,
      excludedFuturePeriod:
        observations.length - chronologicalHistory.length - outcomes.length,
    },
    projections,
    metrics: buildMetrics(
      projections,
      probabilityOutcomes,
      binCount,
      [periodKey(period.boundary)],
    ),
  };
}

function projectBaseline(
  target: ReplayTarget,
  actual: number,
  training: readonly EvaluationObservation[],
  configuration: BaselineConfiguration,
): BaselineProjection {
  const entityHistory = training.filter(
    (observation) => observation.entityId === target.entityId,
  );
  const segmentPrior =
    target.segment === null
      ? []
      : training.filter((observation) => observation.segment === target.segment);
  let reference: readonly EvaluationObservation[];
  let method: BaselineProjection['method'];
  if (entityHistory.length >= configuration.minimumEntityHistory) {
    reference = entityHistory;
    method = 'entity-history';
  } else if (segmentPrior.length > 0) {
    reference = segmentPrior;
    method = 'segment-prior';
  } else if (training.length > 0) {
    reference = training;
    method = 'global-prior';
  } else {
    reference = [];
    method = 'zero-prior';
  }

  const predicted = baselineMean(reference, configuration);
  const varianceReference =
    reference.length >= 2
      ? reference
      : segmentPrior.length >= 2
        ? segmentPrior
        : training;
  const deviation = populationStandardDeviation(
    varianceReference.map((observation) => observation.actual),
  );
  const z = inverseNormal(0.5 + configuration.intervalLevel / 2);
  return {
    entityId: target.entityId,
    label: target.label,
    segment: target.segment,
    decisionId: target.decisionId,
    historyCount: entityHistory.length,
    method,
    predicted,
    lower: predicted - z * deviation,
    upper: predicted + z * deviation,
    actual,
  };
}

function baselineMean(
  reference: readonly EvaluationObservation[],
  configuration: BaselineConfiguration,
): number {
  if (reference.length === 0) {
    return 0;
  }
  const ordered = [...reference].sort(compareObservations);
  const allMean = mean(ordered.map((observation) => observation.actual));
  const recent = ordered.slice(-configuration.recentWindow);
  const recentMean = mean(recent.map((observation) => observation.actual));
  return (
    allMean * (1 - configuration.recentWeight) +
    recentMean * configuration.recentWeight
  );
}

function buildMetrics(
  projections: readonly BaselineProjection[],
  probabilityOutcomes: readonly ProbabilityOutcome[],
  binCount: number,
  rankGroupIds: readonly string[],
): ReplayMetrics {
  const rankValues: RankedPrediction[] = projections.map((projection, index) => ({
    itemId: projection.entityId,
    groupId: rankGroupIds.length === 1
      ? rankGroupIds[0] ?? 'period'
      : rankGroupIds[index] ?? projection.decisionId ?? 'aggregate',
    predicted: projection.predicted,
    actual: projection.actual,
  }));
  const decisions: DecisionOption[] = projections.flatMap((projection, index) => {
    if (projection.decisionId === null) {
      return [];
    }
    const groupId =
      rankGroupIds.length === 1
        ? rankGroupIds[0]
        : rankGroupIds[index];
    return [
      {
        decisionId: `${groupId ?? 'period'}:${projection.decisionId}`,
        optionId: projection.entityId,
        predicted: projection.predicted,
        actual: projection.actual,
      },
    ];
  });
  return {
    regression: calculateRegressionMetrics(projections),
    ranks: calculateRankMetrics(rankValues),
    intervals: calculateIntervalMetrics(projections),
    probability: calculateProbabilityMetrics(probabilityOutcomes, binCount),
    decisions: calculateDecisionRegret(decisions),
  };
}

function normalizeConfiguration(
  input: Partial<BaselineConfiguration> | undefined,
): BaselineConfiguration {
  const result = { ...DEFAULT_BASELINE_CONFIGURATION, ...input };
  if (
    !Number.isFinite(result.intervalLevel) ||
    result.intervalLevel <= 0 ||
    result.intervalLevel >= 1
  ) {
    throw new RangeError('The interval level must be greater than 0 and less than 1.');
  }
  if (
    !Number.isFinite(result.recentWeight) ||
    result.recentWeight < 0 ||
    result.recentWeight > 1
  ) {
    throw new RangeError('The recent weight must be from 0 through 1.');
  }
  integer(result.recentWindow, 'The recent window', 1, 100);
  integer(result.minimumEntityHistory, 'The minimum entity history', 1, 100);
  return result;
}

function validateBoundary(boundary: ReplayBoundary): void {
  integer(boundary.season, 'The replay season', 1999, 2100);
  integer(boundary.week, 'The replay week', 1, 25);
  validInstant(boundary.knowledgeCutoff, 'The knowledge cutoff');
}

function validateTargets(
  targets: readonly ReplayTarget[],
  boundary: ReplayBoundary,
): void {
  const entityIds = new Set<string>();
  const cutoff = timestamp(boundary.knowledgeCutoff);
  for (const target of targets) {
    requiredText(target.entityId, 'The target entity ID');
    requiredText(target.label, 'The target label');
    validInstant(target.availableAt, 'The target availability time');
    if (timestamp(target.availableAt) > cutoff) {
      throw new FutureLeakageError(
        `The target ${target.entityId} became available after the forecast cutoff.`,
      );
    }
    if (entityIds.has(target.entityId)) {
      throw new Error(`The target ${target.entityId} occurs more than once.`);
    }
    entityIds.add(target.entityId);
  }
}

function validateProbabilityForecast(forecast: ProbabilityForecast): void {
  validateBoundary(forecast.boundary);
  requiredText(forecast.eventId, 'The probability event ID');
  validInstant(forecast.forecastAt, 'The probability forecast time');
  validInstant(forecast.outcomeAvailableAt, 'The probability result time');
  if (
    timestamp(forecast.forecastAt) >
    timestamp(forecast.boundary.knowledgeCutoff)
  ) {
    throw new FutureLeakageError(
      `The probability forecast ${forecast.eventId} was created after the cutoff.`,
    );
  }
  if (
    timestamp(forecast.outcomeAvailableAt) <=
    timestamp(forecast.boundary.knowledgeCutoff)
  ) {
    throw new FutureLeakageError(
      `The probability result ${forecast.eventId} was available at or before the cutoff.`,
    );
  }
  if (
    !Number.isFinite(forecast.predictedProbability) ||
    forecast.predictedProbability < 0 ||
    forecast.predictedProbability > 1
  ) {
    throw new RangeError('The predicted probability must be from 0 through 1.');
  }
}

function validateProbabilityForecastPeriods(
  forecasts: readonly ProbabilityForecast[],
  periods: readonly ReplayPeriodInput[],
): void {
  const eventKeys = new Set<string>();
  for (const forecast of forecasts) {
    validateProbabilityForecast(forecast);
    if (!periods.some((period) => sameBoundary(period.boundary, forecast.boundary))) {
      throw new Error(
        `The probability forecast ${forecast.eventId} has no matching replay period.`,
      );
    }
    const key = `${periodKey(forecast.boundary)}:${forecast.eventId}`;
    if (eventKeys.has(key)) {
      throw new Error(
        `The probability event ${forecast.eventId} occurs more than once in its replay period.`,
      );
    }
    eventKeys.add(key);
  }
}

function validateUniquePeriods(periods: readonly ReplayPeriodInput[]): void {
  const keys = new Set<string>();
  for (const period of periods) {
    validateBoundary(period.boundary);
    const key = periodKey(period.boundary);
    if (keys.has(key)) {
      throw new Error(`The replay boundary ${key} occurs more than once.`);
    }
    keys.add(key);
  }
}

function beforeBoundary(
  observation: EvaluationObservation,
  boundary: ReplayBoundary,
): boolean {
  return (
    observation.season < boundary.season ||
    (observation.season === boundary.season && observation.week < boundary.week)
  );
}

function sameBoundary(left: ReplayBoundary, right: ReplayBoundary): boolean {
  return (
    left.season === right.season &&
    left.week === right.week &&
    timestamp(left.knowledgeCutoff) === timestamp(right.knowledgeCutoff)
  );
}

function comparePeriods(left: ReplayPeriodInput, right: ReplayPeriodInput): number {
  return (
    left.boundary.season - right.boundary.season ||
    left.boundary.week - right.boundary.week ||
    timestamp(left.boundary.knowledgeCutoff) -
      timestamp(right.boundary.knowledgeCutoff)
  );
}

function compareObservations(
  left: EvaluationObservation,
  right: EvaluationObservation,
): number {
  return (
    left.season - right.season ||
    left.week - right.week ||
    timestamp(left.availableAt) - timestamp(right.availableAt) ||
    left.id.localeCompare(right.id)
  );
}

function periodKey(boundary: ReplayBoundary): string {
  return `${boundary.season}:W${boundary.week}:${new Date(boundary.knowledgeCutoff).toISOString()}`;
}

function toProbabilityOutcome(forecast: ProbabilityForecast): ProbabilityOutcome {
  return {
    predictedProbability: forecast.predictedProbability,
    outcome: forecast.outcome,
  };
}

function populationStandardDeviation(values: readonly number[]): number {
  if (values.length < 2) {
    return 0;
  }
  const average = mean(values);
  return Math.sqrt(
    mean(values.map((value) => (value - average) ** 2)),
  );
}

// Peter J. Acklam's rational approximation provides stable normal quantiles.
function inverseNormal(probability: number): number {
  const a = [
    -39.69683028665376,
    220.9460984245205,
    -275.9285104469687,
    138.357751867269,
    -30.66479806614716,
    2.506628277459239,
  ];
  const b = [
    -54.47609879822406,
    161.5858368580409,
    -155.6989798598866,
    66.80131188771972,
    -13.28068155288572,
  ];
  const c = [
    -0.007784894002430293,
    -0.3223964580411365,
    -2.400758277161838,
    -2.549732539343734,
    4.374664141464968,
    2.938163982698783,
  ];
  const d = [
    0.007784695709041462,
    0.3224671290700398,
    2.445134137142996,
    3.754408661907416,
  ];
  const low = 0.02425;
  const high = 1 - low;
  if (probability < low) {
    const q = Math.sqrt(-2 * Math.log(probability));
    return polynomial(c, q) / polynomial([...d, 1], q);
  }
  if (probability <= high) {
    const q = probability - 0.5;
    const r = q * q;
    return (polynomial(a, r) * q) / polynomial([...b, 1], r);
  }
  const q = Math.sqrt(-2 * Math.log(1 - probability));
  return -polynomial(c, q) / polynomial([...d, 1], q);
}

function polynomial(coefficients: readonly number[], value: number): number {
  return coefficients.reduce(
    (result, coefficient) => result * value + coefficient,
    0,
  );
}

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function validInstant(value: string, label: string): string {
  if (value.trim().length === 0 || !Number.isFinite(Date.parse(value))) {
    throw new TypeError(`${label} must be a valid date and time.`);
  }
  return new Date(value).toISOString();
}

function timestamp(value: string): number {
  return Date.parse(value);
}

function requiredText(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`${label} must not be empty.`);
  }
}

function integer(
  value: number,
  label: string,
  minimum: number,
  maximum: number,
): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${label} must be an integer from ${minimum} through ${maximum}.`,
    );
  }
}
