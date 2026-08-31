import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import type { Telemetry, TelemetryOptions } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { activeAiDevToolsTelemetryMock, devToolsTelemetry, generateTextMock } =
vi.hoisted(() => ({
  activeAiDevToolsTelemetryMock: vi.fn<() => object[]>(() => []),
  devToolsTelemetry: { onStart: vi.fn() },
  generateTextMock: vi.fn(),
}));

vi.mock('ai', async (importOriginal) => {
  const original = await importOriginal<typeof import('ai')>();
  return { ...original, generateText: generateTextMock };
});

vi.mock('../src/ai/devtools.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/ai/devtools.js')>();
  return {
    ...original,
    activeAiDevToolsTelemetry: activeAiDevToolsTelemetryMock,
  };
});

import { runWithRequestSignal } from '../src/ai/request-signal.js';
import { SebDatabase } from '../src/data/sqlite-store.js';
import {
  formatDoctorReport,
  runDoctor,
  verifyGeminiApi,
} from '../src/doctor.js';
import { createSessionUsage } from '../src/interactive/session.js';
import { SebUsageTelemetry } from '../src/usage/telemetry.js';

const databases: SebDatabase[] = [];
const temporaryDirectories: string[] = [];

afterEach(() => {
  generateTextMock.mockReset();
  activeAiDevToolsTelemetryMock.mockReset();
  activeAiDevToolsTelemetryMock.mockReturnValue([]);
  for (const database of databases.splice(0)) database.close();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe('runDoctor', () => {
  it('checks local requirements without network requests', async () => {
    const report = await runDoctor({
      environment: { GOOGLE_GENERATIVE_AI_API_KEY: 'test-key' },
      nodeVersion: '22.12.0',
      offline: true,
      verifyPermissions: passingPermissions,
      verifyDatabase: () => ({
        cacheEntries: 0,
        file: '/tmp/seb.sqlite',
        identities: 0,
        identityLinks: 0,
        schemaVersion: 1,
        snapshots: 0,
      }),
    });

    expect(report.ok).toBe(true);
    expect(report.checks.map((check) => check.status)).toEqual([
      'pass',
      'pass',
      'pass',
      'pass',
      'skip',
      'skip',
      'skip',
      'skip',
    ]);
  });

  it('checks Sleeper and Gemini with injected test services', async () => {
    const report = await runDoctor({
      environment: {
        GOOGLE_GENERATIVE_AI_API_KEY: 'test-key',
        GEMINI_MODEL: 'primary-test',
        GEMINI_FALLBACK_MODEL: 'fallback-test',
      },
      nodeVersion: '26.0.0',
      offline: false,
      verifyPermissions: passingPermissions,
      verifyDatabase: () => ({ cacheEntries: 3, file: '/tmp/seb.sqlite', identities: 4, identityLinks: 7, schemaVersion: 2, snapshots: 2 }),
      verifySleeper: async () => ({
        season: '2026',
        seasonType: 'regular',
        week: 3,
      }),
      verifyGemini: async (apiKey, primaryModel, fallbackModel) => {
        expect(apiKey).toBe('test-key');
        expect(primaryModel).toBe('primary-test');
        expect(fallbackModel).toBe('fallback-test');
        return { fallbackUsed: false, model: primaryModel };
      },
      verifyNflverse: async () => ({ games: 100, latestSeason: 2026 }),
      verifyWeather: async () => ({
        periods: 156,
        timeZone: 'America/Los_Angeles',
      }),
    });

    expect(report.ok).toBe(true);
    expect(formatDoctorReport(report)).toContain(
      '✓ Sleeper API: 2026 regular, week 3.',
    );
    expect(formatDoctorReport(report)).toContain(
      '✓ Gemini API: primary-test returned a grounded Google Search source.',
    );
    expect(formatDoctorReport(report)).toContain(
      '✓ nflverse data: 100 schedule rows loaded through the 2026 season.',
    );
    expect(formatDoctorReport(report)).toContain(
      '✓ National Weather Service API: 156 hourly periods loaded',
    );
  });

  it('checks grounded Google Search and requires a valid web source', async () => {
    const database = createDatabase();
    generateTextMock.mockResolvedValueOnce({
      sources: [
        {
          id: 'source-1',
          sourceType: 'url',
          title: 'NFL report',
          url: 'https://www.nfl.com/news/',
        },
      ],
    });

    await expect(
      verifyGeminiApi(
        'test-key',
        'primary-test',
        'fallback-test',
        AbortSignal.timeout(1_000),
        { agentKind: 'doctor', database, surface: 'cli' },
      ),
    ).resolves.toEqual({ fallbackUsed: false, model: 'primary-test' });

    const request = generateTextMock.mock.calls[0]?.[0];
    expect(JSON.stringify(request?.tools)).toContain('google.google_search');
    expect(request?.prompt).toContain('current NFL news report');
    expect(request?.telemetry).toMatchObject({
      functionId: 'seb.cli.doctor',
      isEnabled: true,
      recordInputs: false,
      recordOutputs: false,
    });
    expect(telemetryIntegrations(request)).toEqual([
      expect.any(SebUsageTelemetry),
    ]);

    generateTextMock.mockResolvedValueOnce({ sources: [] });
    await expect(
      verifyGeminiApi(
        'test-key',
        'primary-test',
        'fallback-test',
        AbortSignal.timeout(1_000),
        { agentKind: 'doctor', database, surface: 'cli' },
      ),
    ).rejects.toThrow('returned no valid web source');
  });

  it('keeps DevTools telemetry active for a Gemini verification call', async () => {
    const database = createDatabase();
    activeAiDevToolsTelemetryMock.mockReturnValue([devToolsTelemetry]);
    generateTextMock.mockResolvedValueOnce(validGeminiResult());

    await verifyGeminiApi(
      'test-key',
      'primary-test',
      'fallback-test',
      AbortSignal.timeout(1_000),
      { agentKind: 'doctor', database, surface: 'cli' },
    );

    const request = generateTextMock.mock.calls[0]?.[0];
    expect(request?.telemetry).toMatchObject({
      recordInputs: true,
      recordOutputs: true,
    });
    expect(telemetryIntegrations(request)).toEqual([
      devToolsTelemetry,
      expect.any(SebUsageTelemetry),
    ]);
  });

  it('counts the failed primary and completed fallback setup attempts', async () => {
    const database = createDatabase();
    const sessionUsage = createSessionUsage(
      new Date('2026-08-31T12:00:00.000Z'),
    );
    const capacityError = Object.assign(
      new Error('The primary model has no capacity.'),
      { statusCode: 503 },
    );
    generateTextMock.mockImplementationOnce(
      async (request: TelemetryRequest) => {
        await emitFailedCall(
          request,
          'primary-call',
          'primary-test',
          capacityError,
        );
        throw capacityError;
      },
    );
    generateTextMock.mockImplementationOnce(
      async (request: TelemetryRequest) => {
        await emitCompletedCall(request, 'fallback-call', 'fallback-test');
        return validGeminiResult();
      },
    );

    await expect(verifyGeminiApi(
      'test-key',
      'primary-test',
      'fallback-test',
      AbortSignal.timeout(1_000),
      {
        agentKind: 'setup',
        database,
        sessionId: 'setup-session',
        sessionUsage,
        surface: 'cli',
      },
    )).resolves.toEqual({ fallbackUsed: true, model: 'fallback-test' });

    const primaryTelemetry = usageTelemetry(
      generateTextMock.mock.calls[0]?.[0],
    );
    const fallbackTelemetry = usageTelemetry(
      generateTextMock.mock.calls[1]?.[0],
    );
    const dataset = database.readUsageDataset({ sessionId: 'setup-session' });
    const runs = Object.fromEntries(
      dataset.runs.map((run) => [run.callId, run]),
    );
    const steps = Object.fromEntries(
      dataset.steps.map((step) => [step.callId, step]),
    );

    expect(primaryTelemetry).toBe(fallbackTelemetry);
    expect(runs).toMatchObject({
      'fallback-call': {
        agentKind: 'setup',
        status: 'completed',
        surface: 'cli',
      },
      'primary-call': {
        agentKind: 'setup',
        status: 'failed',
        surface: 'cli',
      },
    });
    expect(steps).toMatchObject({
      'fallback-call': {
        callId: 'fallback-call',
        inputTokens: 12,
        modelId: 'fallback-test',
        outputTokens: 6,
        totalTokens: 18,
      },
      'primary-call': {
        callId: 'primary-call',
        inputTokens: null,
        modelId: 'primary-test',
        outputTokens: null,
        totalTokens: null,
      },
    });
    expect(dataset.toolCalls).toEqual([
      expect.objectContaining({
        callId: 'fallback-call',
        executionLocation: 'provider',
        outcome: 'returned',
        toolName: 'google_search',
      }),
    ]);
    expect(sessionUsage).toMatchObject({
      agentRuns: 2,
      completedRuns: 1,
      failedRuns: 1,
      modelCalls: 2,
      toolCalls: 1,
      totalTokens: 18,
    });
  });

  it('adds a live doctor call to the current interactive usage session', async () => {
    const database = createDatabase();
    const sessionUsage = createSessionUsage(
      new Date('2026-08-31T13:00:00.000Z'),
    );
    generateTextMock.mockImplementationOnce(
      async (request: TelemetryRequest) => {
        await emitCompletedCall(request, 'doctor-call', 'primary-test');
        return validGeminiResult();
      },
    );

    const report = await runDoctor({
      environment: {
        GOOGLE_GENERATIVE_AI_API_KEY: 'test-key',
        GEMINI_FALLBACK_MODEL: 'fallback-test',
        GEMINI_MODEL: 'primary-test',
      },
      geminiTelemetry: {
        agentKind: 'doctor',
        database,
        sessionId: 'interactive-session',
        sessionUsage,
        surface: 'interactive',
      },
      nodeVersion: '22.12.0',
      offline: false,
      verifyDatabase: passingDatabase,
      verifyNflverse: async () => ({ games: 100, latestSeason: 2026 }),
      verifyPermissions: passingPermissions,
      verifySleeper: async () => ({
        season: '2026',
        seasonType: 'regular',
        week: 3,
      }),
      verifyWeather: async () => ({
        periods: 156,
        timeZone: 'America/Los_Angeles',
      }),
    });

    const dataset = database.readUsageDataset({
      sessionId: 'interactive-session',
    });
    expect(report.ok).toBe(true);
    expect(dataset.runs).toEqual([
      expect.objectContaining({
        agentKind: 'doctor',
        callId: 'doctor-call',
        surface: 'interactive',
      }),
    ]);
    expect(sessionUsage).toMatchObject({
      agentRuns: 1,
      completedRuns: 1,
      modelCalls: 1,
      toolCalls: 1,
    });
  });

  it('reports an old Node.js version and a missing key', async () => {
    const report = await runDoctor({
      environment: {},
      nodeVersion: '20.19.0',
      offline: true,
      verifyPermissions: passingPermissions,
      verifyDatabase: () => ({ cacheEntries: 0, file: '/tmp/seb.sqlite', identities: 0, identityLinks: 0, schemaVersion: 2, snapshots: 0 }),
    });

    expect(report.ok).toBe(false);
    expect(report.checks.filter((check) => check.status === 'fail')).toHaveLength(
      2,
    );
  });

  it('preserves caller cancellation after the live checks finish', async () => {
    const controller = new AbortController();
    const reason = new DOMException('The user stopped the doctor.', 'AbortError');
    let geminiSignal: AbortSignal | undefined;
    let markGeminiStarted!: () => void;
    const geminiStarted = new Promise<void>((resolve) => {
      markGeminiStarted = resolve;
    });
    const pending = runWithRequestSignal(controller.signal, () => runDoctor({
      environment: { GOOGLE_GENERATIVE_AI_API_KEY: 'test-key' },
      nodeVersion: '22.12.0',
      offline: false,
      verifyPermissions: passingPermissions,
      verifyDatabase: () => ({
        cacheEntries: 0,
        file: '/tmp/seb.sqlite',
        identities: 0,
        identityLinks: 0,
        schemaVersion: 2,
        snapshots: 0,
      }),
      verifySleeper: async () => ({
        season: '2026',
        seasonType: 'regular',
        week: 3,
      }),
      verifyGemini: async (_apiKey, primaryModel, _fallbackModel, signal) => {
        geminiSignal = signal;
        markGeminiStarted();
        await new Promise<void>((resolve) => {
          controller.signal.addEventListener('abort', () => resolve(), {
            once: true,
          });
        });
        return { fallbackUsed: false, model: primaryModel };
      },
      verifyNflverse: async () => ({ games: 100, latestSeason: 2026 }),
      verifyWeather: async () => ({
        periods: 156,
        timeZone: 'America/Los_Angeles',
      }),
    }));
    await geminiStarted;

    controller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect(geminiSignal).not.toBe(controller.signal);
    expect(geminiSignal?.aborted).toBe(true);
    expect(geminiSignal?.reason).toBe(reason);
  });

  it('limits the Gemini check to 30 seconds', async () => {
    const timeoutController = new AbortController();
    const timeoutReason = new DOMException(
      'The Gemini check timed out.',
      'TimeoutError',
    );
    const timeoutSpy = vi
      .spyOn(AbortSignal, 'timeout')
      .mockReturnValue(timeoutController.signal);
    let geminiSignal: AbortSignal | undefined;
    let markGeminiStarted!: () => void;
    const geminiStarted = new Promise<void>((resolve) => {
      markGeminiStarted = resolve;
    });

    try {
      const pending = runDoctor({
        environment: { GOOGLE_GENERATIVE_AI_API_KEY: 'test-key' },
        nodeVersion: '22.12.0',
        offline: false,
        verifyPermissions: passingPermissions,
        verifyDatabase: () => ({
          cacheEntries: 0,
          file: '/tmp/seb.sqlite',
          identities: 0,
          identityLinks: 0,
          schemaVersion: 2,
          snapshots: 0,
        }),
        verifySleeper: async () => ({
          season: '2026',
          seasonType: 'regular',
          week: 3,
        }),
        verifyGemini: async (_apiKey, _primary, _fallback, signal) => {
          geminiSignal = signal;
          markGeminiStarted();
          await new Promise<void>((resolve) => {
            signal.addEventListener('abort', () => resolve(), { once: true });
          });
          throw signal.reason;
        },
        verifyNflverse: async () => ({ games: 100, latestSeason: 2026 }),
        verifyWeather: async () => ({
          periods: 156,
          timeZone: 'America/Los_Angeles',
        }),
      });
      await geminiStarted;

      timeoutController.abort(timeoutReason);

      const report = await pending;
      const check = report.checks.find(({ name }) => name === 'Gemini API');
      expect(timeoutSpy).toHaveBeenCalledWith(30_000);
      expect(geminiSignal).toBe(timeoutController.signal);
      expect(check).toEqual({
        name: 'Gemini API',
        status: 'fail',
        detail: 'The Gemini check timed out.',
      });
    } finally {
      timeoutSpy.mockRestore();
    }
  });

  it('reports external service failures without throwing', async () => {
    const report = await runDoctor({
      environment: { GOOGLE_GENERATIVE_AI_API_KEY: 'test-key' },
      nodeVersion: '22.12.0',
      offline: false,
      verifyPermissions: passingPermissions,
      verifyDatabase: () => ({ cacheEntries: 0, file: '/tmp/seb.sqlite', identities: 0, identityLinks: 0, schemaVersion: 2, snapshots: 0 }),
      verifySleeper: async () => {
        throw new Error('Sleeper is unavailable.');
      },
      verifyGemini: async () => {
        throw new Error('The key is invalid.');
      },
      verifyNflverse: async () => {
        throw new Error('nflverse is unavailable.');
      },
      verifyWeather: async () => {
        throw new Error('Weather is unavailable.');
      },
    });

    expect(report.ok).toBe(false);
    expect(formatDoctorReport(report)).toContain(
      '✗ Sleeper API: Sleeper is unavailable.',
    );
    expect(formatDoctorReport(report)).toContain(
      '✗ Gemini API: The key is invalid.',
    );
  });

  it('fails live checks that return empty source data', async () => {
    const report = await runDoctor({
      environment: {},
      nodeVersion: '22.12.0',
      offline: false,
      verifyPermissions: passingPermissions,
      verifyDatabase: () => ({ cacheEntries: 0, file: '/tmp/seb.sqlite', identities: 0, identityLinks: 0, schemaVersion: 3, snapshots: 0 }),
      verifySleeper: async () => ({ season: '2026', seasonType: 'regular', week: 1 }),
      verifyNflverse: async () => ({ games: 0, latestSeason: Number.NEGATIVE_INFINITY }),
      verifyWeather: async () => ({ periods: 0, timeZone: null }),
    });

    expect(report.ok).toBe(false);
    expect(formatDoctorReport(report)).toContain('nflverse returned no valid schedule rows');
    expect(formatDoctorReport(report)).toContain('returned no hourly periods');
  });
});

function passingPermissions() {
  return {
    name: 'Local file permissions',
    status: 'pass' as const,
    detail: 'Private.',
  };
}

function passingDatabase() {
  return {
    cacheEntries: 0,
    file: '/tmp/seb.sqlite',
    identities: 0,
    identityLinks: 0,
    schemaVersion: 6,
    snapshots: 0,
  };
}

interface TelemetryRequest {
  telemetry?: TelemetryOptions;
}

function telemetryIntegrations(request: TelemetryRequest | undefined): Telemetry[] {
  const integrations = request?.telemetry?.integrations;
  if (!integrations) return [];
  return Array.isArray(integrations)
    ? integrations
    : [integrations as Telemetry];
}

function usageTelemetry(request: TelemetryRequest | undefined): SebUsageTelemetry {
  const telemetry = telemetryIntegrations(request).find(
    (integration) => integration instanceof SebUsageTelemetry,
  );
  if (!telemetry) throw new Error('The request has no Seb usage telemetry.');
  return telemetry;
}

async function emitFailedCall(
  request: TelemetryRequest,
  callId: string,
  modelId: string,
  error: Error,
): Promise<void> {
  const telemetry = usageTelemetry(request);
  await telemetry.onStart({ callId } as never);
  await telemetry.onStepStart({ callId, stepNumber: 0 } as never);
  await telemetry.onLanguageModelCallStart({
    callId,
    modelId,
    provider: 'google.generative-ai',
  } as never);
  await telemetry.onError({ callId, error } as never);
}

async function emitCompletedCall(
  request: TelemetryRequest,
  callId: string,
  modelId: string,
): Promise<void> {
  const telemetry = usageTelemetry(request);
  const content = [
    {
      dynamic: true,
      input: { query: 'private current news query' },
      providerExecuted: true,
      toolCallId: `${callId}-search`,
      toolName: 'google_search',
      type: 'tool-call',
    },
    {
      output: { private: 'provider search output' },
      toolCallId: `${callId}-search`,
      toolName: 'google_search',
      type: 'tool-result',
    },
  ];
  await telemetry.onStart({ callId } as never);
  await telemetry.onStepStart({ callId, stepNumber: 0 } as never);
  await telemetry.onLanguageModelCallStart({
    callId,
    modelId,
    provider: 'google.generative-ai',
  } as never);
  await telemetry.onStepEnd({
    callId,
    content,
    finishReason: 'stop',
    model: {
      modelId,
      provider: 'google.generative-ai',
    },
    performance: {
      responseTimeMs: 100,
      stepTimeMs: 125,
      timeToFirstOutputMs: 25,
      toolExecutionMs: {},
    },
    providerMetadata: { google: { serviceTier: 'STANDARD' } },
    rawFinishReason: 'STOP',
    stepNumber: 0,
    usage: {
      inputTokenDetails: {
        cacheReadTokens: 2,
        cacheWriteTokens: undefined,
        noCacheTokens: 10,
      },
      inputTokens: 12,
      outputTokenDetails: {
        reasoningTokens: 1,
        textTokens: 5,
      },
      outputTokens: 6,
      raw: { total_tokens: 18 },
      totalTokens: 18,
    },
  } as never);
  await telemetry.onEnd({ callId, finishReason: 'stop' } as never);
}

function validGeminiResult() {
  return {
    sources: [
      {
        id: 'source-1',
        sourceType: 'url',
        title: 'NFL report',
        url: 'https://www.nfl.com/news/',
      },
    ],
  };
}

function createDatabase(): SebDatabase {
  const directory = mkdtempSync(resolve(tmpdir(), 'seb-doctor-telemetry-'));
  temporaryDirectories.push(directory);
  const database = new SebDatabase(resolve(directory, 'seb.sqlite'));
  databases.push(database);
  return database;
}
