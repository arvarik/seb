import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Telemetry, UIMessageChunk } from 'ai';

const fake = vi.hoisted(() => ({
  imports: 0,
  spans: [] as Array<{ name: string; end: ReturnType<typeof vi.fn>; setAttribute: ReturnType<typeof vi.fn> }>,
  init: vi.fn(),
  register: vi.fn(),
  setInput: vi.fn(),
  setOutput: vi.fn(),
  setError: vi.fn(),
  setSessionId: vi.fn(),
  setSpanKind: vi.fn(),
  forceFlush: vi.fn(),
  shutdown: vi.fn(),
  otelOptions: vi.fn(),
  stepEnd: vi.fn(),
  toolEnd: vi.fn(),
}));

vi.mock('judgeval', () => {
  fake.imports += 1;
  return { Tracer: {
    init: fake.init,
    getOTELTracer: () => ({
      startActiveSpan: (name: string, run: (span: unknown) => unknown) => {
        const span = { name, end: vi.fn(), setAttribute: vi.fn() };
        fake.spans.push(span);
        return run(span);
      },
    }),
    setInput: fake.setInput,
    setOutput: fake.setOutput,
    setError: fake.setError,
    setSessionId: fake.setSessionId,
    setSpanKind: fake.setSpanKind,
    forceFlush: fake.forceFlush,
    shutdown: fake.shutdown,
  } };
});

vi.mock('@ai-sdk/otel', () => ({
  OpenTelemetry: class {
    constructor(options: unknown) { fake.otelOptions(options); }
    onStepEnd(event: unknown) { fake.stepEnd(event); }
    onToolExecutionEnd(event: unknown) { fake.toolEnd(event); }
    onEnd() {}
  },
}));

vi.mock('ai', async (importOriginal) => ({
  ...await importOriginal<typeof import('ai')>(),
  registerTelemetry: fake.register,
}));

const enabled = {
  SEB_JUDGMENT_TRACING: 'true',
  JUDGMENT_API_KEY: 'test-key',
  JUDGMENT_ORG_ID: 'test-organization',
};
const options = { name: 'test.turn', sessionId: 'conversation-1', input: 'Question' };

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  fake.spans.length = 0;
  fake.init.mockResolvedValue({ projectId: 'test-project' });
  fake.forceFlush.mockResolvedValue(undefined);
  fake.shutdown.mockResolvedValue(undefined);
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
});

afterEach(() => { vi.restoreAllMocks(); });

