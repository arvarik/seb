import { createHash } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import Database from 'better-sqlite3';
import { MockLanguageModelV4 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createFantasyFootballAgent,
  createFantasyFootballAnalysisAgent,
} from '../src/agent.js';
import { withWebSources } from '../src/connectors/bot.js';
import { SebDatabase } from '../src/data/sqlite-store.js';
import { createSessionUsage } from '../src/interactive/session.js';
import { SleeperClient } from '../src/sleeper/client.js';
import {
  observeUsageStreamErrors,
  SebUsageTelemetry,
} from '../src/usage/telemetry.js';
import {
  MAX_USAGE_DURATION_MS,
  MAX_USAGE_TOKEN_COUNT,
} from '../src/usage/types.js';

const PROMPT_SECRET = 'private prompt: start the hidden player';
const ANSWER_SECRET = 'private answer: hidden player is active';
const TOOL_INPUT_SECRET = 'private tool input: league-123';
const TOOL_OUTPUT_SECRET = 'private tool output: roster-456';
const RAW_ERROR_SECRET = 'private raw tool error: credential-789';
const RAW_FINISH_REASON_SECRET = 'private-raw-finish-reason-credential-012';
const ERROR_NAME_SECRET = 'PrivateCustomerCredentialError';
const GROUNDING_TYPE_SECRET = 'private_grounding_customer_123';
const SERVICE_TIER_SECRET = 'private-customer-service-tier';
const INVALID_TOOL_NAME_SECRET = 'PrivateCustomerCredentialTool';

