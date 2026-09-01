import type {
  UsageDataset,
  UsageQuery,
  UsageRunRecord,
  UsageStepRecord,
  UsageToolCallRecord,
  UsageToolOutcome,
} from './types.js';
import {
  MAX_USAGE_DURATION_MS,
  MAX_USAGE_TOKEN_COUNT,
} from './types.js';

export type UsageScope = 'session' | 'today' | '7d' | '30d' | 'all';

export interface UsageWindow {
  name: UsageScope;
  sessionId: string | null;
  since: string | null;
  timeZone: string;
  until: string;
}

export interface MetricTotal {
  calls: number;
  reported: number;
  sum: number | null;
}

export interface RatioMetric {
  calls: number;
  reported: number;
  value: number | null;
}

export interface Distribution {
  average: number;
  max: number;
  min: number;
  p50: number;
  p90: number;
  p95: number;
  samples: number;
}

export interface NamedCount {
  count: number;
  name: string;
}

export interface ModelUsageBreakdown {
  calls: number;
  inputTokens: MetricTotal;
  model: string;
  outputTokens: MetricTotal;
  provider: string;
  providerTotalTokens: MetricTotal;
  sdkTotalTokens: MetricTotal;
}

export interface ToolUsageBreakdown {
  calls: number;
  clientCalls: number;
  duration: Distribution | null;
  name: string;
  outcomes: Record<UsageToolOutcome, number>;
  providerCalls: number;
}

export interface DailyUsageTrend {
  date: string;
  modelCalls: number;
  providerTotalTokens: MetricTotal;
  runs: number;
  sdkTotalTokens: MetricTotal;
  toolCalls: number;
}

export interface UsageAnalyticsReport {
  dataQuality: {
    inconsistentModelCalls: number;
    missingTokenUsageCalls: number;
    notes: string[];
    overflowedAggregates: boolean;
    truncated: boolean;
  };
  generatedAt: string;
  grounding: NamedCount[];
  latency: {
    responseMs: Distribution | null;
    stepMs: Distribution | null;
    timeToFirstOutputMs: Distribution | null;
  };
  models: ModelUsageBreakdown[];
  runs: {
    aborted: number;
    agentKinds: NamedCount[];
    completed: number;
    successfulRunRatePercent: number | null;
    durationMs: Distribution | null;
    errorKinds: NamedCount[];
    failed: number;
    failedAfterReturnedToolRuns: number;
    modelCallsPerRun: Distribution | null;
    noModelCallRuns: number;
    noToolRuns: number;
    unfinished: number;
    surfaces: NamedCount[];
    total: number;
  };
  schemaVersion: 1;
  scope: UsageWindow;
  source: 'seb-local-telemetry';
  steps: {
    finishReasons: NamedCount[];
    providers: NamedCount[];
    providerTokensPerCall: Distribution | null;
    sdkTokensPerCall: Distribution | null;
    serviceTiers: NamedCount[];
    total: number;
  };
  tokens: {
    cacheReadInput: MetricTotal;
    cacheWriteInput: MetricTotal;
    input: MetricTotal;
    noCacheInput: MetricTotal;
    output: MetricTotal;
    providerTotal: MetricTotal;
    ratios: {
      cacheReadInputPercent: RatioMetric;
      cacheWriteInputPercent: RatioMetric;
      inputToOutput: RatioMetric;
      reasoningOutputPercent: RatioMetric;
      toolUseOfProviderTotalPercent: RatioMetric;
    };
    reasoning: MetricTotal;
    text: MetricTotal;
    toolUse: MetricTotal;
    total: MetricTotal;
  };
  tools: {
    callsPerRun: Distribution | null;
    clientCalls: number;
    cumulativeClientDurationMs: MetricTotal;
    outcomes: Record<UsageToolOutcome, number>;
    providerCalls: number;
    repeatedCalls: number;
    repeatedRunToolPairs: number;
    total: number;
    unique: number;
  };
  toolUsage: ToolUsageBreakdown[];
  trend: DailyUsageTrend[];
}

export interface UsageSummary {
  billing: {
    available: false;
    reason: string;
  };
  dataQuality: UsageAnalyticsReport['dataQuality'];
  generatedAt: string;
  models: ModelUsageBreakdown[];
  runs: UsageAnalyticsReport['runs'];
  schemaVersion: 1;
  scope: UsageWindow;
  source: 'seb-local-telemetry';
  steps: Pick<UsageAnalyticsReport['steps'], 'finishReasons' | 'total'>;
  tokens: UsageAnalyticsReport['tokens'];
  tools: Pick<UsageAnalyticsReport['tools'], 'clientCalls' | 'providerCalls' | 'total'>;
}

const TOOL_OUTCOMES: readonly UsageToolOutcome[] = [
  'returned',
  'error',
  'invalid',
  'cancelled',
  'unresolved',
];