describe('optional Judgment tracing', () => {
  it.each([undefined, '', 'false', '1', 'yes'])('does not load the SDK for flag %s', async (flag) => {
    const module = await import('../src/ai/judgment.js');
    const before = fake.imports;
    await module.configureJudgmentTracing({ ...enabled, SEB_JUDGMENT_TRACING: flag });
    const stream = new ReadableStream<UIMessageChunk>();
    expect(await module.traceJudgmentStream(options, async () => stream)).toBe(stream);
    expect(await module.traceJudgmentOperation(options, async () => 'answer')).toBe('answer');
    await module.shutdownJudgmentTracing();
    expect(fake.imports).toBe(before);
    expect(fake.init).not.toHaveBeenCalled();
    expect(fake.register).not.toHaveBeenCalled();
    expect(fake.shutdown).not.toHaveBeenCalled();
    expect(fake.spans).toHaveLength(0);
  });

  it('honors the monitoring kill switch before importing the SDK', async () => {
    const module = await import('../src/ai/judgment.js');
    await module.configureJudgmentTracing({ ...enabled, JUDGMENT_MONITORING: 'false' });
    expect(fake.init).not.toHaveBeenCalled();
    expect(module.judgmentTelemetry()).toEqual([]);
  });

  it('continues without tracing when credentials are missing', async () => {
    const module = await import('../src/ai/judgment.js');
    await module.configureJudgmentTracing({ SEB_JUDGMENT_TRACING: 'true' });
    expect(fake.init).not.toHaveBeenCalled();
    expect(module.judgmentTelemetry()).toEqual([]);
    expect(process.stderr.write).toHaveBeenCalledWith(expect.stringContaining('continues without tracing'));
  });

  it('initializes and registers once for concurrent startup calls', async () => {
    const module = await import('../src/ai/judgment.js');
    await Promise.all([
      module.configureJudgmentTracing(enabled),
      module.configureJudgmentTracing(enabled),
    ]);
    expect(fake.init).toHaveBeenCalledExactlyOnceWith({
      projectName: 'seb', apiKey: 'test-key', organizationId: 'test-organization',
    });
    expect(fake.otelOptions).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      usage: true,
    }));
    expect(fake.register).toHaveBeenCalledTimes(1);
    expect(module.judgmentTelemetry()).toHaveLength(1);
    await Promise.all([module.shutdownJudgmentTracing(), module.shutdownJudgmentTracing()]);
    expect(fake.shutdown).toHaveBeenCalledTimes(1);
  });

  it('does not expose a raw initialization error', async () => {
    fake.init.mockRejectedValueOnce(new Error('secret-test-key'));
    const module = await import('../src/ai/judgment.js');
    await module.configureJudgmentTracing(enabled);
    expect(module.judgmentTelemetry()).toEqual([]);
    expect(JSON.stringify(vi.mocked(process.stderr.write).mock.calls)).not.toContain('secret-test-key');
  });

  it('does not report tracing as enabled when the project is unavailable', async () => {
    fake.init.mockResolvedValueOnce({ projectId: null });
    const module = await import('../src/ai/judgment.js');
    await module.configureJudgmentTracing(enabled);
    expect(module.judgmentTelemetry()).toEqual([]);
    expect(fake.register).not.toHaveBeenCalled();
    expect(fake.shutdown).toHaveBeenCalledTimes(1);
  });

  it('keeps concurrent request outputs separate and flushes after each root ends', async () => {
    const module = await import('../src/ai/judgment.js');
    await module.configureJudgmentTracing(enabled);
    await Promise.all(['first', 'second'].map((answer) => module.traceJudgmentOperation(
      { ...options, name: answer },
      async () => {
        await Promise.resolve();
        module.appendJudgmentOutput(answer);
        return answer;
      },
    )));
    for (const span of fake.spans) {
      expect(fake.setOutput).toHaveBeenCalledWith(span.name, span);
      expect(span.end).toHaveBeenCalledTimes(1);
    }
    expect(fake.forceFlush).toHaveBeenCalledTimes(2);
    expect(fake.spans[0]!.end.mock.invocationCallOrder[0]).toBeLessThan(
      fake.forceFlush.mock.invocationCallOrder[0]!,
    );
    expect(fake.setSessionId).toHaveBeenCalledWith('conversation-1');
  });

  it('preserves the application error when export fails', async () => {
    const module = await import('../src/ai/judgment.js');
    await module.configureJudgmentTracing(enabled);
    fake.forceFlush.mockRejectedValueOnce(new Error('export failed'));
    const error = new Error('application failed');
    await expect(module.traceJudgmentOperation(options, async () => { throw error; })).rejects.toBe(error);
    expect(fake.setError).toHaveBeenCalledWith(expect.any(Error), fake.spans[0]);
    expect(fake.spans[0]!.end).toHaveBeenCalledTimes(1);
  });

  it('returns a stream before completion and records its final text', async () => {
    const module = await import('../src/ai/judgment.js');
    await module.configureJudgmentTracing(enabled);
    let source!: ReadableStreamDefaultController<UIMessageChunk>;
    const stream = await module.traceJudgmentStream(options, async () => new ReadableStream({
      start(controller) { source = controller; },
    }));
    expect(fake.spans[0]!.end).not.toHaveBeenCalled();
    const reader = stream.getReader();
    source.enqueue({ type: 'text-delta', id: 'text-1', delta: 'Answer' });
    expect((await reader.read()).value).toEqual({ type: 'text-delta', id: 'text-1', delta: 'Answer' });
    expect(fake.spans[0]!.end).not.toHaveBeenCalled();
    source.close();
    expect((await reader.read()).done).toBe(true);
    expect(fake.setOutput).toHaveBeenCalledWith('Answer', fake.spans[0]);
    expect(fake.spans[0]!.end).toHaveBeenCalledTimes(1);
  });

  it('waits for source cancellation before ending the root', async () => {
    const module = await import('../src/ai/judgment.js');
    await module.configureJudgmentTracing(enabled);
    let release!: () => void;
    const cancellation = new Promise<void>((resolve) => { release = resolve; });
    const cancel = vi.fn(() => cancellation);
    const stream = await module.traceJudgmentStream(options, async () => new ReadableStream({ cancel }));
    const stopped = stream.cancel('user stopped');
    expect(cancel).toHaveBeenCalledWith('user stopped');
    expect(fake.spans[0]!.end).not.toHaveBeenCalled();
    release();
    await stopped;
    expect(fake.setError).toHaveBeenCalledWith(expect.any(Error), fake.spans[0]);
    expect(fake.spans[0]!.end).toHaveBeenCalledTimes(1);
  });

  it('marks an error chunk without changing the chunk', async () => {
    const module = await import('../src/ai/judgment.js');
    await module.configureJudgmentTracing(enabled);
    const chunk: UIMessageChunk = { type: 'error', errorText: 'request failed' };
    const stream = await module.traceJudgmentStream(options, async () => new ReadableStream({
      start(controller) { controller.enqueue(chunk); controller.close(); },
    }));
    const reader = stream.getReader();
    expect((await reader.read()).value).toBe(chunk);
    await reader.read();
    expect(fake.setError).toHaveBeenCalledTimes(1);
  });

  it('marks returned tool failures without changing the application event', async () => {
    const module = await import('../src/ai/judgment.js');
    await module.configureJudgmentTracing(enabled);
    const event = {
      toolOutput: { type: 'tool-result', output: { error: 'no data' } },
    } as Parameters<NonNullable<Telemetry['onToolExecutionEnd']>>[0];
    await module.judgmentTelemetry()[0]!.onToolExecutionEnd!(event);
    expect(event.toolOutput.type).toBe('tool-result');
    expect(fake.toolEnd).toHaveBeenCalledWith(expect.objectContaining({
      toolOutput: expect.objectContaining({ type: 'tool-error', error: expect.any(Error) }),
    }));
  });

  it('strips step wrapper usage details without changing the application event', async () => {
    const module = await import('../src/ai/judgment.js');
    await module.configureJudgmentTracing(enabled);
    const proto = { get text() { return 'Done'; } };
    const event = Object.assign(Object.create(proto), {
      finishReason: 'stop',
      usage: {
        inputTokens: 10,
        inputTokenDetails: { noCacheTokens: 3, cacheReadTokens: 5, cacheWriteTokens: 2 },
        outputTokens: 4,
        outputTokenDetails: { textTokens: 4, reasoningTokens: undefined },
        totalTokens: 14,
      },
    }) as Parameters<NonNullable<Telemetry['onStepEnd']>>[0];
    await module.judgmentTelemetry()[0]!.onStepEnd!(event);
    expect(event.usage.inputTokenDetails.noCacheTokens).toBe(3);
    const forwarded = fake.stepEnd.mock.calls[0]![0] as typeof event;
    expect(forwarded.text).toBe('Done');
    expect(forwarded.usage.inputTokenDetails.noCacheTokens).toBeUndefined();
    expect(forwarded.usage.outputTokenDetails.textTokens).toBeUndefined();
  });

  it('attaches seb.version and custom span attributes on traced operations', async () => {
    const module = await import('../src/ai/judgment.js');
    const { SEB_VERSION } = await import('../src/version.js');
    await module.configureJudgmentTracing(enabled);
    await module.traceJudgmentOperation(
      {
        ...options,
        attributes: {
          'seb.connector.channel_id': 'C123',
          'seb.connector.platform': 'slack',
          'seb.connector.user_id': 'U456',
          unused: undefined,
        },
      },
      async () => 'ok',
    );
    expect(fake.spans[0]!.setAttribute).toHaveBeenCalledWith('seb.version', SEB_VERSION);
    expect(fake.spans[0]!.setAttribute).toHaveBeenCalledWith('seb.connector.platform', 'slack');
    expect(fake.spans[0]!.setAttribute).toHaveBeenCalledWith('seb.connector.channel_id', 'C123');
    expect(fake.spans[0]!.setAttribute).toHaveBeenCalledWith('seb.connector.user_id', 'U456');
    expect(fake.spans[0]!.setAttribute).not.toHaveBeenCalledWith('unused', undefined);
  });
});
