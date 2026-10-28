import { context, trace } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { generateText, stepCountIs, tool, type UIMessageChunk } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ provider: undefined as BasicTracerProvider | undefined }));

// Use real AI SDK telemetry and exported OpenTelemetry spans without cloud access.
vi.mock('judgeval', () => ({ Tracer: {
  init: async () => ({ projectId: 'test-project' }),
  getOTELTracer: () => fake.provider!.getTracer('test-judgment'),
  setSessionId: (value: string) => trace.getActiveSpan()!.setAttribute('judgment.session_id', value),
  setSpanKind: () => undefined,
  setInput: () => undefined,
  setOutput: () => undefined,
  setError: () => undefined,
  forceFlush: () => fake.provider!.forceFlush(),
  shutdown: () => fake.provider!.shutdown(),
} }));
vi.mock('ai', async (importOriginal) => ({
  ...await importOriginal<typeof import('ai')>(),
  registerTelemetry: vi.fn(),
}));

const usage = {
  inputTokens: { total: 10, noCache: 3, cacheRead: 5, cacheWrite: 2 },
  outputTokens: { total: 4, text: 4, reasoning: undefined },
};
let exporter: InMemorySpanExporter;
let module: typeof import('../src/ai/judgment.js');

beforeEach(async () => {
  vi.resetModules();
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  exporter = new InMemorySpanExporter();
  fake.provider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  module = await import('../src/ai/judgment.js');
  await module.configureJudgmentTracing({
    SEB_JUDGMENT_TRACING: 'true', JUDGMENT_API_KEY: 'test-key', JUDGMENT_ORG_ID: 'test-org',
  });
});

afterEach(async () => {
  await module.shutdownJudgmentTracing();
  context.disable();
  vi.restoreAllMocks();
});

async function runModelWithTool(): Promise<void> {
  const model = new MockLanguageModelV4({ doGenerate: [
    { content: [{ type: 'tool-call', toolCallId: 'lookup', toolName: 'lookup', input: '{}' }],
      finishReason: { unified: 'tool-calls', raw: undefined }, usage, warnings: [] },
    { content: [{ type: 'text', text: 'Done' }],
      finishReason: { unified: 'stop', raw: undefined }, usage, warnings: [] },
  ] });
  const result = await generateText({
    model, prompt: 'Run the lookup', stopWhen: stepCountIs(3),
    tools: { lookup: tool({ inputSchema: z.object({}), execute: async () => 'result' }) },
    telemetry: { isEnabled: true, integrations: [...module.judgmentTelemetry()] },
  });
  expect(result.text).toBe('Done');
}

function expectSessionOnEverySpan(rootName: string, sessionId: string): void {
  const all = exporter.getFinishedSpans();
  const root = all.find((span) => span.name === rootName)!;
  expect(root).toBeDefined();
  const spans = all.filter((span) => span.spanContext().traceId === root.spanContext().traceId);
  // Root, operation, two steps, two model calls, and a tool execution.
  expect(spans.length).toBeGreaterThanOrEqual(7);
  expect(spans.some((span) => span.name.includes('lookup'))).toBe(true);
  const chatSpans = spans.filter((span) => span.attributes['gen_ai.operation.name'] === 'chat');
  const stepSpans = spans.filter((span) => span.attributes['gen_ai.operation.name'] === 'agent_step');
  expect(chatSpans.length).toBeGreaterThanOrEqual(2);
  expect(stepSpans).toHaveLength(chatSpans.length);
  for (const span of chatSpans) {
    expect(span.attributes['ai.usage.inputTokenDetails.noCacheTokens']).toBe(3);
    expect(span.attributes['ai.usage.outputTokenDetails.textTokens']).toBe(4);
    expect(span.attributes['gen_ai.request.model']).toBeDefined();
    expect(span.attributes['gen_ai.input.messages']).toBeDefined();
    expect(span.attributes['gen_ai.output.messages']).toBeDefined();
  }
  for (const span of stepSpans) {
    expect(Object.keys(span.attributes).filter((key) => key.includes('.usage.'))).toEqual([]);
  }
  for (const span of spans) {
    expect(span.attributes['judgment.session_id'], span.name).toBe(sessionId);
  }
}

