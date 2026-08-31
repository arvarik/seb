import { describe, expect, it } from 'vitest';

import {
  analyzeUsage,
  formatStatsReport,
  formatUsageReport,
  summarizeUsage,
  usageQuery,
  usageWindow,
  type UsageWindow,
} from '../src/usage/analytics.js';
import type {
  UsageDataset,
  UsageRunRecord,
  UsageStepRecord,
  UsageToolCallRecord,
} from '../src/usage/types.js';
import { MAX_USAGE_TOKEN_COUNT } from '../src/usage/types.js';

const GENERATED_AT = '2026-08-31T19:00:00.000Z';
const TEST_WINDOW: UsageWindow = {
  name: '7d',
  sessionId: null,
  since: '2026-08-24T19:00:00.000Z',
  timeZone: 'UTC',
  until: GENERATED_AT,
};

describe('usage analytics', () => {
  it('returns explicit empty values for an empty dataset', () => {
    const report = analyzeUsage(dataset(), TEST_WINDOW, GENERATED_AT);

    expect(report).toMatchObject({
      dataQuality: {
        inconsistentModelCalls: 0,
        missingTokenUsageCalls: 0,
        truncated: false,
      },
      generatedAt: GENERATED_AT,
      grounding: [],
      latency: {
        responseMs: null,
        stepMs: null,
        timeToFirstOutputMs: null,
      },
      models: [],
      runs: {
        modelCallsPerRun: null,
        noModelCallRuns: 0,
        noToolRuns: 0,
        total: 0,
      },
      schemaVersion: 1,
      scope: TEST_WINDOW,
      source: 'seb-local-telemetry',
      steps: {
        finishReasons: [],
        providerTokensPerCall: null,
        sdkTokensPerCall: null,
        total: 0,
      },
      tools: {
        callsPerRun: null,
        clientCalls: 0,
        cumulativeClientDurationMs: { calls: 0, reported: 0, sum: null },
        providerCalls: 0,
        repeatedCalls: 0,
        repeatedRunToolPairs: 0,
        total: 0,
        unique: 0,
      },
      toolUsage: [],
      trend: [],
    });
    expect(report.tokens.input).toEqual({ calls: 0, reported: 0, sum: null });
    expect(report.tokens.ratios).toEqual({
      cacheReadInputPercent: { calls: 0, reported: 0, value: null },
      cacheWriteInputPercent: { calls: 0, reported: 0, value: null },
      inputToOutput: { calls: 0, reported: 0, value: null },
      reasoningOutputPercent: { calls: 0, reported: 0, value: null },
      toolUseOfProviderTotalPercent: { calls: 0, reported: 0, value: null },
    });
    expect(report.tools.outcomes).toEqual({
      cancelled: 0,
      error: 0,
      invalid: 0,
      returned: 0,
      unresolved: 0,
    });
  });

  it('keeps missing token metrics distinct from reported zero values', () => {
    const report = analyzeUsage(dataset({
      runs: [run()],
      steps: [
        step(),
        step({
          inputTokens: 25,
          noCacheInputTokens: 25,
          stepNumber: 1,
        }),
      ],
    }), TEST_WINDOW, GENERATED_AT);

    expect(report.dataQuality.missingTokenUsageCalls).toBe(1);
    expect(report.tokens.input).toEqual({ calls: 2, reported: 1, sum: 25 });
    expect(report.tokens.output).toEqual({ calls: 2, reported: 0, sum: null });
    expect(report.tokens.total).toEqual({ calls: 2, reported: 0, sum: null });
    expect(report.steps.providerTokensPerCall).toBeNull();
    expect(report.steps.sdkTokensPerCall).toBeNull();
    expect(report.models).toEqual([{
      calls: 2,
      inputTokens: { calls: 2, reported: 1, sum: 25 },
      model: 'model-a',
      outputTokens: { calls: 2, reported: 0, sum: null },
      provider: 'provider-a',
      providerTotalTokens: { calls: 2, reported: 0, sum: null },
      sdkTotalTokens: { calls: 2, reported: 0, sum: null },
    }]);
    expect(formatUsageReport(report)).toContain(
      '- Input tokens: 25 from 1 of 2 calls',
    );
    expect(formatUsageReport(report)).toContain('- Output tokens: not reported');
  });

  it.each([
    'cacheReadInputTokens',
    'cacheWriteInputTokens',
    'inputTokens',
    'noCacheInputTokens',
    'outputTokens',
    'providerTotalTokens',
    'reasoningTokens',
    'textTokens',
    'toolUseTokens',
    'totalTokens',
  ] as const)('recognizes an independent %s report', (field) => {
    const report = analyzeUsage(dataset({
      steps: [step({ [field]: 1 } as Partial<UsageStepRecord>)],
    }), TEST_WINDOW, GENERATED_AT);

    expect(report.dataQuality.missingTokenUsageCalls).toBe(0);
  });

  it('calculates ratios from weighted token totals', () => {
    const report = analyzeUsage(dataset({
      steps: [
        step({
          cacheReadInputTokens: 80,
          cacheWriteInputTokens: 0,
          inputTokens: 100,
          noCacheInputTokens: 20,
          outputTokens: 20,
          providerTotalTokens: 120,
          reasoningTokens: 10,
          textTokens: 10,
          toolUseTokens: 10,
          totalTokens: 120,
        }),
        step({
          cacheReadInputTokens: 90,
          cacheWriteInputTokens: 90,
          inputTokens: 900,
          noCacheInputTokens: 720,
          outputTokens: 180,
          providerTotalTokens: 1_080,
          reasoningTokens: 18,
          stepNumber: 1,
          textTokens: 162,
          toolUseTokens: 18,
          totalTokens: 1_080,
        }),
      ],
    }), TEST_WINDOW, GENERATED_AT);

    expect(report.tokens.ratios).toEqual({
      cacheReadInputPercent: { calls: 2, reported: 2, value: 17 },
      cacheWriteInputPercent: { calls: 2, reported: 2, value: 9 },
      inputToOutput: { calls: 2, reported: 2, value: 5 },
      reasoningOutputPercent: { calls: 2, reported: 2, value: 14 },
      toolUseOfProviderTotalPercent: { calls: 2, reported: 2, value: 2.33 },
    });
  });

  it('calculates token ratios only from calls that report both values', () => {
    const report = analyzeUsage(dataset({
      steps: [
        step({
          cacheReadInputTokens: 100,
          inputTokens: 100,
          outputTokens: 20,
          providerTotalTokens: 120,
          reasoningTokens: 10,
          toolUseTokens: 12,
        }),
        step({
          cacheReadInputTokens: null,
          inputTokens: 100,
          outputTokens: null,
          providerTotalTokens: null,
          reasoningTokens: null,
          stepNumber: 1,
          toolUseTokens: null,
          totalTokens: 100,
        }),
      ],
    }), TEST_WINDOW, GENERATED_AT);

    expect(report.tokens.ratios.cacheReadInputPercent).toEqual({
      calls: 2,
      reported: 1,
      value: 100,
    });
    expect(report.tokens.ratios.inputToOutput).toEqual({
      calls: 2,
      reported: 1,
      value: 5,
    });
    expect(report.tokens.ratios.toolUseOfProviderTotalPercent).toEqual({
      calls: 2,
      reported: 1,
      value: 10,
    });
    expect(formatStatsReport(report)).toContain(
      'Cache-read share of input: 100% from 1 of 2 calls with both values',
    );
  });

  it('keeps AI SDK and provider totals separate with explicit coverage', () => {
    const report = analyzeUsage(dataset({
      runs: [run()],
      steps: [
        step({
          inputTokens: 100,
          outputTokens: 40,
          providerTotalTokens: 147,
          totalTokens: 140,
        }),
        step({ stepNumber: 1 }),
      ],
    }), TEST_WINDOW, GENERATED_AT);

    expect(report.tokens.total).toEqual({ calls: 2, reported: 1, sum: 140 });
    expect(report.tokens.providerTotal).toEqual({
      calls: 2,
      reported: 1,
      sum: 147,
    });
    expect(report.models[0]).toMatchObject({
      calls: 2,
      providerTotalTokens: { calls: 2, reported: 1, sum: 147 },
      sdkTotalTokens: { calls: 2, reported: 1, sum: 140 },
    });
    expect(report.trend[0]).toMatchObject({
      modelCalls: 2,
      providerTotalTokens: { calls: 2, reported: 1, sum: 147 },
      sdkTotalTokens: { calls: 2, reported: 1, sum: 140 },
    });

    const usageOutput = formatUsageReport(report);
    const statsOutput = formatStatsReport(report);
    expect(usageOutput).toContain('- AI SDK total tokens: 140 from 1 of 2 calls');
    expect(usageOutput).toContain('- Provider total tokens: 147 from 1 of 2 calls');
    expect(statsOutput).toContain(
      '140 from 1 of 2 calls AI SDK total tokens, 147 from 1 of 2 calls provider total tokens',
    );
  });

  it('uses exact linear quantiles for distributions', () => {
    const responseTimes = [40, 0, 30, 10, 20];
    const report = analyzeUsage(dataset({
      steps: responseTimes.map((responseTimeMs, stepNumber) => step({
        responseTimeMs,
        stepNumber,
      })),
    }), TEST_WINDOW, GENERATED_AT);

    expect(report.latency.responseMs).toEqual({
      average: 20,
      max: 40,
      min: 0,
      p50: 20,
      p90: 36,
      p95: 38,
      samples: 5,
    });
  });

  it('counts conflicting token records and keeps their reported values', () => {
    const report = analyzeUsage(dataset({
      steps: [
        step({
          inputTokens: 10,
          outputTokens: 5,
          providerTotalTokens: 15,
          totalTokens: 99,
        }),
        step({
          cacheReadInputTokens: 1,
          cacheWriteInputTokens: 1,
          inputTokens: 10,
          noCacheInputTokens: 1,
          outputTokens: 5,
          providerTotalTokens: 15,
          stepNumber: 1,
          totalTokens: 15,
        }),
        step({
          inputTokens: 10,
          outputTokens: 5,
          providerTotalTokens: 15,
          reasoningTokens: 6,
          stepNumber: 2,
          totalTokens: 15,
        }),
      ],
    }), TEST_WINDOW, GENERATED_AT);

    expect(report.dataQuality.inconsistentModelCalls).toBe(3);
    expect(report.dataQuality.notes).toContain(
      'Some token fields conflict. Seb kept the original values.',
    );
    expect(report.tokens.total.sum).toBe(129);
  });

  it.each([
    'noCacheInputTokens',
    'cacheReadInputTokens',
    'cacheWriteInputTokens',
  ] as const)('detects a partial %s value above the input total', (field) => {
    const report = analyzeUsage(dataset({
      steps: [step({
        inputTokens: 10,
        [field]: 11,
      })],
    }), TEST_WINDOW, GENERATED_AT);

    expect(report.dataQuality.inconsistentModelCalls).toBe(1);
  });

  it('detects partial input components whose sum exceeds the input total', () => {
    const report = analyzeUsage(dataset({
      steps: [step({
        cacheReadInputTokens: 6,
        inputTokens: 10,
        noCacheInputTokens: 5,
      })],
    }), TEST_WINDOW, GENERATED_AT);

    expect(report.dataQuality.inconsistentModelCalls).toBe(1);
  });

  it.each([
    'textTokens',
    'reasoningTokens',
  ] as const)('detects a partial %s value above the output total', (field) => {
    const report = analyzeUsage(dataset({
      steps: [step({
        outputTokens: 10,
        [field]: 11,
      })],
    }), TEST_WINDOW, GENERATED_AT);

    expect(report.dataQuality.inconsistentModelCalls).toBe(1);
  });

  it('compares reported text and reasoning tokens with the output total', () => {
    const report = analyzeUsage(dataset({
      steps: [
        step({ outputTokens: 10, reasoningTokens: 4, textTokens: 6 }),
        step({
          outputTokens: 10,
          reasoningTokens: 3,
          stepNumber: 1,
          textTokens: 6,
        }),
      ],
    }), TEST_WINDOW, GENERATED_AT);

    expect(report.dataQuality.inconsistentModelCalls).toBe(1);
  });

  it('flags provider tool-use tokens above the provider total', () => {
    const report = analyzeUsage(dataset({
      steps: [step({ providerTotalTokens: 10, toolUseTokens: 11 })],
    }), TEST_WINDOW, GENERATED_AT);

    expect(report.dataQuality.inconsistentModelCalls).toBe(1);
    expect(report.tokens.ratios.toolUseOfProviderTotalPercent.value).toBe(110);
  });

  it('reports an aggregate overflow without emitting an unsafe JSON number', () => {
    const repeated = step({ inputTokens: MAX_USAGE_TOKEN_COUNT });
    const steps = Array.from({ length: 900_720 }, () => repeated);
    steps.push(step({ inputTokens: 1 }));

    const report = analyzeUsage(dataset({ steps }), TEST_WINDOW, GENERATED_AT);

    expect(report.tokens.input).toEqual({
      calls: 900_721,
      reported: 900_721,
      sum: null,
    });
    expect(report.dataQuality.overflowedAggregates).toBe(true);
    expect(report.dataQuality.notes).toContain(
      'One or more aggregate values exceeded the safe JSON number range. Seb reports those values as null.',
    );
    expect(formatUsageReport(report)).toContain(
      'Input tokens: overflow across 900,721 reported calls',
    );
    report.tools.cumulativeClientDurationMs = {
      calls: 2,
      reported: 2,
      sum: null,
    };
    expect(formatStatsReport(report)).toContain(
      'Cumulative client duration: overflow across 2 reported calls',
    );
    expect(nonfiniteNumberPaths(report)).toEqual([]);
  });

  it('returns null when a scaled ratio exceeds the safe JSON number range', () => {
    const steps = Array.from({ length: 10_000 }, (_value, index) => step({
      outputTokens: index === 0 ? 1 : 0,
      reasoningTokens: MAX_USAGE_TOKEN_COUNT,
    }));

    const report = analyzeUsage(dataset({ steps }), TEST_WINDOW, GENERATED_AT);

    expect(report.tokens.ratios.reasoningOutputPercent).toEqual({
      calls: 10_000,
      reported: 10_000,
      value: null,
    });
    expect(report.dataQuality.overflowedAggregates).toBe(true);
    expect(nonfiniteNumberPaths(report)).toEqual([]);
  });

  it('returns null when JSON cannot preserve a ratio to two decimals', () => {
    const repeated = step({ inputTokens: MAX_USAGE_TOKEN_COUNT, outputTokens: 0 });
    const steps = Array.from({ length: 900_000 }, () => repeated);
    steps.push(step({ inputTokens: 1, outputTokens: 100 }));

    const report = analyzeUsage(dataset({ steps }), TEST_WINDOW, GENERATED_AT);

    expect(report.tokens.ratios.inputToOutput).toEqual({
      calls: 900_001,
      reported: 900_001,
      value: null,
    });
    expect(report.dataQuality.overflowedAggregates).toBe(true);
  });

  it('builds deterministic model and tool breakdowns', () => {
    const report = analyzeUsage(dataset({
      runs: [run(), run({ callId: 'run-2', sessionId: 'session-2' })],
      steps: [
        step({
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
        }),
        step({
          inputTokens: null,
          outputTokens: 7,
          stepNumber: 1,
          totalTokens: 7,
        }),
        step({
          callId: 'run-2',
          inputTokens: 20,
          modelId: 'model-z',
          outputTokens: 10,
          provider: 'provider-z',
          totalTokens: 30,
        }),
      ],
      toolCalls: [
        tool({ executionMs: 100 }),
        tool({
          executionMs: 300,
          outcome: 'error',
          toolCallId: 'tool-call-2',
        }),
        tool({
          callId: 'run-2',
          executionLocation: 'provider',
          outcome: 'unresolved',
          toolCallId: 'tool-call-3',
          toolName: 'lookup',
        }),
      ],
    }), TEST_WINDOW, GENERATED_AT);

    expect(report.models).toEqual([
      {
        calls: 2,
        inputTokens: { calls: 2, reported: 1, sum: 10 },
        model: 'model-a',
        outputTokens: { calls: 2, reported: 2, sum: 12 },
        provider: 'provider-a',
        providerTotalTokens: { calls: 2, reported: 0, sum: null },
        sdkTotalTokens: { calls: 2, reported: 2, sum: 22 },
      },
      {
        calls: 1,
        inputTokens: { calls: 1, reported: 1, sum: 20 },
        model: 'model-z',
        outputTokens: { calls: 1, reported: 1, sum: 10 },
        provider: 'provider-z',
        providerTotalTokens: { calls: 1, reported: 0, sum: null },
        sdkTotalTokens: { calls: 1, reported: 1, sum: 30 },
      },
    ]);
    expect(report.tools).toMatchObject({
      clientCalls: 2,
      outcomes: {
        error: 1,
        returned: 1,
        unresolved: 1,
      },
      providerCalls: 1,
      total: 3,
      unique: 2,
    });
    expect(report.toolUsage).toEqual([
      {
        calls: 2,
        clientCalls: 2,
        duration: {
          average: 200,
          max: 300,
          min: 100,
          p50: 200,
          p90: 280,
          p95: 290,
          samples: 2,
        },
        name: 'search',
        outcomes: {
          cancelled: 0,
          error: 1,
          invalid: 0,
          returned: 1,
          unresolved: 0,
        },
        providerCalls: 0,
      },
      {
        calls: 1,
        clientCalls: 0,
        duration: null,
        name: 'lookup',
        outcomes: {
          cancelled: 0,
          error: 0,
          invalid: 0,
          returned: 0,
          unresolved: 1,
        },
        providerCalls: 1,
      },
    ]);
  });

  it('counts repeated calls within each run and tool pair', () => {
    const toolCalls = [
      tool(),
      tool({ toolCallId: 'a-2' }),
      tool({ toolCallId: 'a-3' }),
      tool({ toolCallId: 'b-1', toolName: 'lookup' }),
      tool({ callId: 'run-2', toolCallId: 'a-4' }),
      tool({ callId: 'run-2', toolCallId: 'a-5' }),
    ];
    const report = analyzeUsage(dataset({
      runs: [run(), run({ callId: 'run-2' })],
      toolCalls,
    }), TEST_WINDOW, GENERATED_AT);

    expect(report.tools.total).toBe(6);
    expect(report.tools.repeatedCalls).toBe(3);
    expect(report.tools.repeatedRunToolPairs).toBe(2);
  });

  it('constructs inclusive since and exclusive until query boundaries', () => {
    expect(usageQuery(TEST_WINDOW)).toEqual({
      since: '2026-08-24T19:00:00.000Z',
      until: '2026-08-31T19:00:00.000Z',
    });
  });

  it('removes both time boundaries from the all query', () => {
    const window = usageWindow('all', new Date(GENERATED_AT));

    expect(window).toMatchObject({ name: 'all', since: null, until: GENERATED_AT });
    expect(usageQuery(window)).toEqual({});
    expect(formatUsageReport(analyzeUsage(dataset(), window)))
      .toContain('Range: all saved data (newest matching runs only)');
  });

  it('groups the daily trend in the report time zone', () => {
    const input = dataset({
      runs: [run({ startedAt: '2026-08-31T01:00:00.000Z' })],
      steps: [step({ totalTokens: 10 })],
      toolCalls: [tool()],
    });
    const pacific = analyzeUsage(input, {
      ...TEST_WINDOW,
      timeZone: 'America/Los_Angeles',
    }, GENERATED_AT);
    const utc = analyzeUsage(input, TEST_WINDOW, GENERATED_AT);

    expect(pacific.trend).toEqual([
      expect.objectContaining({ date: '2026-08-30', modelCalls: 1, runs: 1, toolCalls: 1 }),
    ]);
    expect(utc.trend).toEqual([
      expect.objectContaining({ date: '2026-08-31', modelCalls: 1, runs: 1, toolCalls: 1 }),
    ]);
  });

  it('limits the local session scope to its session identifier', () => {
    const window = usageWindow(
      'session',
      new Date('2026-08-31T19:00:00.000Z'),
      'local-session-42',
    );

    expect(window).toMatchObject({
      name: 'session',
      sessionId: 'local-session-42',
      since: null,
      until: '2026-08-31T19:00:00.000Z',
    });
    expect(window.timeZone).toEqual(expect.any(String));
    expect(usageQuery(window)).toEqual({
      sessionId: 'local-session-42',
      until: '2026-08-31T19:00:00.000Z',
    });
    expect(() => usageWindow('session', new Date(GENERATED_AT))).toThrow(
      'Session usage needs a session identifier.',
    );
  });

  it('never writes nonfinite values through either text formatter', () => {
    const report = analyzeUsage(dataset({
      runs: [run()],
      steps: [step({
        cacheReadInputTokens: 0,
        cacheWriteInputTokens: 0,
        inputTokens: 0,
        noCacheInputTokens: 0,
        outputTokens: 0,
        providerTotalTokens: 0,
        reasoningTokens: 0,
        responseTimeMs: 0,
        stepTimeMs: 0,
        textTokens: 0,
        timeToFirstOutputMs: 0,
        toolUseTokens: 0,
        totalTokens: 0,
      })],
    }), TEST_WINDOW, GENERATED_AT);

    for (const output of [formatUsageReport(report), formatStatsReport(report)]) {
      expect(output).not.toMatch(/NaN|Infinity|∞/u);
    }
    expect(report.tokens.ratios).toEqual({
      cacheReadInputPercent: { calls: 1, reported: 1, value: null },
      cacheWriteInputPercent: { calls: 1, reported: 1, value: null },
      inputToOutput: { calls: 1, reported: 1, value: null },
      reasoningOutputPercent: { calls: 1, reported: 1, value: null },
      toolUseOfProviderTotalPercent: { calls: 1, reported: 1, value: null },
    });
  });

  it('rejects extreme metrics before aggregation and formatting', () => {
    const report = analyzeUsage(dataset({
      runs: [run()],
      steps: [step({
        inputTokens: Number.MAX_VALUE,
        providerTotalTokens: Number.MAX_VALUE,
        responseTimeMs: Number.MAX_VALUE,
        stepTimeMs: Number.MAX_VALUE,
        timeToFirstOutputMs: Number.MAX_VALUE,
        totalTokens: Number.MAX_VALUE,
      })],
      toolCalls: [
        tool({ executionMs: null }),
        tool({ executionMs: Number.MAX_VALUE, toolCallId: 'tool-call-extreme' }),
      ],
    }), TEST_WINDOW, GENERATED_AT);

    expect(report.tokens.input).toEqual({ calls: 1, reported: 0, sum: null });
    expect(report.latency.responseMs).toBeNull();
    expect(report.tools.cumulativeClientDurationMs).toEqual({
      calls: 2,
      reported: 0,
      sum: null,
    });
    expect(formatStatsReport(report)).toContain(
      '- Cumulative client duration: not reported',
    );
    expect(nonfiniteNumberPaths(report)).toEqual([]);
    expect(formatUsageReport(report)).not.toMatch(/NaN|Infinity|∞/u);
    expect(formatStatsReport(report)).not.toMatch(/NaN|Infinity|∞/u);
  });

  it('states the privacy boundary and the local billing limitation', () => {
    const report = analyzeUsage(dataset(), TEST_WINDOW, GENERATED_AT);
    const usageOutput = formatUsageReport(report);
    const statsOutput = formatStatsReport(report);

    expect(usageOutput).toContain(
      'Seb stores identifiers, timestamps, numeric metrics, and bounded categories. It does not store prompts, answers, tool inputs, or tool results.',
    );
    expect(usageOutput).toContain(
      'These values cover only Seb calls stored on this device. They do not show account quota, credits, or billing totals.',
    );
    expect(statsOutput).toContain(
      '- Seb stores identifiers, timestamps, numeric metrics, and bounded categories.',
    );
    expect(statsOutput).toContain(
      '- Seb does not store prompts, answers, tool inputs, tool results, or raw errors.',
    );
    expect(statsOutput).toContain(
      '- Local telemetry does not show account quota, credits, or billing totals.',
    );
  });

  it('produces stable JSON-safe summary output', () => {
    const input = dataset({
      runs: [
        run(),
        run({
          callId: 'run-2',
          sessionId: 'session-2',
          startedAt: '2026-08-30T12:00:00.000Z',
        }),
      ],
      steps: [
        step({
          groundingCounts: { search: 1 },
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
        }),
        step({
          callId: 'run-2',
          finishReason: 'length',
          groundingCounts: { search: 2, maps: 1 },
          inputTokens: 20,
          modelId: 'model-z',
          outputTokens: 10,
          provider: 'provider-z',
          totalTokens: 30,
        }),
      ],
      toolCalls: [
        tool(),
        tool({
          callId: 'run-2',
          executionLocation: 'provider',
          toolCallId: 'tool-call-2',
          toolName: 'lookup',
        }),
      ],
    });
    const reversed = dataset({
      runs: [...input.runs].reverse(),
      steps: [...input.steps].reverse(),
      toolCalls: [...input.toolCalls].reverse(),
    });
    const first = summarizeUsage(analyzeUsage(input, TEST_WINDOW, GENERATED_AT));
    const second = summarizeUsage(analyzeUsage(reversed, TEST_WINDOW, GENERATED_AT));
    const json = JSON.stringify(first);

    expect(JSON.stringify(second)).toBe(json);
    expect(JSON.parse(json)).toEqual(first);
    expect(nonfiniteNumberPaths(first)).toEqual([]);
    expect(first).toMatchObject({
      billing: {
        available: false,
        reason: 'Local Seb telemetry does not include account quota, credits, or billing.',
      },
      generatedAt: GENERATED_AT,
      schemaVersion: 1,
      source: 'seb-local-telemetry',
    });
  });
});

