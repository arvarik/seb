import { getEventListeners } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { assertModelCompleted, observeCompletedModelStream, waitForModelOperation } from '../src/ai/stream-completion.js';

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const parts: T[] = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

describe('model stream completion', () => {
  it('accepts tool steps followed by a complete final answer', async () => {
    const parts = [{ type: 'finish-step', finishReason: 'tool-calls' },
      { type: 'text-delta', text: 'Final answer' }, { type: 'finish', finishReason: 'stop' }];
    await expect(collect(observeCompletedModelStream((async function* () { yield* parts; })()))).resolves.toEqual(parts);
    expect(() => assertModelCompleted('tool-calls', { phase: 'step' })).not.toThrow();
    expect(() => assertModelCompleted('tool-calls')).toThrow('stopped');
  });

  it.each(['length', 'tool-calls'])('reports an explicit partial warning for %s', async (finishReason) => {
    const warning = vi.fn();
    await collect(observeCompletedModelStream((async function* () {
      yield { type: 'finish', finishReason };
    })(), undefined, { onPartial: warning }));
    expect(warning).toHaveBeenCalledWith(expect.objectContaining({ finishReason }));
  });

  it.each(['content-filter', 'error', 'unknown', undefined])('rejects invalid final completion %s', (finishReason) => {
    expect(() => assertModelCompleted(finishReason, { onPartial: vi.fn() })).toThrow();
  });

  it('does not treat an intermediate step as final completion', async () => {
    await expect(collect(observeCompletedModelStream((async function* () {
      yield { type: 'finish-step', finishReason: 'tool-calls' };
    })()))).rejects.toThrow('stopped');
  });

  it('cancels stalled next and return calls without waiting for the producer', async () => {
    const controller = new AbortController();
    const cleanup = vi.fn(() => new Promise<IteratorResult<unknown>>(() => undefined));
    const iterator = { next: () => new Promise<IteratorResult<unknown>>(() => undefined), return: cleanup };
    const pending = collect(observeCompletedModelStream({ [Symbol.asyncIterator]: () => iterator }, controller.signal));
    const reason = new DOMException('Cancelled', 'AbortError');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('removes abort listeners after successful operations', async () => {
    const controller = new AbortController();
    await expect(waitForModelOperation(Promise.resolve(42), controller.signal)).resolves.toBe(42);
    await Promise.resolve();
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('does not read a pre-aborted stream', async () => {
    const controller = new AbortController(); controller.abort();
    const next = vi.fn();
    await expect(collect(observeCompletedModelStream({ [Symbol.asyncIterator]: () => ({ next }) }, controller.signal))).rejects.toThrow();
    expect(next).not.toHaveBeenCalled();
  });
});
