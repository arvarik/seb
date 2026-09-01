import { createHash, randomUUID } from 'node:crypto';

import type { Telemetry } from 'ai';

import type { SebDatabase } from '../data/sqlite-store.js';
import { classifyModelError } from '../model-capacity-error.js';
import {
  recordSessionModelUsage,
  type SessionUsage,
} from '../interactive/session.js';
import {
  MAX_USAGE_DURATION_MS,
  MAX_USAGE_TOKEN_COUNT,
  type UsageRunFinalStatus,
  type UsageRunFinishWrite,
  type UsageRunWrite,
  type UsageStepWrite,
  type UsageToolCallWrite,
} from './types.js';

interface UsageStore {
  finishUsageRun(callId: string, write: UsageRunFinishWrite): unknown;
  putUsageStep(write: UsageStepWrite): unknown;
  putUsageToolCall(write: UsageToolCallWrite): unknown;
  startUsageRun(write: UsageRunWrite): unknown;
}

interface ResolvedModelIdentity {
  modelId: string;
  provider: string;
}

interface ToolStepLocator {
  callId: string;
  stepNumber: number;
}

const MAX_TERMINAL_RUN_TOMBSTONES = 1_024;
const MAX_PENDING_RUN_FINISHES = 1_024;
const SAFE_RAW_FINISH_REASONS = new Set([
  'blocklist',
  'cancelled',
  'completed',
  'content-filter',
  'error',
  'failed',
  'image-other',
  'image-prohibited-content',
  'image-safety',
  'in-progress',
  'incomplete',
  'language',
  'length',
  'malformed-function-call',
  'max-tokens',
  'no-image',
  'other',
  'prohibited-content',
  'reasoning',
  'recitation',
  'requires-action',
  'safety',
  'spii',
  'stop',
  'tool-calls',
]);

export interface SebUsageTelemetryOptions {
  agentKind: string;
  database: Pick<
    SebDatabase,
    'finishUsageRun' | 'putUsageStep' | 'putUsageToolCall' | 'startUsageRun'
  >;
  now?: () => Date;
  sessionId?: string;
  sessionUsage?: SessionUsage;
  surface: string;
  warningSink?: (warning: UsageTelemetryWarning) => void;
}

export interface UsageTelemetryWarning {
  errorKind: string;
  event: 'seb.telemetry.write_failed';
}

export class SebUsageTelemetry implements Telemetry {
  readonly agentKind: string;
  readonly sessionId: string;
  readonly surface: string;

  private readonly abortedRunReasons = new Map<string, unknown>();
  private readonly activeTools = new Set<string>();
  private readonly cancelledTools = new Set<string>();
  private readonly currentSteps = new Map<string, number>();
  private readonly database: UsageStore;
  private readonly failedTools = new Set<string>();
  private readonly now: () => Date;
  private readonly observedModelCalls = new Set<string>();
  private readonly pendingRunFinishes = new Map<string, UsageRunFinishWrite>();
  private readonly persistedRuns = new Set<string>();
  private readonly recordedModelCalls = new Set<string>();
  private readonly recordedTools = new Set<string>();
  private readonly resolvedModels = new Map<string, ResolvedModelIdentity>();
  private readonly runWrites = new Map<string, UsageRunWrite>();
  private readonly sessionUsage: SessionUsage | undefined;
  private readonly stepWrites = new Map<string, UsageStepWrite>();
  private readonly startedRuns = new Set<string>();
  private readonly terminalRuns = new Map<string, UsageRunFinishWrite>();
  private readonly toolErrors = new Map<string, unknown>();
  private readonly toolRecords = new Map<string, UsageToolCallWrite>();
  private readonly toolSteps = new Map<string, ToolStepLocator>();
  private readonly warnedKinds = new Set<string>();
  private readonly warningSink: ((warning: UsageTelemetryWarning) => void) | undefined;

  constructor(options: SebUsageTelemetryOptions) {
    this.agentKind = options.agentKind;
    this.database = options.database;
    this.now = options.now ?? (() => new Date());
    this.sessionId = options.sessionId ?? randomUUID();
    this.sessionUsage = options.sessionUsage;
    this.surface = options.surface;
    this.warningSink = options.warningSink ?? (
      options.sessionUsage
        ? undefined
        : (warning) => process.stderr.write(`${JSON.stringify(warning)}\n`)
    );
  }

