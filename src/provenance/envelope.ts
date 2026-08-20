import {
  aggregateFreshness,
  assessSourceFreshness,
  refreshProvenanceFreshness,
} from './freshness.js';
import type {
  CreateProvenanceEnvelopeInput,
  DerivedFieldBundle,
  DerivedFieldInput,
  FieldDerivation,
  FieldLineage,
  FieldLineageInput,
  ProvenanceEnvelope,
  ProvenanceSource,
} from './types.js';

export function createProvenanceEnvelope<T>(
  input: CreateProvenanceEnvelopeInput<T>,
): ProvenanceEnvelope<T> {
  if (!input.id.trim()) throw new Error('A provenance envelope needs an ID.');
  const createdAt = toIso(input.createdAt ?? input.now ?? new Date(), 'envelope creation time');
  const now = input.now ?? createdAt;
  const sources = mergeSourceReferences(input.sources);
  const sourcesById = new Map(sources.map((source) => [source.id, source]));
  const fields: Record<string, FieldLineage> = {};
  for (const [path, lineage] of Object.entries(input.fields ?? {})) {
    validateJsonPointer(path);
    if (!hasJsonPointer(input.value, path)) {
      throw new Error(`The field path ${path} does not exist in the envelope value.`);
    }
    const sourceIds = unique(lineage.sourceIds);
    for (const sourceId of sourceIds) {
      if (!sourcesById.has(sourceId)) {
        throw new Error(`The field path ${path} refers to the missing source ${sourceId}.`);
      }
    }
    if (lineage.derivation) validateDerivation(lineage.derivation);
    const assessments = sourceIds.map((sourceId) =>
      assessSourceFreshness(sourcesById.get(sourceId) as ProvenanceSource, now),
    );
    fields[path] = {
      sourceIds,
      ...(lineage.derivation ? { derivation: cloneDerivation(lineage.derivation) } : {}),
      freshness: aggregateFreshness(assessments, now),
    };
  }
  const sourceAssessments = sources.map((source) => assessSourceFreshness(source, now));
  const fieldAssessments = Object.values(fields).map((lineage) => lineage.freshness);
  return {
    schemaVersion: 1,
    id: input.id,
    createdAt,
    value: input.value,
    sources,
    fields,
    freshness: aggregateFreshness(
      fieldAssessments.length > 0 ? fieldAssessments : sourceAssessments,
      now,
    ),
  };
}

export function directFieldLineage(
  ...sourceIds: readonly string[]
): FieldLineageInput {
  return { sourceIds: unique(sourceIds) };
}

export function derivedFieldLineage(input: {
  description?: string;
  inputs: readonly { envelopeId: string; fieldPath: string }[];
  operation: string;
  sourceIds: readonly string[];
  version: string;
}): FieldLineageInput {
  const derivation: FieldDerivation = {
    operation: required(input.operation, 'derivation operation'),
    version: required(input.version, 'derivation version'),
    inputs: input.inputs.map((reference) => ({
      envelopeId: required(reference.envelopeId, 'input envelope ID'),
      fieldPath: validateJsonPointer(reference.fieldPath),
    })),
    ...(input.description ? { description: input.description } : {}),
  };
  return { sourceIds: unique(input.sourceIds), derivation };
}

export function deriveFromFields(input: {
  description?: string;
  inputs: readonly DerivedFieldInput[];
  operation: string;
  version: string;
}): DerivedFieldBundle {
  const sources: ProvenanceSource[] = [];
  const sourceIds: string[] = [];
  const references: { envelopeId: string; fieldPath: string }[] = [];
  for (const item of input.inputs) {
    validateJsonPointer(item.fieldPath);
    const field = item.envelope.fields[item.fieldPath];
    if (!field) {
      throw new Error(`The envelope ${item.envelope.id} has no lineage for ${item.fieldPath}.`);
    }
    references.push({ envelopeId: item.envelope.id, fieldPath: item.fieldPath });
    for (const sourceId of field.sourceIds) {
      const source = item.envelope.sources.find((candidate) => candidate.id === sourceId);
      if (!source) {
        throw new Error(`The envelope ${item.envelope.id} lacks the source ${sourceId}.`);
      }
      sources.push(source);
      sourceIds.push(sourceId);
    }
  }
  return {
    sources: mergeSourceReferences(sources),
    lineage: derivedFieldLineage({
      operation: input.operation,
      version: input.version,
      inputs: references,
      sourceIds,
      ...(input.description ? { description: input.description } : {}),
    }),
  };
}

