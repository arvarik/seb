/** Largest token count that Seb accepts from one model step. */
export const MAX_USAGE_TOKEN_COUNT = 10_000_000_000;

/** Largest duration that Seb accepts. This value equals 365 days. */
export const MAX_USAGE_DURATION_MS = 31_536_000_000;

export type UsageRunStatus = 'running' | 'completed' | 'aborted' | 'failed';

export type UsageRunFinalStatus = Exclude<UsageRunStatus, 'running'>;

export type UsageToolExecutionLocation = 'client' | 'provider';

export type UsageToolOutcome =
  | 'returned'
  | 'error'
  | 'invalid'
  | 'cancelled'
  | 'unresolved';

/** Metadata that Seb saves before an agent run starts. */
export interface UsageRunWrite {
  agentKind: string;
  callId: string;
  sessionId: string;
  startedAt?: string;
  surface: string;
}

/** One saved agent run. This record never contains prompts or model output. */
export interface UsageRunRecord {
  agentKind: string;
  callId: string;
  endedAt: string | null;
  errorKind: string | null;
  finalFinishReason: string | null;
  sessionId: string;
  startedAt: string;
  status: UsageRunStatus;
  surface: string;
}

/** Final metadata that closes a running usage record. */
export interface UsageRunFinishWrite {
  endedAt?: string;
  errorKind?: string | null;
  finalFinishReason?: string | null;
  status: UsageRunFinalStatus;
}

/** Metrics from one model call in an agent run. */
export interface UsageStepWrite {
  cacheReadInputTokens?: number | null;
  cacheWriteInputTokens?: number | null;
  callId: string;
  finishReason?: string | null;
  groundingCounts?: Readonly<Record<string, number>> | null;
  inputTokens?: number | null;
  modelId: string;
  noCacheInputTokens?: number | null;
  outputTokens?: number | null;
  provider: string;
  providerTotalTokens?: number | null;
  rawFinishReason?: string | null;
  reasoningTokens?: number | null;
  responseTimeMs?: number | null;
  serviceTier?: string | null;
  stepNumber: number;
  stepTimeMs?: number | null;
  textTokens?: number | null;
  timeToFirstOutputMs?: number | null;
  toolUseTokens?: number | null;
  totalTokens?: number | null;
}

/** One normalized model-call record. Missing provider metrics stay null. */
export interface UsageStepRecord {
  cacheReadInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  callId: string;
  finishReason: string | null;
  groundingCounts: Readonly<Record<string, number>> | null;
  inputTokens: number | null;
  modelId: string;
  noCacheInputTokens: number | null;
  outputTokens: number | null;
  provider: string;
  providerTotalTokens: number | null;
  rawFinishReason: string | null;
  reasoningTokens: number | null;
  responseTimeMs: number | null;
  serviceTier: string | null;
  stepNumber: number;
  stepTimeMs: number | null;
  textTokens: number | null;
  timeToFirstOutputMs: number | null;
  toolUseTokens: number | null;
  totalTokens: number | null;
}

/** Metadata from one client-side or provider-side tool call. */
export interface UsageToolCallWrite {
  callId: string;
  dynamic?: boolean | null;
  executionLocation: UsageToolExecutionLocation;
  executionMs?: number | null;
  outcome: UsageToolOutcome;
  stepNumber: number;
  toolCallId: string;
  toolName: string;
}

/** One normalized tool-call record. Inputs and outputs are never saved. */
export interface UsageToolCallRecord {
  callId: string;
  dynamic: boolean | null;
  executionLocation: UsageToolExecutionLocation;
  executionMs: number | null;
  outcome: UsageToolOutcome;
  stepNumber: number;
  toolCallId: string;
  toolName: string;
}

/** Filters saved runs by session and run start time. */
export interface UsageQuery {
  /** Returns at most this many recent runs. */
  limit?: number;
  sessionId?: string;
  /** Includes runs that start at this ISO 8601 time. */
  since?: string;
  /** Excludes runs that start at this ISO 8601 time. */
  until?: string;
}

/** A consistent group of runs and their child records. */
export interface UsageDataset {
  runs: UsageRunRecord[];
  steps: UsageStepRecord[];
  toolCalls: UsageToolCallRecord[];
  /** True when the query limit excluded older runs. */
  truncated: boolean;
}
