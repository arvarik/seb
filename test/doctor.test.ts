import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import type { Telemetry, TelemetryOptions } from 'ai';
import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  activeAiDevToolsTelemetryMock,
  devToolsTelemetry,
  generateTextMock,
  streamTextMock,
} =
vi.hoisted(() => ({
  activeAiDevToolsTelemetryMock: vi.fn<() => object[]>(() => []),
  devToolsTelemetry: { onStart: vi.fn() },
  generateTextMock: vi.fn(),
  streamTextMock: vi.fn(),
}));

vi.mock('ai', async (importOriginal) => {
  const original = await importOriginal<typeof import('ai')>();
  return {
    ...original,
    generateText: generateTextMock,
    streamText: streamTextMock,
  };
});

vi.mock('../src/ai/devtools.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/ai/devtools.js')>();
  return {
    ...original,
    activeAiDevToolsTelemetry: activeAiDevToolsTelemetryMock,
  };
});

import { runWithRequestSignal } from '../src/ai/request-signal.js';
import type { ResolvedModelProvider } from '../src/ai/model-provider.js';
import { SebDatabase } from '../src/data/sqlite-store.js';
import {
  formatDoctorReport,
  runDoctor,
  verifyGeminiApi,
  verifyModelProviderApi,
} from '../src/doctor.js';
import { createSessionUsage } from '../src/interactive/session.js';
import { SebUsageTelemetry } from '../src/usage/telemetry.js';

const databases: SebDatabase[] = [];
const temporaryDirectories: string[] = [];

