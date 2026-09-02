import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  stat,
  truncate,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createSetupCredentials,
  FileSetupCredentialStore,
  resolveSetupCredentialsPath,
  SETUP_CREDENTIALS_SCHEMA_VERSION,
  SetupCredentialsValidationError,
  validateSetupCredentials,
} from '../src/setup/credentials.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('setup credential validation', () => {
  it('accepts each supported provider and keeps the local key optional', () => {
    const updatedAt = '2026-09-01T12:00:00.000Z';

    expect(validateSetupCredentials({
      schemaVersion: SETUP_CREDENTIALS_SCHEMA_VERSION,
      keys: {
        anthropic: 'anthropic-secret',
        google: 'google-secret',
        openai: 'openai-secret',
      },
      updatedAt,
    })).toEqual({
      schemaVersion: SETUP_CREDENTIALS_SCHEMA_VERSION,
      keys: {
        google: 'google-secret',
        anthropic: 'anthropic-secret',
        openai: 'openai-secret',
      },
      updatedAt,
    });

    expect(createSetupCredentials(
      { 'openai-compatible': 'local-secret' },
      new Date(updatedAt),
      'http://localhost:11434/v1/',
    )).toMatchObject({
      compatibleBaseURL: 'http://localhost:11434/v1',
      keys: { 'openai-compatible': 'local-secret' },
    });
    expect(createSetupCredentials({}, new Date(updatedAt)).keys).toEqual({});
  });

  it('requires one safe endpoint binding for a saved compatible key', () => {
    const base = {
      schemaVersion: SETUP_CREDENTIALS_SCHEMA_VERSION,
      updatedAt: '2026-09-01T12:00:00.000Z',
    };

    expect(() => validateSetupCredentials({
      ...base,
      keys: { 'openai-compatible': 'local-secret' },
    })).toThrow('needs its matching base URL');
    expect(() => validateSetupCredentials({
      ...base,
      compatibleBaseURL: 'http://localhost:11434/v1',
      keys: {},
    })).toThrow('cannot bind an endpoint');
    expect(() => validateSetupCredentials({
      ...base,
      compatibleBaseURL: 'http://models.example.com/v1',
      keys: { 'openai-compatible': 'local-secret' },
    })).toThrow('valid and safe base URL');
  });

  it('rejects invalid schemas without including secret values in errors', () => {
    const secret = 'do-not-return-this-secret';
    const invalidValues: unknown[] = [
      null,
      {
        schemaVersion: 999,
        keys: { google: secret },
        updatedAt: '2026-09-01T12:00:00.000Z',
      },
      {
        schemaVersion: SETUP_CREDENTIALS_SCHEMA_VERSION,
        keys: { unsupported: secret },
        updatedAt: '2026-09-01T12:00:00.000Z',
      },
      {
        schemaVersion: SETUP_CREDENTIALS_SCHEMA_VERSION,
        keys: { google: '' },
        updatedAt: '2026-09-01T12:00:00.000Z',
      },
      {
        schemaVersion: SETUP_CREDENTIALS_SCHEMA_VERSION,
        keys: { google: `${secret}\nsecond-line` },
        updatedAt: '2026-09-01T12:00:00.000Z',
      },
      {
        schemaVersion: SETUP_CREDENTIALS_SCHEMA_VERSION,
        keys: { google: secret },
        model: 'must-not-be-stored',
        updatedAt: '2026-09-01T12:00:00.000Z',
      },
    ];

    for (const value of invalidValues) {
      try {
        validateSetupCredentials(value);
        throw new Error('Expected credential validation to fail.');
      } catch (error) {
        expect(error).toBeInstanceOf(SetupCredentialsValidationError);
        expect(String(error)).not.toContain(secret);
      }
    }
  });
});