const databases: SebDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('SebUsageTelemetry', () => {
  it('clamps the end time when the system clock moves backward', () => {
    const database = createDatabase();
    const sessionUsage = createSessionUsage(new Date('2026-08-31T12:00:00.000Z'));
    const times = [
      new Date('2026-08-31T12:00:00.000Z'),
      new Date('2026-08-31T11:59:59.000Z'),
    ];
    const telemetry = new SebUsageTelemetry({
      agentKind: 'research',
      database,
      now: () => times.shift() ?? new Date('2026-08-31T11:59:59.000Z'),
      sessionId: 'session-clock-correction',
      sessionUsage,
      surface: 'cli',
    });
    const callId = 'run-clock-correction';

    telemetry.onStart(startEvent(callId) as never);
    telemetry.onEnd(endEvent(callId, 'stop') as never);

    expect(database.readUsageDataset().runs).toEqual([
      expect.objectContaining({
        callId,
        endedAt: '2026-08-31T12:00:00.000Z',
        startedAt: '2026-08-31T12:00:00.000Z',
        status: 'completed',
      }),
    ]);
    expect(sessionUsage).toMatchObject({ completedRuns: 1, storageWarning: null });
  });

  it('observes the real AI SDK lifecycle for a two-step tool loop', async () => {
    const database = createDatabase();
    const sessionUsage = createSessionUsage(new Date('2026-08-31T09:00:00.000Z'));
    const telemetry = createTelemetry(database, sessionUsage, '2026-08-31T09:00:00.000Z');
    const model = new MockLanguageModelV4({
      doGenerate: [
        {
          content: [{
            input: '{}',
            toolCallId: 'sdk-tool-1',
            toolName: 'getNflState',
            type: 'tool-call',
          }],
          finishReason: { raw: 'tool_calls', unified: 'tool-calls' },
          usage: modelUsage(),
          warnings: [],
        },
        {
          content: [{ type: 'text', text: 'The NFL is in Week 2.' }],
          finishReason: { raw: 'stop', unified: 'stop' },
          usage: modelUsage(),
          warnings: [],
        },
      ],
    });
    const agent = createFantasyFootballAgent({
      identityRepository: false,
      languageModel: model,
      sleeperClient: new SleeperClient({
        database: false,
        fetch: async () => Response.json({
          league_season: '2026',
          leg: 2,
          season: '2026',
          season_type: 'regular',
          week: 2,
        }),
      }),
      telemetryIntegrations: [telemetry],
    });

    const result = await agent.generate({ prompt: PROMPT_SECRET });
    const dataset = database.readUsageDataset();

    expect(result.text).toBe('The NFL is in Week 2.');
    expect(dataset.runs).toEqual([
      expect.objectContaining({ status: 'completed' }),
    ]);
    expect(dataset.steps).toHaveLength(2);
    expect(dataset.steps.map((step) => step.stepNumber)).toEqual([0, 1]);
    expect(dataset.toolCalls).toEqual([
      expect.objectContaining({
        executionLocation: 'client',
        outcome: 'returned',
        toolCallId: 'sdk-tool-1',
      }),
    ]);
    expect(sessionUsage).toMatchObject({
      agentRuns: 1,
      completedRuns: 1,
      modelCalls: 2,
      toolCalls: 1,
    });
  });

  it('records a real SDK invalid tool call that has no tool name', async () => {
    const database = createDatabase();
    const sessionUsage = createSessionUsage(new Date('2026-08-31T09:15:00.000Z'));
    const telemetry = createTelemetry(database, sessionUsage, '2026-08-31T09:15:00.000Z');
    const model = new MockLanguageModelV4({
      doGenerate: [
        {
          content: [{
            input: '{}',
            toolCallId: 'empty-name-tool-call',
            toolName: '',
            type: 'tool-call',
          }],
          finishReason: { raw: 'tool_calls', unified: 'tool-calls' },
          usage: modelUsage(),
          warnings: [],
        },
        {
          content: [{ type: 'text', text: 'The invalid call did not run.' }],
          finishReason: { raw: 'stop', unified: 'stop' },
          usage: modelUsage(),
          warnings: [],
        },
      ],
    });
    const agent = createFantasyFootballAgent({
      enableWebTools: false,
      identityRepository: false,
      languageModel: model,
      telemetryIntegrations: [telemetry],
    });

    const result = await agent.generate({ prompt: PROMPT_SECRET });

    expect(result.text).toBe('The invalid call did not run.');
    expect(database.readUsageDataset().toolCalls).toEqual([
      expect.objectContaining({
        outcome: 'invalid',
        toolCallId: 'empty-name-tool-call',
        toolName: 'invalid-tool',
      }),
    ]);
    expect(sessionUsage).toMatchObject({ toolCalls: 1 });
  });

  it('records a model step when the provider call fails before usage arrives', async () => {
    const database = createDatabase();
    const sessionUsage = createSessionUsage(new Date('2026-08-31T09:30:00.000Z'));
    const telemetry = createTelemetry(database, sessionUsage, '2026-08-31T09:30:00.000Z');
    const providerFailure = new Error('The provider call failed.');
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw providerFailure;
      },
    });
    const agent = createFantasyFootballAgent({
      enableWebTools: false,
      identityRepository: false,
      languageModel: model,
      telemetryIntegrations: [telemetry],
    });

    await expect(agent.generate({ prompt: PROMPT_SECRET })).rejects.toThrow(
      'The provider call failed.',
    );

    const dataset = database.readUsageDataset();
    expect(dataset.runs).toEqual([
      expect.objectContaining({ status: 'failed' }),
    ]);
    expect(dataset.steps).toEqual([
      expect.objectContaining({
        inputTokens: null,
        modelId: 'mock-model-id',
        outputTokens: null,
        provider: 'mock-provider',
        totalTokens: null,
      }),
    ]);
    expect(sessionUsage).toMatchObject({
      agentRuns: 1,
      failedRuns: 1,
      modelCalls: 1,
      totalTokensReported: 0,
    });
  });

  it('classifies a real non-streaming SDK timeout as an aborted run', async () => {
    const database = createDatabase();
    const sessionUsage = createSessionUsage(new Date('2026-08-31T09:35:00.000Z'));
    const telemetry = createTelemetry(
      database,
      sessionUsage,
      '2026-08-31T09:35:00.000Z',
    );
    const model = new MockLanguageModelV4({
      doGenerate: async ({ abortSignal }) => {
        await new Promise<never>((_resolve, reject) => {
          const stop = () => reject(abortSignal?.reason);
          if (abortSignal?.aborted) stop();
          else abortSignal?.addEventListener('abort', stop, { once: true });
        });
        throw new Error('The unreachable provider request returned.');
      },
    });
    const agent = createFantasyFootballAgent({
      enableWebTools: false,
      identityRepository: false,
      languageModel: model,
      telemetryIntegrations: [telemetry],
    });

    await expect(agent.generate({
      prompt: PROMPT_SECRET,
      timeout: 30,
    })).rejects.toMatchObject({ name: 'TimeoutError' });

    expect(database.readUsageDataset().runs).toEqual([
      expect.objectContaining({
        errorKind: 'timeout',
        finalFinishReason: null,
        status: 'aborted',
      }),
    ]);
    expect(sessionUsage).toMatchObject({
      abortedRuns: 1,
      failedRuns: 0,
    });
  });

  it('corrects a completed run when structured output validation fails', async () => {
    const database = createDatabase();
    const sessionUsage = createSessionUsage(new Date('2026-08-31T09:40:00.000Z'));
    const telemetry = createTelemetry(
      database,
      sessionUsage,
      '2026-08-31T09:40:00.000Z',
    );
    const model = new MockLanguageModelV4({
      doGenerate: {
        content: [{ type: 'text', text: 'This is not valid structured JSON.' }],
        finishReason: { raw: 'stop', unified: 'stop' },
        usage: modelUsage(),
        warnings: [],
      },
    });
    const agent = createFantasyFootballAnalysisAgent({
      languageModel: model,
      telemetryIntegrations: [telemetry],
    });

    await expect(agent.generate({ prompt: PROMPT_SECRET })).rejects.toThrow();

    expect(database.readUsageDataset().runs).toEqual([
      expect.objectContaining({
        errorKind: 'validation',
        finalFinishReason: 'error',
        status: 'failed',
      }),
    ]);
    expect(sessionUsage).toMatchObject({
      completedRuns: 0,
      failedRuns: 1,
    });
  });

  it('closes an unfinished real SDK stream when the application stops it', async () => {
    const database = createDatabase();
    const sessionUsage = createSessionUsage(new Date('2026-08-31T09:42:00.000Z'));
    const telemetry = createTelemetry(
      database,
      sessionUsage,
      '2026-08-31T09:42:00.000Z',
    );
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: 'partial-text' });
            controller.enqueue({
              type: 'text-delta',
              id: 'partial-text',
              delta: 'A partial answer.',
            });
          },
        }),
      }),
    });
    const agent = createFantasyFootballAgent({
      enableWebTools: false,
      identityRepository: false,
      languageModel: model,
      telemetryIntegrations: [telemetry],
    });
    const result = await agent.stream({ prompt: PROMPT_SECRET });
    const reader = result.fullStream.getReader();

    await reader.read();
    expect(database.readUsageDataset().runs[0]?.status).toBe('running');

    const reason = new DOMException('The user stopped the request.', 'AbortError');
    telemetry.abortUnfinished(reason);
    await reader.cancel(reason);

    expect(database.readUsageDataset().runs[0]).toMatchObject({
      errorKind: 'aborterror',
      finalFinishReason: null,
      status: 'aborted',
    });
    expect(sessionUsage).toMatchObject({ abortedRuns: 1, completedRuns: 0 });
  });

  it('classifies connector shutdown during provider startup as cancellation', async () => {
    const database = createDatabase();
    const sessionUsage = createSessionUsage(new Date('2026-08-31T09:43:00.000Z'));
    const telemetry = createTelemetry(
      database,
      sessionUsage,
      '2026-08-31T09:43:00.000Z',
    );
    const shutdown = new Error('The connector is stopping.');
    shutdown.name = 'ConnectorShutdownError';
    const model = new MockLanguageModelV4({
      doStream: async ({ abortSignal }) => {
        await new Promise<never>((_resolve, reject) => {
          const stop = () => reject(abortSignal?.reason);
          if (abortSignal?.aborted) stop();
          else abortSignal?.addEventListener('abort', stop, { once: true });
        });
        throw new Error('The unreachable provider startup returned.');
      },
    });
    const agent = createFantasyFootballAgent({
      enableWebTools: false,
      identityRepository: false,
      languageModel: model,
      telemetryIntegrations: [telemetry],
    });
    const controller = new AbortController();
    const result = await agent.stream({
      abortSignal: controller.signal,
      prompt: PROMPT_SECRET,
    });
    const reader = result.stream.getReader();

    expect((await reader.read()).value?.type).toBe('start');
    const next = reader.read();
    controller.abort(shutdown);
    expect((await next).value).toMatchObject({ type: 'abort' });

    expect(database.readUsageDataset().runs[0]).toMatchObject({
      errorKind: 'aborterror',
      finalFinishReason: null,
      status: 'aborted',
    });
    expect(sessionUsage).toMatchObject({
      abortedRuns: 1,
      completedRuns: 0,
      failedRuns: 0,
    });
  });

  it('closes a connector run when its consumer stops a partial response', async () => {
    const database = createDatabase();
    const sessionUsage = createSessionUsage(new Date('2026-08-31T09:44:00.000Z'));
    const telemetry = createTelemetry(
      database,
      sessionUsage,
      '2026-08-31T09:44:00.000Z',
    );
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ type: 'text-start', id: 'connector-text' });
            controller.enqueue({
              type: 'text-delta',
              id: 'connector-text',
              delta: 'A partial connector answer.',
            });
          },
        }),
      }),
    });
    const agent = createFantasyFootballAgent({
      enableWebTools: false,
      identityRepository: false,
      languageModel: model,
      telemetryIntegrations: [telemetry],
    });
    const result = await agent.stream({ prompt: PROMPT_SECRET });
    const response = withWebSources(
      result.fullStream,
      undefined,
      '',
      undefined,
      () => telemetry.abortUnfinished(),
    );
    const iterator = response[Symbol.asyncIterator]();

    expect((await iterator.next()).value).toContain('A partial connector answer.');
    await iterator.return?.();

    expect(database.readUsageDataset().runs[0]).toMatchObject({
      errorKind: 'aborterror',
      finalFinishReason: null,
      status: 'aborted',
    });
    expect(sessionUsage).toMatchObject({
      abortedRuns: 1,
      completedRuns: 0,
      failedRuns: 0,
    });
  });

  it('keeps a streamed provider error separate from consumer cancellation', async () => {
    const database = createDatabase();
    const sessionUsage = createSessionUsage(new Date('2026-08-31T09:44:30.000Z'));
    const telemetry = createTelemetry(
      database,
      sessionUsage,
      '2026-08-31T09:44:30.000Z',
    );
    const providerFailure = new Error('The provider stream failed.');
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ error: providerFailure, type: 'error' });
            controller.close();
          },
        }),
      }),
    });
    const agent = createFantasyFootballAgent({
      enableWebTools: false,
      identityRepository: false,
      languageModel: model,
      telemetryIntegrations: [telemetry],
    });
    const result = await agent.stream({ prompt: PROMPT_SECRET });
    let consumerCancellations = 0;
    const response = withWebSources(
      result.fullStream,
      undefined,
      '',
      undefined,
      () => {
        consumerCancellations += 1;
        telemetry.abortUnfinished();
      },
      (error) => telemetry.closeUnfinished(error),
    );

    await expect(async () => {
      for await (const _part of response) {
        // Consume the wrapped response.
      }
    }).rejects.toMatchObject({ name: 'ModelResponseError' });

    expect(consumerCancellations).toBe(0);
    expect(database.readUsageDataset().runs[0]).toMatchObject({
      errorKind: 'error',
      status: 'failed',
    });
    expect(sessionUsage).toMatchObject({
      abortedRuns: 0,
      failedRuns: 1,
    });
  });

  it('closes a raw command-line stream when the provider returns an error', async () => {
    const database = createDatabase();
    const sessionUsage = createSessionUsage(new Date('2026-08-31T09:44:45.000Z'));
    const telemetry = createTelemetry(
      database,
      sessionUsage,
      '2026-08-31T09:44:45.000Z',
    );
    const providerFailure = new Error('The command-line provider stream failed.');
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            controller.enqueue({ error: providerFailure, type: 'error' });
            controller.close();
          },
        }),
      }),
    });
    const agent = createFantasyFootballAgent({
      enableWebTools: false,
      identityRepository: false,
      languageModel: model,
      telemetryIntegrations: [telemetry],
    });
    const result = await agent.stream({ prompt: PROMPT_SECRET });

    await expect(async () => {
      for await (const part of observeUsageStreamErrors(
        result.fullStream,
        telemetry,
      )) {
        if (part.type === 'error') {
          telemetry.closeUnfinished(part.error);
          throw part.error;
        }
      }
    }).rejects.toThrow('The command-line provider stream failed.');

    expect(database.readUsageDataset().runs[0]).toMatchObject({
      errorKind: 'error',
      status: 'failed',
    });
    expect(sessionUsage).toMatchObject({ abortedRuns: 0, failedRuns: 1 });
  });

  it('retries a failed run start before it saves the model step', () => {
    const database = createDatabase();
    const sessionUsage = createSessionUsage(new Date('2026-08-31T09:45:00.000Z'));
    const transientFailure = new Error('The database was busy.');
    transientFailure.name = 'StorageError';
    let startAttempts = 0;
    const telemetry = new SebUsageTelemetry({
      agentKind: 'research',
      database: {
        finishUsageRun: (callId, write) => database.finishUsageRun(callId, write),
        putUsageStep: (write) => database.putUsageStep(write),
        putUsageToolCall: (write) => database.putUsageToolCall(write),
        startUsageRun: (write) => {
          startAttempts += 1;
          if (startAttempts === 1) throw transientFailure;
          return database.startUsageRun(write);
        },
      },
      now: () => new Date('2026-08-31T09:45:00.000Z'),
      sessionId: 'session-retry-start',
      sessionUsage,
      surface: 'interactive',
    });
    const callId = 'run-retry-start';

    telemetry.onStart(startEvent(callId) as never);
    telemetry.onStepStart(stepStartEvent(callId, 0) as never);
    telemetry.onLanguageModelCallStart(modelCallStartEvent(callId) as never);
    telemetry.onError({ callId, error: new Error('The model failed.') } as never);

    expect(startAttempts).toBe(2);
    expect(database.readUsageDataset()).toMatchObject({
      runs: [{ callId, status: 'failed' }],
      steps: [{ callId, modelId: 'gemini-3.7-flash', stepNumber: 0 }],
    });
    expect(sessionUsage).toMatchObject({ agentRuns: 1, failedRuns: 1, modelCalls: 1 });
  });

  it('records a privacy-safe two-step run with null coverage and deduplicated tools', () => {
    const database = createDatabase();
    const sessionUsage = createSessionUsage(new Date('2026-08-31T10:00:00.000Z'));
    const telemetry = createTelemetry(database, sessionUsage, '2026-08-31T10:00:00.000Z');
    const callId = 'run-two-step';
    const clientCall = clientToolCall('client-tool-1', 'getNflState');
    const failedCall = clientToolCall('client-tool-error', 'readNewsUrl');
    const providerCall = providerToolCall('provider-tool-1', 'google_search');
    const providerResult = toolResult('provider-tool-1', 'google_search');
    const firstModelContent = [
      clientCall,
      failedCall,
      providerCall,
      providerResult,
      { type: 'text', text: ANSWER_SECRET },
    ];

    telemetry.onStart(startEvent(callId) as never);
    telemetry.onStart(startEvent(callId) as never);
    telemetry.onStepStart(stepStartEvent(callId, 0) as never);
    telemetry.onLanguageModelCallEnd(modelCallEndEvent({
      callId,
      content: firstModelContent,
      finishReason: 'tool-calls',
      stepNumber: 0,
      usage: reportedUsage(),
    }) as never);
    telemetry.onLanguageModelCallEnd(modelCallEndEvent({
      callId,
      content: firstModelContent,
      finishReason: 'tool-calls',
      stepNumber: 0,
      usage: reportedUsage(),
    }) as never);
    telemetry.onToolExecutionEnd(toolEndEvent({
      callId,
      executionMs: 25,
      output: { type: 'tool-result', output: { value: TOOL_OUTPUT_SECRET } },
      toolCallId: 'client-tool-1',
      toolName: 'getNflState',
    }) as never);
    telemetry.onToolExecutionEnd(toolEndEvent({
      callId,
      executionMs: 25,
      output: { type: 'tool-result', output: { value: TOOL_OUTPUT_SECRET } },
      toolCallId: 'client-tool-1',
      toolName: 'getNflState',
    }) as never);
    telemetry.onToolExecutionEnd(toolEndEvent({
      callId,
      executionMs: 12,
      output: toolError(RAW_ERROR_SECRET),
      toolCallId: 'client-tool-error',
      toolName: 'readNewsUrl',
    }) as never);
    telemetry.onToolExecutionEnd(toolEndEvent({
      callId,
      executionMs: 12,
      output: toolError(RAW_ERROR_SECRET),
      toolCallId: 'client-tool-error',
      toolName: 'readNewsUrl',
    }) as never);
    const firstStepContent = [
      clientCall,
      toolResult('client-tool-1', 'getNflState'),
      failedCall,
      {
        error: new Error(RAW_ERROR_SECRET),
        toolCallId: 'client-tool-error',
        toolName: 'readNewsUrl',
        type: 'tool-error',
      },
      providerCall,
      providerResult,
      { type: 'text', text: ANSWER_SECRET },
    ];
    telemetry.onStepEnd(stepEndEvent({
      callId,
      content: firstStepContent,
      finishReason: 'tool-calls',
      stepNumber: 0,
      usage: reportedUsage(),
    }) as never);
    telemetry.onStepEnd(stepEndEvent({
      callId,
      content: firstStepContent,
      finishReason: 'tool-calls',
      stepNumber: 0,
      usage: reportedUsage(),
    }) as never);

    telemetry.onStepStart(stepStartEvent(callId, 1) as never);
    telemetry.onLanguageModelCallEnd(modelCallEndEvent({
      callId,
      content: [{ type: 'text', text: ANSWER_SECRET }],
      finishReason: 'stop',
      stepNumber: 1,
      usage: missingUsage(),
    }) as never);
    telemetry.onStepEnd(stepEndEvent({
      callId,
      content: [{ type: 'text', text: ANSWER_SECRET }],
      finishReason: 'stop',
      stepNumber: 1,
      usage: missingUsage(),
    }) as never);
    telemetry.onEnd(endEvent(callId, 'stop') as never);
    telemetry.onEnd(endEvent(callId, 'stop') as never);

    const dataset = database.readUsageDataset();
    expect(dataset.runs).toEqual([
      expect.objectContaining({
        callId,
        finalFinishReason: 'stop',
        sessionId: 'session-telemetry',
        status: 'completed',
      }),
    ]);
    expect(dataset.steps).toHaveLength(2);
    expect(dataset.steps.find((step) => step.stepNumber === 0)).toMatchObject({
      cacheReadInputTokens: 20,
      cacheWriteInputTokens: null,
      groundingCounts: { 'google-search': 2, other: 1 },
      inputTokens: 100,
      noCacheInputTokens: 80,
      outputTokens: 40,
      providerTotalTokens: 147,
      reasoningTokens: 10,
      serviceTier: 'priority',
      textTokens: 30,
      toolUseTokens: 7,
      totalTokens: 140,
    });
    expect(dataset.steps.find((step) => step.stepNumber === 1)).toMatchObject({
      cacheReadInputTokens: null,
      cacheWriteInputTokens: null,
      groundingCounts: null,
      inputTokens: null,
      noCacheInputTokens: null,
      outputTokens: null,
      providerTotalTokens: null,
      reasoningTokens: null,
      serviceTier: null,
      textTokens: null,
      toolUseTokens: null,
      totalTokens: null,
    });
    expect(dataset.toolCalls).toHaveLength(3);
    expect(toolRecord(dataset.toolCalls, 'client-tool-1')).toMatchObject({
      executionLocation: 'client',
      executionMs: 25,
      outcome: 'returned',
      stepNumber: 0,
      toolName: 'getNflState',
    });
    expect(toolRecord(dataset.toolCalls, 'provider-tool-1')).toMatchObject({
      dynamic: true,
      executionLocation: 'provider',
      executionMs: null,
      outcome: 'returned',
      stepNumber: 0,
      toolName: 'google_search',
    });
    expect(toolRecord(dataset.toolCalls, 'client-tool-error')).toMatchObject({
      executionLocation: 'client',
      executionMs: 12,
      outcome: 'error',
      stepNumber: 0,
      toolName: 'readNewsUrl',
    });
    expect(sessionUsage).toMatchObject({
      agentRuns: 1,
      cacheReadInputTokens: 20,
      cacheReadInputTokensReported: 1,
      completedRuns: 1,
      failedRuns: 0,
      inputTokens: 100,
      inputTokensReported: 1,
      modelCalls: 2,
      outputTokens: 40,
      outputTokensReported: 1,
      reasoningTokens: 10,
      reasoningTokensReported: 1,
      storageWarning: null,
      toolCalls: 3,
      toolFailures: 1,
      toolUseTokens: 7,
      toolUseTokensReported: 1,
      totalTokens: 140,
      totalTokensReported: 1,
    });
    expect(savedUsageText(database)).not.toContain(PROMPT_SECRET);
    expect(savedUsageText(database)).not.toContain(ANSWER_SECRET);
    expect(savedUsageText(database)).not.toContain(TOOL_INPUT_SECRET);
    expect(savedUsageText(database)).not.toContain(TOOL_OUTPUT_SECRET);
    expect(savedUsageText(database)).not.toContain(RAW_ERROR_SECRET);
    expect(savedUsageText(database)).not.toContain(GROUNDING_TYPE_SECRET);
  });

  it('preserves completed step metrics when a run aborts', () => {
    const database = createDatabase();
    const sessionUsage = createSessionUsage(new Date('2026-08-31T11:00:00.000Z'));
    const telemetry = createTelemetry(database, sessionUsage, '2026-08-31T11:00:00.000Z');
    const callId = 'run-aborted';

    telemetry.onStart(startEvent(callId) as never);
    telemetry.onStepStart(stepStartEvent(callId, 0) as never);
    telemetry.onStepEnd(stepEndEvent({
      callId,
      content: [clientToolCall('cancelled-tool', 'readNewsUrl')],
      finishReason: 'tool-calls',
      stepNumber: 0,
      usage: reportedUsage(),
    }) as never);
    telemetry.onAbort({
      callId,
      reason: new Error(RAW_ERROR_SECRET),
      steps: [],
    } as never);
    telemetry.onAbort({
      callId,
      reason: new Error(RAW_ERROR_SECRET),
      steps: [],
    } as never);
    telemetry.onEnd(endEvent(callId, 'stop') as never);

    const dataset = database.readUsageDataset();
    expect(dataset.runs).toEqual([
      expect.objectContaining({
        callId,
        errorKind: 'aborterror',
        finalFinishReason: null,
        status: 'aborted',
      }),
    ]);
    expect(dataset.steps).toHaveLength(1);
    expect(dataset.steps[0]).toMatchObject({
      callId,
      inputTokens: 100,
      totalTokens: 140,
    });
    expect(toolRecord(dataset.toolCalls, 'cancelled-tool')).toMatchObject({
      executionLocation: 'client',
      outcome: 'cancelled',
      toolName: 'readNewsUrl',
    });
    expect(sessionUsage).toMatchObject({
      abortedRuns: 1,
      agentRuns: 1,
      completedRuns: 0,
      modelCalls: 1,
    });
    expect(savedUsageText(database)).not.toContain(RAW_ERROR_SECRET);
  });

  it.each(['error-first', 'abort-first'] as const)(
    'keeps an aborted tool cancelled when callbacks arrive %s',
    (order) => {
      const database = createDatabase();
      const sessionUsage = createSessionUsage(new Date('2026-08-31T11:30:00.000Z'));
      const telemetry = createTelemetry(database, sessionUsage, '2026-08-31T11:30:00.000Z');
      const callId = `run-aborted-tool-${order}`;
      const toolCallId = `aborted-tool-${order}`;
      const reason = new Error('The connector stopped the request.');
      reason.name = 'ConnectorShutdownError';
      const end = () => telemetry.onToolExecutionEnd(toolEndEvent({
        callId,
        executionMs: 4,
        output: { error: reason, type: 'tool-error' },
        toolCallId,
        toolName: 'readNewsUrl',
      }) as never);
      const abort = () => telemetry.onAbort({ callId, reason, steps: [] } as never);

      telemetry.onStart(startEvent(callId) as never);
      telemetry.onStepStart(stepStartEvent(callId, 0) as never);
      telemetry.onLanguageModelCallStart(modelCallStartEvent(callId) as never);
      telemetry.onToolExecutionStart(toolStartEvent({
        callId,
        toolCallId,
        toolName: 'readNewsUrl',
      }) as never);
      if (order === 'error-first') {
        end();
        abort();
      } else {
        abort();
        end();
      }

      expect(toolRecord(database.readUsageDataset().toolCalls, toolCallId)).toMatchObject({
        executionLocation: 'client',
        outcome: 'cancelled',
      });
      expect(sessionUsage).toMatchObject({
        abortedRuns: 1,
        storageWarning: null,
        toolCalls: 1,
        toolFailures: 0,
      });
    },
  );

  it.each(['error-first', 'abort-first'] as const)(
    'matches an AbortError tool failure to a TimeoutError run in %s order',
    (order) => {
      const database = createDatabase();
      const sessionUsage = createSessionUsage(new Date('2026-08-31T11:35:00.000Z'));
      const telemetry = createTelemetry(database, sessionUsage, '2026-08-31T11:35:00.000Z');
      const callId = `run-timeout-tool-${order}`;
      const toolCallId = `timeout-tool-${order}`;
      const toolError = new DOMException('The tool request stopped.', 'AbortError');
      const timeout = new DOMException('The model deadline expired.', 'TimeoutError');
      const end = () => telemetry.onToolExecutionEnd(toolEndEvent({
        callId,
        executionMs: 4,
        output: { error: toolError, type: 'tool-error' },
        toolCallId,
        toolName: 'readNewsUrl',
      }) as never);
      const abort = () => telemetry.onAbort({ callId, reason: timeout, steps: [] } as never);

      telemetry.onStart(startEvent(callId) as never);
      telemetry.onStepStart(stepStartEvent(callId, 0) as never);
      telemetry.onLanguageModelCallStart(modelCallStartEvent(callId) as never);
      telemetry.onToolExecutionStart(toolStartEvent({
        callId,
        toolCallId,
        toolName: 'readNewsUrl',
      }) as never);
      if (order === 'error-first') {
        end();
        abort();
      } else {
        abort();
        end();
      }

      expect(database.readUsageDataset()).toMatchObject({
        runs: [{ errorKind: 'timeout', status: 'aborted' }],
        toolCalls: [{ outcome: 'cancelled', toolCallId }],
      });
      expect(sessionUsage).toMatchObject({
        abortedRuns: 1,
        storageWarning: null,
        toolCalls: 1,
        toolFailures: 0,
      });
    },
  );

  it('maps a private error name to a safe stored category', () => {
    const database = createDatabase();
    const sessionUsage = createSessionUsage(new Date('2026-08-31T11:45:00.000Z'));
    const telemetry = createTelemetry(database, sessionUsage, '2026-08-31T11:45:00.000Z');
    const callId = 'run-private-error-name';
    const privateError = new Error('The request failed.');
    privateError.name = ERROR_NAME_SECRET;

    telemetry.onStart(startEvent(callId) as never);
    telemetry.onStepStart(stepStartEvent(callId, 0) as never);
    telemetry.onLanguageModelCallStart(modelCallStartEvent(callId) as never);
    telemetry.onError({ callId, error: privateError } as never);

    expect(database.readUsageDataset().runs).toEqual([
      expect.objectContaining({ errorKind: 'error', status: 'failed' }),
    ]);
    expect(savedUsageText(database)).not.toContain(ERROR_NAME_SECRET);
  });

  it('maps an unknown service tier to a safe stored category', () => {
    const database = createDatabase();
    const sessionUsage = createSessionUsage(new Date('2026-08-31T11:47:00.000Z'));
    const telemetry = createTelemetry(database, sessionUsage, '2026-08-31T11:47:00.000Z');
    const callId = 'run-private-service-tier';
    const event = stepEndEvent({
      callId,
      content: [],
      finishReason: 'stop',
      stepNumber: 0,
      usage: reportedUsage(),
    });
    event.providerMetadata = { google: { serviceTier: SERVICE_TIER_SECRET } };

    telemetry.onStart(startEvent(callId) as never);
    telemetry.onStepStart(stepStartEvent(callId, 0) as never);
    telemetry.onStepEnd(event as never);
    telemetry.onEnd(endEvent(callId, 'stop') as never);

    expect(database.readUsageDataset().steps[0]?.serviceTier).toBe('other');
    expect(savedUsageText(database)).not.toContain(SERVICE_TIER_SECRET);
  });

  it('replaces a model-returned invalid tool name with a safe category', () => {
    const database = createDatabase();
    const sessionUsage = createSessionUsage(new Date('2026-08-31T11:47:00.000Z'));
    const telemetry = createTelemetry(database, sessionUsage, '2026-08-31T11:47:00.000Z');
    const callId = 'run-private-invalid-tool-name';
    const toolCallId = 'invalid-tool-call';

    telemetry.onStart(startEvent(callId) as never);
    telemetry.onStepStart(stepStartEvent(callId, 0) as never);
    telemetry.onLanguageModelCallEnd(modelCallEndEvent({
      callId,
      content: [{
        input: { query: TOOL_INPUT_SECRET },
        invalid: true,
        toolCallId,
        toolName: INVALID_TOOL_NAME_SECRET,
        type: 'tool-call',
      }],
      finishReason: 'tool-calls',
      stepNumber: 0,
      usage: reportedUsage(),
    }) as never);
    telemetry.onEnd(endEvent(callId, 'tool-calls') as never);

    expect(toolRecord(database.readUsageDataset().toolCalls, toolCallId)).toMatchObject({
      outcome: 'invalid',
      toolName: 'invalid-tool',
    });
    expect(savedUsageText(database)).not.toContain(INVALID_TOOL_NAME_SECRET);
  });

  it('drops oversized metrics while it preserves valid fields from the same call', () => {
    const database = createDatabase();
    const sessionUsage = createSessionUsage(new Date('2026-08-31T11:48:00.000Z'));
    const telemetry = createTelemetry(database, sessionUsage, '2026-08-31T11:48:00.000Z');
    const callId = 'run-oversized-metrics';
    const usage = reportedUsage();
    const event = stepEndEvent({
      callId,
      content: [{ type: 'text', text: ANSWER_SECRET }],
      finishReason: 'stop',
      stepNumber: 0,
      usage: {
        ...usage,
        inputTokens: MAX_USAGE_TOKEN_COUNT + 1,
        raw: {
          ...usage.raw,
          total_tokens: MAX_USAGE_TOKEN_COUNT + 1,
        },
        totalTokens: MAX_USAGE_TOKEN_COUNT + 1,
      },
    });

    telemetry.onStart(startEvent(callId) as never);
    telemetry.onStepStart(stepStartEvent(callId, 0) as never);
    telemetry.onStepEnd({
      ...event,
      performance: {
        ...event.performance,
        responseTimeMs: MAX_USAGE_DURATION_MS + 1,
        stepTimeMs: MAX_USAGE_DURATION_MS + 1,
        timeToFirstOutputMs: 25,
      },
    } as never);
    telemetry.onEnd(endEvent(callId, 'stop') as never);

    expect(database.readUsageDataset().steps).toEqual([
      expect.objectContaining({
        cacheReadInputTokens: 20,
        inputTokens: null,
        outputTokens: 40,
        providerTotalTokens: null,
        responseTimeMs: null,
        stepTimeMs: null,
        timeToFirstOutputMs: 25,
        toolUseTokens: 7,
        totalTokens: null,
      }),
    ]);
    expect(sessionUsage.storageWarning).toBeNull();
  });

  it('drops an overflowing grounding category and preserves the model step', () => {
    const database = createDatabase();
    const sessionUsage = createSessionUsage(new Date('2026-08-31T11:49:00.000Z'));
    const telemetry = createTelemetry(database, sessionUsage, '2026-08-31T11:49:00.000Z');
    const callId = 'run-grounding-overflow';
    const usage = reportedUsage();

    telemetry.onStart(startEvent(callId) as never);
    telemetry.onStepStart(stepStartEvent(callId, 0) as never);
    telemetry.onStepEnd(stepEndEvent({
      callId,
      content: [{ type: 'text', text: ANSWER_SECRET }],
      finishReason: 'stop',
      stepNumber: 0,
      usage: {
        ...usage,
        raw: {
          ...usage.raw,
          grounding_tool_count: [
            { count: 2, type: 'GOOGLE SEARCH' },
            { count: MAX_USAGE_TOKEN_COUNT, type: 'private category one' },
            { count: 1, type: 'private category two' },
          ],
        },
      },
    }) as never);
    telemetry.onEnd(endEvent(callId, 'stop') as never);

    expect(database.readUsageDataset().steps).toEqual([
      expect.objectContaining({
        groundingCounts: { 'google-search': 2 },
        inputTokens: 100,
        outputTokens: 40,
        totalTokens: 140,
      }),
    ]);
    expect(sessionUsage.storageWarning).toBeNull();
  });

  it('keeps delimiter-like run and tool identifiers distinct', () => {
    const database = createDatabase();
    const sessionUsage = createSessionUsage(new Date('2026-08-31T11:50:00.000Z'));
    const telemetry = createTelemetry(database, sessionUsage, '2026-08-31T11:50:00.000Z');
    const records = [
      { callId: 'run:part', toolCallId: 'tool' },
      { callId: 'run', toolCallId: 'part:tool' },
    ];

    for (const record of records) {
      telemetry.onStart(startEvent(record.callId) as never);
      telemetry.onStepStart(stepStartEvent(record.callId, 0) as never);
      telemetry.onLanguageModelCallStart(modelCallStartEvent(record.callId) as never);
      telemetry.onToolExecutionStart(toolStartEvent({
        ...record,
        toolName: 'getNflState',
      }) as never);
      telemetry.onToolExecutionEnd(toolEndEvent({
        ...record,
        executionMs: 1,
        output: { type: 'tool-result', output: {} },
        toolName: 'getNflState',
      }) as never);
      telemetry.onEnd(endEvent(record.callId, 'stop') as never);
    }

    expect(database.readUsageDataset().toolCalls).toHaveLength(2);
    expect(sessionUsage).toMatchObject({
      agentRuns: 2,
      completedRuns: 2,
      modelCalls: 2,
      toolCalls: 2,
    });
  });

  it('keeps a hashed invalid identifier separate from a raw identifier', () => {
    const database = createDatabase();
    const sessionUsage = createSessionUsage(new Date('2026-08-31T11:52:00.000Z'));
    const telemetry = createTelemetry(database, sessionUsage, '2026-08-31T11:52:00.000Z');
    const callId = 'run-disjoint-identifiers';
    const invalidToolCallId = 'bad tool id';
    const paddedInvalidToolCallId = ' bad tool id ';
    const digest = createHash('sha256').update(invalidToolCallId).digest('hex');
    const paddedDigest = createHash('sha256')
      .update(paddedInvalidToolCallId)
      .digest('hex');
    const rawToolCallId = `id-${digest}`;

    telemetry.onStart(startEvent(callId) as never);
    telemetry.onStepStart(stepStartEvent(callId, 0) as never);
    telemetry.onLanguageModelCallStart(modelCallStartEvent(callId) as never);
    for (const [toolCallId, toolName] of [
      [invalidToolCallId, 'getNflState'],
      [paddedInvalidToolCallId, 'getNflState'],
      [rawToolCallId, 'getNflSchedule'],
    ] as const) {
      telemetry.onToolExecutionStart(toolStartEvent({
        callId,
        toolCallId,
        toolName,
      }) as never);
      telemetry.onToolExecutionEnd(toolEndEvent({
        callId,
        executionMs: 1,
        output: { type: 'tool-result', output: {} },
        toolCallId,
        toolName,
      }) as never);
    }
    telemetry.onEnd(endEvent(callId, 'stop') as never);

    expect(database.readUsageDataset().toolCalls.map((tool) => tool.toolCallId).sort())
      .toEqual([rawToolCallId, `~id-${digest}`, `~id-${paddedDigest}`].sort());
    expect(sessionUsage).toMatchObject({ storageWarning: null, toolCalls: 3 });
  });

  it('records a reused tool-call ID once in each model step', () => {
    const database = createDatabase();
    const sessionUsage = createSessionUsage(new Date('2026-08-31T11:55:00.000Z'));
    const telemetry = createTelemetry(database, sessionUsage, '2026-08-31T11:55:00.000Z');
    const callId = 'run-reused-tool-id';
    const toolCallId = 'reused-tool-id';

    telemetry.onStart(startEvent(callId) as never);
    for (const stepNumber of [0, 1]) {
      const call = clientToolCall(toolCallId, 'getNflState');
      telemetry.onStepStart(stepStartEvent(callId, stepNumber) as never);
      telemetry.onLanguageModelCallEnd(modelCallEndEvent({
        callId,
        content: [call],
        finishReason: 'tool-calls',
        stepNumber,
        usage: reportedUsage(),
      }) as never);
      telemetry.onToolExecutionStart(toolStartEvent({
        callId,
        toolCallId,
        toolName: 'getNflState',
      }) as never);
      telemetry.onToolExecutionEnd(toolEndEvent({
        callId,
        executionMs: stepNumber + 1,
        output: { type: 'tool-result', output: {} },
        toolCallId,
        toolName: 'getNflState',
      }) as never);
    }
    telemetry.onEnd(endEvent(callId, 'stop') as never);

    const records = database.readUsageDataset().toolCalls;
    expect(records).toHaveLength(2);
    expect(records.map((record) => record.stepNumber)).toEqual([0, 1]);
    expect(records.map((record) => record.executionMs)).toEqual([1, 2]);
    expect(sessionUsage.toolCalls).toBe(2);
  });

  it('uses one canonical identity at every callback boundary', () => {
    const database = createDatabase();
    const sessionUsage = createSessionUsage(new Date('2026-08-31T11:56:00.000Z'));
    const telemetry = createTelemetry(database, sessionUsage, '2026-08-31T11:56:00.000Z');
    const callId = 'r'.repeat(700);
    const toolCallId = 't'.repeat(700);

    telemetry.onStart(startEvent(callId) as never);
    telemetry.onStepStart(stepStartEvent(callId, 0) as never);
    telemetry.onLanguageModelCallStart(modelCallStartEvent(callId) as never);
    telemetry.onToolExecutionStart(toolStartEvent({
      callId,
      toolCallId,
      toolName: 'getNflState',
    }) as never);
    telemetry.onToolExecutionEnd(toolEndEvent({
      callId,
      executionMs: 1,
      output: { type: 'tool-result', output: {} },
      toolCallId,
      toolName: 'getNflState',
    }) as never);
    telemetry.onEnd(endEvent(callId, 'stop') as never);

    const dataset = database.readUsageDataset();
    expect(dataset.runs).toHaveLength(1);
    expect(dataset.steps).toHaveLength(1);
    expect(dataset.toolCalls).toHaveLength(1);
    expect(dataset.runs[0]?.callId).toMatch(/^~id-[a-f0-9]{64}$/u);
    expect(dataset.steps[0]?.callId).toBe(dataset.runs[0]?.callId);
    expect(dataset.toolCalls[0]?.callId).toBe(dataset.runs[0]?.callId);
    expect(dataset.toolCalls[0]?.toolCallId).toMatch(/^~id-[a-f0-9]{64}$/u);
    expect(sessionUsage.storageWarning).toBeNull();
  });

  it('stores the provider-returned model identity without a storage conflict', () => {
    const database = createDatabase();
    const sessionUsage = createSessionUsage(new Date('2026-08-31T11:57:00.000Z'));
    const telemetry = createTelemetry(database, sessionUsage, '2026-08-31T11:57:00.000Z');
    const callId = 'run-resolved-model';

    telemetry.onStart(startEvent(callId) as never);
    telemetry.onStepStart(stepStartEvent(callId, 0) as never);
    telemetry.onLanguageModelCallStart({
      ...modelCallStartEvent(callId),
      modelId: 'requested-model-alias',
    } as never);
    telemetry.onLanguageModelCallEnd(modelCallEndEvent({
      callId,
      content: [],
      finishReason: 'stop',
      modelId: 'provider-model-version-2026-08-31',
      stepNumber: 0,
      usage: reportedUsage(),
    }) as never);
    telemetry.onStepEnd(stepEndEvent({
      callId,
      content: [],
      finishReason: 'stop',
      modelId: 'requested-model-alias',
      stepNumber: 0,
      usage: reportedUsage(),
    }) as never);
    telemetry.onEnd(endEvent(callId, 'stop') as never);

    expect(database.readUsageDataset().steps[0]?.modelId).toBe(
      'provider-model-version-2026-08-31',
    );
    expect(sessionUsage.storageWarning).toBeNull();
  });

  it('maps an unknown raw finish reason to a safe stored category', () => {
    const database = createDatabase();
    const sessionUsage = createSessionUsage(new Date('2026-08-31T11:58:00.000Z'));
    const telemetry = createTelemetry(database, sessionUsage, '2026-08-31T11:58:00.000Z');
    const callId = 'run-private-raw-finish-reason';

    telemetry.onStart(startEvent(callId) as never);
    telemetry.onStepStart(stepStartEvent(callId, 0) as never);
    telemetry.onStepEnd(stepEndEvent({
      callId,
      content: [],
      finishReason: 'stop',
      rawFinishReason: RAW_FINISH_REASON_SECRET,
      stepNumber: 0,
      usage: reportedUsage(),
    }) as never);
    telemetry.onEnd(endEvent(callId, 'stop') as never);

    expect(database.readUsageDataset().steps[0]?.rawFinishReason).toBe('other');
    expect(savedUsageText(database)).not.toContain(RAW_FINISH_REASON_SECRET);
  });

  it('applies terminal status precedence and preserves the first end time', () => {
    const database = createDatabase();
    const sessionUsage = createSessionUsage(new Date('2026-08-31T11:58:30.000Z'));
    const telemetry = createTelemetry(database, sessionUsage, '2026-08-31T11:58:30.000Z');
    const callId = 'run-terminal-precedence';

    telemetry.onStart(startEvent(callId) as never);
    telemetry.onEnd(endEvent(callId, 'stop') as never);
    const completedEnd = database.readUsageDataset().runs[0]?.endedAt;
    telemetry.onError({ callId, error: new TypeError('The output is invalid.') } as never);
    const abortReason = new Error(RAW_ERROR_SECRET);
    abortReason.name = 'AbortError';
    telemetry.onAbort({ callId, reason: abortReason, steps: [] } as never);
    telemetry.onEnd(endEvent(callId, 'stop') as never);

    expect(database.readUsageDataset().runs[0]).toMatchObject({
      endedAt: completedEnd,
      errorKind: 'aborterror',
      finalFinishReason: null,
      status: 'aborted',
    });
    expect(sessionUsage).toMatchObject({
      abortedRuns: 1,
      completedRuns: 0,
      failedRuns: 0,
      storageWarning: null,
    });
    expect(savedUsageText(database)).not.toContain(RAW_ERROR_SECRET);
  });

  it('clears per-run state and bounds terminal status tombstones', () => {
    const store = {
      finishUsageRun: () => undefined,
      putUsageStep: () => undefined,
      putUsageToolCall: () => undefined,
      startUsageRun: () => undefined,
    };
    const telemetry = new SebUsageTelemetry({
      agentKind: 'research',
      database: store as never,
      now: () => new Date('2026-08-31T11:59:00.000Z'),
      sessionId: 'session-bounded-state',
      surface: 'interactive',
    });

    for (let index = 0; index < 1_050; index += 1) {
      const callId = `bounded-run-${index}`;
      telemetry.onStart(startEvent(callId) as never);
      telemetry.onStepStart(stepStartEvent(callId, 0) as never);
      telemetry.onLanguageModelCallStart(modelCallStartEvent(callId) as never);
      telemetry.onError({ callId, error: new Error(RAW_ERROR_SECRET) } as never);
    }

    const state = telemetry as unknown as Record<string, { size: number }>;
    expect(state.terminalRuns?.size).toBe(1_024);
    for (const name of [
      'abortedRunReasons',
      'activeTools',
      'cancelledTools',
      'currentSteps',
      'failedTools',
      'observedModelCalls',
      'pendingRunFinishes',
      'persistedRuns',
      'recordedModelCalls',
      'recordedTools',
      'resolvedModels',
      'runWrites',
      'startedRuns',
      'stepWrites',
      'toolErrors',
      'toolRecords',
      'toolSteps',
    ]) {
      expect(state[name]?.size, name).toBe(0);
    }
  });

  it('bounds pending run state and drops raw errors during permanent storage failure', () => {
    const storageError = new Error('The usage store is unavailable.');
    storageError.name = 'StorageError';
    const throwingStore = {
      finishUsageRun: () => {
        throw storageError;
      },
      putUsageStep: () => {
        throw storageError;
      },
      putUsageToolCall: () => {
        throw storageError;
      },
      startUsageRun: () => {
        throw storageError;
      },
    };
    const sessionUsage = createSessionUsage(new Date('2026-08-31T11:59:30.000Z'));
    const telemetry = new SebUsageTelemetry({
      agentKind: 'research',
      database: throwingStore,
      now: () => new Date('2026-08-31T11:59:30.000Z'),
      sessionId: 'session-bounded-storage-failure',
      sessionUsage,
      surface: 'interactive',
    });

    for (let index = 0; index < 1_100; index += 1) {
      const callId = `failed-storage-run-${index}`;
      const reason = new Error(`private-abort-secret-${index}`);
      reason.name = 'AbortError';
      telemetry.onStart(startEvent(callId) as never);
      telemetry.onAbort({ callId, reason, steps: [] } as never);
    }

    const state = telemetry as unknown as Record<string, { size: number }>;
    expect(state.pendingRunFinishes?.size).toBe(1_024);
    expect(state.startedRuns?.size).toBe(1_024);
    expect(state.runWrites?.size).toBe(1_024);
    expect(state.abortedRunReasons?.size).toBe(0);
    expect(state.toolErrors?.size).toBe(0);
    expect(sessionUsage).toMatchObject({
      abortedRuns: 1_100,
      agentRuns: 1_100,
      storageWarning: 'Seb could not save usage telemetry (storage).',
    });
    expect(JSON.stringify(telemetry)).not.toContain('private-abort-secret');
  });

  it('keeps callback metrics when the usage store throws', () => {
    const storageError = new Error(RAW_ERROR_SECRET);
    storageError.name = 'StorageError';
    const throwingStore = {
      finishUsageRun: () => {
        throw storageError;
      },
      putUsageStep: () => {
        throw storageError;
      },
      putUsageToolCall: () => {
        throw storageError;
      },
      startUsageRun: () => {
        throw storageError;
      },
    };
    const sessionUsage = createSessionUsage(new Date('2026-08-31T12:00:00.000Z'));
    const telemetry = new SebUsageTelemetry({
      agentKind: 'research',
      database: throwingStore,
      now: () => new Date('2026-08-31T12:00:00.000Z'),
      sessionId: 'session-throwing-store',
      sessionUsage,
      surface: 'interactive',
    });
    const callId = 'run-throwing-store';
    const call = clientToolCall('client-tool-store', 'getNflState');

    expect(() => telemetry.onStart(startEvent(callId) as never)).not.toThrow();
    expect(() => telemetry.onStepStart(stepStartEvent(callId, 0) as never)).not.toThrow();
    expect(() => telemetry.onStepEnd(stepEndEvent({
      callId,
      content: [call, toolResult('client-tool-store', 'getNflState')],
      finishReason: 'stop',
      stepNumber: 0,
      usage: reportedUsage(),
    }) as never)).not.toThrow();
    expect(() => telemetry.onToolExecutionEnd(toolEndEvent({
      callId,
      executionMs: 3,
      output: { type: 'tool-result', output: { value: TOOL_OUTPUT_SECRET } },
      toolCallId: 'client-tool-store',
      toolName: 'getNflState',
    }) as never)).not.toThrow();
    expect(() => telemetry.onAbort({
      callId,
      reason: storageError,
      steps: [],
    } as never)).not.toThrow();

    expect(sessionUsage).toMatchObject({
      abortedRuns: 1,
      agentRuns: 1,
      inputTokens: 100,
      modelCalls: 1,
      storageWarning: 'Seb could not save usage telemetry (storage).',
      toolCalls: 1,
      totalTokens: 140,
    });
    expect(sessionUsage.storageWarning).not.toContain(RAW_ERROR_SECRET);
  });

  it('retries a transient final-write failure without double counting', () => {
    const database = createDatabase();
    const sessionUsage = createSessionUsage(new Date('2026-08-31T12:10:00.000Z'));
    let finalFailuresRemaining = 2;
    const store = {
      finishUsageRun: (...arguments_: Parameters<SebDatabase['finishUsageRun']>) => {
        if (finalFailuresRemaining > 0) {
          finalFailuresRemaining -= 1;
          throw new Error('Transient storage failure.');
        }
        return database.finishUsageRun(...arguments_);
      },
      putUsageStep: database.putUsageStep.bind(database),
      putUsageToolCall: database.putUsageToolCall.bind(database),
      startUsageRun: database.startUsageRun.bind(database),
    };
    const telemetry = new SebUsageTelemetry({
      agentKind: 'research',
      database: store,
      now: () => new Date('2026-08-31T12:10:00.000Z'),
      sessionId: 'session-transient-final-write',
      sessionUsage,
      surface: 'interactive',
    });
    const callId = 'run-transient-final-write';

    telemetry.onStart(startEvent(callId) as never);
    telemetry.onEnd(endEvent(callId, 'stop') as never);
    expect(database.readUsageDataset().runs[0]?.status).toBe('running');

    telemetry.onEnd(endEvent(callId, 'stop') as never);

    expect(database.readUsageDataset().runs[0]).toMatchObject({
      finalFinishReason: 'stop',
      status: 'completed',
    });
    expect(sessionUsage.completedRuns).toBe(1);
  });
});

