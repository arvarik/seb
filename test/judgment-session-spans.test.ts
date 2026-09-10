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
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
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
});
