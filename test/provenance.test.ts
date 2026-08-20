import { describe, expect, it } from 'vitest';

import {
  aggregateFreshness,
  assessFreshness,
  createProvenanceEnvelope,
  deriveFromFields,
  directFieldLineage,
  escapeJsonPointerSegment,
  getFieldLineage,
  parseProvenance,
  refreshEnvelope,
  serializeProvenance,
} from '../src/provenance/index.js';
import type { ProvenanceSource } from '../src/provenance/index.js';

const hour = 60 * 60 * 1_000;
const now = '2026-08-20T12:00:00.000Z';

describe('provenance freshness', () => {
  it('classifies fresh, stale, and expired source ages', () => {
    const policy = { freshForMs: hour, staleIfErrorForMs: hour };

    expect(assessFreshness('2026-08-20T11:30:00Z', policy, now)).toMatchObject({
      state: 'fresh',
      usable: true,
      ageMs: 30 * 60 * 1_000,
    });
    expect(assessFreshness('2026-08-20T10:30:00Z', policy, now)).toMatchObject({
      state: 'stale',
      usable: true,
    });
    expect(assessFreshness('2026-08-20T09:30:00Z', policy, now)).toMatchObject({
      state: 'expired',
      usable: false,
    });
  });

  it('rejects future data and marks missing policies as unknown', () => {
    expect(
      assessFreshness(
        '2026-08-20T12:10:00Z',
        { freshForMs: hour, futureToleranceMs: 60_000 },
        now,
      ),
    ).toMatchObject({ state: 'future', usable: false });
    expect(assessFreshness(now, undefined, now)).toMatchObject({
      state: 'unknown',
      usable: false,
    });
    expect(() =>
      assessFreshness(now, { freshForMs: -1 }, now),
    ).toThrow('non-negative');
  });

  it('uses the least reliable state across all inputs', () => {
    const fresh = assessFreshness('2026-08-20T11:30:00Z', { freshForMs: hour }, now);
    const stale = assessFreshness(
      '2026-08-20T10:30:00Z',
      { freshForMs: hour, staleIfErrorForMs: hour },
      now,
    );

    expect(aggregateFreshness([fresh, stale], now)).toMatchObject({
      state: 'stale',
      usable: true,
    });
    expect(aggregateFreshness([], now)).toMatchObject({ state: 'unknown' });
  });
});

describe('field-level provenance', () => {
  it('attaches independent sources and freshness to exact fields', () => {
    const envelope = createProvenanceEnvelope({
      id: 'player-week:1',
      now,
      value: {
        player: { name: 'Josh Allen', team: 'BUF' },
        points: 25.3,
      },
      sources: [source('sleeper', '2026-08-20T11:50:00Z'), source('nflverse', '2026-08-20T10:30:00Z')],
      fields: {
        '/player/name': directFieldLineage('sleeper'),
        '/player/team': directFieldLineage('sleeper'),
        '/points': directFieldLineage('nflverse'),
      },
    });

    expect(envelope.fields['/player/name']?.freshness.state).toBe('fresh');
    expect(envelope.fields['/points']?.freshness.state).toBe('stale');
    expect(envelope.freshness.state).toBe('stale');
    expect(getFieldLineage(envelope, '/points')).toMatchObject({
      sourceIds: ['nflverse'],
    });
  });

  it('validates field paths, value fields, and source references', () => {
    const base = {
      id: 'invalid',
      now,
      value: { points: 10 },
      sources: [source('nflverse', now)],
    };

    expect(() =>
      createProvenanceEnvelope({ ...base, fields: { points: directFieldLineage('nflverse') } }),
    ).toThrow('valid JSON Pointer');
    expect(() =>
      createProvenanceEnvelope({ ...base, fields: { '/missing': directFieldLineage('nflverse') } }),
    ).toThrow('does not exist');
    expect(() =>
      createProvenanceEnvelope({ ...base, fields: { '/points': directFieldLineage('missing') } }),
    ).toThrow('missing source');
    expect(escapeJsonPointerSegment('a/b~c')).toBe('a~1b~0c');
  });

  it('tracks derived inputs and merges their source definitions', () => {
    const weekOne = pointsEnvelope('week:1', 20, 'week-one', '2026-08-20T11:50:00Z');
    const weekTwo = pointsEnvelope('week:2', 30, 'week-two', '2026-08-20T11:40:00Z');
    const derived = deriveFromFields({
      operation: 'arithmetic-mean',
      version: '1.0.0',
      description: 'Average two weekly point totals.',
      inputs: [
        { envelope: weekOne, fieldPath: '/points' },
        { envelope: weekTwo, fieldPath: '/points' },
      ],
    });
    const summary = createProvenanceEnvelope({
      id: 'trend:1',
      now,
      value: { average: 25 },
      sources: derived.sources,
      fields: { '/average': derived.lineage },
    });

    expect(summary.sources.map((item) => item.id)).toEqual(['week-one', 'week-two']);
    expect(summary.fields['/average']?.derivation).toEqual({
      operation: 'arithmetic-mean',
      version: '1.0.0',
      description: 'Average two weekly point totals.',
      inputs: [
        { envelopeId: 'week:1', fieldPath: '/points' },
        { envelopeId: 'week:2', fieldPath: '/points' },
      ],
    });
  });

  it('moves fresh fields through stale and expired states as time advances', () => {
    const envelope = pointsEnvelope('week:1', 20, 'stats', '2026-08-20T11:30:00Z');

    expect(envelope.freshness.state).toBe('fresh');
    expect(refreshEnvelope(envelope, '2026-08-20T13:00:00Z').freshness.state).toBe('stale');
    expect(refreshEnvelope(envelope, '2026-08-20T14:00:01Z').freshness.state).toBe('expired');
  });

  it('serializes deterministically and validates the value on parse', () => {
    const envelope = pointsEnvelope('week:1', 20, 'stats', '2026-08-20T11:30:00Z');
    const encoded = serializeProvenance(envelope);
    const parsed = parseProvenance(
      encoded,
      (value): value is { points: number } =>
        Boolean(value) && typeof value === 'object' && typeof (value as { points?: unknown }).points === 'number',
    );

    expect(serializeProvenance(parsed)).toBe(encoded);
    expect(parsed.value.points).toBe(20);
    expect(() => parseProvenance('{bad')).toThrow('JSON is invalid');
    expect(() => parseProvenance(encoded, (_value): _value is string => false)).toThrow(
      'failed its validation',
    );
  });

  it('rejects conflicting definitions for the same source ID', () => {
    expect(() =>
      createProvenanceEnvelope({
        id: 'conflict',
        now,
        value: { points: 1 },
        sources: [source('same', now), { ...source('same', now), provider: 'other' }],
      }),
    ).toThrow('conflicting definitions');
  });
});

function source(id: string, observedAt: string): ProvenanceSource {
  return {
    id,
    provider: 'nflverse',
    label: `${id} statistics`,
    url: `https://example.com/${id}`,
    retrievedAt: now,
    observedAt,
    freshnessPolicy: {
      freshForMs: hour,
      staleIfErrorForMs: hour,
    },
  };
}

function pointsEnvelope(
  id: string,
  points: number,
  sourceId: string,
  observedAt: string,
) {
  return createProvenanceEnvelope({
    id,
    now,
    value: { points },
    sources: [source(sourceId, observedAt)],
    fields: { '/points': directFieldLineage(sourceId) },
  });
}