function createTelemetry(
  database: SebDatabase,
  sessionUsage: ReturnType<typeof createSessionUsage>,
  start: string,
): SebUsageTelemetry {
  let tick = 0;
  const startMs = Date.parse(start);
  return new SebUsageTelemetry({
    agentKind: 'research',
    database,
    now: () => new Date(startMs + tick++ * 1_000),
    sessionId: 'session-telemetry',
    sessionUsage,
    surface: 'interactive',
  });
}

function startEvent(callId: string) {
  return {
    callId,
    messages: [{ content: PROMPT_SECRET, role: 'user' }],
    operationId: 'ai.streamText',
    prompt: PROMPT_SECRET,
  };
}

function stepStartEvent(callId: string, stepNumber: number) {
  return {
    callId,
    messages: [{ content: PROMPT_SECRET, role: 'user' }],
    stepNumber,
  };
}

function modelCallStartEvent(callId: string) {
  return {
    callId,
    instructions: 'private instructions',
    messages: [{ content: PROMPT_SECRET, role: 'user' }],
    modelId: 'gemini-3.7-flash',
    provider: 'google.interactions',
    tools: [],
  };
}

function modelCallEndEvent(options: StepEventOptions) {
  return {
    callId: options.callId,
    content: options.content,
    finishReason: options.finishReason,
    modelId: options.modelId ?? 'gemini-3.7-flash',
    performance: modelPerformance(),
    prompt: [{ content: PROMPT_SECRET, role: 'user' }],
    provider: 'google.interactions',
    providerMetadata: options.stepNumber === 0
      ? { google: { serviceTier: 'PRIORITY' } }
      : undefined,
    responseId: `response-${options.stepNumber}`,
    usage: options.usage,
  };
}

