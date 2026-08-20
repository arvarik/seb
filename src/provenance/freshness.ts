import type {
  FieldLineage,
  FreshnessAssessment,
  FreshnessPolicy,
  ProvenanceEnvelope,
  ProvenanceSource,
} from './types.js';

const DEFAULT_FUTURE_TOLERANCE_MS = 5 * 60 * 1_000;

export function assessFreshness(
  timestamp: string | undefined,
  policy: FreshnessPolicy | undefined,
  now: Date | string = new Date(),
): FreshnessAssessment {
  const evaluatedAt = toIso(now, 'freshness evaluation time');
  if (!timestamp || !policy) {
    return {
      state: 'unknown',
      ageMs: null,
      usable: false,
      evaluatedAt,
      reason: !timestamp
        ? 'The source has no observation or retrieval time.'
        : 'The source has no freshness policy.',
    };
  }
  validatePolicy(policy);
  const timestampMs = Date.parse(timestamp);
  if (!Number.isFinite(timestampMs)) {
    return {
      state: 'unknown',
      ageMs: null,
      usable: false,
      evaluatedAt,
      reason: `The source timestamp "${timestamp}" is invalid.`,
    };
  }
  const ageMs = Date.parse(evaluatedAt) - timestampMs;
  const futureToleranceMs = policy.futureToleranceMs ?? DEFAULT_FUTURE_TOLERANCE_MS;
  if (ageMs < -futureToleranceMs) {
    return {
      state: 'future',
      ageMs,
      usable: false,
      evaluatedAt,
      reason: 'The source timestamp is too far in the future.',
    };
  }
  if (ageMs <= policy.freshForMs) {
    return {
      state: 'fresh',
      ageMs: Math.max(0, ageMs),
      usable: true,
      evaluatedAt,
      reason: 'The source age is within the fresh interval.',
    };
  }
  const staleUntilMs = policy.freshForMs + (policy.staleIfErrorForMs ?? 0);
  if (ageMs <= staleUntilMs) {
    return {
      state: 'stale',
      ageMs,
      usable: true,
      evaluatedAt,
      reason: 'The source age exceeds the fresh interval but remains inside the stale-if-error interval.',
    };
  }
  return {
    state: 'expired',
    ageMs,
    usable: false,
    evaluatedAt,
    reason: 'The source age exceeds the allowed stale-if-error interval.',
  };
}

export function assessSourceFreshness(
  source: ProvenanceSource,
  now: Date | string = new Date(),
): FreshnessAssessment {
  return assessFreshness(
    source.observedAt ?? source.publishedAt ?? source.retrievedAt,
    source.freshnessPolicy,
    now,
  );
}

export function aggregateFreshness(
  assessments: readonly FreshnessAssessment[],
  now: Date | string = new Date(),
): FreshnessAssessment {
  const evaluatedAt = toIso(now, 'freshness evaluation time');
  if (assessments.length === 0) {
    return {
      state: 'unknown',
      ageMs: null,
      usable: false,
      evaluatedAt,
      reason: 'No sources contribute freshness information.',
    };
  }
  const orderedStates: FreshnessAssessment['state'][] = [
    'future',
    'expired',
    'unknown',
    'stale',
    'fresh',
  ];
  const state = orderedStates.find((candidate) =>
    assessments.some((assessment) => assessment.state === candidate),
  ) ?? 'unknown';
  const ages = assessments.flatMap((assessment) =>
    assessment.ageMs === null ? [] : [assessment.ageMs],
  );
  return {
    state,
    ageMs: ages.length === 0 ? null : Math.max(...ages),
    usable: assessments.every((assessment) => assessment.usable),
    evaluatedAt,
    reason: `The aggregate uses the least reliable state from ${assessments.length} source assessment${assessments.length === 1 ? '' : 's'}.`,
  };
}

export function refreshProvenanceFreshness<T>(
  envelope: ProvenanceEnvelope<T>,
  now: Date | string = new Date(),
): ProvenanceEnvelope<T> {
  const sources = envelope.sources.map(cloneSource);
  const sourceAssessments = new Map(
    sources.map((source) => [source.id, assessSourceFreshness(source, now)]),
  );
  const fields = Object.fromEntries(
    Object.entries(envelope.fields).map(([path, lineage]): [string, FieldLineage] => {
      const assessments = lineage.sourceIds.flatMap((sourceId) => {
        const assessment = sourceAssessments.get(sourceId);
        return assessment ? [assessment] : [];
      });
      return [
        path,
        {
          ...lineage,
          sourceIds: [...lineage.sourceIds],
          ...(lineage.derivation ? { derivation: cloneDerivation(lineage.derivation) } : {}),
          freshness: aggregateFreshness(assessments, now),
        },
      ];
    }),
  );
  const envelopeAssessments =
    Object.keys(fields).length > 0
      ? Object.values(fields).map((field) => field.freshness)
      : [...sourceAssessments.values()];
  return {
    ...envelope,
    sources,
    fields,
    freshness: aggregateFreshness(envelopeAssessments, now),
  };
}

export function sourceTimestamp(source: ProvenanceSource): string {
  return source.observedAt ?? source.publishedAt ?? source.retrievedAt;
}

function validatePolicy(policy: FreshnessPolicy): void {
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`The freshness policy value ${name} must be a non-negative finite number.`);
    }
  }
}

function toIso(value: Date | string, label: string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`The ${label} is invalid.`);
  }
  return date.toISOString();
}

function cloneSource(source: ProvenanceSource): ProvenanceSource {
  return {
    ...source,
    ...(source.freshnessPolicy ? { freshnessPolicy: { ...source.freshnessPolicy } } : {}),
  };
}

function cloneDerivation(derivation: NonNullable<FieldLineage['derivation']>): NonNullable<FieldLineage['derivation']> {
  return {
    ...derivation,
    inputs: derivation.inputs.map((input) => ({ ...input })),
  };
}
