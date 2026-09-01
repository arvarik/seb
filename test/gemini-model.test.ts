import { createGoogle } from '@ai-sdk/google';
import { describe, expect, it } from 'vitest';

import { createGeminiLanguageModel } from '../src/gemini-model.js';

describe('Gemini model selection', () => {
  it('uses the standard generateContent provider', () => {
    const provider = createGoogle({ apiKey: 'test-key' });
    const model = createGeminiLanguageModel(provider, 'gemini-test');

    expect(model.provider).toBe('google.generative-ai');
    expect(model.provider).not.toBe('google.generative-ai.interactions');
  });
});