function stepEndEvent(options: StepEventOptions) {
  return {
    callId: options.callId,
    content: options.content,
    finishReason: options.finishReason,
    model: {
      modelId: options.modelId ?? 'gemini-3.7-flash',
      provider: 'google.interactions',
    },
    performance: {
      ...modelPerformance(),
      stepTimeMs: 160 + options.stepNumber,
      toolExecutionMs: {},
    },
    providerMetadata: options.stepNumber === 0
      ? { google: { serviceTier: 'PRIORITY' } }
      : undefined,
    rawFinishReason: options.rawFinishReason ?? options.finishReason,
    stepNumber: options.stepNumber,
    usage: options.usage,
  };
}

function endEvent(callId: string, finishReason: string) {
  return { callId, finishReason };
}

interface StepEventOptions {
  callId: string;
  content: readonly unknown[];
  finishReason: string;
  modelId?: string;
  rawFinishReason?: string;
  stepNumber: number;
  usage: SyntheticUsage;
}

interface SyntheticUsage {
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
  raw: Record<string, unknown>;
  totalTokens: number | undefined;
}

function modelPerformance() {
  return {
    effectiveOutputTokensPerSecond: 100,
    effectiveTotalTokensPerSecond: 200,
    inputTokensPerSecond: 500,
    outputTokensPerSecond: 100,
    responseTimeMs: 120,
    timeToFirstOutputMs: 30,
  };
}