  onStart: NonNullable<Telemetry['onStart']> = (event) => {
    const callId = eventCallId(event);
    if (!callId || !this.acceptActiveCallback(callId, false)) return;
    if (!this.startedRuns.has(callId)) {
      this.startedRuns.add(callId);
      this.runWrites.set(callId, {
        agentKind: this.agentKind,
        callId,
        sessionId: this.sessionId,
        startedAt: this.timestamp(),
        surface: this.surface,
      });
      if (this.sessionUsage) this.sessionUsage.agentRuns += 1;
    }
    this.persistRun(callId);
  };

  onStepStart: NonNullable<Telemetry['onStepStart']> = (event) => {
    const callId = usageIdentifier(event.callId);
    if (!callId || !this.acceptActiveCallback(callId)) return;
    this.currentSteps.set(callId, event.stepNumber);
  };

  onLanguageModelCallStart: NonNullable<Telemetry['onLanguageModelCallStart']> = (
    event,
  ) => {
    const callId = usageIdentifier(event.callId);
    if (!callId || !this.acceptActiveCallback(callId)) return;
    const stepNumber = this.currentSteps.get(callId) ?? 0;
    this.observeModelCall(callId, stepNumber);
    this.stageStep({
      callId,
      modelId: event.modelId,
      provider: event.provider,
      stepNumber,
    });
  };

  onLanguageModelCallEnd: NonNullable<Telemetry['onLanguageModelCallEnd']> = (
    event,
  ) => {
    const callId = usageIdentifier(event.callId);
    if (!callId || !this.acceptActiveCallback(callId)) return;
    const stepNumber = this.currentSteps.get(callId) ?? 0;
    this.resolvedModels.set(stepKey(callId, stepNumber), {
      modelId: event.modelId,
      provider: event.provider,
    });
    this.recordModelCall({
      callId,
      content: event.content,
      finishReason: event.finishReason,
      modelId: event.modelId,
      performance: event.performance,
      provider: event.provider,
      providerMetadata: event.providerMetadata,
      stepNumber,
      usage: event.usage,
    });
  };

  onStepEnd: NonNullable<Telemetry['onStepEnd']> = (event) => {
    const callId = usageIdentifier(event.callId);
    if (!callId || !this.acceptActiveCallback(callId)) return;
    this.currentSteps.set(callId, event.stepNumber);
    this.recordModelCall({
      callId,
      content: event.content,
      finishReason: event.finishReason,
      modelId: event.model.modelId,
      performance: event.performance,
      provider: event.model.provider,
      providerMetadata: event.providerMetadata,
      ...(event.rawFinishReason === undefined
        ? {}
        : { rawFinishReason: event.rawFinishReason }),
      stepNumber: event.stepNumber,
      usage: event.usage,
    });
  };

  onToolExecutionEnd: NonNullable<Telemetry['onToolExecutionEnd']> = (event) => {
    const callId = usageIdentifier(event.callId);
    const toolCallId = usageIdentifier(event.toolCall.toolCallId);
    if (!callId || !toolCallId || !this.acceptActiveCallback(callId)) return;
    const locatorKey = toolLocatorKey(callId, toolCallId);
    const stepNumber = this.toolSteps.get(locatorKey)?.stepNumber ??
      this.currentSteps.get(callId) ?? 0;
    const key = toolRecordKey(callId, stepNumber, toolCallId);
    this.activeTools.delete(key);
    const toolError = event.toolOutput.type === 'tool-error'
      ? event.toolOutput.error
      : null;
    if (toolError !== null) this.toolErrors.set(key, toolError);
    const cancelled = this.cancelledTools.has(key) ||
      (toolError !== null && this.abortedRunReasons.has(callId) &&
        isMatchingAbortError(toolError, this.abortedRunReasons.get(callId)));
    const outcome = cancelled
      ? 'cancelled'
      : toolError !== null
      ? 'error'
      : 'returned';
    this.recordTool({
      callId,
      dynamic: event.toolCall.dynamic === true,
      executionLocation: 'client',
      executionMs: validDuration(event.toolExecutionMs),
      outcome,
      stepNumber,
      toolCallId,
      toolName: event.toolCall.toolName,
    });
  };