afterEach(() => {
  generateTextMock.mockReset();
  streamTextMock.mockReset();
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
      'pass',
      'skip',
      'skip',
      'skip',
      'skip',
    ]);
  });

  it('accepts GEMINI_API_KEY in the legacy offline check', async () => {
    const report = await runDoctor({
      environment: { GEMINI_API_KEY: 'alias-key' },
      nodeVersion: '22.12.0',
      offline: true,
      verifyPermissions: passingPermissions,
      verifyDatabase: passingDatabase,
    });

    expect(report.ok).toBe(true);
    expect(report.checks).toContainEqual({
      detail: 'GEMINI_API_KEY is set.',
      name: 'Gemini key',
      status: 'pass',
    });
  });

  it('checks Sleeper and Gemini with injected test services', async () => {
    const report = await runDoctor({
      environment: {
        GEMINI_API_KEY: 'test-key',
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
      '✓ Gemini API: primary-test completed a local tool loop and returned a grounded Google Search source.',
    );
    expect(formatDoctorReport(report)).toContain(
      '✓ nflverse data: 100 schedule rows loaded through the 2026 season.',
    );
    expect(formatDoctorReport(report)).toContain(
      '✓ National Weather Service API: 156 hourly periods loaded',
    );
  });

  it('uses provider-neutral checks for the active model provider', async () => {
    const modelProvider: ResolvedModelProvider = {
      apiKey: 'anthropic-key',
      fallbackModel: 'claude-fallback',
      model: 'claude-primary',
      provider: 'anthropic',
    };
    const report = await runDoctor({
      environment: {},
      modelProvider,
      nodeVersion: '26.0.0',
      offline: false,
      verifyDatabase: passingDatabase,
      verifyModelProvider: async (selection, signal) => {
        expect(selection).toBe(modelProvider);
        expect(signal).toBeInstanceOf(AbortSignal);
        return { fallbackUsed: false, model: selection.model };
      },
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

    const output = formatDoctorReport(report);
    expect(report.ok).toBe(true);
    expect(output).toContain(
      '✓ Model provider key: Anthropic has a configured ANTHROPIC_API_KEY.',
    );
    expect(output).toContain(
      '✓ Model provider API: Anthropic model claude-primary completed a local tool loop.',
    );
    expect(output).not.toContain('Gemini key');
    expect(output).not.toContain('Gemini API');
  });

  it('accepts a keyless OpenAI-compatible endpoint configuration', async () => {
    const report = await runDoctor({
      environment: {},
      modelProvider: {
        baseURL: 'http://localhost:11434/v1',
        fallbackModel: 'local-model',
        model: 'local-model',
        provider: 'openai-compatible',
      },
      nodeVersion: '22.12.0',
      offline: true,
      verifyDatabase: passingDatabase,
      verifyPermissions: passingPermissions,
    });

    expect(report.ok).toBe(true);
    expect(formatDoctorReport(report)).toContain(
      '✓ Model provider key: OpenAI-compatible endpoint will connect without an API key.',
    );
    expect(formatDoctorReport(report)).toContain(
      '– Model provider API: The offline check skipped this request.',
    );
  });

  it('does not send a legacy Gemini request after configuration loading fails', async () => {
    const verifyGemini = vi.fn();
    const verifyModelProvider = vi.fn();
    const report = await runDoctor({
      environment: { GOOGLE_GENERATIVE_AI_API_KEY: 'google-key' },
      nodeVersion: '22.12.0',
      offline: false,
      skipModelProviderCheck: true,
      verifyDatabase: passingDatabase,
      verifyGemini,
      verifyModelProvider,
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

    expect(verifyGemini).not.toHaveBeenCalled();
    expect(verifyModelProvider).not.toHaveBeenCalled();
    expect(report.checks).toContainEqual({
      name: 'Model provider API',
      status: 'skip',
      detail: 'Seb skipped this request because the model configuration is invalid.',
    });
  });

  it('checks grounded Google Search and requires a valid web source', async () => {
    const database = createDatabase();
    mockSuccessfulGeminiVerification();

    await expect(
      verifyGeminiApi(
        'test-key',
        'primary-test',
        'fallback-test',
        AbortSignal.timeout(1_000),
        { agentKind: 'doctor', database, surface: 'cli' },
      ),
    ).resolves.toEqual({ fallbackUsed: false, model: 'primary-test' });

    const localRequest = streamTextMock.mock.calls[0]?.[0];
    const searchRequest = generateTextMock.mock.calls[0]?.[0];
    expect(JSON.stringify(localRequest?.tools)).toContain('google.google_search');
    expect(localRequest?.tools).toHaveProperty('verifyLocalTool');
    expect(localRequest?.prompt).toContain('SEB_TOOL_LOOP_OK');
    expect(localRequest?.toolChoice).toEqual({
      toolName: 'verifyLocalTool',
      type: 'tool',
    });
    expect(localRequest?.prepareStep?.({ stepNumber: 0 } as never)).toEqual({});
    expect(localRequest?.prepareStep?.({ stepNumber: 1 } as never)).toEqual({
      activeTools: [],
      toolChoice: 'none',
    });
    expect(JSON.stringify(searchRequest?.tools)).toContain('google.google_search');
    expect(searchRequest?.prompt).toContain('current NFL news report');
    expect(localRequest?.telemetry).toMatchObject({
      functionId: 'seb.cli.doctor',
      isEnabled: true,
      recordInputs: false,
      recordOutputs: false,
    });
    expect(searchRequest?.telemetry).toBe(localRequest?.telemetry);
    expect(telemetryIntegrations(localRequest)).toEqual([
      expect.any(SebUsageTelemetry),
    ]);

    streamTextMock.mockReturnValueOnce(validLocalToolResult());
    generateTextMock.mockResolvedValueOnce({
        ...validSearchResult(),
        sources: [],
      });
    await expect(
      verifyGeminiApi(
        'test-key',
        'primary-test',
        'fallback-test',
        AbortSignal.timeout(1_000),
        { agentKind: 'doctor', database, surface: 'cli' },
      ),
    ).rejects.toThrow('returned no valid web source');

    streamTextMock.mockReturnValueOnce({
      ...validLocalToolResult(),
      toolResults: Promise.resolve([]),
    });
    await expect(
      verifyGeminiApi(
        'test-key',
        'primary-test',
        'fallback-test',
        AbortSignal.timeout(1_000),
        { agentKind: 'doctor', database, surface: 'cli' },
      ),
    ).rejects.toThrow('did not complete the local tool loop');

    streamTextMock.mockReturnValueOnce({
      ...validLocalToolResult(),
      toolResults: Promise.resolve([{
          output: { marker: 'wrong-marker' },
          toolName: 'verifyLocalTool',
        }]),
    });
    await expect(
      verifyGeminiApi(
        'test-key',
        'primary-test',
        'fallback-test',
        AbortSignal.timeout(1_000),
        { agentKind: 'doctor', database, surface: 'cli' },
      ),
    ).rejects.toThrow('did not complete the local tool loop');

    streamTextMock.mockReturnValueOnce(validLocalToolResult());
    generateTextMock.mockResolvedValueOnce({
        ...validSearchResult(),
        finishReason: 'length',
      });
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

  it.each([
    [
      'Google',
      {
        apiKey: 'google-key',
        fallbackModel: 'gemini-fallback',
        model: 'gemini-primary',
        provider: 'google',
      },
      'google.generative-ai',
      true,
    ],
    [
      'Anthropic',
      {
        apiKey: 'anthropic-key',
        fallbackModel: 'claude-fallback',
        model: 'claude-primary',
        provider: 'anthropic',
      },
      'anthropic.messages',
      false,
    ],
    [
      'OpenAI',
      {
        apiKey: 'openai-key',
        fallbackModel: 'gpt-fallback',
        model: 'gpt-primary',
        provider: 'openai',
      },
      'openai.responses',
      false,
    ],
    [
      'OpenAI-compatible',
      {
        baseURL: 'http://localhost:11434/v1',
        fallbackModel: 'local-fallback',
        model: 'local-primary',
        provider: 'openai-compatible',
      },
      'openai-compatible.chat',
      false,
    ],
  ] satisfies readonly (readonly [
    string,
    ResolvedModelProvider,
    string,
    boolean,
  ])[])('verifies the %s local tool loop', async (
    _label,
    modelProvider,
    expectedProvider,
    expectsGoogleSearch,
  ) => {
    const database = createDatabase();
    streamTextMock.mockReturnValueOnce(validLocalToolResult());
    if (expectsGoogleSearch) {
      generateTextMock.mockResolvedValueOnce(validSearchResult());
    }

    await expect(verifyModelProviderApi(
      modelProvider,
      AbortSignal.timeout(1_000),
      { agentKind: 'doctor', database, surface: 'cli' },
    )).resolves.toEqual({
      fallbackUsed: false,
      model: modelProvider.model,
    });

    const localRequest = streamTextMock.mock.calls[0]?.[0];
    expect(localRequest?.model.provider).toBe(expectedProvider);
    expect(localRequest?.tools).toHaveProperty('verifyLocalTool');
    expect(localRequest?.toolChoice).toEqual({
      toolName: 'verifyLocalTool',
      type: 'tool',
    });
    expect(JSON.stringify(localRequest?.tools).includes('google.google_search'))
      .toBe(expectsGoogleSearch);
    expect(generateTextMock).toHaveBeenCalledTimes(expectsGoogleSearch ? 1 : 0);
  });

  it('uses a non-Google fallback only after a capacity error', async () => {
    const database = createDatabase();
    const capacityError = Object.assign(
      new Error('The primary model has no capacity.'),
      { statusCode: 503 },
    );
    streamTextMock.mockImplementationOnce(() => {
      const failed = Promise.reject(capacityError);
      return rejectedLocalToolResult(failed);
    });
    streamTextMock.mockReturnValueOnce(validLocalToolResult());
    const modelProvider: ResolvedModelProvider = {
      apiKey: 'anthropic-key',
      fallbackModel: 'claude-fallback',
      model: 'claude-primary',
      provider: 'anthropic',
    };

    await expect(verifyModelProviderApi(
      modelProvider,
      AbortSignal.timeout(1_000),
      { agentKind: 'doctor', database, surface: 'cli' },
    )).resolves.toEqual({
      fallbackUsed: true,
      model: 'claude-fallback',
    });

    expect(streamTextMock.mock.calls.map(
      ([request]) => request.model.modelId,
    )).toEqual(['claude-primary', 'claude-fallback']);
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it('keeps DevTools telemetry active for a Gemini verification call', async () => {
    const database = createDatabase();
    activeAiDevToolsTelemetryMock.mockReturnValue([devToolsTelemetry]);
    mockSuccessfulGeminiVerification();

    await verifyGeminiApi(
      'test-key',
      'primary-test',
      'fallback-test',
      AbortSignal.timeout(1_000),
      { agentKind: 'doctor', database, surface: 'cli' },
    );

    const localRequest = streamTextMock.mock.calls[0]?.[0];
    const searchRequest = generateTextMock.mock.calls[0]?.[0];
    expect(localRequest?.telemetry).toMatchObject({
      recordInputs: true,
      recordOutputs: true,
    });
    expect(searchRequest?.telemetry).toBe(localRequest?.telemetry);
    expect(telemetryIntegrations(localRequest)).toEqual([
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
    streamTextMock.mockImplementationOnce(
      (request: TelemetryRequest) => {
        const failed = emitFailedCall(
          request,
          'primary-call',
          'primary-test',
          capacityError,
        ).then(() => {
          throw capacityError;
        });
        return rejectedLocalToolResult(failed);
      },
    );
    streamTextMock.mockImplementationOnce(
      (request: TelemetryRequest) => {
        const completed = emitCompletedCall(
          request,
          'fallback-local-call',
          'fallback-test',
          'verifyLocalTool',
          false,
        );
        return validLocalToolResult(completed);
      },
    );
    generateTextMock.mockImplementationOnce(
      async (request: TelemetryRequest) => {
        await emitCompletedCall(
          request,
          'fallback-search-call',
          'fallback-test',
        );
        return validSearchResult();
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
      streamTextMock.mock.calls[0]?.[0],
    );
    const fallbackLocalTelemetry = usageTelemetry(
      streamTextMock.mock.calls[1]?.[0],
    );
    const fallbackSearchTelemetry = usageTelemetry(
      generateTextMock.mock.calls[0]?.[0],
    );
    const dataset = database.readUsageDataset({ sessionId: 'setup-session' });
    const runs = Object.fromEntries(
      dataset.runs.map((run) => [run.callId, run]),
    );
    const steps = Object.fromEntries(
      dataset.steps.map((step) => [step.callId, step]),
    );

    expect(primaryTelemetry).toBe(fallbackLocalTelemetry);
    expect(fallbackSearchTelemetry).toBe(fallbackLocalTelemetry);
    expect(runs).toMatchObject({
      'fallback-local-call': {
        agentKind: 'setup',
        status: 'completed',
        surface: 'cli',
      },
      'fallback-search-call': {
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
      'fallback-local-call': {
        callId: 'fallback-local-call',
        inputTokens: 12,
        modelId: 'fallback-test',
        outputTokens: 6,
        totalTokens: 18,
      },
      'fallback-search-call': {
        callId: 'fallback-search-call',
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
    expect(dataset.toolCalls).toEqual(expect.arrayContaining([
      expect.objectContaining({
        callId: 'fallback-local-call',
        executionLocation: 'client',
        outcome: 'returned',
        toolName: 'verifyLocalTool',
      }),
      expect.objectContaining({
        callId: 'fallback-search-call',
        executionLocation: 'provider',
        outcome: 'returned',
        toolName: 'google_search',
      }),
    ]));
    expect(sessionUsage).toMatchObject({
      agentRuns: 3,
      completedRuns: 2,
      failedRuns: 1,
      modelCalls: 3,
      toolCalls: 2,
      totalTokens: 36,
    });
  });

  it('adds a live doctor call to the current interactive usage session', async () => {
    const database = createDatabase();
    const sessionUsage = createSessionUsage(
      new Date('2026-08-31T13:00:00.000Z'),
    );
    streamTextMock.mockImplementationOnce(
      (request: TelemetryRequest) => {
        const completed = emitCompletedCall(
          request,
          'doctor-local-call',
          'primary-test',
          'verifyLocalTool',
          false,
        );
        return validLocalToolResult(completed);
      },
    );
    generateTextMock.mockImplementationOnce(
      async (request: TelemetryRequest) => {
        await emitCompletedCall(request, 'doctor-search-call', 'primary-test');
        return validSearchResult();
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
    expect(dataset.runs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        agentKind: 'doctor',
        callId: 'doctor-local-call',
        surface: 'interactive',
      }),
      expect.objectContaining({
        agentKind: 'doctor',
        callId: 'doctor-search-call',
        surface: 'interactive',
      }),
    ]));
    expect(sessionUsage).toMatchObject({
      agentRuns: 2,
      completedRuns: 2,
      modelCalls: 2,
      toolCalls: 2,
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
        detail: 'Gemini did not finish before the request deadline. Retry the request.',
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
      '✗ Gemini API: Gemini could not complete the request.',
    );
    expect(formatDoctorReport(report)).not.toContain('The key is invalid.');
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
  toolName = 'google_search',
  providerExecuted = true,
): Promise<void> {
  const telemetry = usageTelemetry(request);
  const toolCallId = `${callId}-${toolName}`;
  const content = [
    {
      dynamic: providerExecuted,
      input: { query: 'private current news query' },
      providerExecuted,
      toolCallId,
      toolName,
      type: 'tool-call',
    },
    {
      output: { private: 'provider search output' },
      toolCallId,
      toolName,
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

function mockSuccessfulGeminiVerification(): void {
  streamTextMock.mockReturnValueOnce(validLocalToolResult());
  generateTextMock.mockResolvedValueOnce(validSearchResult());
}

function validLocalToolResult(ready: Promise<unknown> = Promise.resolve()) {
  return {
    finishReason: ready.then(() => 'stop'),
    text: ready.then(() => 'SEB_TOOL_LOOP_OK'),
    toolResults: ready.then(() => [{
        output: { marker: 'seb-tool-ok' },
        toolName: 'verifyLocalTool',
      }]),
  };
}

function rejectedLocalToolResult(rejected: Promise<never>) {
  return {
    finishReason: rejected,
    text: rejected,
    toolResults: rejected,
  };
}

function validSearchResult() {
  return {
    finishReason: 'stop',
    steps: [{ toolResults: [] }],
    text: 'Current NFL report.',
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
