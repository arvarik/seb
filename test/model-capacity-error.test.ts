import { describe, expect, it } from 'vitest';

import { isModelCapacityError } from '../src/model-capacity-error.js';

describe('isModelCapacityError', () => {
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

  it('does not classify authentication failures as capacity errors', () => {
    expect(isModelCapacityError({ statusCode: 401 })).toBe(false);
  });
});