  onToolExecutionStart: NonNullable<Telemetry['onToolExecutionStart']> = (event) => {
    const callId = usageIdentifier(event.callId);
    const toolCallId = usageIdentifier(event.toolCall.toolCallId);
    if (!callId || !toolCallId || !this.acceptActiveCallback(callId)) return;
    const locatorKey = toolLocatorKey(callId, toolCallId);
    const stepNumber = this.currentSteps.get(callId) ?? 0;
    const key = toolRecordKey(callId, stepNumber, toolCallId);
    this.activeTools.add(key);
    this.toolSteps.set(locatorKey, { callId, stepNumber });
    this.recordTool({
      callId,
      dynamic: event.toolCall.dynamic === true,
      executionLocation: 'client',
      executionMs: null,
      outcome: 'unresolved',
      stepNumber,
      toolCallId,
      toolName: event.toolCall.toolName,
    });
  };

  onEnd: NonNullable<Telemetry['onEnd']> = (event) => {
    const callId = eventCallId(event);
    if (!callId || !('finishReason' in event)) return;
    this.flushToolErrors(callId);
    const completed = event.finishReason === 'stop' || isToolApprovalPause(event);
    this.finishRun(
      callId,
      completed ? 'completed' : 'failed',
      event.finishReason,
      completed ? null : `incomplete-${normalizedLabel(event.finishReason) ?? 'unknown'}`,
    );
  };

  onAbort: NonNullable<Telemetry['onAbort']> = (event) => {
    const callId = usageIdentifier(event.callId);
    if (
      !callId ||
      (!this.startedRuns.has(callId) && !this.terminalRuns.has(callId)) ||
      this.terminalRuns.get(callId)?.status === 'aborted'
    ) return;
    this.cancelAbortedTools(callId, event.reason);
    const kind = errorKind(event.reason);
    this.finishRun(
      callId,
      'aborted',
      null,
      kind === 'timeout' ? 'timeout' : 'aborterror',
    );
  };

  onError: NonNullable<Telemetry['onError']> = (event) => {
    const record = objectValue(event);
    const unfinished = [...this.startedRuns].filter(
      (candidate) => !this.terminalRuns.has(candidate),
    );
    const callId = usageIdentifier(record?.callId) ??
      (unfinished.length === 1 ? unfinished[0] ?? null : null);
    if (!callId) return;
    const kind = errorKind(record?.error ?? event);
    const cancelled = kind === 'aborterror' || kind === 'timeout';
    const status = cancelled ? 'aborted' : 'failed';
    const terminal = this.terminalRuns.get(callId);
    if (!this.startedRuns.has(callId) && !terminal) return;
    const refinesTerminal = terminal?.status === status &&
      shouldRefineErrorKind(terminal.errorKind ?? null, kind);
    if (
      terminal &&
      terminalStatusRank(status) <= terminalStatusRank(terminal.status) &&
      !refinesTerminal
    ) {
      return;
    }
    if (cancelled) {
      this.cancelAbortedTools(callId, record?.error ?? event);
    } else {
      this.flushToolErrors(callId);
    }
    this.finishRun(
      callId,
      status,
      cancelled
        ? null
        : terminal?.status === status
        ? terminal.finalFinishReason ?? 'error'
        : 'error',
      kind,
    );
  };

  abortUnfinished(
    reason: unknown = new DOMException('The request stopped.', 'AbortError'),
  ): void {
    const kind = errorKind(reason);
    const errorType = kind === 'timeout' ? 'timeout' : 'aborterror';
    for (const callId of this.startedRuns) {
      if (this.terminalRuns.has(callId)) continue;
      this.cancelAbortedTools(callId, reason);
      this.finishRun(callId, 'aborted', null, errorType);
    }
  }

  closeUnfinished(error: unknown): void {
    const cause = errorCause(error);
    const kind = errorKind(cause);
    const cancelled = kind === 'aborterror' || kind === 'timeout';
    for (const callId of this.startedRuns) {
      if (this.terminalRuns.has(callId)) continue;
      if (cancelled) this.cancelAbortedTools(callId, cause);
      else this.flushToolErrors(callId);
      this.finishRun(
        callId,
        cancelled ? 'aborted' : 'failed',
        cancelled ? null : 'error',
        kind,
      );
    }
  }

  private acceptActiveCallback(callId: string, requireStarted = true): boolean {
    return !this.terminalRuns.has(callId) &&
      (!requireStarted || this.startedRuns.has(callId));
  }

  private cancelAbortedTools(callId: string, reason: unknown): void {
    this.abortedRunReasons.set(callId, reason);
    for (const key of this.activeTools) {
      if (this.toolRecords.get(key)?.callId === callId) this.cancelledTools.add(key);
    }
    for (const [key, record] of this.toolRecords) {
      if (record.callId !== callId) continue;
      const matchingError = record.outcome === 'error' &&
        isMatchingAbortError(this.toolErrors.get(key), reason);
      if (record.outcome === 'unresolved' || matchingError || this.cancelledTools.has(key)) {
        this.cancelledTools.add(key);
        this.recordTool({ ...record, outcome: 'cancelled' });
      } else if (record.outcome === 'error') {
        this.commitTool(record);
      }
    }
  }

