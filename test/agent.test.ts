import { describe, expect, it } from 'vitest';

import { createFantasyFootballAgent } from '../src/agent.js';

describe('createFantasyFootballAgent', () => {
  it('rejects an empty Gemini key', () => {
    expect(() => createFantasyFootballAgent({ apiKey: '   ' })).toThrow(
      'API key is empty',
    );
  });
});