export function usageWindow(
  scope: UsageScope,
  now = new Date(),
  sessionId?: string,
): UsageWindow {
  const validNow = Number.isFinite(now.getTime()) ? now : new Date();
  const until = validNow.toISOString();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local';
  if (scope === 'session') {
    if (!sessionId) throw new Error('Session usage needs a session identifier.');
    return { name: scope, sessionId, since: null, timeZone, until };
  }
  if (scope === 'all') {
    return { name: scope, sessionId: null, since: null, timeZone, until };
  }
  if (scope === 'today') {
    const since = new Date(
      validNow.getFullYear(),
      validNow.getMonth(),
      validNow.getDate(),
    );
    return {
      name: scope,
      sessionId: null,
      since: since.toISOString(),
      timeZone,
      until,
    };
  }
  const days = scope === '7d' ? 7 : 30;
  return {
    name: scope,
    sessionId: null,
    since: new Date(validNow.getTime() - days * 24 * 60 * 60 * 1_000).toISOString(),
    timeZone,
    until,
  };
}

export function usageQuery(window: UsageWindow): UsageQuery {
  return {
    ...(window.sessionId ? { sessionId: window.sessionId } : {}),
    ...(window.since ? { since: window.since } : {}),
    ...(window.name === 'all' ? {} : { until: window.until }),
  };
}