  private flushToolErrors(callId: string): void {
    for (const record of this.toolRecords.values()) {
      if (record.callId === callId && record.outcome === 'error') {
        this.commitTool(record);
      }
    }
  }

  private finishRun(
    callId: string,
    status: UsageRunFinalStatus,
    finishReason: string | null,
    errorType: string | null = null,
  ): void {
    const terminal = this.terminalRuns.get(callId);
    if (!terminal && !this.startedRuns.has(callId)) return;
    const refinesTerminal = terminal?.status === status &&
      shouldRefineErrorKind(terminal.errorKind ?? null, errorType);
    if (
      terminal &&
      terminalStatusRank(status) <= terminalStatusRank(terminal.status) &&
      !refinesTerminal
    ) {
      return;
    }
    let finish = this.pendingRunFinishes.get(callId);
    const refinesPending = finish?.status === status &&
      shouldRefineErrorKind(finish.errorKind ?? null, errorType);
    if (
      finish &&
      (terminalStatusRank(status) > terminalStatusRank(finish.status) || refinesPending)
    ) {
      if (terminalStatusRank(status) > terminalStatusRank(finish.status)) {
        this.updateSessionRunStatus(finish.status, status);
      }
      const endedAt = finish.endedAt;
      finish = {
        ...(endedAt === undefined ? {} : { endedAt }),
        errorKind: errorType,
        finalFinishReason: finishReason,
        status,
      };
      this.pendingRunFinishes.set(callId, finish);
    } else if (!finish) {
      finish = {
        endedAt: terminal?.endedAt ?? this.terminalTimestamp(callId),
        errorKind: errorType,
        finalFinishReason: finishReason,
        status,
      };
      this.pendingRunFinishes.set(callId, finish);
      this.updateSessionRunStatus(terminal?.status ?? null, status);
    }
    if (!finish) return;
    this.persistPendingSteps(callId);
    if (!terminal && !this.persistRun(callId)) {
      this.retainPendingRunFinish(callId);
      return;
    }
    let failure = this.attemptWrite(() => this.database.finishUsageRun(callId, finish));
    if (failure) {
      if (!terminal) {
        this.persistedRuns.delete(callId);
        if (!this.persistRun(callId)) return;
      }
      failure = this.attemptWrite(() => this.database.finishUsageRun(callId, finish));
    }
    if (failure) {
      this.warn(failure);
      this.retainPendingRunFinish(callId);
      return;
    }
    this.pendingRunFinishes.delete(callId);
    this.rememberTerminalRun(callId, finish);
    this.cleanupRun(callId);
  }

  private recordModelCall(event: ModelCallEvent): void {
    const usage = normalizeUsage(event.usage);
    const key = stepKey(event.callId, event.stepNumber);
    const resolvedModel = this.resolvedModels.get(key);
    this.observeModelCall(event.callId, event.stepNumber);
    if (!this.recordedModelCalls.has(key)) {
      this.recordedModelCalls.add(key);
      if (this.sessionUsage) {
        recordSessionModelUsage(this.sessionUsage, {
          cacheReadInputTokens: usage.cacheReadInputTokens,
          cacheWriteInputTokens: usage.cacheWriteInputTokens,
          inputTokens: usage.inputTokens,
          noCacheInputTokens: usage.noCacheInputTokens,
          outputTokens: usage.outputTokens,
          reasoningTokens: usage.reasoningTokens,
          textTokens: usage.textTokens,
          toolUseTokens: usage.toolUseTokens,
          totalTokens: usage.totalTokens,
        });
      }
    }
    const serviceTier = providerServiceTier(
      event.providerMetadata,
      event.usage.raw,
    );
    this.persistStep({
      cacheReadInputTokens: usage.cacheReadInputTokens,
      cacheWriteInputTokens: usage.cacheWriteInputTokens,
      callId: event.callId,
      finishReason: event.finishReason,
      groundingCounts: usage.groundingCounts,
      inputTokens: usage.inputTokens,
      modelId: resolvedModel?.modelId ?? event.modelId,
      noCacheInputTokens: usage.noCacheInputTokens,
      outputTokens: usage.outputTokens,
      provider: resolvedModel?.provider ?? event.provider,
      providerTotalTokens: usage.providerTotalTokens,
      rawFinishReason: safeRawFinishReason(event.rawFinishReason),
      reasoningTokens: usage.reasoningTokens,
      responseTimeMs: validDuration(event.performance.responseTimeMs),
      serviceTier,
      stepNumber: event.stepNumber,
      stepTimeMs: validDuration(event.performance.stepTimeMs),
      textTokens: usage.textTokens,
      timeToFirstOutputMs: validDuration(event.performance.timeToFirstOutputMs),
      toolUseTokens: usage.toolUseTokens,
      totalTokens: usage.totalTokens,
    });
    this.recordContentTools(event.callId, event.stepNumber, event.content);
  }

