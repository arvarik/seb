import { describe, expect, it } from 'vitest';

import {
  createDirectProvenanceManifest,
  directFields,
} from '../src/provenance/direct.js';

describe('direct source provenance', () => {
  it('tracks each leaf with a JSON Pointer', () => {
    const manifest = createDirectProvenanceManifest(
      { player: { name: 'Josh Allen', points: 24 }, weeks: [1, 2] },
      {
        envelopeId: 'player-summary-1',
        now: '2026-08-20T12:00:00.000Z',
        source: {
          id: 'nflverse-2025',
          label: 'nflverse player statistics',
          provider: 'nflverse',
          retrievedAt: '2026-08-20T11:00:00.000Z',
          freshnessPolicy: { freshForMs: 7_200_000 },
        },
      },
    );

    expect(Object.keys(manifest.fields)).toEqual([
      '/player/name',
      '/player/points',
      '/weeks/0',
      '/weeks/1',
    ]);
    expect(manifest.fields['/player/points']).toMatchObject({
      sourceIds: ['nflverse-2025'],
      freshness: { state: 'fresh' },
    });
  });

  it('uses root lineage when the field count exceeds the safe limit', () => {
    expect(directFields([1, 2, 3], 'source-1', 2)).toEqual({
      '': { sourceIds: ['source-1'] },
    });
  });
});
