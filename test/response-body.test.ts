import { describe, expect, it } from 'vitest';

import {
  readResponseBytes,
  readResponseErrorDetail,
  readResponseJson,
  ResponseBodyLimitError,
} from '../src/data/response-body.js';

describe('bounded response readers', () => {
  it('reads a response under the byte limit', async () => {
    const response = new Response(JSON.stringify({ ok: true }));

    await expect(readResponseJson(response, 1024)).resolves.toEqual({ ok: true });
  });

  it('rejects a declared body that exceeds the byte limit', async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({
      cancel() {
        cancelled = true;
      },
    }), {
      headers: { 'content-length': '5000' },
    });

    await expect(readResponseBytes(response, 100)).rejects.toBeInstanceOf(
      ResponseBodyLimitError,
    );
    expect(cancelled).toBe(true);
  });

  it('rejects a declared oversized body when cancellation stays pending', async () => {
    const response = new Response(new ReadableStream({
      cancel() {
        return new Promise<void>(() => undefined);
      },
    }), {
      headers: { 'content-length': '5000' },
    });

    await expect(readResponseBytes(response, 100)).rejects.toBeInstanceOf(
      ResponseBodyLimitError,
    );
  });

  it('preserves the body limit error when streamed-body cancellation fails', async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(80));
      },
      cancel() {
        cancelled = true;
        throw new Error('stream cancellation failed');
      },
    }));

    await expect(readResponseBytes(response, 100)).rejects.toMatchObject({
      name: 'ResponseBodyLimitError',
      limitBytes: 100,
    } satisfies Partial<ResponseBodyLimitError>);
    expect(cancelled).toBe(true);
  });

  it('rejects a streamed oversized body when cancellation stays pending', async () => {
    const response = new Response(new ReadableStream({
      pull(controller) {
        controller.enqueue(new Uint8Array(101));
      },
      cancel() {
        return new Promise<void>(() => undefined);
      },
    }));

    await expect(readResponseBytes(response, 100)).rejects.toBeInstanceOf(
      ResponseBodyLimitError,
    );
  });

  it('returns bounded error detail when the response stream fails', async () => {
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.error(new Error('socket closed during the error response'));
      },
    }), { status: 503 });

    await expect(readResponseErrorDetail(response, 1_024)).resolves.toBe(
      'Response body unavailable: socket closed during the error response',
    );
  });
});
