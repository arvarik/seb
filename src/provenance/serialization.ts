import { createProvenanceEnvelope } from './envelope.js';
import type {
  FieldLineageInput,
  FreshnessAssessment,
  ProvenanceEnvelope,
  ProvenanceSource,
} from './types.js';

export function serializeProvenance<T>(envelope: ProvenanceEnvelope<T>): string {
  return JSON.stringify(sortValue(envelope));
}

export function parseProvenance<T = unknown>(
  value: string,
  validateValue?: (value: unknown) => value is T,
): ProvenanceEnvelope<T> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`The provenance JSON is invalid: ${errorMessage(error)}`);
  }
  if (!isEnvelopeRecord(parsed)) {
    throw new Error('The provenance envelope structure is invalid.');
  }
  if (validateValue && !validateValue(parsed.value)) {
    throw new Error('The provenance value failed its validation function.');
  }
  const fields: Record<string, FieldLineageInput> = {};
  for (const [path, lineage] of Object.entries(parsed.fields)) {
    if (!isFieldLineage(lineage)) {
      throw new Error(`The provenance lineage for ${path} is invalid.`);
    }
    fields[path] = {
      sourceIds: [...lineage.sourceIds],
      ...(lineage.derivation ? { derivation: lineage.derivation } : {}),
    };
  }
  return createProvenanceEnvelope({
    id: parsed.id,
    createdAt: parsed.createdAt,
    now: parsed.freshness.evaluatedAt,
    value: parsed.value as T,
    sources: parsed.sources,
    fields,
  });
}

function isEnvelopeRecord(value: unknown): value is {
  createdAt: string;
  fields: Record<string, unknown>;
  freshness: FreshnessAssessment;
  id: string;
  schemaVersion: 1;
  sources: ProvenanceSource[];
  value: unknown;
} {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    record.schemaVersion === 1 &&
    typeof record.id === 'string' &&
    typeof record.createdAt === 'string' &&
    isRecord(record.fields) &&
    Array.isArray(record.sources) &&
    record.sources.every(isSource) &&
    isFreshness(record.freshness) &&
    Object.hasOwn(record, 'value')
  );
}

function isSource(value: unknown): value is ProvenanceSource {
  if (!value || typeof value !== 'object') return false;
  const source = value as Record<string, unknown>;
  return (
    typeof source.id === 'string' &&
    typeof source.label === 'string' &&
    typeof source.provider === 'string' &&
    typeof source.retrievedAt === 'string' &&
    (source.observedAt === undefined || typeof source.observedAt === 'string') &&
    (source.publishedAt === undefined || typeof source.publishedAt === 'string') &&
    (source.url === undefined || typeof source.url === 'string') &&
    (source.version === undefined || typeof source.version === 'string') &&
    (source.freshnessPolicy === undefined || isFreshnessPolicy(source.freshnessPolicy))
  );
}

function isFieldLineage(value: unknown): value is {
  derivation?: {
    description?: string;
    inputs: { envelopeId: string; fieldPath: string }[];
    operation: string;
    version: string;
  };
  freshness: FreshnessAssessment;
  sourceIds: string[];
} {
  if (!value || typeof value !== 'object') return false;
  const field = value as Record<string, unknown>;
  return (
    Array.isArray(field.sourceIds) &&
    field.sourceIds.every((sourceId) => typeof sourceId === 'string') &&
    isFreshness(field.freshness) &&
    (field.derivation === undefined || isDerivation(field.derivation))
  );
}

function isDerivation(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const derivation = value as Record<string, unknown>;
  return (
    typeof derivation.operation === 'string' &&
    typeof derivation.version === 'string' &&
    (derivation.description === undefined || typeof derivation.description === 'string') &&
    Array.isArray(derivation.inputs) &&
    derivation.inputs.every((input) => {
      if (!input || typeof input !== 'object') return false;
      const reference = input as Record<string, unknown>;
      return typeof reference.envelopeId === 'string' && typeof reference.fieldPath === 'string';
    })
  );
}

function isFreshness(value: unknown): value is FreshnessAssessment {
  if (!value || typeof value !== 'object') return false;
  const freshness = value as Record<string, unknown>;
  return (
    ['expired', 'fresh', 'future', 'stale', 'unknown'].includes(String(freshness.state)) &&
    (typeof freshness.ageMs === 'number' || freshness.ageMs === null) &&
    typeof freshness.usable === 'boolean' &&
    typeof freshness.evaluatedAt === 'string' &&
    typeof freshness.reason === 'string'
  );
}

function isFreshnessPolicy(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const policy = value as Record<string, unknown>;
  return (
    typeof policy.freshForMs === 'number' &&
    (policy.staleIfErrorForMs === undefined || typeof policy.staleIfErrorForMs === 'number') &&
    (policy.futureToleranceMs === undefined || typeof policy.futureToleranceMs === 'number')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, sortValue(item)]),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
