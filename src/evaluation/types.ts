export const REPLAY_REPORT_SCHEMA_VERSION = '1' as const;

export type EvaluationDatasetKind =
  | 'nflverse-player-week'
  | 'sleeper-roster-week'
  | 'custom';

export interface EvaluationSource {
  id: string;
  label: string;
  url: string | null;
}

export type EvaluationMetadata = Readonly<
  Record<string, boolean | number | string | null>
>;

/**
 * One historical result. The availableAt value records when this result became
 * usable by a live forecast. It must not represent the later download time.
 */
export interface EvaluationObservation {
  actual: number;
  availableAt: string;
  entityId: string;
  id: string;
  label: string;
  metadata: EvaluationMetadata;
  season: number;
  segment: string | null;
  week: number;
}

export interface EvaluationDataset {
  createdAt: string;
  id: string;
  kind: EvaluationDatasetKind;
  label: string;
  metric: string;
  observations: readonly EvaluationObservation[];
  source: EvaluationSource;
}

/**
 * The boundary represents the exact information horizon for one forecast.
 */
export interface ReplayBoundary {
  knowledgeCutoff: string;
  season: number;
  week: number;
}

/**
 * A target must exist before the knowledge cutoff. This rule prevents the
 * target list from revealing participation or availability after kickoff.
 */
export interface ReplayTarget {
  availableAt: string;
  decisionId: string | null;
  entityId: string;
  label: string;
  metadata: EvaluationMetadata;
  segment: string | null;
}

export interface ReplayPeriodInput {
  boundary: ReplayBoundary;
  targets: readonly ReplayTarget[];
}

export interface BaselineConfiguration {
  intervalLevel: number;
  minimumEntityHistory: number;
  recentWeight: number;
  recentWindow: number;
}

export type ProjectionMethod =
  | 'entity-history'
  | 'segment-prior'
  | 'global-prior'
  | 'zero-prior';

export interface BaselineProjection {
  actual: number;
  decisionId: string | null;
  entityId: string;
  historyCount: number;
  label: string;
  lower: number;
  method: ProjectionMethod;
  predicted: number;
  segment: string | null;
  upper: number;
}

export interface RegressionMetrics {
  mae: number | null;
  meanActual: number | null;
  meanError: number | null;
  meanPredicted: number | null;
  rmse: number | null;
  sampleSize: number;
}

export interface RankMetrics {
  meanAbsoluteRankError: number | null;
  pairwiseAccuracy: number | null;
  sampleSize: number;
  spearmanCorrelation: number | null;
}

export interface IntervalMetrics {
  aboveRate: number | null;
  belowRate: number | null;
  coverage: number | null;
  meanWidth: number | null;
  sampleSize: number;
}

export interface CalibrationBin {
  actualRate: number | null;
  count: number;
  lowerBound: number;
  meanProbability: number | null;
  upperBound: number;
}

export interface ProbabilityMetrics {
  brierScore: number | null;
  bins: readonly CalibrationBin[];
  expectedCalibrationError: number | null;
  sampleSize: number;
}

export interface ProbabilityForecast {
  boundary: ReplayBoundary;
  eventId: string;
  forecastAt: string;
  outcome: boolean;
  outcomeAvailableAt: string;
  predictedProbability: number;
}

export interface DecisionOption {
  actual: number;
  decisionId: string;
  optionId: string;
  predicted: number;
  selected?: boolean;
}

export interface DecisionRegretMetrics {
  decisions: number;
  maximumRegret: number | null;
  meanRegret: number | null;
  optimalSelectionRate: number | null;
  totalRegret: number | null;
}

export interface ReplayAudit {
  evaluatedTargets: number;
  excludedAfterCutoff: number;
  excludedFuturePeriod: number;
  missingOutcomeEntityIds: readonly string[];
  targetCount: number;
  trainingObservations: number;
}

export interface ReplayMetrics {
  decisions: DecisionRegretMetrics;
  intervals: IntervalMetrics;
  probability: ProbabilityMetrics;
  ranks: RankMetrics;
  regression: RegressionMetrics;
}

export interface ReplayPeriodResult {
  audit: ReplayAudit;
  boundary: ReplayBoundary;
  metrics: ReplayMetrics;
  projections: readonly BaselineProjection[];
}

export interface ReplayReport {
  baseline: BaselineConfiguration;
  dataset: {
    id: string;
    kind: EvaluationDatasetKind;
    label: string;
    metric: string;
    source: EvaluationSource;
  };
  generatedAt: string;
  metrics: ReplayMetrics;
  periods: readonly ReplayPeriodResult[];
  schemaVersion: typeof REPLAY_REPORT_SCHEMA_VERSION;
}

export interface HistoricalReplayInput {
  baseline?: Partial<BaselineConfiguration>;
  calibrationBins?: number;
  dataset: EvaluationDataset;
  generatedAt?: string;
  periods: readonly ReplayPeriodInput[];
  probabilityForecasts?: readonly ProbabilityForecast[];
}