  private observeModelCall(callId: string, stepNumber: number): void {
    const key = stepKey(callId, stepNumber);
    if (this.observedModelCalls.has(key)) return;
    this.observedModelCalls.add(key);
    if (this.sessionUsage) this.sessionUsage.modelCalls += 1;
  }

  private stageStep(write: UsageStepWrite): UsageStepWrite {
    const key = stepKey(write.callId, write.stepNumber);
    const current = this.stepWrites.get(key);
    const resolvedModel = this.resolvedModels.get(key);
    const record = {
      ...current,
      ...write,
      ...resolvedModel,
    };
    this.stepWrites.set(key, record);
    return record;
  }

  private recordContentTools(
    callId: string,
    stepNumber: number,
    content: readonly unknown[],
  ): void {
    const outcomes = new Map<string, 'error' | 'returned'>();
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const record = part as Record<string, unknown>;
      if (record.type !== 'tool-result' && record.type !== 'tool-error') continue;
      const toolCallId = usageIdentifier(record.toolCallId);
      if (!toolCallId) continue;
      outcomes.set(toolCallId, record.type === 'tool-error' ? 'error' : 'returned');
    }
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const record = part as Record<string, unknown>;
      if (record.type !== 'tool-call') continue;
      const toolCallId = usageIdentifier(record.toolCallId);
      const toolName = textValue(record.toolName);
      const providerExecuted = record.providerExecuted === true;
      const invalid = record.invalid === true;
      const storedToolName = invalid ? 'invalid-tool' : toolName;
      if (!toolCallId || !storedToolName) continue;
      const outcome = invalid
        ? 'invalid'
        : outcomes.get(toolCallId) ?? 'unresolved';
      const locatorKey = toolLocatorKey(callId, toolCallId);
      this.toolSteps.set(locatorKey, { callId, stepNumber });
      this.recordTool({
        callId,
        dynamic: record.dynamic === true,
        executionLocation: providerExecuted ? 'provider' : 'client',
        executionMs: null,
        outcome,
        stepNumber,
        toolCallId,
        toolName: storedToolName,
      });
    }
  }

  private recordTool(write: UsageToolCallWrite): void {
    const key = toolRecordKey(write.callId, write.stepNumber, write.toolCallId);
    const current = this.toolRecords.get(key);
    const executionMs = write.executionMs ?? current?.executionMs ?? null;
    const record = current?.outcome === 'cancelled' && write.outcome !== 'cancelled'
      ? { ...current, executionMs }
      : current && write.outcome === 'unresolved'
      ? current
      : { ...current, ...write, executionMs };
    this.toolRecords.set(key, record);
    if (!this.recordedTools.has(key)) {
      this.recordedTools.add(key);
      if (this.sessionUsage) this.sessionUsage.toolCalls += 1;
    }
    if (record.outcome === 'error') return;
    this.commitTool(record);
  }

  private commitTool(record: UsageToolCallWrite): void {
    const key = toolRecordKey(record.callId, record.stepNumber, record.toolCallId);
    if ((record.outcome === 'error' || record.outcome === 'invalid') &&
      !this.failedTools.has(key)) {
      this.failedTools.add(key);
      if (this.sessionUsage) this.sessionUsage.toolFailures += 1;
    }
    this.persistTool(record);
  }

  private persistRun(callId: string): boolean {
    if (this.persistedRuns.has(callId)) return true;
    const write = this.runWrites.get(callId);
    if (!write) return false;
    const failure = this.attemptWrite(() => this.database.startUsageRun(write));
    if (failure) {
      this.warn(failure);
      return false;
    }
    this.persistedRuns.add(callId);
    return true;
  }

  private persistPendingSteps(callId: string): void {
    for (const write of this.stepWrites.values()) {
      if (write.callId === callId) this.persistStep(write);
    }
  }

  private persistStep(write: UsageStepWrite): boolean {
    const record = this.stageStep(write);
    if (!this.persistRun(write.callId)) return false;
    let failure = this.attemptWrite(() => this.database.putUsageStep(record));
    if (!failure) return true;

    this.persistedRuns.delete(write.callId);
    if (!this.persistRun(write.callId)) return false;
    failure = this.attemptWrite(() => this.database.putUsageStep(record));
    if (failure) this.warn(failure);
    return failure === null;
  }

  private updateSessionRunStatus(
    previous: UsageRunFinalStatus | null,
    next: UsageRunFinalStatus,
  ): void {
    if (!this.sessionUsage || previous === next) return;
    if (previous === 'completed') this.sessionUsage.completedRuns -= 1;
    if (previous === 'aborted') this.sessionUsage.abortedRuns -= 1;
    if (previous === 'failed') this.sessionUsage.failedRuns -= 1;
    if (next === 'completed') this.sessionUsage.completedRuns += 1;
    if (next === 'aborted') this.sessionUsage.abortedRuns += 1;
    if (next === 'failed') this.sessionUsage.failedRuns += 1;
  }

  private rememberTerminalRun(callId: string, finish: UsageRunFinishWrite): void {
    this.terminalRuns.delete(callId);
    this.terminalRuns.set(callId, finish);
    while (this.terminalRuns.size > MAX_TERMINAL_RUN_TOMBSTONES) {
      const oldest = this.terminalRuns.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.terminalRuns.delete(oldest);
    }
  }

  private retainPendingRunFinish(callId: string): void {
    this.discardRawRunErrors(callId);
    const finish = this.pendingRunFinishes.get(callId);
    if (finish) {
      this.pendingRunFinishes.delete(callId);
      this.pendingRunFinishes.set(callId, finish);
    }
    while (this.pendingRunFinishes.size > MAX_PENDING_RUN_FINISHES) {
      const oldest = this.pendingRunFinishes.keys().next().value as
        | string
        | undefined;
      if (oldest === undefined) break;
      this.cleanupRun(oldest);
    }
  }

  private discardRawRunErrors(callId: string): void {
    this.abortedRunReasons.delete(callId);
    for (const [key, record] of this.toolRecords) {
      if (record.callId === callId) this.toolErrors.delete(key);
    }
  }

  private cleanupRun(callId: string): void {
    this.abortedRunReasons.delete(callId);
    this.currentSteps.delete(callId);
    this.pendingRunFinishes.delete(callId);
    this.persistedRuns.delete(callId);
    this.runWrites.delete(callId);
    this.startedRuns.delete(callId);

    for (const [key, write] of this.stepWrites) {
      if (write.callId !== callId) continue;
      this.observedModelCalls.delete(key);
      this.recordedModelCalls.delete(key);
      this.resolvedModels.delete(key);
      this.stepWrites.delete(key);
    }
    for (const [key, record] of this.toolRecords) {
      if (record.callId !== callId) continue;
      this.activeTools.delete(key);
      this.cancelledTools.delete(key);
      this.failedTools.delete(key);
      this.recordedTools.delete(key);
      this.toolErrors.delete(key);
      this.toolRecords.delete(key);
    }
    for (const [key, locator] of this.toolSteps) {
      if (locator.callId === callId) this.toolSteps.delete(key);
    }
  }

  private persistTool(record: UsageToolCallWrite): void {
    const step = this.stepWrites.get(stepKey(record.callId, record.stepNumber));
    if (step ? !this.persistStep(step) : !this.persistRun(record.callId)) return;
    let failure = this.attemptWrite(() => this.database.putUsageToolCall(record));
    if (!failure) return;

    this.persistedRuns.delete(record.callId);
    if (step ? !this.persistStep(step) : !this.persistRun(record.callId)) return;
    failure = this.attemptWrite(() => this.database.putUsageToolCall(record));
    if (failure) this.warn(failure);
  }

  private timestamp(): string {
    const value = this.now();
    return Number.isFinite(value.getTime()) ? value.toISOString() : new Date().toISOString();
  }

  private terminalTimestamp(callId: string): string {
    const endedAt = this.timestamp();
    const startedAt = this.runWrites.get(callId)?.startedAt;
    return startedAt && endedAt < startedAt ? startedAt : endedAt;
  }

  private attemptWrite(run: () => unknown): string | null {
    try {
      run();
      return null;
    } catch (error) {
      return errorKind(error);
    }
  }

  private warn(kind: string): void {
    if (this.sessionUsage) {
      this.sessionUsage.storageWarning =
        `Seb could not save usage telemetry (${kind}).`;
    }
    if (this.warnedKinds.has(kind)) return;
    this.warnedKinds.add(kind);
    try {
      this.warningSink?.({
        errorKind: kind,
        event: 'seb.telemetry.write_failed',
      });
    } catch {
      // Preserve the application path when the secondary warning sink fails.
    }
  }
}

