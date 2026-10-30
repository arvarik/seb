import { AsyncLocalStorage } from 'node:async_hooks';

import { registerTelemetry, type Telemetry, type UIMessageChunk } from 'ai';
import type { Tracer as JudgmentTracer } from 'judgeval';

import { SEB_VERSION } from '../version.js';

type TracerClass = typeof JudgmentTracer;
type Span = NonNullable<ReturnType<TracerClass['getCurrentSpan']>>;

interface TraceState {
  span: Span;
  sessionId: string;
  output: string;
  failure: string | undefined;
}

interface TraceOptions {
  attributes?: Record<string, string | number | boolean | undefined> | undefined;
  name: string;
  sessionId: string;
  input: unknown;
}

const currentTrace = new AsyncLocalStorage<TraceState>();
const MAX_OUTPUT_CHARACTERS = 128_000;
let initialization: Promise<void> | undefined;
let tracer: TracerClass | undefined;
let otelTracer: ReturnType<TracerClass['getOTELTracer']> | undefined;
let integration: Telemetry | undefined;
let shutdown: Promise<void> | undefined;

/** Call after loading the environment and before constructing agents. */
export async function configureJudgmentTracing(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (environment.SEB_JUDGMENT_TRACING?.trim().toLowerCase() !== 'true' ||
      environment.JUDGMENT_MONITORING?.trim().toLowerCase() === 'false') return;
  initialization ??= initialize(environment);
  await initialization;
}

async function initialize(environment: NodeJS.ProcessEnv): Promise<void> {
  if (!environment.JUDGMENT_API_KEY?.trim() || !environment.JUDGMENT_ORG_ID?.trim()) {
    warn('Tracing needs JUDGMENT_API_KEY and JUDGMENT_ORG_ID. Seb continues without tracing.');
    return;
  }
  try {
    // Dynamic imports keep the SDK and its side effects out of default startup.
    const { Tracer } = await import('judgeval');
    const { OpenTelemetry } = await import('@ai-sdk/otel');
    const configured = await Tracer.init({
      projectName: 'seb',
      apiKey: environment.JUDGMENT_API_KEY,
      organizationId: environment.JUDGMENT_ORG_ID,
    });
    tracer = Tracer;
    if (!configured.projectId) {
      warn('The seb project is unavailable. Seb continues without tracing.');
      await shutdownJudgmentTracing();
      return;
    }
    otelTracer = monotonicOtelTracer(Tracer.getOTELTracer());
    const telemetry = new OpenTelemetry({
      tracer: otelTracer,
      usage: true,
      enrichSpan: () => {
        const state = currentTrace.getStore();
        return state ? { 'judgment.session_id': state.sessionId } : undefined;
      },
    });
    if (typeof telemetry.onLanguageModelCallEnd === 'function') {
      const onModelEnd = telemetry.onLanguageModelCallEnd.bind(telemetry);
      telemetry.onLanguageModelCallEnd = (event) => {
        onModelEnd(enrichProviderExecutedToolOutputs(event));
      };
    }
    const onStepEnd = telemetry.onStepEnd.bind(telemetry);
    telemetry.onStepEnd = (event) => {
      // Child chat spans report LLM usage; step wrappers lack model/IO and would be misread as LLM spans.
      onStepEnd(Object.assign(Object.create(Object.getPrototypeOf(event)) as typeof event, event, {
        usage: {
          inputTokens: undefined,
          inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
          outputTokens: undefined,
          outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
          totalTokens: undefined,
        },
      }));
    };
    const onToolEnd = telemetry.onToolExecutionEnd.bind(telemetry);
    telemetry.onToolExecutionEnd = (event) => {
      const output = event.toolOutput;
      // Change only the telemetry event, never the result returned to the agent.
      if (output.type === 'tool-result' && returnedFailure(output.output)) {
        onToolEnd({ ...event, toolOutput: {
          ...output, type: 'tool-error', error: new Error('Tool returned a failure'),
        } });
      } else {
        onToolEnd(event);
      }
    };
    const onEnd = telemetry.onEnd.bind(telemetry);
    telemetry.onEnd = (event) => {
      onEnd(event);
      const state = currentTrace.getStore();
      if (!state || !('finishReason' in event)) return;
      const approval = 'content' in event && Array.isArray(event.content) &&
        event.content.some((part) => part.type === 'tool-approval-request');
      state.failure = event.finishReason === 'stop' || approval
        ? undefined
        : `Agent stopped with ${event.finishReason}`;
    };
    integration = telemetry;
    registerTelemetry(telemetry);
    warn('Tracing is enabled for project seb. Judgment receives prompts, answers, and tool data.');
  } catch {
    integration = undefined;
    warn('Tracing initialization failed. Seb continues without tracing.');
    await shutdownJudgmentTracing();
  }
}

export function judgmentTelemetry(): readonly Telemetry[] {
  return integration ? [integration] : [];
}

