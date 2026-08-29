import { describe, expect, it } from 'vitest';

import { CircuitOpenError, ResilientFetch } from '../src/data/resilient-fetch.js';

describe('ResilientFetch', () => {
  it('retries temporary responses and honors Retry-After', async () => {
    let calls = 0;
    const delays: number[] = [];
    const client = new ResilientFetch({
      fetch: async () => {
        calls += 1;
        return calls === 1
          ? new Response('busy', { status: 429, headers: { 'retry-after': '2' } })
          : new Response('ok', { status: 200 });
      },
      policy: { maxRetryDelayMs: 5_000 },
      sleep: async (delay) => {
        delays.push(delay);
      },
    });

    const response = await client.request('https://example.test/data');

    expect(response.status).toBe(200);
    expect(calls).toBe(2);
    expect(delays).toEqual([2_000]);
  });

  it('opens the circuit after the configured number of failures', async () => {
    let now = 1_000;
    const client = new ResilientFetch({
      fetch: async () => {
        throw new Error('offline');
      },
      now: () => now,
      policy: {
        circuitBreakerCooldownMs: 10_000,
        circuitBreakerThreshold: 2,
        maxAttempts: 1,
      },
    });

    await expect(client.request('https://example.test')).rejects.toThrow('offline');
    await expect(client.request('https://example.test')).rejects.toThrow('offline');
    await expect(client.request('https://example.test')).rejects.toBeInstanceOf(
      CircuitOpenError,
    );
    now += 11_000;
    await expect(client.request('https://example.test')).rejects.toThrow('offline');
  });

  it('does not open the circuit after the caller aborts a request', async () => {
    let calls = 0;
    const client = new ResilientFetch({
      fetch: async (_input, init) => {
        calls += 1;
        if (calls > 1) return new Response('ok', { status: 200 });
        const signal = init?.signal;
        return await new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => reject(signal.reason),
            { once: true },
          );
        });
      },
      policy: {
        circuitBreakerThreshold: 1,
        maxAttempts: 1,
      },
    });
    const controller = new AbortController();
    const reason = new DOMException('The caller stopped the request.', 'AbortError');

    const pending = client.request('https://example.test/first', {
      signal: controller.signal,
    });
    const rejection = expect(pending).rejects.toBe(reason);
    controller.abort(reason);

    await rejection;
    expect(client.state()).toEqual({ consecutiveFailures: 0, openUntil: null });
    await expect(client.request('https://example.test/second')).resolves.toMatchObject({
      status: 200,
    });
    expect(calls).toBe(2);
  });

  it('stops a retry delay when the caller aborts', async () => {
    let calls = 0;
    let releaseSleep!: () => void;
    let markSleepStarted!: () => void;
    const sleepStarted = new Promise<void>((resolveStarted) => {
      markSleepStarted = resolveStarted;
    });
    const sleepGate = new Promise<void>((resolveSleep) => {
      releaseSleep = resolveSleep;
    });
    const client = new ResilientFetch({
      fetch: async () => {
        calls += 1;
        return new Response('busy', { status: 503 });
      },
      policy: {
        circuitBreakerThreshold: 1,
        maxAttempts: 2,
      },
      random: () => 1,
      sleep: async () => {
        markSleepStarted();
        await sleepGate;
      },
    });
    const controller = new AbortController();
    const reason = new DOMException('The caller stopped the retry.', 'AbortError');
    const pending = client.request('https://example.test/retry', {
      signal: controller.signal,
    });
    const rejection = expect(pending).rejects.toBe(reason);

    await sleepStarted;
    controller.abort(reason);
    await rejection;
    releaseSleep();

    expect(calls).toBe(1);
    expect(client.state()).toEqual({ consecutiveFailures: 0, openUntil: null });
  });

  it('observes a retry wait rejection after an attempt observer aborts', async () => {
    const controller = new AbortController();
    const reason = new DOMException('The observer stopped the retry.', 'AbortError');
    const client = new ResilientFetch({
      fetch: async () => new Response('busy', { status: 503 }),
      policy: { maxAttempts: 2 },
      sleep: async () => {
        throw new Error('The retry wait failed after cancellation.');
      },
    });

    const pending = client.request(
      'https://example.test/observer-abort',
      { signal: controller.signal },
      () => controller.abort(reason),
    );

    await expect(pending).rejects.toBe(reason);
    expect(client.state()).toEqual({ consecutiveFailures: 0, openUntil: null });
  });

  it('does not wait for response-body cancellation before caller cancellation', async () => {
    let markCancelStarted!: () => void;
    const cancelStarted = new Promise<void>((resolveStarted) => {
      markCancelStarted = resolveStarted;
    });
    const client = new ResilientFetch({
      fetch: async () => new Response(new ReadableStream({
        cancel() {
          markCancelStarted();
          return new Promise<void>(() => undefined);
        },
      }), { status: 503 }),
      policy: { maxAttempts: 2 },
      sleep: async () => await new Promise<void>(() => undefined),
    });
    const controller = new AbortController();
    const reason = new DOMException('The caller stopped the cleanup.', 'AbortError');
    const pending = client.request('https://example.test/hanging-cancel', {
      signal: controller.signal,
    });
    const rejection = expect(pending).rejects.toBe(reason);

    await cancelStarted;
    controller.abort(reason);

    await rejection;
    expect(client.state()).toEqual({ consecutiveFailures: 0, openUntil: null });
  });

  it('rejects when the caller aborts before fetch returns a response', async () => {
    const controller = new AbortController();
    const reason = new DOMException('The caller stopped the response.', 'AbortError');
    let cancelled = false;
    const client = new ResilientFetch({
      fetch: async () => {
        controller.abort(reason);
        return new Response(new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }), { status: 503 });
      },
      policy: {
        circuitBreakerThreshold: 1,
        maxAttempts: 1,
      },
    });

    await expect(client.request('https://example.test/late', {
      signal: controller.signal,
    })).rejects.toBe(reason);
    expect(client.state()).toEqual({ consecutiveFailures: 0, openUntil: null });
    expect(cancelled).toBe(true);
  });
});
