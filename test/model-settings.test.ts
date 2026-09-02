import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  stat,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createModelSettings,
  FileModelSettingsStore,
  formatModelSettings,
  MAX_MODEL_ID_LENGTH,
  MODEL_SETTINGS_SCHEMA_VERSION,
  ModelSettingsValidationError,
  removeProviderModelSettings,
  resolveModelSettingsPath,
  setActiveModelProvider,
  setProviderModelSettings,
  validateModelSettings,
} from '../src/ai/model-settings.js';

const temporaryDirectories: string[] = [];
const UPDATED_AT = '2026-09-01T12:00:00.000Z';

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('model settings validation', () => {
  it('accepts every provider and normalizes model values', () => {
    expect(validateModelSettings({
      activeProvider: 'google',
      providers: {
        anthropic: {
          fallbackModel: ' claude-fallback ',
          model: ' claude-primary ',
        },
        google: {
          fallbackModel: ' gemini-fallback ',
          model: ' gemini-primary ',
        },
        openai: { model: ' gpt-primary ' },
        'openai-compatible': {
          baseURL: ' http://localhost:11434/v1 ',
          model: ' local-primary ',
        },
      },
      schemaVersion: MODEL_SETTINGS_SCHEMA_VERSION,
      updatedAt: UPDATED_AT,
    })).toEqual({
      activeProvider: 'google',
      providers: {
        google: {
          fallbackModel: 'gemini-fallback',
          model: 'gemini-primary',
        },
        anthropic: {
          fallbackModel: 'claude-fallback',
          model: 'claude-primary',
        },
        openai: { model: 'gpt-primary' },
        'openai-compatible': {
          baseURL: 'http://localhost:11434/v1',
          model: 'local-primary',
        },
      },
      schemaVersion: MODEL_SETTINGS_SCHEMA_VERSION,
      updatedAt: UPDATED_AT,
    });
  });

  it('requires a strict supported active provider with saved settings', () => {
    for (const value of [
      null,
      settingsValue({ activeProvider: 'unsupported' }),
      settingsValue({ activeProvider: 'openai' }),
      settingsValue({ providers: [] }),
      settingsValue({ providers: { unsupported: { model: 'private-model' } } }),
      settingsValue({ extra: 'private-value' }),
      settingsValue({ schemaVersion: 2 }),
      settingsValue({ updatedAt: 'not-a-date' }),
    ]) {
      expect(() => validateModelSettings(value)).toThrow(
        ModelSettingsValidationError,
      );
    }
  });

  it('rejects blank, oversized, control-character, and unknown model fields', () => {
    const invalidProviders = [
      { google: { model: '' } },
      { google: { model: 'x'.repeat(MAX_MODEL_ID_LENGTH + 1) } },
      { google: { model: 'model\nsecond-line' } },
      { google: { fallbackModel: '', model: 'model' } },
      { google: { model: 42 } },
      { google: { apiKey: 'must-not-be-stored', model: 'model' } },
    ];

    for (const providers of invalidProviders) {
      expect(() => validateModelSettings(settingsValue({ providers }))).toThrow(
        ModelSettingsValidationError,
      );
    }
  });

  it('requires a compatible base URL and rejects it for other providers', () => {
    expect(() => validateModelSettings(settingsValue({
      activeProvider: 'openai-compatible',
      providers: { 'openai-compatible': { model: 'local-model' } },
    }))).toThrow('needs a base URL');

    expect(() => validateModelSettings(settingsValue({
      providers: {
        google: {
          baseURL: 'https://generativelanguage.googleapis.com',
          model: 'gemini-model',
        },
      },
    }))).toThrow('cannot contain a base URL');
  });

  it.each([
    'ftp://localhost/v1',
    'http://user@localhost/v1',
    'http://user:password@localhost/v1',
    'http://localhost/v1?token=value',
    'http://localhost/v1?',
    'http://localhost/v1#section',
    'http://localhost/v1#',
    'http://models.example.com/v1',
    'http://localhost/v1/chat/completions',
    '/v1',
    'not a URL',
  ])('rejects the unsafe compatible base URL %s', (baseURL) => {
    expect(() => validateModelSettings(settingsValue({
      activeProvider: 'openai-compatible',
      providers: {
        'openai-compatible': { baseURL, model: 'local-model' },
      },
    }))).toThrow(ModelSettingsValidationError);
  });
});

describe('model settings updates and formatting', () => {
  it('adds, selects, and removes provider settings with new timestamps', () => {
    const initial = createModelSettings(
      'google',
      { google: { model: 'gemini-model' } },
      new Date(UPDATED_AT),
    );
    const withOpenAi = setProviderModelSettings(
      initial,
      'openai',
      { fallbackModel: 'gpt-fallback', model: 'gpt-model' },
      new Date('2026-09-01T12:01:00.000Z'),
    );
    const activeOpenAi = setActiveModelProvider(
      withOpenAi,
      'openai',
      new Date('2026-09-01T12:02:00.000Z'),
    );
    const withoutGoogle = removeProviderModelSettings(
      activeOpenAi,
      'google',
      new Date('2026-09-01T12:03:00.000Z'),
    );

    expect(withoutGoogle).toEqual({
      activeProvider: 'openai',
      providers: {
        openai: { fallbackModel: 'gpt-fallback', model: 'gpt-model' },
      },
      schemaVersion: MODEL_SETTINGS_SCHEMA_VERSION,
      updatedAt: '2026-09-01T12:03:00.000Z',
    });
    expect(() => removeProviderModelSettings(
      withoutGoogle,
      'openai',
    )).toThrow('Select another active provider');
    expect(() => setActiveModelProvider(initial, 'anthropic')).toThrow(
      'active provider needs one saved model configuration',
    );
    expect(() => removeProviderModelSettings(
      initial,
      'unsupported' as never,
    )).toThrow('provider is not supported');
  });

  it('formats settings without accepting or printing secret fields', () => {
    const settings = createModelSettings('openai-compatible', {
      google: { model: 'gemini-model' },
      'openai-compatible': {
        baseURL: 'http://localhost:11434/v1',
        fallbackModel: 'local-fallback',
        model: 'local-model',
      },
    }, new Date(UPDATED_AT));

    const output = formatModelSettings(settings, '/private/config/model-settings.json');

    expect(output).toContain('Active provider: `openai-compatible`');
    expect(output).toContain('model `local-model`');
    expect(output).toContain('fallback `local-fallback`');
    expect(output).toContain('endpoint `http://localhost:11434/v1`');
    expect(output).toContain('stores no API keys');
    expect(output).not.toContain('Authorization');
  });
});