function dataset(overrides: Partial<UsageDataset> = {}): UsageDataset {
  return {
    runs: [],
    steps: [],
    toolCalls: [],
    truncated: false,
    ...overrides,
  };
}

function run(overrides: Partial<UsageRunRecord> = {}): UsageRunRecord {
  return {
    agentKind: 'general',
    callId: 'run-1',
    endedAt: '2026-08-31T18:00:01.000Z',
    errorKind: null,
    finalFinishReason: 'stop',
    sessionId: 'session-1',
    startedAt: '2026-08-31T18:00:00.000Z',
    status: 'completed',
    surface: 'cli',
    ...overrides,
  };
}

function step(overrides: Partial<UsageStepRecord> = {}): UsageStepRecord {
  return {
    cacheReadInputTokens: null,
    cacheWriteInputTokens: null,
    callId: 'run-1',
    finishReason: 'stop',
    groundingCounts: null,
    inputTokens: null,
    modelId: 'model-a',
    noCacheInputTokens: null,
    outputTokens: null,
    provider: 'provider-a',
    providerTotalTokens: null,
    rawFinishReason: null,
    reasoningTokens: null,
    responseTimeMs: null,
    serviceTier: null,
    stepNumber: 0,
    stepTimeMs: null,
    textTokens: null,
    timeToFirstOutputMs: null,
    toolUseTokens: null,
    totalTokens: null,
    ...overrides,
  };
}

function tool(overrides: Partial<UsageToolCallRecord> = {}): UsageToolCallRecord {
  return {
    callId: 'run-1',
    dynamic: false,
    executionLocation: 'client',
    executionMs: null,
    outcome: 'returned',
    stepNumber: 0,
    toolCallId: 'tool-call-1',
    toolName: 'search',
    ...overrides,
  };
}

function nonfiniteNumberPaths(value: unknown, path = '$'): string[] {
  if (typeof value === 'number') return Number.isFinite(value) ? [] : [path];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => nonfiniteNumberPaths(item, `${path}[${index}]`));
  }
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, item]) =>
    nonfiniteNumberPaths(item, `${path}.${key}`));
}
