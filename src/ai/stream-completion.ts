/** A model response ended without a complete answer. */
export class IncompleteModelResponseError extends Error {
  constructor(readonly finishReason: unknown) {
    super(finishReason === 'length'
      ? 'The model reached the output limit before it completed the answer. Ask a narrower question, then retry.'
      : finishReason === 'content-filter'
        ? 'The model stopped because of its content filter. Rephrase the question, then retry.'
        : 'The model stopped before it completed the answer. Retry the request.');
    this.name = 'IncompleteModelResponseError';
  }
}

export interface ModelCompletionOptions {
  phase?: 'step' | 'final';
  onPartial?: (warning: IncompleteModelResponseError) => void;
}

export function assertModelCompleted(finishReason: unknown, options: ModelCompletionOptions = {}): void {
  if (finishReason === 'stop' || (options.phase === 'step' && finishReason === 'tool-calls')) return;
  const error = new IncompleteModelResponseError(finishReason);
  if (options.onPartial && (finishReason === 'length' || finishReason === 'tool-calls')) {
    options.onPartial(error);
    return;
  }
  throw error;
}

/** Reject promptly on cancellation, even when the producer ignores its signal. */
export function waitForModelOperation<T>(pending: PromiseLike<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return Promise.resolve(pending);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason ?? new DOMException('The request stopped.', 'AbortError'));
    };
    if (signal.aborted) {
      void Promise.resolve(pending).catch(() => undefined);
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(pending).then(resolve, reject).finally(() => {
      signal.removeEventListener('abort', onAbort);
    }).catch(() => undefined);
  });
}

/** Intermediate step events do not prove that the final answer completed. */
export async function* observeCompletedModelStream<T>(
  stream: AsyncIterable<T>,
  abortSignal?: AbortSignal,
  options: Pick<ModelCompletionOptions, 'onPartial'> = {},
): AsyncIterable<T> {
  abortSignal?.throwIfAborted();
  const iterator = stream[Symbol.asyncIterator]();
  let finished = false;
  let exhausted = false;
  try {
    while (true) {
      abortSignal?.throwIfAborted();
      const next = await waitForModelOperation(iterator.next(), abortSignal);
      abortSignal?.throwIfAborted();
      if (next.done) { exhausted = true; break; }
      const part = next.value;
      const event = part && typeof part === 'object'
        ? part as { type?: unknown; finishReason?: unknown; error?: unknown }
        : undefined;
      if (event?.type === 'error') throw event.error;
      if (event?.type === 'abort') {
        throw abortSignal?.reason ?? new DOMException('The model stream stopped.', 'AbortError');
      }
      if (event?.type === 'finish') {
        assertModelCompleted(event.finishReason, options);
        finished = true;
      }
      yield part;
    }
    if (!finished) throw new IncompleteModelResponseError(undefined);
  } finally {
    // A blocked generator can also block return(). Observe cleanup without delaying cancellation.
    if (!exhausted && iterator.return) {
      try { void Promise.resolve(iterator.return()).catch(() => undefined); } catch { /* Preserve the original failure. */ }
    }
  }
}
