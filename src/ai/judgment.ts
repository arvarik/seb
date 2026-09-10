import { AsyncLocalStorage } from 'node:async_hooks';

import { registerTelemetry, type Telemetry, type UIMessageChunk } from 'ai';
import type { Tracer as JudgmentTracer } from 'judgeval';

type TracerClass = typeof JudgmentTracer;
type Span = NonNullable<ReturnType<TracerClass['getCurrentSpan']>>;

interface TraceState {
  span: Span;
  sessionId: string;
  output: string;
  failure: string | undefined;
}

interface TraceOptions {
  name: string;
  sessionId: string;
  input: unknown;
}

const currentTrace = new AsyncLocalStorage<TraceState>();
const MAX_OUTPUT_CHARACTERS = 128_000;
let initialization: Promise<void> | undefined;
let tracer: TracerClass | undefined;
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
    const telemetry = new OpenTelemetry({
      tracer: Tracer.getOTELTracer(),
      enrichSpan: () => {
        const state = currentTrace.getStore();
        return state ? { 'judgment.session_id': state.sessionId } : undefined;
      },
    });
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
  return sdk.getOTELTracer().startActiveSpan(options.name, async (span) => {
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
  return sdk.getOTELTracer().startActiveSpan(options.name, async (span) => {
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
  shutdown ??= tracer.shutdown().catch(() => { warn('Trace shutdown failed.'); });
  await shutdown;
}

function returnedFailure(output: unknown): boolean {
  if (!output || typeof output !== 'object') return false;
  const result = output as Record<string, unknown>;
  return Boolean(result.error) || result.success === false;
}

function warn(message: string): void {
  process.stderr.write(`Seb Judgment: ${message}\n`);
}
