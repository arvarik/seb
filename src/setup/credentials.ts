import { randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  rename,
  stat,
  unlink,
  writeFile,
  type FileHandle,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

import { validateOpenAICompatibleBaseURL } from '../ai/model-provider.js';
import { readBoundedUtf8File } from './bounded-file.js';
import { resolveSetupProfilePath } from './profile.js';
import { validateStoredEnvironment } from './configuration-registry.js';

export const SETUP_CREDENTIALS_SCHEMA_VERSION = 1;
export const SETUP_CREDENTIAL_PROVIDER_IDS = [
  'google',
  'anthropic',
  'openai',
  'openai-compatible',
] as const;

const MAX_CREDENTIALS_BYTES = 64 * 1024;
const MAX_API_KEY_LENGTH = 16 * 1024;
const CONFIGURATION_COMMIT_LOCK_NAME = '.model-configuration.lock';
const CONFIGURATION_COMMIT_LOCK_RETRY_MS = 25;
const CONFIGURATION_COMMIT_LOCK_TIMEOUT_MS = 5_000;
const CONFIGURATION_COMMIT_LOCK_STALE_MS = 60_000;
const TOP_LEVEL_FIELDS = new Set([
  'compatibleBaseURL',
  'schemaVersion',
  'keys',
  'updatedAt',
  'environment',
]);
const PROVIDER_IDS = new Set<string>(SETUP_CREDENTIAL_PROVIDER_IDS);

export type SetupCredentialProvider =
  (typeof SETUP_CREDENTIAL_PROVIDER_IDS)[number];

export type SetupCredentialKeys = Partial<
  Record<SetupCredentialProvider, string>
>;

export interface SebSetupCredentials {
  environment?: Record<string, string>;
  compatibleBaseURL?: string;
  schemaVersion: typeof SETUP_CREDENTIALS_SCHEMA_VERSION;
  keys: SetupCredentialKeys;
  updatedAt: string;
}

export interface SetupCredentialStore {
  readonly path: string;
  load(): Promise<SebSetupCredentials | null>;
  remove(): Promise<boolean>;
  save(credentials: SebSetupCredentials): Promise<void>;
  withConfigurationCommitLock?<T>(commit: () => Promise<T>): Promise<T>;
}

export interface FileSetupCredentialStoreOptions {
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  path?: string;
}

export class SetupCredentialsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SetupCredentialsValidationError';
  }
}

export class FileSetupCredentialStore implements SetupCredentialStore {
  readonly path: string;

  constructor(options: FileSetupCredentialStoreOptions = {}) {
    this.path = options.path ?? resolveSetupCredentialsPath(
      options.environment ?? process.env,
      options.homeDirectory,
    );
  }

