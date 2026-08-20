import { describe, expect, it } from 'vitest';

import {
  createEvaluationDataset,
  parseReplayReport,
  runHistoricalReplay,
  serializeReplayReport,
} from '../src/evaluation/index.js';

describe('replay report serialization', () => {
  it('writes stable versioned JSON and reads it again', () => {
    const report = runHistoricalReplay({
      dataset: createEvaluationDataset({
        id: 'one',
        label: 'One result',
        kind: 'custom',
        metric: 'points',
        createdAt: '2025-01-03T00:00:00.000Z',
        source: { id: 'fixture', label: 'Fixture', url: null },
        observations: [
          {
            id: '2025:1:a',
            entityId: 'a',
            label: 'Player A',
            season: 2025,
            week: 1,
            segment: 'RB',
            actual: 10,
            availableAt: '2025-01-02T00:00:00.000Z',
            metadata: {},
          },
        ],
      }),
      periods: [],
      generatedAt: '2025-01-03T00:00:00.000Z',
    });

    const first = serializeReplayReport(report);
    const second = serializeReplayReport(report);

    expect(first).toBe(second);
    expect(first.endsWith('\n')).toBe(true);
    expect(parseReplayReport(first)).toEqual(report);
  });

  it('rejects an unknown schema version', () => {
    expect(() =>
      parseReplayReport('{"schemaVersion":"99"}'),
    ).toThrow('schema must be 1');
  });
});
