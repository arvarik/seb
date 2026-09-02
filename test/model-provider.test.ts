import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_PROVIDER_MODELS,
  ModelProviderConfigurationError,
  createProviderLanguageModel,
  discoverConfiguredModelProviders,
  resolveModelProvider,
  resolveProviderApiKey,
  resolveVerifiedModelProvider,
  validateModelId,
  validateModelProviderApiKey,
  validateModelProviderId,
  validateOpenAICompatibleBaseURL,
} from '../src/ai/model-provider.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('model provider configuration', () => {
  it('keeps the existing Gemini defaults and environment names', () => {
    const selection = resolveModelProvider({
      environment: { GOOGLE_GENERATIVE_AI_API_KEY: 'google-key' },
    });

    expect(selection).toEqual({
      apiKey: 'google-key',
      fallbackModel: 'gemini-3.6-flash',
      model: 'gemini-3.7-flash',
      provider: 'google',
    });
    expect(DEFAULT_PROVIDER_MODELS.google).toEqual({
      fallbackModel: 'gemini-3.6-flash',
      model: 'gemini-3.7-flash',
    });
  });

  it('uses environment keys before saved credentials', () => {
    const credentials = {
      anthropic: 'saved-anthropic',
      google: 'saved-google',
      openai: 'saved-openai',
    };

    expect(resolveProviderApiKey(
      'openai',
      { OPENAI_API_KEY: 'environment-openai' },
      credentials,
    )).toBe('environment-openai');
    expect(resolveProviderApiKey('anthropic', {}, credentials)).toBe(
      'saved-anthropic',
    );
    expect(resolveProviderApiKey(
      'google',
      { GEMINI_API_KEY: 'gemini-alias' },
      credentials,
    )).toBe('gemini-alias');
    expect(resolveProviderApiKey(
      'openai',
      { OPENAI_API_KEY: ' \t ' },
      credentials,
    )).toBe('saved-openai');
  });

  it.each([
    ['google', 'GOOGLE_GENERATIVE_AI_API_KEY'],
    ['anthropic', 'ANTHROPIC_API_KEY'],
    ['openai', 'OPENAI_API_KEY'],
    ['openai-compatible', 'OPENAI_COMPATIBLE_API_KEY'],
  ] as const)('rejects unsafe %s environment and supplied keys', (provider, variable) => {
    const privateValue = 'private-key-value\n';
    for (const resolve of [
      () => resolveProviderApiKey(provider, { [variable]: privateValue }),
      () => resolveProviderApiKey(provider, {}, { [provider]: privateValue }),
    ]) {
      expect(resolve).toThrow('contains an invalid value');
      try {
        resolve();
      } catch (error) {
        expect(String(error)).not.toContain('private-key-value');
      }
    }
  });

  it('discovers configured providers in a stable order', () => {
    expect(discoverConfiguredModelProviders({
      credentials: { anthropic: 'saved-anthropic' },
      environment: {
        OPENAI_API_KEY: 'openai-key',
        OPENAI_COMPATIBLE_BASE_URL: 'http://localhost:1234/v1',
      },
    })).toEqual(['anthropic', 'openai', 'openai-compatible']);
  });

  it('resolves each direct provider and its provider-specific model values', () => {
    expect(resolveModelProvider({
      environment: {
        ANTHROPIC_API_KEY: 'anthropic-key',
        ANTHROPIC_FALLBACK_MODEL: 'claude-haiku-custom',
        ANTHROPIC_MODEL: 'claude-sonnet-custom',
        SEB_PROVIDER: 'anthropic',
      },
    })).toEqual({
      apiKey: 'anthropic-key',
      fallbackModel: 'claude-haiku-custom',
      model: 'claude-sonnet-custom',
      provider: 'anthropic',
    });

    expect(resolveModelProvider({
      environment: {
        OPENAI_API_KEY: 'openai-key',
        OPENAI_MODEL: 'gpt-custom',
        SEB_PROVIDER: 'openai',
      },
    })).toMatchObject({
      apiKey: 'openai-key',
      model: 'gpt-custom',
      provider: 'openai',
    });
  });

  it('prefers SEB_MODEL_PROVIDER and accepts the old provider alias', () => {
    expect(resolveModelProvider({
      environment: {
        ANTHROPIC_API_KEY: 'anthropic-key',
        OPENAI_API_KEY: 'openai-key',
        SEB_MODEL_PROVIDER: 'anthropic',
        SEB_PROVIDER: 'openai',
      },
    }).provider).toBe('anthropic');

    expect(resolveModelProvider({
      environment: {
        OPENAI_API_KEY: 'openai-key',
        SEB_PROVIDER: 'openai',
      },
    }).provider).toBe('openai');
  });

  it('supports a keyless local OpenAI-compatible endpoint', () => {
    const selection = resolveModelProvider({
      environment: {
        OPENAI_COMPATIBLE_BASE_URL: 'http://127.0.0.1:11434/v1/',
        OPENAI_COMPATIBLE_MODEL: 'llama3.2:latest',
        SEB_PROVIDER: 'openai-compatible',
      },
    });

    expect(selection).toEqual({
      baseURL: 'http://127.0.0.1:11434/v1',
      fallbackModel: 'llama3.2:latest',
      model: 'llama3.2:latest',
      provider: 'openai-compatible',
    });
  });

  it('keeps a full model ID literal for an explicit compatible provider', () => {
    const selection = resolveModelProvider({
      environment: {},
      baseURL: 'http://127.0.0.1:11434/v1',
      model: 'openai:gpt-oss-20b',
      provider: 'openai-compatible',
    });

    expect(selection).toMatchObject({
      fallbackModel: 'openai:gpt-oss-20b',
      model: 'openai:gpt-oss-20b',
      provider: 'openai-compatible',
    });
    expect(createProviderLanguageModel(selection).modelId).toBe(
      'openai:gpt-oss-20b',
    );
  });

  it('stops provider autodiscovery after the first configured provider', () => {
    expect(resolveModelProvider({
      environment: {
        GOOGLE_GENERATIVE_AI_API_KEY: 'google-key',
        OPENAI_COMPATIBLE_BASE_URL: 'https://models.example.com/v1?',
      },
    })).toMatchObject({
      model: 'gemini-3.7-flash',
      provider: 'google',
    });
  });

  it('accepts provider-qualified models and rejects provider conflicts', () => {
    expect(resolveModelProvider({
      credentials: { anthropic: 'anthropic-key' },
      environment: {},
      model: 'anthropic:claude-sonnet-5',
    })).toMatchObject({
      fallbackModel: 'claude-sonnet-5',
      model: 'claude-sonnet-5',
      provider: 'anthropic',
    });

    expect(() => resolveModelProvider({
      credentials: { google: 'google-key', openai: 'openai-key' },
      environment: {},
      model: 'openai:gpt-5.6-luna',
      provider: 'google',
    })).toThrow('selects openai, but the active provider is google');
  });

  it('uses an explicit model as its own fallback', () => {
    expect(resolveModelProvider({
      environment: { GOOGLE_GENERATIVE_AI_API_KEY: 'google-key' },
      model: 'gemini-custom',
    })).toMatchObject({
      fallbackModel: 'gemini-custom',
      model: 'gemini-custom',
    });
  });

  it('uses the fallback model that verification proved', () => {
    const selection = resolveModelProvider({
      environment: { GOOGLE_GENERATIVE_AI_API_KEY: 'google-key' },
    });

    expect(resolveVerifiedModelProvider(
      selection,
      selection.fallbackModel,
    )).toEqual({
      ...selection,
      fallbackModel: selection.fallbackModel,
      model: selection.fallbackModel,
    });
    expect(resolveVerifiedModelProvider(
      selection,
      selection.model,
    )).toEqual({
      ...selection,
      fallbackModel: selection.model,
      model: selection.model,
    });
    expect(() => resolveVerifiedModelProvider(
      selection,
      'unverified-model',
    )).toThrow('must equal the configured primary or fallback model');
  });

  it('rejects missing provider configuration without exposing credentials', () => {
    expect(() => resolveModelProvider({ environment: {} })).toThrow(
      ModelProviderConfigurationError,
    );
    expect(() => resolveModelProvider({
      credentials: { anthropic: 'private-value' },
      environment: { SEB_PROVIDER: 'openai' },
    })).toThrow('OpenAI needs OPENAI_API_KEY');

    try {
      resolveModelProvider({
        credentials: { anthropic: 'private-value' },
        environment: { SEB_PROVIDER: 'openai' },
      });
    } catch (error) {
      expect(String(error)).not.toContain('private-value');
    }
  });
});

