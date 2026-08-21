import { describe, expect, it } from 'vitest';

import {
  readResponseBytes,
  readResponseJson,
  ResponseBodyLimitError,
} from '../src/data/response-body.js';

describe('bounded response readers', () => {
  it('reads a response under the byte limit', async () => {
    const response = new Response(JSON.stringify({ ok: true }));

    await expect(readResponseJson(response, 1024)).resolves.toEqual({ ok: true });
  });

  it('rejects a declared body that exceeds the byte limit', async () => {
    const response = new Response('large', {
      headers: { 'content-length': '5000' },
    });

    await expect(readResponseBytes(response, 100)).rejects.toBeInstanceOf(
      ResponseBodyLimitError,
    );
  });

  it('stops a streamed body after it crosses the byte limit', async () => {
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(80));
        controller.enqueue(new Uint8Array(80));
        controller.close();
      },
    }));

    await expect(readResponseBytes(response, 100)).rejects.toMatchObject({
      limitBytes: 100,
    });
  });
});