/** Record only text that the application sends to the user. */
export function appendJudgmentOutput(text: string): void {
  const state = currentTrace.getStore();
  if (state) state.output = (state.output + text).slice(0, MAX_OUTPUT_CHARACTERS);
}

export async function traceJudgmentOperation<T>(
  options: TraceOptions,
  run: () => Promise<T>,
): Promise<T> {
  if (!integration || !tracer) return run();
  const sdk = tracer;
  const activeTracer = otelTracer ?? sdk.getOTELTracer();
  return activeTracer.startActiveSpan(options.name, async (span) => {
    const state = startTrace(sdk, span, options);
    return currentTrace.run(state, async () => {
      try {
        return await run();
      } catch (error) {
        state.failure = 'The request failed or stopped';
        throw error;
      } finally {
        await endTrace(sdk, state);
      }
    });
  });
}

/** Return the stream immediately and end its root after consumption or cancellation. */
export async function traceJudgmentStream(
  options: TraceOptions,
  run: () => Promise<ReadableStream<UIMessageChunk>>,
): Promise<ReadableStream<UIMessageChunk>> {
  if (!integration || !tracer) return run();
  const sdk = tracer;
  const activeTracer = otelTracer ?? sdk.getOTELTracer();
  return activeTracer.startActiveSpan(options.name, async (span) => {
    const state = startTrace(sdk, span, options);
    return currentTrace.run(state, async () => {
      let reader: ReadableStreamDefaultReader<UIMessageChunk>;
      try {
        reader = (await run()).getReader();
      } catch (error) {
        state.failure = 'The request failed before streaming';
        await endTrace(sdk, state);
        throw error;
      }
      let ended = false;
      const finish = async () => {
        if (ended) return;
        ended = true;
        reader.releaseLock();
        await endTrace(sdk, state);
      };
      const inTrace = AsyncLocalStorage.snapshot();
      return new ReadableStream<UIMessageChunk>({
        pull: (controller) => inTrace(async () => {
          try {
            const result = await reader.read();
            if (ended) return;
            if (result.done) {
              await finish();
              controller.close();
              return;
            }
            const part = result.value;
            if (part.type === 'text-delta') {
              state.output = (state.output + part.delta).slice(0, MAX_OUTPUT_CHARACTERS);
            } else if (part.type === 'error' || part.type === 'abort') {
              state.failure = 'The response stream failed or stopped';
            }
            controller.enqueue(part);
          } catch (error) {
            if (ended) return;
            state.failure = 'The response stream failed';
            await finish();
            controller.error(error);
          }
        }),
        cancel: (reason) => inTrace(async () => {
          state.failure = 'The response stream was cancelled';
          try {
            await reader.cancel(reason);
          } finally {
            await finish();
          }
        }),
      }, { highWaterMark: 0 });
    });
  });
}

function startTrace(sdk: TracerClass, span: Span, options: TraceOptions): TraceState {
  sdk.setSpanKind('agent', span);
  sdk.setSessionId(options.sessionId);
  sdk.setInput(options.input, span);
  const setAttribute = (span as { setAttribute?: (key: string, value: string | number | boolean) => void }).setAttribute;
  if (typeof setAttribute === 'function') {
    setAttribute.call(span, 'seb.version', SEB_VERSION);
    if (options.attributes) {
      for (const [key, value] of Object.entries(options.attributes)) {
        if (value !== undefined) setAttribute.call(span, key, value);
      }
    }
  }
  return { span, sessionId: options.sessionId, output: '', failure: undefined };
}

async function endTrace(sdk: TracerClass, state: TraceState): Promise<void> {
  try {
    sdk.setOutput(state.output, state.span);
    if (state.failure) sdk.setError(new Error(state.failure), state.span);
    state.span.end();
    await sdk.forceFlush();
  } catch {
    warn('Trace export failed.');
  }
}

export async function shutdownJudgmentTracing(): Promise<void> {
  if (!tracer) return;
  integration = undefined;
  otelTracer = undefined;
  shutdown ??= tracer.shutdown().catch(() => { warn('Trace shutdown failed.'); });
  await shutdown;
}

const CLOCK_ORIGIN_MS = Date.now() - performance.now();
let lastMonotonicMs = 0;

function nextMonotonicEpochMs(minMs = 0): number {
  const next = Math.max(CLOCK_ORIGIN_MS + performance.now(), lastMonotonicMs + 0.001, minMs);
  lastMonotonicMs = next;
  return next;
}

function toEpochMs(input: unknown): number | undefined {
  if (typeof input === 'number' && Number.isFinite(input)) {
    return input < CLOCK_ORIGIN_MS / 2 ? CLOCK_ORIGIN_MS + input : input;
  }
  if (input instanceof Date) return input.getTime();
  if (Array.isArray(input) && input.length === 2 && typeof input[0] === 'number' && typeof input[1] === 'number') {
    return input[0] * 1_000 + input[1] / 1_000_000;
  }
  return undefined;
}