function reportedUsage(): SyntheticUsage {
  return {
    inputTokenDetails: {
      cacheReadTokens: 20,
      cacheWriteTokens: undefined,
      noCacheTokens: 80,
    },
    inputTokens: 100,
    outputTokenDetails: {
      reasoningTokens: 10,
      textTokens: 30,
    },
    outputTokens: 40,
    raw: {
      grounding_tool_count: [
        { count: 2, type: 'GOOGLE SEARCH' },
        { count: 1, type: GROUNDING_TYPE_SECRET },
      ],
      private_debug_value: RAW_ERROR_SECRET,
      total_tokens: 147,
      total_tool_use_tokens: 7,
    },
    totalTokens: 140,
  };
}

function modelUsage() {
  return {
    inputTokens: {
      cacheRead: undefined,
      cacheWrite: undefined,
      noCache: 10,
      total: 10,
    },
    outputTokens: {
      reasoning: undefined,
      text: 5,
      total: 5,
    },
  };
}

function missingUsage(): SyntheticUsage {
  return {
    inputTokenDetails: {
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
      noCacheTokens: undefined,
    },
    inputTokens: undefined,
    outputTokenDetails: {
      reasoningTokens: undefined,
      textTokens: undefined,
    },
    outputTokens: undefined,
    raw: { private_debug_value: RAW_ERROR_SECRET },
    totalTokens: undefined,
  };
}