  async load(): Promise<SebSetupCredentials | null> {
    const content = await readBoundedUtf8File(
      this.path,
      MAX_CREDENTIALS_BYTES,
      credentialsSizeError,
    );
    if (content === null) return null;

    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      throw new SetupCredentialsValidationError(
        'The credentials file contains invalid JSON.',
      );
    }
    return validateSetupCredentials(value);
  }

  async save(credentials: SebSetupCredentials): Promise<void> {
    const validated = validateSetupCredentials(credentials);
    const content = `${JSON.stringify(validated, null, 2)}\n`;
    assertCredentialsSize(content);

    const directory = dirname(this.path);
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporaryPath, content, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      await rename(temporaryPath, this.path);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }

  async remove(): Promise<boolean> {
    try {
      await unlink(this.path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  async withConfigurationCommitLock<T>(commit: () => Promise<T>): Promise<T> {
    const directory = dirname(this.path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const lockPath = resolve(directory, CONFIGURATION_COMMIT_LOCK_NAME);
    const lock = await acquireConfigurationCommitLock(lockPath);
    try {
      const result = await commit();
      await releaseConfigurationCommitLock(lock, lockPath);
      return result;
    } catch (error) {
      await releaseConfigurationCommitLock(lock, lockPath).catch(() => undefined);
      throw error;
    }
  }
}

export function resolveSetupCredentialsPath(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): string {
  const profilePath = resolveSetupProfilePath(environment, homeDirectory);
  return resolve(dirname(profilePath), 'credentials.json');
}

export function createSetupCredentials(
  keys: SetupCredentialKeys = {},
  now = new Date(),
  compatibleBaseURL?: string,
): SebSetupCredentials {
  return validateSetupCredentials({
    ...(compatibleBaseURL === undefined ? {} : { compatibleBaseURL }),
    schemaVersion: SETUP_CREDENTIALS_SCHEMA_VERSION,
    keys,
    updatedAt: now.toISOString(),
  });
}

export function validateSetupCredentials(value: unknown): SebSetupCredentials {
  if (!isRecord(value)) {
    throw new SetupCredentialsValidationError(
      'The credentials file must contain one JSON object.',
    );
  }
  if (hasUnknownFields(value, TOP_LEVEL_FIELDS)) {
    throw new SetupCredentialsValidationError(
      'The credentials file contains an unsupported field.',
    );
  }
  if (value.schemaVersion !== SETUP_CREDENTIALS_SCHEMA_VERSION) {
    throw new SetupCredentialsValidationError(
      `The credentials schema must equal ${SETUP_CREDENTIALS_SCHEMA_VERSION}.`,
    );
  }
  if (!isIsoDate(value.updatedAt)) {
    throw new SetupCredentialsValidationError(
      'The credentials file needs a valid updatedAt value.',
    );
  }

  const keys = readCredentialKeys(value.keys);
  const compatibleBaseURL = readCompatibleBaseURL(
    value.compatibleBaseURL,
    keys['openai-compatible'] !== undefined,
  );
  return {
    ...(compatibleBaseURL === undefined ? {} : { compatibleBaseURL }),
    schemaVersion: SETUP_CREDENTIALS_SCHEMA_VERSION,
    keys,
    ...(value.environment === undefined ? {} : { environment: validateStoredEnvironment(value.environment, true) }),
    updatedAt: value.updatedAt,
  };
}

function readCredentialKeys(value: unknown): SetupCredentialKeys {
  if (!isRecord(value)) {
    throw new SetupCredentialsValidationError(
      'The credentials file needs one keys object.',
    );
  }
  if (Object.keys(value).some((key) => !PROVIDER_IDS.has(key))) {
    throw new SetupCredentialsValidationError(
      'The credentials keys object contains an unsupported provider.',
    );
  }

  const keys: SetupCredentialKeys = {};
  for (const provider of SETUP_CREDENTIAL_PROVIDER_IDS) {
    const apiKey = value[provider];
    if (apiKey === undefined) continue;
    if (typeof apiKey !== 'string') {
      throw new SetupCredentialsValidationError(
        `The ${provider} API key must contain text.`,
      );
    }
    const normalized = apiKey.trim();
    if (!normalized) {
      throw new SetupCredentialsValidationError(
        `The ${provider} API key must not be empty.`,
      );
    }
    if (
      normalized.length > MAX_API_KEY_LENGTH ||
      /[\u0000-\u001F\u007F]/u.test(normalized)
    ) {
      throw new SetupCredentialsValidationError(
        `The ${provider} API key contains an invalid value.`,
      );
    }
    keys[provider] = normalized;
  }
  return keys;
}

function assertCredentialsSize(content: string): void {
  if (Buffer.byteLength(content, 'utf8') > MAX_CREDENTIALS_BYTES) {
    throw credentialsSizeError();
  }
}

function credentialsSizeError(): SetupCredentialsValidationError {
  return new SetupCredentialsValidationError(
    'The credentials file exceeds 64 KiB.',
  );
}

function readCompatibleBaseURL(
  value: unknown,
  required: boolean,
): string | undefined {
  if (value === undefined) {
    if (!required) return undefined;
    throw new SetupCredentialsValidationError(
      'The saved OpenAI-compatible key needs its matching base URL.',
    );
  }
  if (!required) {
    throw new SetupCredentialsValidationError(
      'The credentials file cannot bind an endpoint without a saved OpenAI-compatible key.',
    );
  }
  if (typeof value !== 'string') {
    throw new SetupCredentialsValidationError(
      'The saved OpenAI-compatible key needs a valid base URL.',
    );
  }
  try {
    return validateOpenAICompatibleBaseURL(value);
  } catch {
    throw new SetupCredentialsValidationError(
      'The saved OpenAI-compatible key needs a valid and safe base URL.',
    );
  }
}

async function acquireConfigurationCommitLock(
  path: string,
): Promise<FileHandle> {
  const deadline = Date.now() + CONFIGURATION_COMMIT_LOCK_TIMEOUT_MS;
  while (true) {
    try {
      return await open(path, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (await removeStaleConfigurationCommitLock(path)) continue;
      if (Date.now() >= deadline) {
        throw new Error(
          `Another Seb model configuration is still saving. Remove ${path} only when no configure command is running.`,
        );
      }
      await delay(CONFIGURATION_COMMIT_LOCK_RETRY_MS);
    }
  }
}

async function removeStaleConfigurationCommitLock(path: string): Promise<boolean> {
  let existing: Awaited<ReturnType<typeof stat>>;
  try {
    existing = await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  if (Date.now() - existing.mtimeMs <= CONFIGURATION_COMMIT_LOCK_STALE_MS) {
    return false;
  }
  let current: Awaited<ReturnType<typeof stat>>;
  try {
    current = await stat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
  if (
    current.dev !== existing.dev ||
    current.ino !== existing.ino ||
    Date.now() - current.mtimeMs <= CONFIGURATION_COMMIT_LOCK_STALE_MS
  ) {
    return false;
  }
  try {
    await unlink(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw error;
  }
}

async function releaseConfigurationCommitLock(
  lock: FileHandle,
  path: string,
): Promise<void> {
  const lockedFile = await lock.stat();
  let closeError: unknown;
  try {
    await lock.close();
  } catch (error) {
    closeError = error;
  }
  try {
    const current = await stat(path);
    if (current.dev === lockedFile.dev && current.ino === lockedFile.ino) {
      await unlink(path);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (closeError) throw closeError;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function hasUnknownFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).some((key) => !allowed.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}