describe('file setup credential store', () => {
  it('uses the profile directory for each supported path rule', () => {
    expect(resolveSetupCredentialsPath(
      { SEB_PROFILE_FILE: '/tmp/seb-custom/account.json' },
      '/unused',
    )).toBe('/tmp/seb-custom/credentials.json');
    expect(resolveSetupCredentialsPath(
      { SEB_CONFIG_HOME: '/tmp/seb-home' },
      '/unused',
    )).toBe('/tmp/seb-home/credentials.json');
    expect(resolveSetupCredentialsPath(
      { XDG_CONFIG_HOME: '/tmp/xdg' },
      '/unused',
    )).toBe('/tmp/xdg/seb/credentials.json');
    expect(resolveSetupCredentialsPath({}, '/tmp/home')).toBe(
      '/tmp/home/.config/seb/credentials.json',
    );
  });

  it('uses an atomic private file and a private directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'seb-credentials-test-'));
    temporaryDirectories.push(directory);
    const configDirectory = join(directory, 'config');
    await chmod(directory, 0o755);
    const path = join(configDirectory, 'credentials.json');
    const store = new FileSetupCredentialStore({ path });
    const credentials = createSetupCredentials(
      {
        anthropic: 'anthropic-secret',
        google: 'google-secret',
        openai: 'openai-secret',
        'openai-compatible': 'local-secret',
      },
      new Date('2026-09-01T12:00:00.000Z'),
      'http://localhost:11434/v1',
    );

    await store.save(credentials);

    expect(await store.load()).toEqual(credentials);
    const content = await readFile(path, 'utf8');
    expect(content).toContain('"compatibleBaseURL"');
    expect(content).not.toContain('model');
    expect(await readdir(configDirectory)).toEqual(['credentials.json']);
    if (process.platform !== 'win32') {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
      expect((await stat(configDirectory)).mode & 0o777).toBe(0o700);
    }
    expect(await store.remove()).toBe(true);
    expect(await store.remove()).toBe(false);
  });

  it('preserves permissions on an existing configuration directory', async () => {
    if (process.platform === 'win32') return;
    const directory = await mkdtemp(join(tmpdir(), 'seb-credentials-mode-'));
    temporaryDirectories.push(directory);
    const configDirectory = join(directory, 'config');
    await mkdir(configDirectory, { mode: 0o750 });
    await chmod(configDirectory, 0o750);
    const store = new FileSetupCredentialStore({
      path: join(configDirectory, 'credentials.json'),
    });

    await store.save(createSetupCredentials({ google: 'saved-secret' }));

    expect((await stat(configDirectory)).mode & 0o777).toBe(0o750);
  });

  it('rejects oversized and invalid files without exposing their secrets', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'seb-credentials-size-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'credentials.json');
    const store = new FileSetupCredentialStore({ path });
    const secret = 'oversized-secret-marker';
    await writeFile(path, `${secret}${'x'.repeat(64 * 1024)}`);

    await expect(store.load()).rejects.toThrow('exceeds 64 KiB');
    await truncate(path, 8 * 1024 * 1024);
    await expect(store.load()).rejects.toThrow('exceeds 64 KiB');

    const maximumKey = 'k'.repeat(16 * 1024);
    await expect(store.save(createSetupCredentials({
      anthropic: maximumKey,
      google: maximumKey,
      openai: maximumKey,
      'openai-compatible': maximumKey,
    }, undefined, 'http://localhost:11434/v1'))).rejects.toThrow(
      'exceeds 64 KiB',
    );

    await writeFile(path, `{${JSON.stringify(secret)}`);
    try {
      await store.load();
      throw new Error('Expected credential loading to fail.');
    } catch (error) {
      expect(error).toBeInstanceOf(SetupCredentialsValidationError);
      expect(String(error)).not.toContain(secret);
    }
  });

  it('serializes configuration commits and releases the lock', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'seb-credentials-lock-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'config', 'credentials.json');
    const firstStore = new FileSetupCredentialStore({ path });
    const secondStore = new FileSetupCredentialStore({ path });
    const events: string[] = [];
    let releaseFirst: () => void = () => {};
    const firstHeld = new Promise<void>((resolveHeld) => {
      releaseFirst = resolveHeld;
    });

    const first = firstStore.withConfigurationCommitLock(async () => {
      events.push('first-start');
      await firstHeld;
      events.push('first-end');
    });
    while (!events.includes('first-start')) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 1));
    }
    const second = secondStore.withConfigurationCommitLock(async () => {
      events.push('second');
    });
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));

    expect(events).toEqual(['first-start']);
    releaseFirst();
    await Promise.all([first, second]);

    expect(events).toEqual(['first-start', 'first-end', 'second']);
    expect(await readdir(join(directory, 'config'))).toEqual([]);
  });

  it('recovers a configuration lock only after it becomes stale', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'seb-credentials-stale-'));
    temporaryDirectories.push(directory);
    const configDirectory = join(directory, 'config');
    await mkdir(configDirectory);
    const lockPath = join(configDirectory, '.model-configuration.lock');
    await writeFile(lockPath, 'interrupted configure');
    const staleTime = new Date(Date.now() - 61_000);
    await utimes(lockPath, staleTime, staleTime);
    const store = new FileSetupCredentialStore({
      path: join(configDirectory, 'credentials.json'),
    });
    let committed = false;

    await store.withConfigurationCommitLock(async () => {
      committed = true;
    });

    expect(committed).toBe(true);
    expect(await readdir(configDirectory)).toEqual([]);
  });

  it('preserves saved credentials when a replacement fails validation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'seb-credentials-preserve-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'credentials.json');
    const store = new FileSetupCredentialStore({ path });
    const credentials = createSetupCredentials(
      { google: 'saved-secret' },
      new Date('2026-09-01T12:00:00.000Z'),
    );
    await store.save(credentials);

    await expect(store.save({
      ...credentials,
      keys: { google: '' },
    })).rejects.toThrow(SetupCredentialsValidationError);

    expect(await store.load()).toEqual(credentials);
  });
});
