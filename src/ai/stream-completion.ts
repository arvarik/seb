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

export function assertModelCompleted(finishReason: unknown): void {
  if (finishReason !== 'stop') throw new IncompleteModelResponseError(finishReason);
}

/** Checks the final model event before consumers publish a buffered answer. */
export async function* observeCompletedModelStream<T>(
  stream: AsyncIterable<T>,
  abortSignal?: AbortSignal,
): AsyncIterable<T> {
  let finished = false;
  for await (const part of stream) {
    const event = part && typeof part === 'object'
      ? part as { type?: unknown; finishReason?: unknown; error?: unknown }
      : undefined;
    if (event?.type === 'error') throw event.error;
    if (event?.type === 'abort') {
      throw abortSignal?.reason ?? new DOMException('The model stream stopped.', 'AbortError');
    }
    if (event?.type === 'finish') {
      assertModelCompleted(event.finishReason);
      finished = true;
    }
    yield part;
  }
  abortSignal?.throwIfAborted();
  if (!finished) throw new IncompleteModelResponseError(undefined);
}
