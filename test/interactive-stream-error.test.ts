import { describe, expect, it } from 'vitest';
import { InvalidToolInputError, NoSuchToolError } from 'ai';
import { z } from 'zod';
import { SleeperApiError } from '../src/sleeper/client.js';
import { formatInteractiveStreamError } from '../src/interactive/stream-error.js';
import { ResearchDataError } from '../src/data/research-error.js';
import { NflverseApiError } from '../src/nflverse/client.js';
import { WeatherApiError } from '../src/weather/client.js';

const context = { providerLabel: 'Google Gemini' };
describe('interactive stream errors', () => {
  it.each([
    [new NoSuchToolError({ toolName: 'private-tool' }), 'unavailable tool'],
    [new InvalidToolInputError({ toolName: 'private-tool', toolInput: 'secret', cause: new Error('secret') }), 'invalid tool inputs'],
    [new SleeperApiError('private response', 404, 'https://private'), 'Sleeper could not find'],
    [new SleeperApiError('private response', 429, 'https://private'), 'Sleeper limited'],
    [new SleeperApiError('private response', 500, 'https://private'), 'Sleeper could not return'],
    [z.boolean().safeParse(null).error, 'unexpected format'],
    [new ResearchDataError('A matchup forecast needs at least two completed scores. Use projectPlayers for Week 1.'), 'Use projectPlayers'],
    [new ResearchDataError('nflverse found no completed games.'), 'no completed games'],
    [new NflverseApiError('secret', 404, 'https://private'), 'nflverse could not return'],
    [new WeatherApiError('secret', 503, 'https://private'), 'weather service'],
  ])('identifies a tool or source failure safely', (error, expected) => {
    const message = formatInteractiveStreamError(error, context);
    expect(message).toContain(expected);
    expect(message).not.toMatch(/Gemini|private|secret/u);
  });
  it('preserves provider-specific diagnostics for model errors', () => {
    expect(formatInteractiveStreamError({ code: 'invalid_request' }, context)).toContain('Google Gemini rejected');
  });
});
