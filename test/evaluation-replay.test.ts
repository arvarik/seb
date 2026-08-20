import { describe, expect, it } from 'vitest';

import {
  createEvaluationDataset,
  FutureLeakageError,
  runHistoricalReplay,
  type EvaluationObservation,
  type ReplayPeriodInput,
  type ReplayTarget,
} from '../src/evaluation/index.js';

describe('historical replay', () => {
  it('uses only results that existed before each forecast cutoff', () => {
    const replayPeriods = periods();
    const firstPeriod = replayPeriods[0];
    if (!firstPeriod) {
      throw new Error('The first replay period is missing.');
    }
    const report = runHistoricalReplay({
      dataset: dataset(),
      periods: replayPeriods,
      generatedAt: '2025-02-01T00:00:00.000Z',
      probabilityForecasts: [
        {
          eventId: 'matchup-week-2',
          boundary: firstPeriod.boundary,
          forecastAt: '2025-01-08T11:00:00.000Z',
          predictedProbability: 0.8,
          outcome: true,
          outcomeAvailableAt: '2025-01-09T00:00:00.000Z',
        },
      ],
    });

    expect(report.periods).toHaveLength(2);
    expect(report.periods[0]?.audit).toMatchObject({
      trainingObservations: 2,
      evaluatedTargets: 2,
      excludedFuturePeriod: 2,
    });
    expect(report.periods[0]?.projections).toMatchObject([
      { entityId: 'a', predicted: 10, actual: 30, historyCount: 1 },
      { entityId: 'b', predicted: 20, actual: 10, historyCount: 1 },
    ]);
    expect(report.periods[0]?.metrics.decisions).toMatchObject({
      decisions: 1,
      totalRegret: 20,
    });
    expect(report.periods[1]?.projections).toMatchObject([
      { entityId: 'a', predicted: 20, actual: 100, historyCount: 2 },
      { entityId: 'b', predicted: 15, actual: 40, historyCount: 2 },
    ]);
    expect(report.metrics.regression.sampleSize).toBe(4);
    expect(report.metrics.probability.brierScore).toBeCloseTo(0.04);
    expect(report.metrics.ranks.spearmanCorrelation).toBeCloseTo(0);
  });

  it('excludes historical rows that arrived after the cutoff', () => {
    const observations = [
      observation('a', 1, 99, '2025-01-20T00:00:00.000Z'),
      observation('a', 2, 10, '2025-01-09T00:00:00.000Z'),
    ];
    const report = runHistoricalReplay({
      dataset: dataset(observations),
      periods: [period(2, '2025-01-08T12:00:00.000Z')],
      generatedAt: '2025-02-01T00:00:00.000Z',
    });

    expect(report.periods[0]?.audit).toMatchObject({
      trainingObservations: 0,
      excludedAfterCutoff: 1,
    });
    expect(report.periods[0]?.projections[0]).toMatchObject({
      predicted: 0,
      method: 'zero-prior',
    });
  });

  it('uses a segment prior when entity history is too short', () => {
    const report = runHistoricalReplay({
      dataset: dataset([
        observation('a', 1, 10, '2025-01-02T00:00:00.000Z'),
        observation('b', 1, 20, '2025-01-02T00:00:00.000Z'),
        observation('a', 2, 30, '2025-01-09T00:00:00.000Z'),
      ]),
      periods: [
        {
          boundary: {
            season: 2025,
            week: 2,
            knowledgeCutoff: '2025-01-08T12:00:00.000Z',
          },
          targets: [target('a', '2025-01-08T12:00:00.000Z')],
        },
      ],
      baseline: { minimumEntityHistory: 2 },
      generatedAt: '2025-02-01T00:00:00.000Z',
    });

    expect(report.periods[0]?.projections[0]).toMatchObject({
      method: 'segment-prior',
      historyCount: 1,
      predicted: 15,
    });
  });

  it('blends the full history with the configured recent window', () => {
    const observations = [0, 0, 0, 40, 30].map((actual, index) =>
      observation(
        'a',
        index + 1,
        actual,
        `2025-01-${String((index + 1) * 2).padStart(2, '0')}T00:00:00.000Z`,
      ),
    );
    const report = runHistoricalReplay({
      dataset: dataset(observations),
      periods: [
        {
          boundary: {
            season: 2025,
            week: 5,
            knowledgeCutoff: '2025-01-09T12:00:00.000Z',
          },
          targets: [target('a', '2025-01-09T12:00:00.000Z')],
        },
      ],
      baseline: { recentWindow: 1, recentWeight: 0.5 },
      generatedAt: '2025-02-01T00:00:00.000Z',
    });

    expect(report.periods[0]?.projections[0]?.predicted).toBe(25);
  });

  it('rejects a target that did not exist at the cutoff', () => {
    const invalid = period(2, '2025-01-08T12:00:00.000Z');
    const target = invalid.targets[0];
    if (!target) {
      throw new Error('The test target is missing.');
    }
    invalid.targets = [
      { ...target, availableAt: '2025-01-08T13:00:00.000Z' },
    ];

    expect(() =>
      runHistoricalReplay({ dataset: dataset(), periods: [invalid] }),
    ).toThrow(FutureLeakageError);
  });

  it('rejects an outcome that was available before the forecast', () => {
    const observations = [
      observation('a', 1, 10, '2025-01-02T00:00:00.000Z'),
      observation('a', 2, 30, '2025-01-08T10:00:00.000Z'),
    ];

    expect(() =>
      runHistoricalReplay({
        dataset: dataset(observations),
        periods: [period(2, '2025-01-08T12:00:00.000Z')],
      }),
    ).toThrow('was available at or before the forecast cutoff');
  });
});

function dataset(
  observations: readonly EvaluationObservation[] = [
    observation('a', 1, 10, '2025-01-02T00:00:00.000Z'),
    observation('b', 1, 20, '2025-01-02T00:00:00.000Z'),
    observation('a', 2, 30, '2025-01-09T00:00:00.000Z'),
    observation('b', 2, 10, '2025-01-09T00:00:00.000Z'),
    observation('a', 3, 100, '2025-01-16T00:00:00.000Z'),
    observation('b', 3, 40, '2025-01-16T00:00:00.000Z'),
  ],
) {
  return createEvaluationDataset({
    id: 'test-points',
    label: 'Test fantasy points',
    kind: 'custom',
    metric: 'points',
    createdAt: '2025-02-01T00:00:00.000Z',
    source: { id: 'fixture', label: 'Test fixture', url: null },
    observations,
  });
}

function periods(): ReplayPeriodInput[] {
  return [
    period(2, '2025-01-08T12:00:00.000Z'),
    period(3, '2025-01-15T12:00:00.000Z'),
  ];
}

function period(week: number, knowledgeCutoff: string): ReplayPeriodInput {
  return {
    boundary: { season: 2025, week, knowledgeCutoff },
    targets: [target('a', knowledgeCutoff), target('b', knowledgeCutoff)],
  };
}

function target(entityId: string, availableAt: string): ReplayTarget {
  return {
    entityId,
    label: `Player ${entityId.toUpperCase()}`,
    segment: 'WR',
    decisionId: 'lineup',
    availableAt,
    metadata: {},
  };
}

function observation(
  entityId: string,
  week: number,
  actual: number,
  availableAt: string,
): EvaluationObservation {
  return {
    id: `2025:${week}:${entityId}`,
    entityId,
    label: `Player ${entityId.toUpperCase()}`,
    season: 2025,
    week,
    segment: 'WR',
    actual,
    availableAt,
    metadata: {},
  };
}
