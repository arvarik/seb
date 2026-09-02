import { describe, expect, it } from 'vitest';

import { createFantasyFootballAgent } from '../src/agent.js';
import type { ResolvedModelProvider } from '../src/ai/model-provider.js';

describe('createFantasyFootballAgent', () => {
  it('rejects an empty Gemini key', () => {
    expect(() => createFantasyFootballAgent({ apiKey: '   ' })).toThrow(
      'API key is empty',
    );
  });

  it.each([
    {
      apiKey: 'google-key',
      fallbackModel: 'gemini-fallback',
      model: 'gemini-model',
      provider: 'google',
    },
    {
      apiKey: 'anthropic-key',
      fallbackModel: 'claude-fallback',
      model: 'claude-model',
      provider: 'anthropic',
    },
    {
      apiKey: 'openai-key',
      fallbackModel: 'gpt-fallback',
      model: 'gpt-model',
      provider: 'openai',
    },
    {
      baseURL: 'http://localhost:11434/v1',
      fallbackModel: 'local-model',
      model: 'local-model',
      provider: 'openai-compatible',
    },
  ] satisfies readonly ResolvedModelProvider[])(
    'constructs a $provider agent from a resolved provider',
    (modelProvider) => {
      expect(() => createFantasyFootballAgent({ modelProvider })).not.toThrow();
    },
  );
});
