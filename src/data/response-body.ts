export class ResponseBodyLimitError extends Error {
  readonly limitBytes: number;

  constructor(limitBytes: number) {
    super(`The response body exceeds ${limitBytes} bytes.`);
    this.name = 'ResponseBodyLimitError';
    this.limitBytes = limitBytes;
  }
}

export async function readResponseBytes(
  response: Response,
  limitBytes: number,
): Promise<Buffer> {
  validateLimit(limitBytes);
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > limitBytes) {
    throw new ResponseBodyLimitError(limitBytes);
  }

  if (!response.body) {
    return Buffer.alloc(0);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > limitBytes) {
        await reader.cancel();
        throw new ResponseBodyLimitError(limitBytes);
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

export async function readResponseText(
  response: Response,
  limitBytes: number,
): Promise<string> {
  return (await readResponseBytes(response, limitBytes)).toString('utf8');
}

export async function readResponseJson(
  response: Response,
  limitBytes: number,
): Promise<unknown> {
  return JSON.parse(await readResponseText(response, limitBytes)) as unknown;
}

function validateLimit(limitBytes: number): void {
  if (!Number.isSafeInteger(limitBytes) || limitBytes < 1) {
    throw new RangeError('The response byte limit must be a positive safe integer.');
  }
}
