import { describe, expect, it, vi } from 'vitest';

import { createModelSettings, type ModelSettingsStore, type SebModelSettings } from '../src/ai/model-settings.js';
import { createSetupCredentials, type SebSetupCredentials, type SetupCredentialStore } from '../src/setup/credentials.js';
import {
  discoverOpenAICompatibleModels,
  runModelConfigurationWizard,
} from '../src/setup/model-configuration.js';
import type { SetupPrompt, SetupPromptChoice, SetupTextPromptOptions } from '../src/setup/prompt.js';

class MemorySettingsStore implements ModelSettingsStore {
  readonly path = '/private/model-settings.json';
  saved: SebModelSettings | null;

  constructor(saved: SebModelSettings | null = null) {
    this.saved = saved;
  }

  async load(): Promise<SebModelSettings | null> {
    return this.saved;
  }

  async remove(): Promise<boolean> {
    const existed = this.saved !== null;
    this.saved = null;
    return existed;
  }

  async save(settings: SebModelSettings): Promise<void> {
    this.saved = settings;
  }
}

class MemoryCredentialStore implements SetupCredentialStore {
  readonly path = '/private/credentials.json';
  lockCalls = 0;
  saved: SebSetupCredentials | null;

  constructor(saved: SebSetupCredentials | null = null) {
    this.saved = saved;
  }

  async load(): Promise<SebSetupCredentials | null> {
    return this.saved;
  }

  async remove(): Promise<boolean> {
    const existed = this.saved !== null;
    this.saved = null;
    return existed;
  }

  async save(credentials: SebSetupCredentials): Promise<void> {
    this.saved = credentials;
  }

  async withConfigurationCommitLock<T>(commit: () => Promise<T>): Promise<T> {
    this.lockCalls += 1;
    return commit();
  }
}

class QueuePrompt implements SetupPrompt {
  readonly confirmations: string[] = [];
  readonly secrets: string[] = [];
  readonly selectRequests: Array<{
    choices: Array<{ label: string; value: string }>;
    message: string;
  }> = [];
  readonly textOptions: SetupTextPromptOptions[] = [];
  readonly textRequests: string[] = [];

  constructor(
    private readonly selected: string[],
    private readonly textValues: string[],
    private readonly confirmationValues: boolean[] = [],
  ) {}

  async confirm(message: string): Promise<boolean> {
    this.confirmations.push(message);
    return this.confirmationValues.shift() ?? true;
  }

  async select<T extends string>(
    message: string,
    choices: readonly SetupPromptChoice<T>[],
  ): Promise<T> {
    this.selectRequests.push({
      choices: choices.map((choice) => ({
        label: choice.label,
        value: choice.value,
      })),
      message,
    });
    const value = this.selected.shift();
    const choice = choices.find((item) => item.value === value);
    if (!choice) throw new Error(`Missing prompt choice: ${String(value)}`);
    return choice.value;
  }

  async text(
    message: string,
    options: SetupTextPromptOptions = {},
  ): Promise<string> {
    this.textRequests.push(message);
    this.textOptions.push({ ...options });
    if (options.secret) this.secrets.push(message);
    const value = this.textValues.shift();
    if (value === undefined) return options.defaultValue ?? '';
    return value || options.defaultValue || '';
  }
}