function clientToolCall(toolCallId: string, toolName: string) {
  return {
    dynamic: false,
    input: { query: TOOL_INPUT_SECRET },
    toolCallId,
    toolName,
    type: 'tool-call',
  };
}

function providerToolCall(toolCallId: string, toolName: string) {
  return {
    dynamic: true,
    input: { query: TOOL_INPUT_SECRET },
    providerExecuted: true,
    toolCallId,
    toolName,
    type: 'tool-call',
  };
}

function toolResult(toolCallId: string, toolName: string) {
  return {
    output: { value: TOOL_OUTPUT_SECRET },
    toolCallId,
    toolName,
    type: 'tool-result',
  };
}

function toolError(message: string) {
  const error = new Error(message);
  error.name = 'ToolExecutionError';
  return { error, type: 'tool-error' };
}

function toolEndEvent(options: {
  callId: string;
  executionMs: number;
  output: unknown;
  toolCallId: string;
  toolName: string;
}) {
  return {
    callId: options.callId,
    messages: [{ content: PROMPT_SECRET, role: 'user' }],
    toolCall: {
      ...clientToolCall(options.toolCallId, options.toolName),
      input: { query: TOOL_INPUT_SECRET },
    },
    toolContext: undefined,
    toolExecutionMs: options.executionMs,
    toolOutput: options.output,
  };
}

function toolStartEvent(options: {
  callId: string;
  toolCallId: string;
  toolName: string;
}) {
  return {
    callId: options.callId,
    messages: [{ content: PROMPT_SECRET, role: 'user' }],
    toolCall: clientToolCall(options.toolCallId, options.toolName),
    toolContext: undefined,
  };
}

function toolRecord(
  records: ReturnType<SebDatabase['readUsageDataset']>['toolCalls'],
  toolCallId: string,
) {
  return records.find((record) => record.toolCallId === toolCallId);
}

function savedUsageText(database: SebDatabase): string {
  const inspected = new Database(database.file, { readonly: true });
  try {
    return JSON.stringify({
      runs: inspected.prepare('SELECT * FROM usage_runs').all(),
      steps: inspected.prepare('SELECT * FROM usage_steps').all(),
      tools: inspected.prepare('SELECT * FROM usage_tool_calls').all(),
    });
  } finally {
    inspected.close();
  }
}

function createDatabase(): SebDatabase {
  const file = resolve(mkdtempSync(resolve(tmpdir(), 'seb-usage-telemetry-')), 'seb.sqlite');
  const database = new SebDatabase(file);
  databases.push(database);
  return database;
}