export function getFieldLineage<T>(
  envelope: ProvenanceEnvelope<T>,
  fieldPath: string,
): FieldLineage | undefined {
  const field = envelope.fields[validateJsonPointer(fieldPath)];
  return field
    ? {
        ...field,
        sourceIds: [...field.sourceIds],
        ...(field.derivation ? { derivation: cloneDerivation(field.derivation) } : {}),
        freshness: { ...field.freshness },
      }
    : undefined;
}

export function mergeSourceReferences(
  inputs: readonly ProvenanceSource[],
): ProvenanceSource[] {
  const sources = new Map<string, ProvenanceSource>();
  for (const input of inputs) {
    validateSource(input);
    const source = cloneSource(input);
    const previous = sources.get(source.id);
    if (previous && stableJson(previous) !== stableJson(source)) {
      throw new Error(`The provenance source ID ${source.id} has conflicting definitions.`);
    }
    sources.set(source.id, source);
  }
  return [...sources.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function refreshEnvelope<T>(
  envelope: ProvenanceEnvelope<T>,
  now?: Date | string,
): ProvenanceEnvelope<T> {
  return refreshProvenanceFreshness(envelope, now);
}

export function validateJsonPointer(path: string): string {
  if (path === '') return path;
  if (!path.startsWith('/') || /~(?:[^01]|$)/.test(path)) {
    throw new Error(`The field path "${path}" is not a valid JSON Pointer.`);
  }
  return path;
}

export function escapeJsonPointerSegment(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

function hasJsonPointer(value: unknown, path: string): boolean {
  if (path === '') return true;
  let current = value;
  for (const encoded of path.slice(1).split('/')) {
    const key = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(current)) {
      if (!/^0$|^[1-9]\d*$/.test(key)) return false;
      const index = Number(key);
      if (index >= current.length) return false;
      current = current[index];
      continue;
    }
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, key)) return false;
    current = (current as Record<string, unknown>)[key];
  }
  return true;
}

function validateSource(source: ProvenanceSource): void {
  required(source.id, 'source ID');
  required(source.provider, 'source provider');
  required(source.label, 'source label');
  toIso(source.retrievedAt, 'source retrieval time');
  if (source.observedAt) toIso(source.observedAt, 'source observation time');
  if (source.publishedAt) toIso(source.publishedAt, 'source publication time');
  if (source.url) {
    const url = new URL(source.url);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error(`The source URL protocol ${url.protocol} is not supported.`);
    }
  }
  if (source.freshnessPolicy) {
    for (const value of Object.values(source.freshnessPolicy)) {
      if (!Number.isFinite(value) || value < 0) {
        throw new Error('Freshness policy values must be non-negative finite numbers.');
      }
    }
  }
}

function validateDerivation(derivation: FieldDerivation): void {
  required(derivation.operation, 'derivation operation');
  required(derivation.version, 'derivation version');
  for (const input of derivation.inputs) {
    required(input.envelopeId, 'input envelope ID');
    validateJsonPointer(input.fieldPath);
  }
}

function cloneSource(source: ProvenanceSource): ProvenanceSource {
  return {
    ...source,
    ...(source.freshnessPolicy ? { freshnessPolicy: { ...source.freshnessPolicy } } : {}),
  };
}

function cloneDerivation(derivation: FieldDerivation): FieldDerivation {
  return {
    ...derivation,
    inputs: derivation.inputs.map((input) => ({ ...input })),
  };
}

function required(value: string, label: string): string {
  if (!value.trim()) throw new Error(`The ${label} is required.`);
  return value;
}

function toIso(value: Date | string, label: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`The ${label} is invalid.`);
  return date.toISOString();
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
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

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}