describe('runModelConfigurationWizard', () => {
  it('verifies exact resolved models but saves family names', async () => {
    const credentials = new MemoryCredentialStore();
    const settings = new MemorySettingsStore();
    const output: string[] = [];
    const verify = vi.fn(async (selection) => ({ fallbackUsed: false, model: selection.model }));
    const result = await runModelConfigurationWizard({
      credentialStore: credentials, settingsStore: settings, environment: {},
      prompt: new QueuePrompt(['google'], ['test-key', 'gemini-flash', 'gemini-flash-lite']),
      fetch: vi.fn(async () => Response.json({ models: [
        { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
      ] })),
      verify, write: (text) => output.push(text),
    });
    expect(verify.mock.calls[0]?.[0]).toMatchObject({ model: 'gemini-3.8-flash', fallbackModel: 'gemini-3.5-flash-lite' });
    expect(result.selection.model).toBe('gemini-3.8-flash');
    expect(settings.saved?.providers.google).toEqual({ model: 'gemini-flash', fallbackModel: 'gemini-flash-lite' });
    expect(output.join('')).toContain('gemini-flash → gemini-3.8-flash');
  });

  it('does not save credentials or settings when family discovery fails', async () => {
    const credentials = new MemoryCredentialStore();
    const settings = new MemorySettingsStore();
    const verify = vi.fn();
    await expect(runModelConfigurationWizard({
      credentialStore: credentials, settingsStore: settings, environment: {},
      prompt: new QueuePrompt(['google'], ['test-key', 'gemini-flash', 'gemini-flash']),
      fetch: vi.fn(async () => Response.json({ error: 'test-key' }, { status: 503 })), verify,
    })).rejects.toThrow('could not read');
    expect(verify).not.toHaveBeenCalled();
    expect(credentials.saved).toBeNull();
    expect(settings.saved).toBeNull();
  });

  it('tests and saves an OpenAI key separately from model settings', async () => {
    const credentials = new MemoryCredentialStore();
    const settings = new MemorySettingsStore();
    const prompt = new QueuePrompt(
      ['openai'],
      ['private-openai-key', 'gpt-test', 'gpt-test'],
    );
    const verify = vi.fn(async (selection) => ({
      fallbackUsed: false,
      model: selection.model,
    }));

    const result = await runModelConfigurationWizard({
      credentialStore: credentials,
      environment: {},
      now: () => new Date('2026-09-01T12:00:00.000Z'),
      prompt,
      settingsStore: settings,
      verify,
    });

    expect(prompt.secrets).toEqual(['OpenAI API key']);
    expect(credentials.saved?.keys).toEqual({ openai: 'private-openai-key' });
    expect(settings.saved?.providers.openai).toEqual({
      fallbackModel: 'gpt-test',
      model: 'gpt-test',
    });
    expect(JSON.stringify(settings.saved)).not.toContain('private-openai-key');
    expect(result.selection.provider).toBe('openai');
    expect(verify).toHaveBeenCalledOnce();
    expect(credentials.lockCalls).toBe(1);
  });

  it('uses environment credentials and models without copying the key', async () => {
    const credentials = new MemoryCredentialStore();
    const settings = new MemorySettingsStore();
    const prompt = new QueuePrompt(['anthropic'], [], [true]);

    const result = await runModelConfigurationWizard({
      credentialStore: credentials,
      environment: {
        ANTHROPIC_API_KEY: 'environment-only-key',
        ANTHROPIC_FALLBACK_MODEL: 'claude-environment-fallback',
        ANTHROPIC_MODEL: 'claude-environment-primary',
      },
      prompt,
      settingsStore: settings,
      verify: async (selection) => ({
        fallbackUsed: false,
        model: selection.model,
      }),
    });

    expect(result.selection).toMatchObject({
      apiKey: 'environment-only-key',
      fallbackModel: 'claude-environment-fallback',
      model: 'claude-environment-primary',
      provider: 'anthropic',
    });
    expect(credentials.saved).toBeNull();
    expect(JSON.stringify(settings.saved)).not.toContain('environment-only-key');
  });

  it('preserves both stores when provider verification fails', async () => {
    const oldSettings = createModelSettings('google', {
      google: { model: 'gemini-old' },
    });
    const oldCredentials = createSetupCredentials({ google: 'google-old-key' });
    const settings = new MemorySettingsStore(oldSettings);
    const credentials = new MemoryCredentialStore(oldCredentials);
    const prompt = new QueuePrompt(
      ['anthropic'],
      ['anthropic-new-key', 'claude-new', 'claude-new'],
    );

    await expect(runModelConfigurationWizard({
      credentialStore: credentials,
      environment: {},
      prompt,
      settingsStore: settings,
      verify: async () => {
        throw new Error('mock provider rejected the request');
      },
    })).rejects.toThrow('Anthropic could not complete the request');

    expect(settings.saved).toBe(oldSettings);
    expect(credentials.saved).toBe(oldCredentials);
  });

  it('restores the prior credentials when the settings write fails', async () => {
    const oldCredentials = createSetupCredentials({ google: 'google-old-key' });
    const credentials = new MemoryCredentialStore(oldCredentials);
    const settings: ModelSettingsStore = {
      path: '/private/model-settings.json',
      load: async () => null,
      remove: async () => false,
      save: async () => {
        throw new Error('mock settings write failed');
      },
    };
    const prompt = new QueuePrompt(
      ['anthropic'],
      ['anthropic-new-key', 'claude-new', 'claude-new'],
    );

    await expect(runModelConfigurationWizard({
      credentialStore: credentials,
      environment: {},
      prompt,
      settingsStore: settings,
      verify: async (selection) => ({
        fallbackUsed: false,
        model: selection.model,
      }),
    })).rejects.toThrow('mock settings write failed');

    expect(credentials.saved).toBe(oldCredentials);
  });

  it('discovers a local model and permits a keyless endpoint', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'qwen-local' }],
    }), { status: 200 }));
    const settings = new MemorySettingsStore();
    const credentials = new MemoryCredentialStore();
    const prompt = new QueuePrompt(
      ['openai-compatible', '!remove-compatible-key', 'qwen-local'],
      ['http://127.0.0.1:11434/v1', 'qwen-local'],
    );

    const result = await runModelConfigurationWizard({
      credentialStore: credentials,
      environment: {},
      fetch: fetchMock,
      prompt,
      settingsStore: settings,
      verify: async (selection) => ({
        fallbackUsed: false,
        model: selection.model,
      }),
    });

    expect(result.selection).toMatchObject({
      baseURL: 'http://127.0.0.1:11434/v1',
      model: 'qwen-local',
      provider: 'openai-compatible',
    });
    expect(credentials.saved).toBeNull();
    expect(prompt.textRequests[0]).toBe('OpenAI-compatible API base URL');
    expect(prompt.selectRequests[1]?.choices.map((choice) => choice.label)).toEqual([
      'Enter a key for this endpoint',
      'Use no key',
    ]);
    expect(prompt.secrets).toEqual([]);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/v1/models',
      expect.objectContaining({ redirect: 'error' }),
    );
  });

  it('requires approval before it sends data to a remote custom endpoint', async () => {
    const prompt = new QueuePrompt(
      ['openai-compatible'],
      ['https://models.example.com/v1'],
      [false],
    );

    await expect(runModelConfigurationWizard({
      credentialStore: new MemoryCredentialStore(),
      environment: {},
      prompt,
      settingsStore: new MemorySettingsStore(),
      verify: vi.fn(),
    })).rejects.toThrow('remote endpoint was not approved');
  });

  it('removes a saved key instead of sending it to another endpoint', async () => {
    const oldBaseURL = 'http://localhost:11434/v1';
    const newBaseURL = 'http://localhost:2244/v1';
    const credentials = new MemoryCredentialStore(createSetupCredentials(
      { 'openai-compatible': 'old-compatible-key' },
      undefined,
      oldBaseURL,
    ));
    const settings = new MemorySettingsStore(createModelSettings(
      'openai-compatible',
      {
        'openai-compatible': {
          baseURL: oldBaseURL,
          model: 'old-model',
        },
      },
    ));
    const prompt = new QueuePrompt(
      ['openai-compatible', '!remove-compatible-key', 'new-model'],
      ['new-model'],
    );
    const output: string[] = [];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'new-model' }],
    }), { status: 200 }));
    const verify = vi.fn(async (selection) => ({
      fallbackUsed: false,
      model: selection.model,
    }));

    const result = await runModelConfigurationWizard({
      credentialStore: credentials,
      environment: { OPENAI_COMPATIBLE_BASE_URL: newBaseURL },
      fetch: fetchMock,
      prompt,
      settingsStore: settings,
      verify,
      write: (text) => output.push(text),
    });

    expect(result.selection).not.toHaveProperty('apiKey');
    expect(verify.mock.calls[0]?.[0]).not.toHaveProperty('apiKey');
    expect(credentials.saved).toBeNull();
    expect(credentials.lockCalls).toBe(1);
    expect(settings.saved?.providers['openai-compatible']?.baseURL).toBe(
      newBaseURL,
    );
    expect(output.join('')).toContain('belongs to another endpoint');
    const fetchCalls = fetchMock.mock.calls as unknown as Array<
      [string, RequestInit]
    >;
    const fetchOptions = fetchCalls[0]?.[1];
    expect(fetchOptions?.headers).toBeUndefined();
  });

  it('removes a saved key from the same compatible endpoint', async () => {
    const baseURL = 'http://localhost:11434/v1';
    const credentials = new MemoryCredentialStore(createSetupCredentials(
      { 'openai-compatible': 'saved-compatible-key' },
      undefined,
      baseURL,
    ));
    const settings = new MemorySettingsStore(createModelSettings(
      'openai-compatible',
      {
        'openai-compatible': {
          baseURL,
          model: 'local-model',
        },
      },
    ));
    const prompt = new QueuePrompt(
      ['openai-compatible', '!remove-compatible-key', 'local-model'],
      [],
    );

    const result = await runModelConfigurationWizard({
      credentialStore: credentials,
      environment: {},
      fetch: async () => new Response(JSON.stringify({
        data: [{ id: 'local-model' }],
      }), { status: 200 }),
      prompt,
      settingsStore: settings,
      verify: async (selection) => ({
        fallbackUsed: false,
        model: selection.model,
      }),
    });

    expect(result.selection).not.toHaveProperty('apiKey');
    expect(credentials.saved).toBeNull();
    expect(prompt.selectRequests[1]?.choices.map((choice) => choice.label))
      .toEqual(['Keep saved key', 'Replace saved key', 'Use no key']);
    expect(prompt.secrets).toEqual([]);
  });

  it('replaces a saved compatible key without using it as a prompt default', async () => {
    const baseURL = 'http://localhost:11434/v1';
    const credentials = new MemoryCredentialStore(createSetupCredentials(
      { 'openai-compatible': 'old-compatible-key' },
      undefined,
      baseURL,
    ));
    const settings = new MemorySettingsStore(createModelSettings(
      'openai-compatible',
      {
        'openai-compatible': {
          baseURL,
          model: 'local-model',
        },
      },
    ));
    const prompt = new QueuePrompt(
      ['openai-compatible', '!replace-compatible-key', 'local-model'],
      ['', 'new-compatible-key'],
    );

    const result = await runModelConfigurationWizard({
      credentialStore: credentials,
      environment: {},
      fetch: async () => new Response(JSON.stringify({
        data: [{ id: 'local-model' }],
      }), { status: 200 }),
      prompt,
      settingsStore: settings,
      verify: async (selection) => ({
        fallbackUsed: false,
        model: selection.model,
      }),
    });

    expect(result.selection.apiKey).toBe('new-compatible-key');
    expect(credentials.saved).toMatchObject({
      compatibleBaseURL: baseURL,
      keys: { 'openai-compatible': 'new-compatible-key' },
    });
    expect(prompt.secrets).toEqual(['OpenAI-compatible endpoint API key']);
    expect(prompt.textOptions[1]).not.toHaveProperty('defaultValue');
  });

  it('rejects a provider choice that conflicts with an environment override', async () => {
    const verify = vi.fn();
    const prompt = new QueuePrompt(['openai'], []);

    await expect(runModelConfigurationWizard({
      credentialStore: new MemoryCredentialStore(),
      environment: {
        SEB_MODEL: 'anthropic:claude-environment',
        SEB_MODEL_PROVIDER: 'google',
        SEB_PROVIDER: 'openai',
      },
      prompt,
      settingsStore: new MemorySettingsStore(createModelSettings('openai', {
        openai: { model: 'gpt-saved' },
      })),
      verify,
    })).rejects.toThrow(
      'The environment selects Google Gemini through SEB_MODEL_PROVIDER',
    );

    expect(verify).not.toHaveBeenCalled();
    expect(prompt.secrets).toEqual([]);
  });

  it('uses a qualified environment model as an explicit provider override', async () => {
    await expect(runModelConfigurationWizard({
      credentialStore: new MemoryCredentialStore(),
      environment: { SEB_MODEL: 'openai:gpt-environment' },
      prompt: new QueuePrompt(['google'], []),
      settingsStore: new MemorySettingsStore(),
      verify: vi.fn(),
    })).rejects.toThrow(
      'The environment selects OpenAI through SEB_MODEL',
    );
  });

  it('rejects an invalid explicit environment provider', async () => {
    await expect(runModelConfigurationWizard({
      credentialStore: new MemoryCredentialStore(),
      environment: { SEB_MODEL_PROVIDER: 'unknown-provider' },
      prompt: new QueuePrompt([], []),
      settingsStore: new MemorySettingsStore(),
      verify: vi.fn(),
    })).rejects.toThrow('Unknown model provider: unknown-provider');
  });

  it('does not print raw model discovery errors', async () => {
    const privateValue = 'private-discovery-secret';
    const output: string[] = [];
    const prompt = new QueuePrompt(
      ['openai-compatible', '!remove-compatible-key'],
      ['http://127.0.0.1:11434/v1', 'manual-model', 'manual-model'],
    );

    await runModelConfigurationWizard({
      credentialStore: new MemoryCredentialStore(),
      environment: {},
      fetch: async () => {
        throw new Error(`The endpoint returned ${privateValue}.`);
      },
      prompt,
      settingsStore: new MemorySettingsStore(),
      verify: async (selection) => ({
        fallbackUsed: false,
        model: selection.model,
      }),
      write: (text) => output.push(text),
    });

    expect(output.join('')).toContain(
      'Seb could not read the endpoint model list. Enter the model ID manually.',
    );
    expect(output.join('')).not.toContain(privateValue);
  });
});

