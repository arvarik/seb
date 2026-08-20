import type {
  CalibrationBin,
  DecisionOption,
  DecisionRegretMetrics,
  IntervalMetrics,
  ProbabilityMetrics,
  RankMetrics,
  RegressionMetrics,
} from './types.js';

export interface NumericPrediction {
  actual: number;
  predicted: number;
}

export interface IntervalPrediction extends NumericPrediction {
  lower: number;
  upper: number;
}

export interface RankedPrediction extends NumericPrediction {
  groupId: string;
  itemId: string;
}

export interface ProbabilityOutcome {
  outcome: boolean;
  predictedProbability: number;
}

export function calculateRegressionMetrics(
  values: readonly NumericPrediction[],
): RegressionMetrics {
  validateNumericPredictions(values);
  if (values.length === 0) {
    return {
      mae: null,
      meanActual: null,
      meanError: null,
      meanPredicted: null,
      rmse: null,
      sampleSize: 0,
    };
  }

  const errors = values.map((value) => value.predicted - value.actual);
  return {
    sampleSize: values.length,
    mae: mean(errors.map(Math.abs)),
    rmse: Math.sqrt(mean(errors.map((error) => error ** 2))),
    meanError: mean(errors),
    meanActual: mean(values.map((value) => value.actual)),
    meanPredicted: mean(values.map((value) => value.predicted)),
  };
}

export function calculateIntervalMetrics(
  values: readonly IntervalPrediction[],
): IntervalMetrics {
  validateNumericPredictions(values);
  for (const value of values) {
    finite(value.lower, 'The interval lower bound');
    finite(value.upper, 'The interval upper bound');
    if (value.lower > value.upper) {
      throw new RangeError('The interval lower bound must not exceed its upper bound.');
    }
  }
  if (values.length === 0) {
    return {
      aboveRate: null,
      belowRate: null,
      coverage: null,
      meanWidth: null,
      sampleSize: 0,
    };
  }

  const below = values.filter((value) => value.actual < value.lower).length;
  const above = values.filter((value) => value.actual > value.upper).length;
  return {
    sampleSize: values.length,
    coverage: (values.length - below - above) / values.length,
    belowRate: below / values.length,
    aboveRate: above / values.length,
    meanWidth: mean(values.map((value) => value.upper - value.lower)),
  };
}

export function calculateRankMetrics(
  values: readonly RankedPrediction[],
): RankMetrics {
  validateNumericPredictions(values);
  const itemKeys = new Set<string>();
  for (const value of values) {
    requiredText(value.groupId, 'The rank group ID');
    requiredText(value.itemId, 'The ranked item ID');
    const key = `${value.groupId}\u0000${value.itemId}`;
    if (itemKeys.has(key)) {
      throw new Error(
        `The ranked item ${value.itemId} occurs more than once in ${value.groupId}.`,
      );
    }
    itemKeys.add(key);
  }
  const groups = groupBy(values, (value) => value.groupId);
  const groupResults = [...groups.values()].flatMap(calculateGroupRanks);
  if (groupResults.length === 0) {
    return {
      meanAbsoluteRankError: null,
      pairwiseAccuracy: null,
      sampleSize: values.length,
      spearmanCorrelation: null,
    };
  }

  const rankErrors = groupResults.flatMap((result) => result.rankErrors);
  const correlations = groupResults.flatMap((result) =>
    result.correlation === null ? [] : [result.correlation],
  );
  const pairwise = groupResults.reduce(
    (total, result) => ({
      correct: total.correct + result.pairwiseCorrect,
      total: total.total + result.pairwiseTotal,
    }),
    { correct: 0, total: 0 },
  );
  return {
    sampleSize: values.length,
    meanAbsoluteRankError:
      rankErrors.length === 0 ? null : mean(rankErrors),
    spearmanCorrelation:
      correlations.length === 0 ? null : mean(correlations),
    pairwiseAccuracy:
      pairwise.total === 0 ? null : pairwise.correct / pairwise.total,
  };
}

