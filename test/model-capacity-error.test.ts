import { describe, expect, it } from 'vitest';

import {
  classifyModelError,
  formatModelErrorForUser,
  isModelCapacityError,
} from '../src/model-capacity-error.js';

describe('isModelCapacityError', () => {
  it.each(['AbortError', 'TimeoutError'])('does not retry %s with a capacity-error cause', (name) => {
    const error = Object.assign(new Error('Stopped after service unavailable'), {
      name, cause: { statusCode: 503 },
    });
    expect(isModelCapacityError(error)).toBe(false);
    expect(classifyModelError(error)).toBe(name === 'AbortError' ? 'cancelled' : 'timeout');
  });

  it('detects the Gemini high-demand message', () => {
    expect(
      isModelCapacityError(
        new Error('This model is currently experiencing high demand.'),
      ),
    ).toBe(true);
  });

  it('detects a nested HTTP 503 error', () => {
    expect(
      isModelCapacityError({
        message: 'The model call failed.',
        lastError: { statusCode: 503 },
      }),
    ).toBe(true);
  });

  it('detects a Gemini quota error and HTTP 429', () => {
    expect(isModelCapacityError(new Error('Quota exceeded for this model.'))).toBe(true);
    expect(isModelCapacityError({ statusCode: 429 })).toBe(true);
    expect(isModelCapacityError({ statusCode: '429' })).toBe(true);
    expect(isModelCapacityError({ status: '503' })).toBe(true);
  });

  it('does not classify authentication failures as capacity errors', () => {
    expect(isModelCapacityError({ statusCode: 401 })).toBe(false);
    expect(isModelCapacityError({
      message: 'Quota exceeded.',
      statusCode: 401,
    })).toBe(false);
  });
});

describe('model error presentation', () => {
  it('classifies the reported plain provider object', () => {
    const error = {
      code: 'invalid_request',
      message: 'Request contains an invalid argument.',
    };

    expect(classifyModelError(error)).toBe('invalid-request');
    expect(formatModelErrorForUser(error)).toContain('rejected the request as invalid');
  });

  it('classifies nested and string HTTP status values', () => {
    expect(classifyModelError({
      error: { data: { cause: { status: '400' } } },
    })).toBe('invalid-request');
    expect(classifyModelError({ cause: { statusCode: 401 } })).toBe(
      'authentication',
    );
  });

  it('separates provider HTTP timeouts from local request deadlines', () => {
    expect(classifyModelError({ status: 504 })).toBe('provider-timeout');
    expect(classifyModelError({
      message: 'Service unavailable',
      status: 504,
    })).toBe('provider-timeout');
    expect(classifyModelError({ statusCode: '408' })).toBe('provider-timeout');
    expect(classifyModelError(new DOMException('Deadline', 'TimeoutError'))).toBe(
      'timeout',
    );
  });

  it('gives commands that match the active surface', () => {
    const error = { code: 'invalid_request' };

    expect(formatModelErrorForUser(error, 'interactive')).toContain('/doctor');
    expect(formatModelErrorForUser(error, 'cli')).toContain('seb doctor');
    expect(formatModelErrorForUser(error, 'connector')).toContain(
      'connector service logs',
    );
  });

  it('does not call user cancellation a timeout', () => {
    const error = new DOMException('The user stopped the request.', 'AbortError');

    expect(classifyModelError(error)).toBe('cancelled');
    expect(formatModelErrorForUser(error)).toBe(
      'The request stopped before Gemini finished.',
    );
  });

  it('uses a provider label without exposing endpoint or credential values', () => {
    const message = formatModelErrorForUser(
      { status: 401, message: 'secret-key at http://private.test/v1' },
      'interactive',
      { credentialName: 'OPENAI_API_KEY', providerLabel: 'OpenAI' },
    );

    expect(message).toContain('OpenAI rejected OPENAI_API_KEY');
    expect(message).not.toContain('secret-key');
    expect(message).not.toContain('private.test');
  });

  it('describes keyless endpoint authentication without naming a missing key', () => {
    const message = formatModelErrorForUser(
      { status: 401 },
      'connector',
      { providerLabel: 'OpenAI-compatible endpoint' },
    );

    expect(message).toContain('rejected the authentication configuration');
    expect(message).toContain('endpoint authentication settings');
    expect(message).not.toContain('OPENAI_COMPATIBLE_API_KEY');
  });

  it('bounds recursive classification and never displays raw provider data', () => {
    const error: Record<string, unknown> = {
      code: 'invalid_request',
      message: 'secret prompt and credential',
    };
    error.cause = error;

    const message = formatModelErrorForUser(error);

    expect(classifyModelError(error)).toBe('invalid-request');
    expect(message).not.toContain('secret');
    expect(message).not.toContain('credential');
  });
});
