import { describe, expect, it } from 'vitest';

import {
  calculateDecisionRegret,
  calculateIntervalMetrics,
  calculateProbabilityMetrics,
  calculateRankMetrics,
  calculateRegressionMetrics,
} from '../src/evaluation/index.js';

describe('evaluation metrics', () => {
  it('calculates baseline error metrics', () => {
    const result = calculateRegressionMetrics([
      { predicted: 2, actual: 1 },
      { predicted: 0, actual: 2 },
    ]);

    expect(result).toMatchObject({
      sampleSize: 2,
      mae: 1.5,
      meanError: -0.5,
      meanActual: 1.5,
      meanPredicted: 1,
    });
    expect(result.rmse).toBeCloseTo(Math.sqrt(2.5));
  });

  it('scores ranks within separate forecast periods', () => {
    const result = calculateRankMetrics([
      { groupId: 'week-1', itemId: 'a', predicted: 20, actual: 30 },
      { groupId: 'week-1', itemId: 'b', predicted: 30, actual: 20 },
      { groupId: 'week-1', itemId: 'c', predicted: 10, actual: 10 },
      { groupId: 'week-2', itemId: 'a', predicted: 5, actual: 5 },
      { groupId: 'week-2', itemId: 'b', predicted: 1, actual: 1 },
    ]);

    expect(result.sampleSize).toBe(5);
    expect(result.meanAbsoluteRankError).toBeCloseTo(0.4);
    expect(result.spearmanCorrelation).toBeCloseTo(0.75);
    expect(result.pairwiseAccuracy).toBeCloseTo(0.75);
  });

  it('measures interval coverage and misses on both sides', () => {
    const result = calculateIntervalMetrics([
      { predicted: 10, lower: 5, upper: 15, actual: 10 },
      { predicted: 10, lower: 5, upper: 15, actual: 4 },
      { predicted: 10, lower: 5, upper: 15, actual: 16 },
    ]);

    expect(result).toEqual({
      sampleSize: 3,
      coverage: 1 / 3,
      belowRate: 1 / 3,
      aboveRate: 1 / 3,
      meanWidth: 10,
    });
  });

  it('calculates Brier and calibration metrics', () => {
    const result = calculateProbabilityMetrics(
      [
        { predictedProbability: 0.8, outcome: true },
        { predictedProbability: 0.2, outcome: false },
      ],
      5,
    );

    expect(result.sampleSize).toBe(2);
    expect(result.brierScore).toBeCloseTo(0.04);
    expect(result.expectedCalibrationError).toBeCloseTo(0.2);
    expect(result.bins.map((bin) => bin.count)).toEqual([0, 1, 0, 0, 1]);
  });

  it('measures the value lost by a predicted decision', () => {
    const result = calculateDecisionRegret([
      { decisionId: 'start', optionId: 'a', predicted: 20, actual: 5 },
      { decisionId: 'start', optionId: 'b', predicted: 15, actual: 10 },
      { decisionId: 'waiver', optionId: 'c', predicted: 8, actual: 8 },
      { decisionId: 'waiver', optionId: 'd', predicted: 4, actual: 2 },
    ]);

    expect(result).toEqual({
      decisions: 2,
      totalRegret: 5,
      meanRegret: 2.5,
      maximumRegret: 5,
      optimalSelectionRate: 0.5,
    });
  });

  it('returns null metrics for empty samples', () => {
    expect(calculateRegressionMetrics([])).toMatchObject({
      sampleSize: 0,
      mae: null,
      rmse: null,
    });
    expect(calculateDecisionRegret([])).toMatchObject({
      decisions: 0,
      meanRegret: null,
    });
  });
});