describe('model provider validation', () => {
  it('rejects control characters and API keys over 16 KiB', () => {
    expect(validateModelProviderApiKey('  safe-key  ')).toBe('safe-key');
    for (const privateValue of [
      'private-value\r',
      'x'.repeat(16 * 1024 + 1),
    ]) {
      expect(() => validateModelProviderApiKey(privateValue)).toThrow(
        'contains an invalid value',
      );
      try {
        validateModelProviderApiKey(privateValue);
      } catch (error) {
        expect(String(error)).not.toContain(privateValue.slice(0, 32));
      }
    }
  });

  it('accepts model IDs used by hosted and local providers', () => {
    expect(validateModelId('gemini-3.7-flash')).toBe('gemini-3.7-flash');
    expect(validateModelId('meta-llama/Llama-3.3-70B-Instruct')).toBe(
      'meta-llama/Llama-3.3-70B-Instruct',
    );
    expect(validateModelId('llama3.2:latest')).toBe('llama3.2:latest');
  });

  it('rejects unsafe or ambiguous model IDs and provider IDs', () => {
    for (const value of ['', 'model with spaces', '../model', 'model?key=value']) {
      expect(() => validateModelId(value)).toThrow(
        ModelProviderConfigurationError,
      );
    }
    expect(() => validateModelProviderId('gemini')).toThrow(
      'Unknown model provider',
    );
  });

  it('normalizes safe local and HTTPS base URLs', () => {
    expect(validateOpenAICompatibleBaseURL(
      'http://localhost:1234/v1/',
    )).toBe('http://localhost:1234/v1');
    expect(validateOpenAICompatibleBaseURL(
      'https://models.example.com/openai/v1///',
    )).toBe('https://models.example.com/openai/v1');
  });

  it.each([
    'ftp://localhost/v1',
    'http://models.example.com/v1',
    'https://user:password@models.example.com/v1',
    'https://models.example.com/v1?api_key=secret',
    'http://localhost:1234/v1?',
    'http://localhost:1234/v1#',
    'http://localhost:1234/v1/chat/completions',
  ])('rejects an unsafe base URL: %s', (value) => {
    expect(() => validateOpenAICompatibleBaseURL(value)).toThrow(
      ModelProviderConfigurationError,
    );
  });
});