export function analyzeUsage(
  dataset: UsageDataset,
  window: UsageWindow,
  generatedAt = window.until,
): UsageAnalyticsReport {
  const aggregation = { overflowed: false };
  const runsById = new Map(dataset.runs.map((run) => [run.callId, run]));
  const stepsByRun = groupBy(dataset.steps, (step) => step.callId);
  const toolsByRun = groupBy(dataset.toolCalls, (tool) => tool.callId);
  const tokenTotals = {
    input: metricTotal(dataset.steps, (step) => step.inputTokens, aggregation),
    noCacheInput: metricTotal(
      dataset.steps,
      (step) => step.noCacheInputTokens,
      aggregation,
    ),
    cacheReadInput: metricTotal(
      dataset.steps,
      (step) => step.cacheReadInputTokens,
      aggregation,
    ),
    cacheWriteInput: metricTotal(
      dataset.steps,
      (step) => step.cacheWriteInputTokens,
      aggregation,
    ),
    output: metricTotal(dataset.steps, (step) => step.outputTokens, aggregation),
    text: metricTotal(dataset.steps, (step) => step.textTokens, aggregation),
    reasoning: metricTotal(dataset.steps, (step) => step.reasoningTokens, aggregation),
    toolUse: metricTotal(dataset.steps, (step) => step.toolUseTokens, aggregation),
    total: metricTotal(dataset.steps, (step) => step.totalTokens, aggregation),
    providerTotal: metricTotal(
      dataset.steps,
      (step) => step.providerTotalTokens,
      aggregation,
    ),
  };
  const callsPerRun = dataset.runs.map(
    (run) => stepsByRun.get(run.callId)?.length ?? 0,
  );
  const toolsPerRun = dataset.runs.map(
    (run) => toolsByRun.get(run.callId)?.length ?? 0,
  );
  const toolOutcomes = emptyOutcomes();
  for (const tool of dataset.toolCalls) toolOutcomes[tool.outcome] += 1;
  const repeated = repeatedToolCalls(dataset.toolCalls);
  const completedRuns = countRuns(dataset.runs, 'completed');
  const successfulRuns = dataset.runs.filter(
    (run) => run.status === 'completed' && run.finalFinishReason === 'stop',
  ).length;
  const failedRuns = countRuns(dataset.runs, 'failed');
  const measuredRuns = successfulRuns + failedRuns;
  const failedAfterReturnedToolRuns = dataset.runs.filter((run) =>
    run.status === 'failed' &&
    toolsByRun.get(run.callId)?.some(
      (tool) =>
        tool.executionLocation === 'client' && tool.outcome === 'returned',
    )
  ).length;
  const inconsistentModelCalls = dataset.steps.filter(isInconsistentStep).length;
  const missingTokenUsageCalls = dataset.steps.filter(
    (step) => !hasAnyTokenUsage(step),
  ).length;
  const notes = [
    'One model call is one AI SDK model step. Provider HTTP retries are not visible.',
    'Provider tool results mean returned, not verified successful.',
    'Tool duration is cumulative work. It is not wall-clock duration.',
  ];
  if (dataset.truncated) {
    notes.push('The query excluded older runs because it reached the storage limit.');
  }
  if (inconsistentModelCalls > 0) {
    notes.push('Some token fields conflict. Seb kept the original values.');
  }
  if (failedAfterReturnedToolRuns > 0) {
    notes.push('One or more runs failed after a client tool returned.');
  }
  const report: UsageAnalyticsReport = {
    dataQuality: {
      inconsistentModelCalls,
      missingTokenUsageCalls,
      notes,
      overflowedAggregates: false,
      truncated: dataset.truncated,
    },
    generatedAt,
    grounding: aggregateGrounding(dataset.steps, aggregation),
    latency: {
      responseMs: distribution(durationValues(
        dataset.steps,
        (step) => step.responseTimeMs,
      )),
      stepMs: distribution(durationValues(dataset.steps, (step) => step.stepTimeMs)),
      timeToFirstOutputMs: distribution(
        durationValues(dataset.steps, (step) => step.timeToFirstOutputMs),
      ),
    },
    models: modelBreakdown(dataset.steps, aggregation),
    runs: {
      aborted: countRuns(dataset.runs, 'aborted'),
      agentKinds: countNames(dataset.runs, (run) => run.agentKind),
      completed: completedRuns,
      successfulRunRatePercent: measuredRuns === 0
        ? null
        : round(successfulRuns / measuredRuns * 100),
      durationMs: distribution(runDurations(dataset.runs)),
      errorKinds: countNames(
        dataset.runs.filter((run) => run.errorKind !== null),
        (run) => run.errorKind ?? 'unknown',
      ),
      failed: failedRuns,
      failedAfterReturnedToolRuns,
      modelCallsPerRun: distribution(callsPerRun),
      noModelCallRuns: callsPerRun.filter((count) => count === 0).length,
      noToolRuns: toolsPerRun.filter((count) => count === 0).length,
      unfinished: countRuns(dataset.runs, 'running'),
      surfaces: countNames(dataset.runs, (run) => run.surface),
      total: dataset.runs.length,
    },
    schemaVersion: 1,
    scope: window,
    source: 'seb-local-telemetry',
    steps: {
      finishReasons: countNames(dataset.steps, (step) => step.finishReason ?? 'unknown'),
      providers: countNames(dataset.steps, (step) => step.provider),
      serviceTiers: countNames(
        dataset.steps,
        (step) => step.serviceTier ?? 'not reported',
      ),
      providerTokensPerCall: distribution(
        tokenValues(dataset.steps, (step) => step.providerTotalTokens),
      ),
      sdkTokensPerCall: distribution(
        tokenValues(dataset.steps, (step) => step.totalTokens),
      ),
      total: dataset.steps.length,
    },
    tokens: {
      ...tokenTotals,
      ratios: {
        cacheReadInputPercent: pairedRatio(
          dataset.steps,
          (step) => step.cacheReadInputTokens,
          (step) => step.inputTokens,
          aggregation,
          100,
        ),
        cacheWriteInputPercent: pairedRatio(
          dataset.steps,
          (step) => step.cacheWriteInputTokens,
          (step) => step.inputTokens,
          aggregation,
          100,
        ),
        inputToOutput: pairedRatio(
          dataset.steps,
          (step) => step.inputTokens,
          (step) => step.outputTokens,
          aggregation,
        ),
        reasoningOutputPercent: pairedRatio(
          dataset.steps,
          (step) => step.reasoningTokens,
          (step) => step.outputTokens,
          aggregation,
          100,
        ),
        toolUseOfProviderTotalPercent: pairedRatio(
          dataset.steps,
          (step) => step.toolUseTokens,
          (step) => step.providerTotalTokens,
          aggregation,
          100,
        ),
      },
    },
    tools: {
      callsPerRun: distribution(toolsPerRun),
      clientCalls: dataset.toolCalls.filter(
        (tool) => tool.executionLocation === 'client',
      ).length,
      cumulativeClientDurationMs: durationTotal(
        dataset.toolCalls.filter((tool) => tool.executionLocation === 'client'),
        (tool) => tool.executionMs,
        aggregation,
      ),
      outcomes: toolOutcomes,
      providerCalls: dataset.toolCalls.filter(
        (tool) => tool.executionLocation === 'provider',
      ).length,
      repeatedCalls: repeated.calls,
      repeatedRunToolPairs: repeated.pairs,
      total: dataset.toolCalls.length,
      unique: new Set(dataset.toolCalls.map((tool) => tool.toolName)).size,
    },
    toolUsage: toolBreakdown(dataset.toolCalls),
    trend: dailyTrend(
      dataset.runs,
      dataset.steps,
      dataset.toolCalls,
      runsById,
      window.timeZone,
      aggregation,
    ),
  };
  report.dataQuality.overflowedAggregates = aggregation.overflowed;
  if (aggregation.overflowed) {
    notes.push(
      'One or more aggregate values exceeded the safe JSON number range. Seb reports those values as null.',
    );
  }
  return report;
}

export function summarizeUsage(report: UsageAnalyticsReport): UsageSummary {
  return {
    billing: {
      available: false,
      reason: 'Local Seb telemetry does not include account quota, credits, or billing.',
    },
    dataQuality: report.dataQuality,
    generatedAt: report.generatedAt,
    models: report.models,
    runs: report.runs,
    schemaVersion: 1,
    scope: report.scope,
    source: report.source,
    steps: {
      finishReasons: report.steps.finishReasons,
      total: report.steps.total,
    },
    tokens: report.tokens,
    tools: {
      clientCalls: report.tools.clientCalls,
      providerCalls: report.tools.providerCalls,
      total: report.tools.total,
    },
  };
}