describe('file model settings store', () => {
  it('resolves an override or a file beside the setup profile', () => {
    expect(resolveModelSettingsPath(
      {
        SEB_MODEL_SETTINGS_FILE: '/tmp/seb-models/custom.json',
        SEB_PROFILE_FILE: '/tmp/ignored/profile.json',
      },
      '/unused',
    )).toBe('/tmp/seb-models/custom.json');
    expect(resolveModelSettingsPath(
      { SEB_PROFILE_FILE: '/tmp/seb-custom/account.json' },
      '/unused',
    )).toBe('/tmp/seb-custom/model-settings.json');
    expect(resolveModelSettingsPath(
      { SEB_CONFIG_HOME: '/tmp/seb-home' },
      '/unused',
    )).toBe('/tmp/seb-home/model-settings.json');
    expect(resolveModelSettingsPath(
      { XDG_CONFIG_HOME: '/tmp/xdg' },
      '/unused',
    )).toBe('/tmp/xdg/seb/model-settings.json');
    expect(resolveModelSettingsPath({}, '/tmp/home')).toBe(
      '/tmp/home/.config/seb/model-settings.json',
    );
  });

  it('uses an atomic private file and a private directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'seb-model-settings-test-'));
    temporaryDirectories.push(directory);
    await chmod(directory, 0o755);
    const configDirectory = join(directory, 'config');
    const path = join(configDirectory, 'model-settings.json');
    const store = new FileModelSettingsStore({ path });
    const settings = createModelSettings('google', {
      google: {
        fallbackModel: 'gemini-fallback',
        model: 'gemini-model',
      },
    }, new Date(UPDATED_AT));

    await store.save(settings);

    expect(await store.load()).toEqual(settings);
    expect(await readdir(configDirectory)).toEqual(['model-settings.json']);
    const content = await readFile(path, 'utf8');
    expect(content).not.toContain('apiKey');
    expect(content).not.toContain('Authorization');
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(configDirectory)).mode & 0o777).toBe(0o700);
    }
    expect(await store.remove()).toBe(true);
    expect(await store.remove()).toBe(false);
  });

  it('preserves permissions on an existing configuration directory', async () => {
    if (process.platform === 'win32') return;
    const directory = await mkdtemp(join(tmpdir(), 'seb-model-settings-mode-'));
    temporaryDirectories.push(directory);
    const configDirectory = join(directory, 'config');
    await mkdir(configDirectory, { mode: 0o750 });
    await chmod(configDirectory, 0o750);
    const store = new FileModelSettingsStore({
      path: join(configDirectory, 'model-settings.json'),
    });

    await store.save(createModelSettings('google', {
      google: { model: 'saved-model' },
    }));

    expect((await stat(configDirectory)).mode & 0o777).toBe(0o750);
    expect((await stat(store.path)).mode & 0o777).toBe(0o600);
  });

  it('rejects oversized and invalid files without returning their content', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'seb-model-settings-size-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'model-settings.json');
    const store = new FileModelSettingsStore({ path });
    const privateMarker = 'private-model-marker';

    await writeFile(path, `${privateMarker}${'x'.repeat(64 * 1024)}`);
    await expect(store.load()).rejects.toThrow('exceeds 64 KiB');
    await truncate(path, 8 * 1024 * 1024);
    await expect(store.load()).rejects.toThrow('exceeds 64 KiB');

    await writeFile(path, `{${JSON.stringify(privateMarker)}`);
    try {
      await store.load();
      throw new Error('Expected model settings loading to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(ModelSettingsValidationError);
      expect(String(error)).not.toContain(privateMarker);
    }
  });

  it('preserves saved settings when a replacement fails validation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'seb-model-settings-preserve-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'model-settings.json');
    const store = new FileModelSettingsStore({ path });
    const settings = createModelSettings(
      'google',
      { google: { model: 'saved-model' } },
      new Date(UPDATED_AT),
    );
    await store.save(settings);

    await expect(store.save({
      ...settings,
      providers: { google: { model: '' } },
    })).rejects.toThrow(ModelSettingsValidationError);

    expect(await store.load()).toEqual(settings);
  });
});

function settingsValue(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    activeProvider: 'google',
    providers: { google: { model: 'gemini-model' } },
    schemaVersion: MODEL_SETTINGS_SCHEMA_VERSION,
    updatedAt: UPDATED_AT,
    ...overrides,
  };
}