export function observeUsageStreamErrors<T>(
  stream: AsyncIterable<T>,
  telemetry: Pick<SebUsageTelemetry, 'closeUnfinished'>,
): AsyncIterable<T> {
  return (async function* () {
    try {
      for await (const part of stream) yield part;
    } catch (error) {
      try {
        telemetry.closeUnfinished(error);
      } catch {
        // Preserve the model stream error when telemetry fails.
      }
      throw error;
    }
  })();
}

interface ModelCallEvent {
  callId: string;
  content: readonly unknown[];
  finishReason: string;
  modelId: string;
  performance: {
    responseTimeMs: number;
    stepTimeMs?: number;
    timeToFirstOutputMs: number | undefined;
  };
  provider: string;
  providerMetadata: unknown;
  rawFinishReason?: string | null;
  stepNumber: number;
  usage: {
    inputTokenDetails: {
      cacheReadTokens: number | undefined;
      cacheWriteTokens: number | undefined;
      noCacheTokens: number | undefined;
    };
    inputTokens: number | undefined;
    outputTokenDetails: {
      reasoningTokens: number | undefined;
      textTokens: number | undefined;
    };
    outputTokens: number | undefined;
    raw?: unknown;
    totalTokens: number | undefined;
  };
}

interface NormalizedUsage {
  cacheReadInputTokens: number | null;
  cacheWriteInputTokens: number | null;
  groundingCounts: Record<string, number> | null;
  inputTokens: number | null;
  noCacheInputTokens: number | null;
  outputTokens: number | null;
  providerTotalTokens: number | null;
  reasoningTokens: number | null;
  textTokens: number | null;
  toolUseTokens: number | null;
  totalTokens: number | null;
}