export function formatUsageReport(report: UsageAnalyticsReport): string {
  const lines = [
    '## Seb-observed API usage',
    '',
    `- Range: ${formatWindow(report.scope)}`,
    `- Agent runs: ${report.runs.total} (${report.runs.completed} completed, ${report.runs.failed} failed, ${report.runs.aborted} cancelled, ${report.runs.unfinished} unfinished)`,
    `- Successful run rate: ${report.runs.successfulRunRatePercent === null ? 'not available' : formatPercent(report.runs.successfulRunRatePercent)}`,
    `- Model calls: ${report.steps.total}`,
    `- Input tokens: ${formatMetric(report.tokens.input)}`,
    `- Non-cached input tokens: ${formatMetric(report.tokens.noCacheInput)}`,
    `- Cache-read input tokens: ${formatMetric(report.tokens.cacheReadInput)}`,
    `- Cache-write input tokens: ${formatMetric(report.tokens.cacheWriteInput)}`,
    `- Output tokens: ${formatMetric(report.tokens.output)}`,
    `- Reasoning tokens: ${formatMetric(report.tokens.reasoning)}`,
    `- Provider tool-use tokens: ${formatMetric(report.tokens.toolUse)}`,
    `- AI SDK total tokens: ${formatMetric(report.tokens.total)}`,
    `- Provider total tokens: ${formatMetric(report.tokens.providerTotal)}`,
    `- Tool calls: ${report.tools.total} (${report.tools.clientCalls} client, ${report.tools.providerCalls} provider)`,
  ];
  if (report.runs.failedAfterReturnedToolRuns > 0) {
    lines.push(
      `- Runs that failed after a client tool returned: ${report.runs.failedAfterReturnedToolRuns}`,
    );
  }
  if (report.runs.errorKinds.length > 0) {
    lines.push(`- Error categories: ${formatNamedCounts(report.runs.errorKinds)}`);
  }
  if (report.tokens.ratios.cacheReadInputPercent.value !== null) {
    lines.push(
      `- Cache-read share: ${formatPercentMetric(report.tokens.ratios.cacheReadInputPercent)}`,
    );
  }
  if (report.models.length > 0) {
    lines.push(
      `- Models: ${report.models.map((model) => `${model.provider}/${model.model} (${model.calls})`).join(', ')}`,
    );
  }
  lines.push(
    '',
    'Seb stores identifiers, timestamps, numeric metrics, and bounded categories. It does not store prompts, answers, tool inputs, or tool results.',
    'These values cover only Seb calls stored on this device. They do not show account quota, credits, or billing totals.',
    'One model call is one AI SDK model step. Provider HTTP retries remain outside local coverage.',
  );
  if (report.dataQuality.truncated) {
    lines.push('The result is partial because the query reached the local storage limit.');
  }
  if (report.dataQuality.overflowedAggregates) {
    lines.push('One or more totals exceeded the safe JSON number range and appear as null.');
  }
  return `${lines.join('\n')}\n`;
}