function wrapMonotonicSpanEnd(span: Span, startedAt: number): Span {
  const end = span.end.bind(span);
  let ended = false;
  span.end = (endTime?: Parameters<Span['end']>[0]) => {
    if (ended) {
      end(endTime);
      return;
    }
    ended = true;
    const explicitEnd = toEpochMs(endTime);
    end(nextMonotonicEpochMs(Math.max(startedAt + 0.001, explicitEnd ?? 0)));
  };
  return span;
}

function monotonicOtelTracer<T extends ReturnType<TracerClass['getOTELTracer']>>(base: T): T {
  if (typeof (base as { startSpan?: unknown }).startSpan !== 'function') return base;
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'startSpan') {
        return (name: string, options?: Record<string, unknown>, ctx?: unknown) => {
          const explicitStart = toEpochMs(options?.startTime);
          const startedAt = nextMonotonicEpochMs(explicitStart ?? 0);
          const span = (target.startSpan as (...args: unknown[]) => Span)(
            name,
            { ...options, startTime: startedAt },
            ctx,
          );
          return wrapMonotonicSpanEnd(span, startedAt);
        };
      }
      if (prop === 'startActiveSpan') {
        return (name: string, ...rest: unknown[]) => {
          const callback = rest.at(-1);
          if (typeof callback !== 'function') {
            return Reflect.apply(target.startActiveSpan, target, [name, ...rest]);
          }
          const rawOptions = rest.length >= 2 && rest[0] && typeof rest[0] === 'object'
            ? (rest[0] as Record<string, unknown>)
            : undefined;
          const startedAt = nextMonotonicEpochMs(toEpochMs(rawOptions?.startTime) ?? 0);
          const nextOptions = { ...rawOptions, startTime: startedAt };
          const wrapped = (span: Span) =>
            (callback as (span: Span) => unknown)(wrapMonotonicSpanEnd(span, startedAt));
          return rest.length >= 3
            ? (target.startActiveSpan as (...args: unknown[]) => unknown)(name, nextOptions, rest[1], wrapped)
            : (target.startActiveSpan as (...args: unknown[]) => unknown)(name, nextOptions, wrapped);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

function sanitizeGroundingMetadata(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  const entry = record.searchEntryPoint;
  if (
    entry &&
    typeof entry === 'object' &&
    typeof (entry as Record<string, unknown>).renderedContent === 'string' &&
    ((entry as Record<string, unknown>).renderedContent as string).includes('<style>')
  ) {
    const rest = { ...record };
    delete rest.searchEntryPoint;
    return rest;
  }
  return value;
}

function enrichProviderExecutedToolOutputs<
  T extends Parameters<NonNullable<Telemetry['onLanguageModelCallEnd']>>[0],
>(event: T): T {
  if (!Array.isArray(event.content)) return event;
  const searchToolIds = new Set<string>();
  const sources: Record<string, unknown>[] = [];
  for (const part of event.content) {
    if (part.type === 'tool-call' && part.providerExecuted && /search/iu.test(part.toolName)) {
      searchToolIds.add(part.toolCallId);
    } else if (part.type === 'source') {
      sources.push(part as unknown as Record<string, unknown>);
    }
  }
  if (searchToolIds.size === 0) return event;
  const googleMeta = event.providerMetadata && typeof event.providerMetadata === 'object'
    ? (event.providerMetadata as Record<string, unknown>).google
    : undefined;
  const groundingMetadata = sanitizeGroundingMetadata(
    googleMeta && typeof googleMeta === 'object'
      ? (googleMeta as Record<string, unknown>).groundingMetadata
      : undefined,
  );
  let changed = false;
  const content = event.content.map((part) => {
    if (part.type !== 'tool-result' || !searchToolIds.has(part.toolCallId)) return part;
    const raw: Record<string, unknown> = part.output && typeof part.output === 'object' && !Array.isArray(part.output)
      ? { ...(part.output as Record<string, unknown>) }
      : { result: part.output };
    const hadStyleWidget = typeof raw.search_suggestions === 'string' && raw.search_suggestions.includes('<style>');
    if (hadStyleWidget) delete raw.search_suggestions;
    if (!hadStyleWidget && sources.length === 0 && groundingMetadata === undefined) return part;
    changed = true;
    return {
      ...part,
      output: {
        ...raw,
        ...(sources.length > 0 ? { sources } : {}),
        ...(groundingMetadata !== undefined ? { groundingMetadata } : {}),
      },
    };
  });
  return changed
    ? Object.assign(Object.create(Object.getPrototypeOf(event)) as T, event, { content })
    : event;
}

function returnedFailure(output: unknown): boolean {
  if (!output || typeof output !== 'object') return false;
  const result = output as Record<string, unknown>;
  return Boolean(result.error) || result.success === false;
}

function warn(message: string): void {
  process.stderr.write(`Seb Judgment: ${message}\n`);
}