describe('AI SDK provider construction', () => {
  it.each([
    ['google', 'google-key', 'gemini-3.7-flash', 'google.generative-ai'],
    ['anthropic', 'anthropic-key', 'claude-sonnet-5', 'anthropic.messages'],
    ['openai', 'openai-key', 'gpt-5.6-luna', 'openai.responses'],
  ] as const)(
    'constructs the %s language model',
    (provider, apiKey, modelId, expectedProvider) => {
      const model = createProviderLanguageModel({
        apiKey,
        fallbackModel: modelId,
        model: modelId,
        provider,
      });

      expect(model.modelId).toBe(modelId);
      expect(model.provider).toBe(expectedProvider);
    },
  );

  it('constructs an OpenAI-compatible chat model without an API key', () => {
    const model = createProviderLanguageModel({
      baseURL: 'http://localhost:1234/v1',
      fallbackModel: 'local-model',
      model: 'local-model',
      provider: 'openai-compatible',
    });

    expect(model.modelId).toBe('local-model');
    expect(model.provider).toBe('openai-compatible.chat');
  });

  it('rejects redirects for OpenAI-compatible model requests', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const model = createProviderLanguageModel({
      baseURL: 'https://models.example.com/v1',
      fallbackModel: 'local-model',
      model: 'local-model',
      provider: 'openai-compatible',
    });
    const fetchRequest = (
      model as unknown as {
        config: { fetch: typeof globalThis.fetch };
      }
    ).config.fetch;

    await fetchRequest('https://models.example.com/v1/chat/completions', {
      method: 'POST',
      redirect: 'follow',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://models.example.com/v1/chat/completions',
      expect.objectContaining({ method: 'POST', redirect: 'error' }),
    );
  });

  it('rejects a fallback model from another provider', () => {
    const selection = resolveModelProvider({
      environment: { GOOGLE_GENERATIVE_AI_API_KEY: 'google-key' },
    });

    expect(() => createProviderLanguageModel(
      selection,
      'openai:gpt-5.6-luna',
    )).toThrow('selects openai, but the active provider is google');
  });
});
