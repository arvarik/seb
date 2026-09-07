import { describe, expect, it } from 'vitest';
import { InvalidToolInputError, NoSuchToolError } from 'ai';
import { z } from 'zod';
import { SleeperApiError } from '../src/sleeper/client.js';
import { formatInteractiveStreamError } from '../src/interactive/stream-error.js';

const context = { providerLabel: 'Google Gemini' };
describe('interactive stream errors', () => {
  it.each([
    [new NoSuchToolError({ toolName: 'private-tool' }), 'unavailable tool'],
    [new InvalidToolInputError({ toolName: 'private-tool', toolInput: 'secret', cause: new Error('secret') }), 'invalid tool inputs'],
    [new SleeperApiError('private response', 404, 'https://private'), 'Sleeper could not find'],
    [new SleeperApiError('private response', 429, 'https://private'), 'Sleeper limited'],
    [new SleeperApiError('private response', 500, 'https://private'), 'Sleeper could not return'],
    [z.boolean().safeParse(null).error, 'unexpected format'],
  ])('identifies a tool or source failure safely', (error, expected) => {
    const message = formatInteractiveStreamError(error, context);
    expect(message).toContain(expected);
    expect(message).not.toMatch(/Gemini|private|secret/u);
  });
  it('preserves provider-specific diagnostics for model errors', () => {
    expect(formatInteractiveStreamError({ code: 'invalid_request' }, context)).toContain('Google Gemini rejected');
  });
});
