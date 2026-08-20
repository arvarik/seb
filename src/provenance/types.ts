export type FreshnessState =
  | 'expired'
  | 'fresh'
  | 'future'
  | 'stale'
  | 'unknown';

export interface FreshnessPolicy {
  freshForMs: number;
  futureToleranceMs?: number;
  staleIfErrorForMs?: number;
}

export interface FreshnessAssessment {
  ageMs: number | null;
  evaluatedAt: string;
  reason: string;
  state: FreshnessState;
  usable: boolean;
}

export interface ProvenanceSource {
  id: string;
  label: string;
  observedAt?: string;
  provider: string;
  publishedAt?: string;
  retrievedAt: string;
  url?: string;
  version?: string;
  freshnessPolicy?: FreshnessPolicy;
}

export interface FieldInputReference {
  envelopeId: string;
  fieldPath: string;
}

export interface FieldDerivation {
  description?: string;
  inputs: FieldInputReference[];
  operation: string;
  version: string;
}

export interface FieldLineageInput {
  derivation?: FieldDerivation;
  sourceIds: string[];
}

export interface FieldLineage extends FieldLineageInput {
  freshness: FreshnessAssessment;
}

export interface ProvenanceEnvelope<T> {
  createdAt: string;
  fields: Record<string, FieldLineage>;
  freshness: FreshnessAssessment;
  id: string;
  schemaVersion: 1;
  sources: ProvenanceSource[];
  value: T;
}

export interface CreateProvenanceEnvelopeInput<T> {
  createdAt?: string;
  fields?: Readonly<Record<string, FieldLineageInput>>;
  id: string;
  now?: Date | string;
  sources: readonly ProvenanceSource[];
  value: T;
}

export interface DerivedFieldInput {
  envelope: ProvenanceEnvelope<unknown>;
  fieldPath: string;
}

export interface DerivedFieldBundle {
  lineage: FieldLineageInput;
  sources: ProvenanceSource[];
}