export function formatStatsReport(report: UsageAnalyticsReport): string {
  const lines = [
    '## Seb usage analytics',
    '',
    `Range: ${formatWindow(report.scope)}`,
    '',
    '### Activity',
    '',
    `- Agent runs: ${report.runs.total}`,
    `- Run outcomes: ${report.runs.completed} completed, ${report.runs.failed} failed, ${report.runs.aborted} cancelled, ${report.runs.unfinished} unfinished`,
    `- Successful run rate: ${report.runs.successfulRunRatePercent === null ? 'not available' : formatPercent(report.runs.successfulRunRatePercent)}`,
    `- Error categories: ${formatNamedCounts(report.runs.errorKinds)}`,
    `- Runs that failed after a client tool returned: ${report.runs.failedAfterReturnedToolRuns}`,
    `- Model calls: ${report.steps.total}`,
    `- Model calls per run: ${formatDistribution(report.runs.modelCallsPerRun)}`,
    `- Agent run duration: ${formatDurationDistribution(report.runs.durationMs)}`,
    `- Runs without a model call: ${report.runs.noModelCallRuns}`,
    `- Surfaces: ${formatNamedCounts(report.runs.surfaces)}`,
    `- Agent kinds: ${formatNamedCounts(report.runs.agentKinds)}`,
    '',
    '### Tokens',
    '',
    metricRow('Input', report.tokens.input),
    metricRow('Non-cached input', report.tokens.noCacheInput),
    metricRow('Cache-read input', report.tokens.cacheReadInput),
    metricRow('Cache-write input', report.tokens.cacheWriteInput),
    metricRow('Output', report.tokens.output),
    metricRow('Text output', report.tokens.text),
    metricRow('Reasoning output', report.tokens.reasoning),
    metricRow('Provider tool use', report.tokens.toolUse),
    metricRow('AI SDK total', report.tokens.total),
    metricRow('Provider total', report.tokens.providerTotal),
    `- AI SDK tokens per model call: ${formatDistribution(report.steps.sdkTokensPerCall)}`,
    `- Provider tokens per model call: ${formatDistribution(report.steps.providerTokensPerCall)}`,
    `- Cache-read share of input: ${formatPercentMetric(report.tokens.ratios.cacheReadInputPercent)}`,
    `- Cache-write share of input: ${formatPercentMetric(report.tokens.ratios.cacheWriteInputPercent)}`,
    `- Reasoning share of output: ${formatPercentMetric(report.tokens.ratios.reasoningOutputPercent)}`,
    `- Provider tool-use share of provider total: ${formatPercentMetric(report.tokens.ratios.toolUseOfProviderTotalPercent)}`,
    `- Input to output ratio: ${formatRatioMetric(report.tokens.ratios.inputToOutput)}`,
    '',
    '### Latency',
    '',
    `- Model response: ${formatDurationDistribution(report.latency.responseMs)}`,
    `- Time to first output: ${formatDurationDistribution(report.latency.timeToFirstOutputMs)}`,
    `- Complete step: ${formatDurationDistribution(report.latency.stepMs)}`,
    '',
    '### Tool calls',
    '',
    `- Total: ${report.tools.total}`,
    `- Unique tools: ${report.tools.unique}`,
    `- Execution location: ${report.tools.clientCalls} client, ${report.tools.providerCalls} provider`,
    `- Outcomes: ${formatOutcomes(report.tools.outcomes)}`,
    `- Calls per run: ${formatDistribution(report.tools.callsPerRun)}`,
    `- Runs without a tool call: ${report.runs.noToolRuns}`,
    `- Repeated calls: ${report.tools.repeatedCalls} extra calls with the same tool name in one run, across ${report.tools.repeatedRunToolPairs} run and tool pairs`,
    `- Cumulative client duration: ${formatDurationMetric(report.tools.cumulativeClientDurationMs)}`,
  ];
  if (report.toolUsage.length > 0) {
    lines.push('', '| Tool | Calls | Location | Outcomes | Duration |', '| --- | ---: | --- | --- | --- |');
    for (const tool of report.toolUsage) {
      lines.push(
        `| ${escapeTable(tool.name)} | ${tool.calls} | ${tool.clientCalls} client, ${tool.providerCalls} provider | ${escapeTable(formatOutcomes(tool.outcomes))} | ${escapeTable(formatDurationDistribution(tool.duration))} |`,
      );
    }
  }
  lines.push('', '### Models and completion states', '');
  if (report.models.length === 0) {
    lines.push('- No model calls matched this range.');
  } else {
    for (const model of report.models) {
      lines.push(
        `- ${model.provider}/${model.model}: ${model.calls} calls, ${formatMetric(model.sdkTotalTokens)} AI SDK total tokens, ${formatMetric(model.providerTotalTokens)} provider total tokens`,
      );
    }
  }
  lines.push(
    `- Finish reasons: ${formatNamedCounts(report.steps.finishReasons)}`,
    `- Service tiers: ${formatNamedCounts(report.steps.serviceTiers)}`,
  );
  if (report.grounding.length > 0) {
    lines.push(`- Provider grounding operations: ${formatNamedCounts(report.grounding)}`);
  }
  if (report.trend.length > 0) {
    lines.push('', '### Daily trend', '', '| Date | Runs | Model calls | Tool calls | AI SDK total | Provider total |', '| --- | ---: | ---: | ---: | ---: | ---: |');
    for (const day of report.trend) {
      lines.push(
        `| ${day.date} | ${day.runs} | ${day.modelCalls} | ${day.toolCalls} | ${formatMetric(day.sdkTotalTokens)} | ${formatMetric(day.providerTotalTokens)} |`,
      );
    }
  }
  lines.push(
    '',
    '### Data quality and privacy',
    '',
    `- Calls with no token report: ${report.dataQuality.missingTokenUsageCalls}`,
    `- Calls with conflicting token fields: ${report.dataQuality.inconsistentModelCalls}`,
    `- Aggregate overflow detected: ${report.dataQuality.overflowedAggregates ? 'yes' : 'no'}`,
    `- Query truncated: ${report.dataQuality.truncated ? 'yes' : 'no'}`,
    '- Seb stores identifiers, timestamps, numeric metrics, and bounded categories.',
    '- Seb does not store prompts, answers, tool inputs, tool results, or raw errors.',
    '- Provider tool results mean returned, not verified successful.',
    '- Tool duration is cumulative work. Parallel calls can make it exceed wall time.',
    '- One model call is one AI SDK model step. Provider HTTP retries are not visible.',
    '- Local telemetry does not show account quota, credits, or billing totals.',
  );
  return `${lines.join('\n')}\n`;
}

function metricTotal(
  steps: readonly UsageStepRecord[],
  select: (step: UsageStepRecord) => number | null,
  aggregation: AggregationState,
): MetricTotal {
  const reported = tokenValues(steps, select);
  return {
    calls: steps.length,
    reported: reported.length,
    sum: reported.length === 0 ? null : safeAggregateSum(reported, aggregation),
  };
}