describe('Judgment session attributes on exported spans', () => {
  it('labels all operation, step, model, and tool spans without mixing concurrent sessions', async () => {
    await Promise.all(['first', 'second'].map((sessionId) => module.traceJudgmentOperation(
      { name: sessionId, sessionId, input: 'Question' }, runModelWithTool,
    )));
    expectSessionOnEverySpan('first', 'first');
    expectSessionOnEverySpan('second', 'second');
    await runModelWithTool();
    const unscoped = exporter.getFinishedSpans().filter((span) => span.attributes['judgment.session_id'] === undefined);
    expect(unscoped.length).toBeGreaterThanOrEqual(6);
  });

  it('preserves the session during delayed stream consumption and cancellation', async () => {
    const stream = await module.traceJudgmentStream(
      { name: 'stream', sessionId: 'stream-session', input: 'Question' },
      async () => new ReadableStream<UIMessageChunk>({
        async pull(controller) {
          await runModelWithTool();
          controller.enqueue({ type: 'text-delta', id: 'answer', delta: 'Done' });
        },
        async cancel() { await runModelWithTool(); },
      }, { highWaterMark: 0 }),
    );
    const reader = stream.getReader();
    expect((await reader.read()).value).toEqual({ type: 'text-delta', id: 'answer', delta: 'Done' });
    await reader.cancel();
    expectSessionOnEverySpan('stream', 'stream-session');
    expect(exporter.getFinishedSpans().every((span) => span.attributes['judgment.session_id'] === 'stream-session')).toBe(true);
  });

  it('keeps provider-executed tool spans inside parent chat timing and enriches grounded web sources', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: [{
        content: [
          {
            type: 'tool-call',
            toolCallId: 'code-1',
            toolName: 'code_execution',
            input: '{"code":"1+1"}',
            providerExecuted: true,
          },
          {
            type: 'tool-result',
            toolCallId: 'code-1',
            toolName: 'code_execution',
            result: { outcome: 'OUTCOME_OK', output: '2' },
          },
          {
            type: 'tool-call',
            toolCallId: 'search-1',
            toolName: 'server:GOOGLE_SEARCH_WEB',
            input: '{"queries":["Amon-Ra St. Brown Week 8 injury"]}',
            providerExecuted: true,
          },
          {
            type: 'tool-result',
            toolCallId: 'search-1',
            toolName: 'server:GOOGLE_SEARCH_WEB',
            result: { search_suggestions: '<style>.chip { color: #555; }</style><div>Widget</div>' },
          },
          {
            type: 'source',
            sourceType: 'url',
            id: 'src-1',
            url: 'https://www.nbcsports.com/nfl/amon-ra-update',
            title: 'St. Brown expected back at practice Thursday',
          },
          { type: 'text', text: 'Amon-Ra St. Brown is expected back Thursday.' },
        ],
        finishReason: { unified: 'stop', raw: undefined },
        providerMetadata: {
          google: {
            groundingMetadata: {
              webSearchQueries: ['Amon-Ra St. Brown Week 8 injury'],
              searchEntryPoint: {
                renderedContent: '<style>.container { display: flex; }</style><div>Search chip</div>',
              },
            },
          },
        },
        usage,
        warnings: [],
      }],
    });
    await module.traceJudgmentOperation(
      { name: 'grounded-search', sessionId: 'google-session', input: [{ role: 'user', content: 'St. Brown update?' }] },
      async () => {
        const res = await generateText({
          model,
          prompt: 'St. Brown update?',
          telemetry: { isEnabled: true, integrations: [...module.judgmentTelemetry()] },
        });
        expect(res.text).toContain('Amon-Ra');
      },
    );
    const spans = exporter.getFinishedSpans();
    const byId = new Map(spans.map((span) => [span.spanContext().spanId, span]));
    const toNs = ([sec, nano]: readonly [number, number]) => BigInt(sec) * 1_000_000_000n + BigInt(nano);
    for (const span of spans) {
      expect(toNs(span.endTime)).toBeGreaterThan(toNs(span.startTime));
      if (!span.parentSpanContext?.spanId) continue;
      const parent = byId.get(span.parentSpanContext.spanId);
      expect(parent, `parent for ${span.name}`).toBeDefined();
      expect(toNs(span.startTime), `${span.name} start >= ${parent!.name}`).toBeGreaterThanOrEqual(toNs(parent!.startTime));
      expect(toNs(span.endTime), `${span.name} end <= ${parent!.name}`).toBeLessThanOrEqual(toNs(parent!.endTime));
    }
    const searchSpan = spans.find((span) => span.name === 'execute_tool server:GOOGLE_SEARCH_WEB');
    expect(searchSpan).toBeDefined();
    const recordedOutput = String(searchSpan?.attributes['gen_ai.tool.call.result'] ?? '');
    expect(recordedOutput).toContain('https://www.nbcsports.com/nfl/amon-ra-update');
    expect(recordedOutput).toContain('webSearchQueries');
    expect(recordedOutput).not.toContain('<style>');
    expect(recordedOutput).not.toContain('searchEntryPoint');
    const codeSpan = spans.find((span) => span.name === 'execute_tool code_execution');
    expect(String(codeSpan?.attributes['gen_ai.tool.call.result'] ?? '')).not.toContain('webSearchQueries');
  });
});
