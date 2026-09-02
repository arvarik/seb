import { describe, expect, it } from 'vitest';

import {
  formatIgnoredLocalEnvironment,
  loadSafeLocalEnvironment,
} from '../src/local-environment.js';

describe('loadSafeLocalEnvironment', () => {
  it('keeps API keys but removes custom endpoint trust from a local file', () => {
    const environment: NodeJS.ProcessEnv = {};

    const ignored = loadSafeLocalEnvironment({
      environment,
      load: () => {
        environment.GOOGLE_GENERATIVE_AI_API_KEY = 'gemini-key';
        environment.OPENAI_COMPATIBLE_BASE_URL = 'https://attacker.example/v1';
        environment.SEB_HISTORY_FILE = '/tmp/untrusted-history.json';
        environment.SEB_MODEL = 'openai-compatible:attacker-model';
        environment.SEB_MODEL_PROVIDER = 'openai-compatible';
        environment.SEB_MODEL_SETTINGS_FILE = '/tmp/untrusted-settings.json';
        environment.SEB_PROFILE_FILE = '/tmp/untrusted-profile.json';
      },
    });

    expect(environment.GOOGLE_GENERATIVE_AI_API_KEY).toBe('gemini-key');
    expect(environment.OPENAI_COMPATIBLE_BASE_URL).toBeUndefined();
    expect(environment.SEB_HISTORY_FILE).toBeUndefined();
    expect(environment.SEB_MODEL).toBeUndefined();
    expect(environment.SEB_MODEL_SETTINGS_FILE).toBeUndefined();
    expect(environment.SEB_MODEL_PROVIDER).toBeUndefined();
    expect(environment.SEB_PROFILE_FILE).toBeUndefined();
    expect(ignored).toEqual([
      'OPENAI_COMPATIBLE_BASE_URL',
      'SEB_HISTORY_FILE',
      'SEB_MODEL',
      'SEB_MODEL_SETTINGS_FILE',
      'SEB_MODEL_PROVIDER',
      'SEB_PROFILE_FILE',
    ]);
  });

  it('keeps explicit shell values when the local file cannot replace them', () => {
    const environment: NodeJS.ProcessEnv = {
      OPENAI_COMPATIBLE_BASE_URL: 'https://trusted.example/v1',
      SEB_MODEL_PROVIDER: 'openai-compatible',
    };

    const ignored = loadSafeLocalEnvironment({
      environment,
      load: () => {},
    });

    expect(ignored).toEqual([]);
    expect(environment.OPENAI_COMPATIBLE_BASE_URL).toBe(
      'https://trusted.example/v1',
    );
  });

  it('formats one clear warning for ignored values', () => {
    expect(formatIgnoredLocalEnvironment(['SEB_PROVIDER'])).toBe(
      'Seb ignored SEB_PROVIDER from the current-directory .env file. Set these values in the shell or use seb configure.\n',
    );
    expect(formatIgnoredLocalEnvironment([])).toBeNull();
  });
});
