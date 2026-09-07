import { describe, expect, it } from 'vitest';

import {
  configuredModelProviders,
  resolveLoadedModelProvider,
} from '../src/ai/model-configuration.js';
import { createModelSettings } from '../src/ai/model-settings.js';
import { createSetupCredentials } from '../src/setup/credentials.js';

describe('resolveLoadedModelProvider', () => {
  it('selects an explicit compatible endpoint before a saved active provider', () => {
    const selection = resolveLoadedModelProvider({
      baseURL: 'http://localhost:4321/v1', model: 'local-model',
      environment: { GOOGLE_GENERATIVE_AI_API_KEY: 'google-key' },
      settings: createModelSettings('google', { google: { model: 'google-model' } }),
    });
    expect(selection).toMatchObject({ provider: 'openai-compatible', baseURL: 'http://localhost:4321/v1', model: 'local-model' });
    expect(selection).not.toHaveProperty('apiKey');
  });

  it('rejects a custom endpoint paired with a different explicit provider', () => {
    expect(() => resolveLoadedModelProvider({
      baseURL: 'http://localhost:4321/v1', provider: 'google',
      environment: { GOOGLE_GENERATIVE_AI_API_KEY: 'google-key' },
    })).toThrow('custom base URL requires');
  });

  it('keeps Google as the first provider for an existing Gemini environment', () => {
    const selection = resolveLoadedModelProvider({
      environment: { GOOGLE_GENERATIVE_AI_API_KEY: 'google-key' },
    });

    expect(selection).toEqual({
      apiKey: 'google-key',
      fallbackModel: 'gemini-flash-lite',
      model: 'gemini-flash',
      provider: 'google',
    });
  });

  it('loads the active provider, model, fallback, and private key', () => {
    const selection = resolveLoadedModelProvider({
      credentials: createSetupCredentials({ openai: 'saved-openai-key' }),
      environment: {},
      settings: createModelSettings('openai', {
        openai: {
          fallbackModel: 'gpt-fallback',
          model: 'gpt-primary',
        },
      }),
    });

    expect(selection).toEqual({
      apiKey: 'saved-openai-key',
      fallbackModel: 'gpt-fallback',
      model: 'gpt-primary',
      provider: 'openai',
    });
  });

  it('gives environment options precedence over saved settings and keys', () => {
    const selection = resolveLoadedModelProvider({
      credentials: createSetupCredentials({ anthropic: 'saved-key' }),
      environment: {
        ANTHROPIC_API_KEY: 'environment-key',
        ANTHROPIC_FALLBACK_MODEL: 'environment-fallback',
        ANTHROPIC_MODEL: 'environment-model',
        SEB_MODEL_PROVIDER: 'anthropic',
      },
      settings: createModelSettings('anthropic', {
        anthropic: {
          fallbackModel: 'saved-fallback',
          model: 'saved-model',
        },
      }),
    });

    expect(selection).toMatchObject({
      apiKey: 'environment-key',
      fallbackModel: 'environment-fallback',
      model: 'environment-model',
      provider: 'anthropic',
    });
  });

  it('ignores a compatible endpoint when another provider is active', () => {
    const selection = resolveLoadedModelProvider({
      environment: {
        OPENAI_API_KEY: 'openai-key',
        OPENAI_COMPATIBLE_BASE_URL: 'http://localhost:11434/v1',
        SEB_MODEL_PROVIDER: 'openai',
      },
    });

    expect(selection.provider).toBe('openai');
    expect(selection).not.toHaveProperty('baseURL');
  });

  it('uses one command model without an unexpected fallback', () => {
    const selection = resolveLoadedModelProvider({
      credentials: createSetupCredentials({ openai: 'saved-key' }),
      environment: {},
      model: 'gpt-request',
      provider: 'openai',
      settings: createModelSettings('openai', {
        openai: {
          fallbackModel: 'saved-fallback',
          model: 'saved-model',
        },
      }),
    });

    expect(selection.model).toBe('gpt-request');
    expect(selection.fallbackModel).toBe('gpt-request');
  });

  it('supports a keyless local OpenAI-compatible endpoint', () => {
    const selection = resolveLoadedModelProvider({
      environment: {},
      settings: createModelSettings('openai-compatible', {
        'openai-compatible': {
          baseURL: 'http://127.0.0.1:11434/v1',
          model: 'llama-local',
        },
      }),
    });

    expect(selection).toEqual({
      baseURL: 'http://127.0.0.1:11434/v1',
      fallbackModel: 'llama-local',
      model: 'llama-local',
      provider: 'openai-compatible',
    });
  });

  it('uses a saved compatible key only with its canonical endpoint', () => {
    const selection = resolveLoadedModelProvider({
      credentials: createSetupCredentials(
        { 'openai-compatible': 'saved-compatible-key' },
        undefined,
        'http://localhost:11434/v1/',
      ),
      environment: {},
      settings: createModelSettings('openai-compatible', {
        'openai-compatible': {
          baseURL: 'http://localhost:11434/v1',
          model: 'local-model',
        },
      }),
    });

    expect(selection).toMatchObject({
      apiKey: 'saved-compatible-key',
      baseURL: 'http://localhost:11434/v1',
      provider: 'openai-compatible',
    });
  });

  it('does not send a saved compatible key to another endpoint', () => {
    const selection = resolveLoadedModelProvider({
      credentials: createSetupCredentials(
        { 'openai-compatible': 'saved-compatible-key' },
        undefined,
        'http://localhost:11434/v1',
      ),
      environment: {
        OPENAI_COMPATIBLE_BASE_URL: 'http://localhost:2244/v1',
        SEB_MODEL_PROVIDER: 'openai-compatible',
      },
      settings: createModelSettings('openai-compatible', {
        'openai-compatible': {
          baseURL: 'http://localhost:11434/v1',
          model: 'local-model',
        },
      }),
    });

    expect(selection).toMatchObject({
      baseURL: 'http://localhost:2244/v1',
      provider: 'openai-compatible',
    });
    expect(selection).not.toHaveProperty('apiKey');
  });

  it('keeps a saved compatible model ID literal', () => {
    const selection = resolveLoadedModelProvider({
      environment: {},
      settings: createModelSettings('openai-compatible', {
        'openai-compatible': {
          baseURL: 'http://127.0.0.1:11434/v1',
          model: 'openai:gpt-oss-20b',
        },
      }),
    });

    expect(selection).toMatchObject({
      fallbackModel: 'openai:gpt-oss-20b',
      model: 'openai:gpt-oss-20b',
      provider: 'openai-compatible',
    });
  });
});

describe('configuredModelProviders', () => {
  it('returns only providers that can make a model request', () => {
    const settings = createModelSettings('google', {
      anthropic: { model: 'claude-test' },
      google: { model: 'gemini-test' },
      'openai-compatible': {
        baseURL: 'http://localhost:11434/v1',
        model: 'local-test',
      },
    });
    const credentials = createSetupCredentials({ google: 'google-key' });

    expect(configuredModelProviders({
      credentials,
      environment: {},
      settings,
    })).toEqual(['google', 'openai-compatible']);
  });
});
