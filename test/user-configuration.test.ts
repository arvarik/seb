import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseCliArguments } from '../src/cli-options.js';
import { importUserEnvironment } from '../src/setup/configuration-editor.js';
import { createSetupCredentials } from '../src/setup/credentials.js';
import { createModelSettings } from '../src/ai/model-settings.js';
import { loadUserEnvironment, readEnvironmentImport, savedEnvironment, UserConfigurationStore } from '../src/setup/user-configuration.js';
import type { SetupPrompt } from '../src/setup/prompt.js';

describe('persistent user configuration', () => {
  let directory: string;
  let environment: NodeJS.ProcessEnv;
  let store: UserConfigurationStore;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'seb-settings-'));
    environment = { SEB_CONFIG_HOME: directory };
    store = new UserConfigurationStore(environment);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  it('saves Gemini and Judgment credentials privately and loads them independently of the launch directory', async () => {
    await store.save({ GOOGLE_GENERATIVE_AI_API_KEY: 'test-google-secret', JUDGMENT_API_KEY: 'test-judgment-secret',
      JUDGMENT_ORG_ID: '0c94b0c2-564b-4a5f-81d3-0363118f3bd4', SEB_JUDGMENT_TRACING: 'true' });
    const settings = await readFile(store.path, 'utf8');
    expect(settings).not.toContain('secret');
    expect((await stat(store.path)).mode & 0o777).toBe(0o600);
    expect((await stat(store.credentials.path)).mode & 0o777).toBe(0o600);
    const launched: NodeJS.ProcessEnv = { SEB_CONFIG_HOME: directory, PWD: '/another-directory' };
    await loadUserEnvironment(launched);
    expect(launched.GOOGLE_GENERATIVE_AI_API_KEY).toBe('test-google-secret');
    expect(launched.JUDGMENT_API_KEY).toBe('test-judgment-secret');
    expect(launched.SEB_JUDGMENT_TRACING).toBe('true');
    expect(launched.GEMINI_MODEL).toBe('gemini-flash');
  });

  it('keeps tracing off when users save keys without opting in', async () => {
    await store.save({ JUDGMENT_API_KEY: 'test-secret' });
    await loadUserEnvironment(environment);
    expect(environment.SEB_JUDGMENT_TRACING).toBeUndefined();
  });

  it('preserves shell values and the Gemini key alias', async () => {
    await store.save({ GOOGLE_GENERATIVE_AI_API_KEY: 'saved-key', SEB_JUDGMENT_TRACING: 'true', GEMINI_MODEL: 'gemini-flash' });
    Object.assign(environment, { GEMINI_API_KEY: 'shell-key', SEB_JUDGMENT_TRACING: 'false', GEMINI_MODEL: 'gemini-3.7-flash' });
    await loadUserEnvironment(environment);
    expect(environment.GOOGLE_GENERATIVE_AI_API_KEY).toBeUndefined();
    expect(environment.GEMINI_API_KEY).toBe('shell-key');
    expect(environment.SEB_JUDGMENT_TRACING).toBe('false');
    expect(environment.GEMINI_MODEL).toBe('gemini-3.7-flash');
  });

  it('does not inject a saved compatible key for a shell endpoint', async () => {
    await store.credentials.save(createSetupCredentials({ 'openai-compatible': 'private-key' }, new Date(), 'https://saved.example/v1'));
    await store.models.save(createModelSettings('openai-compatible', {
      'openai-compatible': { model: 'model', fallbackModel: 'model', baseURL: 'https://saved.example/v1' },
    }));
    environment.OPENAI_COMPATIBLE_BASE_URL = 'https://different.example/v1';
    await loadUserEnvironment(environment);
    expect(environment.OPENAI_COMPATIBLE_API_KEY).toBeUndefined();
  });

  it('imports aliases and ignores endpoint, bootstrap, and arbitrary variables', async () => {
    const path = join(directory, '.env');
    await writeFile(path, 'GEMINI_API_KEY=test-key\nGEMINI_MODEL=gemini-flash\nNODE_OPTIONS=--inspect\nSEB_CONFIG_HOME=/tmp/unsafe\nJUDGMENT_API_URL=https://unsafe.example\nOPENAI_COMPATIBLE_API_KEY=ignored\nJUDGMENT_API_KEY=\n');
    const result = await readEnvironmentImport(path);
    expect(result.changes).toEqual({ GOOGLE_GENERATIVE_AI_API_KEY: 'test-key', GEMINI_MODEL: 'gemini-flash' });
    expect(result.ignored).toHaveLength(4);
    expect((await store.load()).credentials).toBeNull();
  });

  it('rejects conflicting aliases without disclosing either value', async () => {
    const path = join(directory, '.env');
    await writeFile(path, 'GEMINI_API_KEY=first-secret\nGOOGLE_GENERATIVE_AI_API_KEY=second-secret');
    await expect(readEnvironmentImport(path)).rejects.toThrow('Conflicting aliases for GOOGLE_GENERATIVE_AI_API_KEY.');
  });

  it('masks the import preview and writes nothing after refusal', async () => {
    const path = join(directory, '.env');
    await writeFile(path, 'GEMINI_API_KEY=hidden-test-key\nSEB_JUDGMENT_TRACING=true');
    const write = vi.fn();
    const confirm = vi.fn().mockResolvedValue(false);
    const prompt = { confirm, select: vi.fn(), text: vi.fn() } as SetupPrompt;
    await importUserEnvironment(path, { store, environment, prompt, write });
    expect(write.mock.calls.flat().join('')).not.toContain('hidden-test-key');
    expect(write.mock.calls.flat().join('')).toContain('exports prompts');
    expect(confirm).toHaveBeenCalledWith(expect.any(String), false);
    expect((await store.load()).credentials).toBeNull();
    confirm.mockResolvedValue(true);
    await importUserEnvironment(path, { store, environment, prompt, write });
    expect(savedEnvironment(await store.load()).GOOGLE_GENERATIVE_AI_API_KEY).toBe('hidden-test-key');
  });

  it('serializes concurrent saves and supports secret removal', async () => {
    await Promise.all([store.save({ JUDGMENT_API_KEY: 'keep-key' }), new UserConfigurationStore(environment).save({ SEB_THEME: 'compact' })]);
    expect(savedEnvironment(await store.load())).toMatchObject({ JUDGMENT_API_KEY: 'keep-key', SEB_THEME: 'compact' });
    await store.save({ JUDGMENT_API_KEY: null });
    expect(savedEnvironment(await store.load()).JUDGMENT_API_KEY).toBeUndefined();
  });

  it('restores existing snapshots when a later save fails', async () => {
    await store.save({ GOOGLE_GENERATIVE_AI_API_KEY: 'previous', JUDGMENT_API_KEY: 'keep' });
    vi.spyOn(store.models, 'save').mockRejectedValueOnce(new Error('write failed'));
    await expect(store.save({ GOOGLE_GENERATIVE_AI_API_KEY: 'next' })).rejects.toThrow('restored the previous values');
    expect(savedEnvironment(await store.load())).toMatchObject({ GOOGLE_GENERATIVE_AI_API_KEY: 'previous', JUDGMENT_API_KEY: 'keep' });
  });

  it('rejects invalid and oversized imports', async () => {
    const path = join(directory, '.env');
    await writeFile(path, 'SEB_JUDGMENT_TRACING=maybe');
    await expect(readEnvironmentImport(path)).rejects.toThrow('Invalid value for SEB_JUDGMENT_TRACING.');
    await writeFile(path, 'x'.repeat(65537));
    await expect(readEnvironmentImport(path)).rejects.toThrow('exceeds 64 KiB');
  });

  it('parses explicit import arguments', () => {
    expect(parseCliArguments(['configure', '--import-env', '/tmp/settings.env'])).toEqual({ name: 'configure', importEnv: '/tmp/settings.env' });
    expect(() => parseCliArguments(['configure', '--import-env'])).toThrow();
  });
});