export function calculateProbabilityMetrics(
  values: readonly ProbabilityOutcome[],
  binCount = 10,
): ProbabilityMetrics {
  if (!Number.isInteger(binCount) || binCount < 2 || binCount > 100) {
    throw new RangeError('The calibration bin count must be an integer from 2 through 100.');
  }
  for (const value of values) {
    probability(value.predictedProbability);
  }

  const mutableBins = Array.from({ length: binCount }, (_, index) => ({
    lowerBound: index / binCount,
    upperBound: (index + 1) / binCount,
    probabilities: [] as number[],
    outcomes: [] as number[],
  }));
  for (const value of values) {
    const index = Math.min(
      Math.floor(value.predictedProbability * binCount),
      binCount - 1,
    );
    const bin = mutableBins[index];
    if (!bin) {
      throw new Error('The calibration bin does not exist.');
    }
    bin.probabilities.push(value.predictedProbability);
    bin.outcomes.push(value.outcome ? 1 : 0);
  }

  const bins: CalibrationBin[] = mutableBins.map((bin) => ({
    lowerBound: bin.lowerBound,
    upperBound: bin.upperBound,
    count: bin.outcomes.length,
    meanProbability:
      bin.probabilities.length === 0 ? null : mean(bin.probabilities),
    actualRate: bin.outcomes.length === 0 ? null : mean(bin.outcomes),
  }));
  if (values.length === 0) {
    return {
      brierScore: null,
      bins,
      expectedCalibrationError: null,
      sampleSize: 0,
    };
  }

  const brierScore = mean(
    values.map(
      (value) =>
        (value.predictedProbability - (value.outcome ? 1 : 0)) ** 2,
    ),
  );
  const expectedCalibrationError = bins.reduce((total, bin) => {
    if (bin.actualRate === null || bin.meanProbability === null) {
      return total;
    }
    return (
      total +
      (bin.count / values.length) *
        Math.abs(bin.actualRate - bin.meanProbability)
    );
  }, 0);
  return {
    brierScore,
    bins,
    expectedCalibrationError,
    sampleSize: values.length,
  };
}

export function calculateDecisionRegret(
  options: readonly DecisionOption[],
): DecisionRegretMetrics {
  const optionKeys = new Set<string>();
  for (const option of options) {
    requiredText(option.decisionId, 'The decision ID');
    requiredText(option.optionId, 'The option ID');
    finite(option.actual, 'The option result');
    finite(option.predicted, 'The option prediction');
    const key = `${option.decisionId}\u0000${option.optionId}`;
    if (optionKeys.has(key)) {
      throw new Error(
        `The option ${option.optionId} occurs more than once in ${option.decisionId}.`,
      );
    }
    optionKeys.add(key);
  }
  const decisions = groupBy(options, (option) => option.decisionId);
  const regrets: number[] = [];
  let optimalSelections = 0;
  for (const group of decisions.values()) {
    if (group.length === 0) {
      continue;
    }
    const explicit = group.filter((option) => option.selected === true);
    if (explicit.length > 1) {
      throw new Error('Each decision can select at most one option.');
    }
    const selected = explicit[0] ?? bestOption(group, 'predicted');
    const optimal = bestOption(group, 'actual');
    const regret = Math.max(0, optimal.actual - selected.actual);
    regrets.push(regret);
    if (regret === 0) {
      optimalSelections += 1;
    }
  }
  if (regrets.length === 0) {
    return {
      decisions: 0,
      maximumRegret: null,
      meanRegret: null,
      optimalSelectionRate: null,
      totalRegret: null,
    };
  }
  return {
    decisions: regrets.length,
    totalRegret: sum(regrets),
    meanRegret: mean(regrets),
    maximumRegret: Math.max(...regrets),
    optimalSelectionRate: optimalSelections / regrets.length,
  };
}