function normalizeUsage(usage: ModelCallEvent['usage']): NormalizedUsage {
  const raw = objectValue(usage.raw);
  return {
    cacheReadInputTokens: validTokenCount(usage.inputTokenDetails.cacheReadTokens),
    cacheWriteInputTokens: validTokenCount(usage.inputTokenDetails.cacheWriteTokens),
    groundingCounts: groundingCounts(raw),
    inputTokens: validTokenCount(usage.inputTokens),
    noCacheInputTokens: validTokenCount(usage.inputTokenDetails.noCacheTokens),
    outputTokens: validTokenCount(usage.outputTokens),
    providerTotalTokens: firstTokenCount(raw, [
      'total_tokens',
      'totalTokenCount',
      'totalTokens',
    ]),
    reasoningTokens: validTokenCount(usage.outputTokenDetails.reasoningTokens),
    textTokens: validTokenCount(usage.outputTokenDetails.textTokens),
    toolUseTokens: firstTokenCount(raw, [
      'total_tool_use_tokens',
      'toolUsePromptTokenCount',
      'toolUseTokens',
    ]),
    totalTokens: validTokenCount(usage.totalTokens),
  };
}

function groundingCounts(raw: Record<string, unknown> | null): Record<string, number> | null {
  const value = raw?.grounding_tool_count ?? raw?.groundingToolCount;
  if (!Array.isArray(value)) return null;
  const result: Record<string, number> = {};
  const overflowed = new Set<string>();
  for (const item of value) {
    const record = objectValue(item);
    const type = groundingType(record?.type);
    const count = validTokenCount(record?.count);
    if (count === null || overflowed.has(type)) continue;
    const current = result[type] ?? 0;
    if (count > MAX_USAGE_TOKEN_COUNT - current) {
      delete result[type];
      overflowed.add(type);
      continue;
    }
    result[type] = current + count;
  }
  return Object.keys(result).length > 0 ? result : null;
}

function groundingType(value: unknown): 'google-maps' | 'google-search' | 'other' | 'retrieval' {
  const normalized = normalizedLabel(value)?.replaceAll('_', '-');
  if (normalized === 'google-maps') return 'google-maps';
  if (normalized === 'google-search') return 'google-search';
  if (normalized === 'retrieval') return 'retrieval';
  return 'other';
}

