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
});