function pairedRatio(
  steps: readonly UsageStepRecord[],
  selectNumerator: (step: UsageStepRecord) => number | null,
  selectDenominator: (step: UsageStepRecord) => number | null,
  aggregation: AggregationState,
  scale = 1,
): RatioMetric {
  let numerator = 0n;
  let denominator = 0n;
  let reported = 0;
  for (const step of steps) {
    const numeratorValue = selectNumerator(step);
    const denominatorValue = selectDenominator(step);
    if (!isTokenCount(numeratorValue) || !isTokenCount(denominatorValue)) continue;
    numerator += BigInt(numeratorValue);
    denominator += BigInt(denominatorValue);
    reported += 1;
  }
  let value: number | null = null;
  if (reported > 0 && denominator !== 0n) {
    const scaled = numerator * BigInt(scale * 100);
    const quotient = scaled / denominator;
    const remainder = scaled % denominator;
    const hundredths = quotient + (remainder * 2n >= denominator ? 1n : 0n);
    if (hundredths <= BigInt(Number.MAX_SAFE_INTEGER)) {
      const candidate = Number(hundredths) / 100;
      if (BigInt(Math.round(candidate * 100)) === hundredths) {
        value = candidate;
      } else {
        aggregation.overflowed = true;
      }
    } else {
      aggregation.overflowed = true;
    }
  }
  return { calls: steps.length, reported, value };
}

function modelBreakdown(
  steps: readonly UsageStepRecord[],
  aggregation: AggregationState,
): ModelUsageBreakdown[] {
  const groups = groupBy(steps, (step) => `${step.provider}\u0000${step.modelId}`);
  return [...groups.values()]
    .map((group) => ({
      calls: group.length,
      inputTokens: metricTotal(group, (step) => step.inputTokens, aggregation),
      model: group[0]?.modelId ?? 'unknown',
      outputTokens: metricTotal(group, (step) => step.outputTokens, aggregation),
      provider: group[0]?.provider ?? 'unknown',
      providerTotalTokens: metricTotal(
        group,
        (step) => step.providerTotalTokens,
        aggregation,
      ),
      sdkTotalTokens: metricTotal(group, (step) => step.totalTokens, aggregation),
    }))
    .sort((left, right) => right.calls - left.calls ||
      `${left.provider}/${left.model}`.localeCompare(`${right.provider}/${right.model}`));
}

function toolBreakdown(tools: readonly UsageToolCallRecord[]): ToolUsageBreakdown[] {
  const groups = groupBy(tools, (tool) => tool.toolName);
  return [...groups.entries()]
    .map(([name, group]) => {
      const outcomes = emptyOutcomes();
      for (const tool of group) outcomes[tool.outcome] += 1;
      return {
        calls: group.length,
        clientCalls: group.filter((tool) => tool.executionLocation === 'client').length,
        duration: distribution(durationValues(group, (tool) => tool.executionMs)),
        name,
        outcomes,
        providerCalls: group.filter((tool) => tool.executionLocation === 'provider').length,
      };
    })
    .sort((left, right) => right.calls - left.calls || left.name.localeCompare(right.name));
}

function dailyTrend(
  runs: readonly UsageRunRecord[],
  steps: readonly UsageStepRecord[],
  tools: readonly UsageToolCallRecord[],
  runsById: ReadonlyMap<string, UsageRunRecord>,
  timeZone: string,
  aggregation: AggregationState,
): DailyUsageTrend[] {
  const days = new Map<string, DailyUsageTrend>();
  for (const run of runs) {
    const date = localDate(run.startedAt, timeZone);
    if (!date) continue;
    const entry = dayEntry(days, date);
    entry.runs += 1;
  }
  for (const step of steps) {
    const date = localDate(runsById.get(step.callId)?.startedAt, timeZone);
    if (!date) continue;
    const entry = dayEntry(days, date);
    entry.modelCalls += 1;
    addMetric(entry.sdkTotalTokens, step.totalTokens, aggregation);
    addMetric(entry.providerTotalTokens, step.providerTotalTokens, aggregation);
  }
  for (const tool of tools) {
    const date = localDate(runsById.get(tool.callId)?.startedAt, timeZone);
    if (!date) continue;
    dayEntry(days, date).toolCalls += 1;
  }
  return [...days.values()].sort((left, right) => left.date.localeCompare(right.date));
}

function dayEntry(days: Map<string, DailyUsageTrend>, date: string): DailyUsageTrend {
  const existing = days.get(date);
  if (existing) return existing;
  const created = {
    date,
    modelCalls: 0,
    providerTotalTokens: emptyMetric(),
    runs: 0,
    sdkTotalTokens: emptyMetric(),
    toolCalls: 0,
  };
  days.set(date, created);
  return created;
}

function localDate(value: string | undefined, timeZone: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      day: '2-digit',
      month: '2-digit',
      timeZone,
      year: 'numeric',
    }).formatToParts(date);
    const values = new Map(parts.map((part) => [part.type, part.value]));
    const year = values.get('year');
    const month = values.get('month');
    const day = values.get('day');
    return year && month && day ? `${year}-${month}-${day}` : null;
  } catch {
    return null;
  }
}

function aggregateGrounding(
  steps: readonly UsageStepRecord[],
  aggregation: AggregationState,
): NamedCount[] {
  const counts = new Map<string, number>();
  const overflowedNames = new Set<string>();
  for (const step of steps) {
    for (const [name, count] of Object.entries(step.groundingCounts ?? {})) {
      if (!isTokenCount(count) || overflowedNames.has(name)) continue;
      const next = safeAggregateAdd(counts.get(name) ?? 0, count);
      if (next === null) {
        aggregation.overflowed = true;
        overflowedNames.add(name);
        counts.delete(name);
      } else {
        counts.set(name, next);
      }
    }
  }
  return namedCounts(counts);
}