describe('discoverOpenAICompatibleModels', () => {
  it('sends the key only as an authorization header and filters invalid IDs', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [
        { id: 'model-b' },
        { id: '../unsafe' },
        { id: 'model-a' },
        { id: 'model-a' },
      ],
    }), { status: 200 }));

    await expect(discoverOpenAICompatibleModels({
      apiKey: 'private-key',
      baseURL: 'http://localhost:11434/v1',
      fetch: fetchMock,
    })).resolves.toEqual(['model-a', 'model-b']);

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:11434/v1/models',
      expect.objectContaining({
        headers: { Authorization: 'Bearer private-key' },
        redirect: 'error',
      }),
    );
    const calls = fetchMock.mock.calls as unknown as [[string]];
    expect(calls[0]?.[0]).not.toContain('private-key');
  });

  it('stops reading a chunked model list after 1 MiB', async () => {
    const largeChunk = new Uint8Array(600 * 1024);
    const fetchMock = vi.fn(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(largeChunk);
        controller.enqueue(largeChunk);
        controller.close();
      },
    }), { status: 200 }));

    await expect(discoverOpenAICompatibleModels({
      baseURL: 'http://localhost:11434/v1',
      fetch: fetchMock,
    })).rejects.toThrow('model list response exceeds 1 MiB');
  });
});
