import {
  createProvenanceEnvelope,
  directFieldLineage,
  escapeJsonPointerSegment,
} from './envelope.js';
import type {
  FieldLineageInput,
  ProvenanceEnvelope,
  ProvenanceSource,
} from './types.js';

export type ProvenanceManifest = Omit<ProvenanceEnvelope<unknown>, 'value'>;

export interface DirectProvenanceOptions {
  envelopeId: string;
  maxFieldPaths?: number;
  now?: Date | string;
  source: ProvenanceSource;
}

export function createDirectProvenanceManifest(
  value: unknown,
  options: DirectProvenanceOptions,
): ProvenanceManifest {
  const fields = directFields(value, options.source.id, options.maxFieldPaths ?? 2_000);
  const envelope = createProvenanceEnvelope({
    id: options.envelopeId,
    ...(options.now ? { now: options.now } : {}),
    value,
    sources: [options.source],
    fields,
  });
  const { value: _value, ...manifest } = envelope;
  return manifest;
}

export function directFields(
  value: unknown,
  sourceId: string,
  maxFieldPaths = 2_000,
): Record<string, FieldLineageInput> {
  if (!Number.isInteger(maxFieldPaths) || maxFieldPaths < 1 || maxFieldPaths > 100_000) {
    throw new RangeError('The provenance field-path limit must be from 1 through 100000.');
  }
  const paths: string[] = [];
  collectLeafPaths(value, '', paths, maxFieldPaths + 1);
  if (paths.length === 0 || paths.length > maxFieldPaths) {
    return { '': directFieldLineage(sourceId) };
  }
  return Object.fromEntries(
    paths.map((path) => [path, directFieldLineage(sourceId)]),
  );
}

function collectLeafPaths(
  value: unknown,
  path: string,
  paths: string[],
  limit: number,
): void {
  if (paths.length >= limit) return;
  if (Array.isArray(value)) {
    if (value.length === 0) {
      paths.push(path);
      return;
    }
    for (let index = 0; index < value.length && paths.length < limit; index += 1) {
      collectLeafPaths(value[index], `${path}/${index}`, paths, limit);
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      paths.push(path);
      return;
    }
    for (const [key, item] of entries) {
      if (paths.length >= limit) return;
      collectLeafPaths(item, `${path}/${escapeJsonPointerSegment(key)}`, paths, limit);
    }
    return;
  }
  paths.push(path);
}