function calculateGroupRanks(values: readonly RankedPrediction[]): Array<{
  correlation: number | null;
  pairwiseCorrect: number;
  pairwiseTotal: number;
  rankErrors: number[];
}> {
  if (values.length < 2) {
    return [];
  }
  const predictedRanks = averageRanks(values, (value) => value.predicted);
  const actualRanks = averageRanks(values, (value) => value.actual);
  const predicted: number[] = [];
  const actual: number[] = [];
  for (const value of values) {
    predicted.push(predictedRanks.get(value.itemId) ?? 0);
    actual.push(actualRanks.get(value.itemId) ?? 0);
  }
  let pairwiseCorrect = 0;
  let pairwiseTotal = 0;
  for (let leftIndex = 0; leftIndex < values.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < values.length; rightIndex += 1) {
      const left = values[leftIndex];
      const right = values[rightIndex];
      if (!left || !right || left.actual === right.actual) {
        continue;
      }
      pairwiseTotal += 1;
      const actualDirection = Math.sign(left.actual - right.actual);
      const predictedDirection = Math.sign(left.predicted - right.predicted);
      pairwiseCorrect +=
        predictedDirection === 0
          ? 0.5
          : predictedDirection === actualDirection
            ? 1
            : 0;
    }
  }
  return [
    {
      correlation: pearson(predicted, actual),
      pairwiseCorrect,
      pairwiseTotal,
      rankErrors: predicted.map((rank, index) =>
        Math.abs(rank - (actual[index] ?? rank)),
      ),
    },
  ];
}

function averageRanks<T>(
  values: readonly T[],
  select: (value: T) => number,
): Map<string, number> {
  const withIds = values as readonly (T & { itemId: string })[];
  const sorted = [...withIds].sort(
    (left, right) =>
      select(right) - select(left) || left.itemId.localeCompare(right.itemId),
  );
  const ranks = new Map<string, number>();
  let index = 0;
  while (index < sorted.length) {
    const value = select(sorted[index] as T);
    let end = index + 1;
    while (end < sorted.length && select(sorted[end] as T) === value) {
      end += 1;
    }
    const rank = (index + 1 + end) / 2;
    for (let cursor = index; cursor < end; cursor += 1) {
      const item = sorted[cursor];
      if (item) {
        ranks.set(item.itemId, rank);
      }
    }
    index = end;
  }
  return ranks;
}

function pearson(left: readonly number[], right: readonly number[]): number | null {
  if (left.length !== right.length || left.length < 2) {
    return null;
  }
  const leftMean = mean(left);
  const rightMean = mean(right);
  let covariance = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftDelta = (left[index] ?? 0) - leftMean;
    const rightDelta = (right[index] ?? 0) - rightMean;
    covariance += leftDelta * rightDelta;
    leftVariance += leftDelta ** 2;
    rightVariance += rightDelta ** 2;
  }
  if (leftVariance === 0 || rightVariance === 0) {
    return null;
  }
  return covariance / Math.sqrt(leftVariance * rightVariance);
}

function bestOption(
  options: readonly DecisionOption[],
  key: 'actual' | 'predicted',
): DecisionOption {
  const sorted = [...options].sort(
    (left, right) =>
      right[key] - left[key] || left.optionId.localeCompare(right.optionId),
  );
  const result = sorted[0];
  if (!result) {
    throw new Error('A decision needs at least one option.');
  }
  return result;
}

function validateNumericPredictions(values: readonly NumericPrediction[]): void {
  for (const value of values) {
    finite(value.actual, 'The observed value');
    finite(value.predicted, 'The predicted value');
  }
}

function probability(value: number): void {
  finite(value, 'The probability');
  if (value < 0 || value > 1) {
    throw new RangeError('The probability must be from 0 through 1.');
  }
}

function finite(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${label} must be a finite number.`);
  }
}

function requiredText(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`${label} must not be empty.`);
  }
}

function groupBy<T>(
  values: readonly T[],
  select: (value: T) => string,
): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const value of values) {
    const key = select(value);
    const group = result.get(key) ?? [];
    group.push(value);
    result.set(key, group);
  }
  return result;
}

function mean(values: readonly number[]): number {
  return sum(values) / values.length;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