function repeatedToolCalls(tools: readonly UsageToolCallRecord[]): {
  calls: number;
  pairs: number;
} {
  const counts = new Map<string, number>();
  for (const tool of tools) {
    const key = `${tool.callId}\u0000${tool.toolName}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const repeated = [...counts.values()].filter((count) => count > 1);
  return {
    calls: sum(repeated.map((count) => count - 1)),
    pairs: repeated.length,
  };
}

function isInconsistentStep(step: UsageStepRecord): boolean {
  const inputTokens = step.inputTokens;
  const outputTokens = step.outputTokens;
  const reportedInputParts = [
    step.noCacheInputTokens,
    step.cacheReadInputTokens,
    step.cacheWriteInputTokens,
  ].filter(isTokenCount);
  if (
    step.totalTokens !== null &&
    inputTokens !== null &&
    outputTokens !== null &&
    step.totalTokens !== inputTokens + outputTokens
  ) return true;
  if (
    inputTokens !== null &&
    reportedInputParts.length === 3 &&
    inputTokens !== sum(reportedInputParts)
  ) return true;
  if (
    inputTokens !== null &&
    sum(reportedInputParts) > inputTokens
  ) return true;
  if (
    outputTokens !== null &&
    [step.textTokens, step.reasoningTokens]
      .some((value) => value !== null && value > outputTokens)
  ) return true;
  if (
    step.providerTotalTokens !== null &&
    step.toolUseTokens !== null &&
    step.toolUseTokens > step.providerTotalTokens
  ) return true;
  return outputTokens !== null &&
    step.textTokens !== null &&
    step.reasoningTokens !== null &&
    outputTokens !== step.textTokens + step.reasoningTokens;
}

function hasAnyTokenUsage(step: UsageStepRecord): boolean {
  return [
    step.cacheReadInputTokens,
    step.cacheWriteInputTokens,
    step.inputTokens,
    step.noCacheInputTokens,
    step.outputTokens,
    step.providerTotalTokens,
    step.reasoningTokens,
    step.textTokens,
    step.toolUseTokens,
    step.totalTokens,
  ].some(isTokenCount);
}

function distribution(input: readonly number[]): Distribution | null {
  const sorted = input.filter(isFiniteNumber).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  let average = 0;
  for (const [index, value] of sorted.entries()) {
    average += (value - average) / (index + 1);
  }
  return {
    average: round(average),
    max: round(sorted.at(-1) ?? 0),
    min: round(sorted[0] ?? 0),
    p50: round(quantile(sorted, 0.5)),
    p90: round(quantile(sorted, 0.9)),
    p95: round(quantile(sorted, 0.95)),
    samples: sorted.length,
  };
}

function quantile(sorted: readonly number[], probability: number): number {
  if (sorted.length === 1) return sorted[0] ?? 0;
  const index = (sorted.length - 1) * probability;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const lowerValue = sorted[lower] ?? 0;
  const upperValue = sorted[upper] ?? lowerValue;
  return lowerValue + (upperValue - lowerValue) * (index - lower);
}

function countNames<T>(input: readonly T[], select: (item: T) => string): NamedCount[] {
  const counts = new Map<string, number>();
  for (const item of input) {
    const name = select(item);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return namedCounts(counts);
}

function namedCounts(counts: ReadonlyMap<string, number>): NamedCount[] {
  return [...counts.entries()]
    .map(([name, count]) => ({ count, name }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
}

function groupBy<T>(
  input: readonly T[],
  select: (item: T) => string,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of input) {
    const key = select(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

function countRuns(runs: readonly UsageRunRecord[], status: UsageRunRecord['status']): number {
  return runs.filter((run) => run.status === status).length;
}

function runDurations(runs: readonly UsageRunRecord[]): number[] {
  return runs.flatMap((run) => {
    if (run.endedAt === null) return [];
    const started = Date.parse(run.startedAt);
    const ended = Date.parse(run.endedAt);
    const duration = ended - started;
    return isUsageDuration(duration) ? [duration] : [];
  });
}

function tokenValues<T>(
  input: readonly T[],
  select: (item: T) => number | null,
): number[] {
  return input.map(select).filter(isTokenCount);
}

function durationValues<T>(
  input: readonly T[],
  select: (item: T) => number | null,
): number[] {
  return input.map(select).filter(isUsageDuration);
}

function durationTotal<T>(
  input: readonly T[],
  select: (item: T) => number | null,
  aggregation: AggregationState,
): MetricTotal {
  const reported = durationValues(input, select);
  return {
    calls: input.length,
    reported: reported.length,
    sum: reported.length === 0 ? null : safeAggregateSum(reported, aggregation),
  };
}

function emptyMetric(): MetricTotal {
  return { calls: 0, reported: 0, sum: null };
}

function addMetric(
  metric: MetricTotal,
  value: number | null,
  aggregation: AggregationState,
): void {
  metric.calls += 1;
  if (!isTokenCount(value)) return;
  metric.reported += 1;
  if (metric.sum === null && metric.reported > 1) return;
  const next = safeAggregateAdd(metric.sum ?? 0, value);
  if (next === null) aggregation.overflowed = true;
  metric.sum = next;
}

interface AggregationState {
  overflowed: boolean;
}

function safeAggregateSum(
  input: readonly number[],
  aggregation: AggregationState,
): number | null {
  let total = 0;
  for (const value of input) {
    const next = safeAggregateAdd(total, value);
    if (next === null) {
      aggregation.overflowed = true;
      return null;
    }
    total = next;
  }
  return total;
}

function safeAggregateAdd(left: number, right: number): number | null {
  const value = left + right;
  return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER
    ? value
    : null;
}

function sum(input: readonly number[]): number {
  return input.reduce((total, value) => total + value, 0);
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function emptyOutcomes(): Record<UsageToolOutcome, number> {
  return {
    returned: 0,
    error: 0,
    invalid: 0,
    cancelled: 0,
    unresolved: 0,
  };
}

function isTokenCount(value: number | null): value is number {
  return value !== null &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_USAGE_TOKEN_COUNT;
}

function isUsageDuration(value: number | null): value is number {
  return value !== null &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_USAGE_DURATION_MS;
}

function isFiniteNumber(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function formatWindow(window: UsageWindow): string {
  if (window.name === 'session') return `current session through ${window.until}`;
  if (window.name === 'all') return 'all saved data (newest matching runs only)';
  return `${window.since ?? 'start'} through ${window.until} (${window.timeZone})`;
}

function formatMetric(metric: MetricTotal): string {
  if (metric.calls === 0) return 'none';
  if (metric.reported === 0) return 'not reported';
  if (metric.sum === null) {
    return `overflow across ${metric.reported.toLocaleString()} reported ` +
      `call${metric.reported === 1 ? '' : 's'}`;
  }
  const coverage = metric.reported === metric.calls
    ? ''
    : ` from ${metric.reported} of ${metric.calls} calls`;
  return `${metric.sum.toLocaleString()}${coverage}`;
}

function metricRow(name: string, metric: MetricTotal): string {
  return `- ${name}: ${formatMetric(metric)}`;
}

function formatDistribution(value: Distribution | null): string {
  if (!value) return 'not available';
  return `average ${formatNumber(value.average)}, p50 ${formatNumber(value.p50)}, p90 ${formatNumber(value.p90)}, p95 ${formatNumber(value.p95)}, max ${formatNumber(value.max)} (n=${value.samples})`;
}

function formatDurationDistribution(value: Distribution | null): string {
  if (!value) return 'not available';
  return `average ${formatDuration(value.average)}, p50 ${formatDuration(value.p50)}, p90 ${formatDuration(value.p90)}, p95 ${formatDuration(value.p95)}, max ${formatDuration(value.max)} (n=${value.samples})`;
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return `${formatNumber(milliseconds)} ms`;
  return `${formatNumber(milliseconds / 1_000)} s`;
}

function formatDurationMetric(metric: MetricTotal): string {
  if (metric.calls === 0) return 'none';
  if (metric.reported === 0) return 'not reported';
  if (metric.sum === null) {
    return `overflow across ${metric.reported.toLocaleString()} reported ` +
      `call${metric.reported === 1 ? '' : 's'}`;
  }
  const coverage = metric.reported === metric.calls
    ? ''
    : ` from ${metric.reported} of ${metric.calls} calls`;
  return `${formatDuration(metric.sum)}${coverage}`;
}

function formatOutcomes(outcomes: Record<UsageToolOutcome, number>): string {
  const present = TOOL_OUTCOMES
    .filter((outcome) => outcomes[outcome] > 0)
    .map((outcome) => `${outcome} ${outcomes[outcome]}`);
  return present.length > 0 ? present.join(', ') : 'none';
}

function formatNamedCounts(values_: readonly NamedCount[]): string {
  return values_.length === 0
    ? 'none'
    : values_.map((value) => `${value.name} ${value.count}`).join(', ');
}

function formatPercentMetric(metric: RatioMetric): string {
  const value = metric.value === null ? 'not available' : formatPercent(metric.value);
  return `${value}${formatRatioCoverage(metric)}`;
}

function formatPercent(value: number): string {
  return `${formatNumber(value)}%`;
}

function formatRatioMetric(metric: RatioMetric): string {
  const value = metric.value === null ? 'not available' : `${formatNumber(metric.value)}:1`;
  return `${value}${formatRatioCoverage(metric)}`;
}

function formatRatioCoverage(metric: RatioMetric): string {
  if (metric.calls === 0 || metric.reported === metric.calls) return '';
  return ` from ${metric.reported} of ${metric.calls} calls with both values`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? value.toLocaleString() : value.toLocaleString(undefined, {
    maximumFractionDigits: 2,
  });
}

function escapeTable(value: string): string {
  return value.replace(/\|/gu, '\\|').replace(/\r?\n/gu, ' ');
}