function providerServiceTier(
  metadata: unknown,
  rawUsage: unknown,
): string | null {
  const provider = objectValue(objectValue(metadata)?.google);
  const raw = objectValue(rawUsage);
  const tier = normalizedLabel(
    provider?.serviceTier ?? raw?.serviceTier ?? raw?.service_tier,
  );
  if (!tier) return null;
  return ['deferred', 'flex', 'priority', 'standard'].includes(tier)
    ? tier
    : 'other';
}

function firstTokenCount(
  record: Record<string, unknown> | null,
  keys: readonly string[],
): number | null {
  if (!record) return null;
  for (const key of keys) {
    if (!(key in record)) continue;
    return validTokenCount(record[key]);
  }
  return null;
}

function validTokenCount(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_USAGE_TOKEN_COUNT
    ? value
    : null;
}

function validDuration(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_USAGE_DURATION_MS
    ? value
    : null;
}

function normalizedLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._:-]+/gu, '-');
  return normalized ? normalized.slice(0, 80) : null;
}

function eventCallId(event: unknown): string | null {
  return usageIdentifier(objectValue(event)?.callId);
}

function errorKind(value: unknown): string {
  const name = value instanceof Error
    ? normalizedLabel(value.name)
    : normalizedLabel(objectValue(value)?.name);
  if (name === 'aborterror') return 'aborterror';
  if (name === 'connectorshutdownerror') return 'aborterror';
  if (name === 'storageerror' || name === 'sqliteerror') return 'storage';
  if (
    name === 'rangeerror' ||
    name === 'noobjectgeneratederror' ||
    name === 'ai_noobjectgeneratederror' ||
    name === 'syntaxerror' ||
    name === 'typevalidationerror' ||
    name === 'ai_typevalidationerror' ||
    name === 'typeerror' ||
    name === 'zoderror'
  ) return 'validation';
  switch (classifyModelError(value)) {
    case 'authentication':
      return 'provider-authentication';
    case 'cancelled':
      return 'aborterror';
    case 'capacity':
      return 'provider-capacity';
    case 'invalid-request':
      return 'provider-invalid-request';
    case 'provider':
      return 'provider';
    case 'provider-timeout':
      return 'provider-timeout';
    case 'timeout':
      return 'timeout';
    default:
      return 'error';
  }
}

function shouldRefineErrorKind(
  existing: string | null,
  next: string | null,
): boolean {
  if (!next || existing === next) return false;
  return existing === null || existing === 'error' || existing.startsWith('incomplete-');
}

function isToolApprovalPause(value: unknown): boolean {
  const content = objectValue(value)?.content;
  return Array.isArray(content) && content.some((part) =>
    objectValue(part)?.type === 'tool-approval-request'
  );
}

function errorCause(value: unknown): unknown {
  const cause = objectValue(value)?.cause;
  return cause === undefined ? value : cause;
}

function isMatchingAbortError(error: unknown, reason: unknown): boolean {
  if (Object.is(error, reason)) return true;
  const toolKind = errorKind(error);
  const reasonKind = errorKind(reason);
  const cancellationKinds = new Set(['aborterror', 'timeout']);
  return cancellationKinds.has(toolKind) &&
    (reason === undefined || cancellationKinds.has(reasonKind));
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object'
    ? value as Record<string, unknown>
    : null;
}

function textValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, 256) : null;
}

function usageIdentifier(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (!value.trim()) return null;
  if (
    value.length <= 512 &&
    /^[A-Za-z0-9][A-Za-z0-9._:/@+=-]*$/u.test(value)
  ) {
    return value;
  }
  const digest = createHash('sha256').update(value).digest('hex');
  return `~id-${digest}`;
}

function safeRawFinishReason(value: unknown): string | null {
  const normalized = normalizedLabel(value)?.replaceAll('_', '-');
  if (!normalized) return null;
  return SAFE_RAW_FINISH_REASONS.has(normalized) ? normalized : 'other';
}

function terminalStatusRank(value: UsageRunFinalStatus): number {
  if (value === 'completed') return 1;
  if (value === 'failed') return 2;
  return 3;
}

function stepKey(callId: string, stepNumber: number): string {
  return JSON.stringify([callId, stepNumber]);
}

function toolLocatorKey(callId: string, toolCallId: string): string {
  return JSON.stringify([callId, toolCallId]);
}

function toolRecordKey(
  callId: string,
  stepNumber: number,
  toolCallId: string,
): string {
  return JSON.stringify([callId, stepNumber, toolCallId]);
}
