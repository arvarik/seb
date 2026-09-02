import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

export const SETUP_PROFILE_SCHEMA_VERSION = 3;
const MAX_PROFILE_BYTES = 64 * 1024;

export interface SebSetupProfile {
  schemaVersion: typeof SETUP_PROFILE_SCHEMA_VERSION;
  sleeper: {
    username: string;
  } | null;
  updatedAt: string;
}

export interface SetupProfileStore {
  readonly path: string;
  load(): Promise<SebSetupProfile | null>;
  remove(): Promise<boolean>;
  save(profile: SebSetupProfile): Promise<void>;
}

export interface FileSetupProfileStoreOptions {
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  path?: string;
}

export class SetupProfileValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SetupProfileValidationError';
  }
}

export class FileSetupProfileStore implements SetupProfileStore {
  readonly path: string;

  constructor(options: FileSetupProfileStoreOptions = {}) {
    this.path = options.path ?? resolveSetupProfilePath(
      options.environment ?? process.env,
      options.homeDirectory,
    );
  }

  async load(): Promise<SebSetupProfile | null> {
    let content: string;
    try {
      content = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
    if (Buffer.byteLength(content, 'utf8') > MAX_PROFILE_BYTES) {
      throw new SetupProfileValidationError('The setup profile exceeds 64 KiB.');
    }

    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      throw new SetupProfileValidationError('The setup profile contains invalid JSON.');
    }
    const result = readSetupProfile(value);
    if (result.migrated) {
      try {
        await this.save(result.profile);
      } catch (error) {
        if (!isReadOnlyFileError(error)) throw error;
      }
    }
    return result.profile;
  }

  async save(profile: SebSetupProfile): Promise<void> {
    const validated = validateSetupProfile(profile);
    const directory = dirname(this.path);
    const temporaryPath = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporaryPath, `${JSON.stringify(validated, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
      await rename(temporaryPath, this.path);
      await chmod(this.path, 0o600);
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
}

export function resolveSetupProfilePath(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): string {
  const explicitFile = environment.SEB_PROFILE_FILE?.trim();
  if (explicitFile) {
    return resolve(explicitFile);
  }
  const explicitDirectory = environment.SEB_CONFIG_HOME?.trim();
  if (explicitDirectory) {
    return resolve(explicitDirectory, 'profile.json');
  }
  const xdgDirectory = environment.XDG_CONFIG_HOME?.trim();
  return resolve(xdgDirectory || resolve(homeDirectory, '.config'), 'seb', 'profile.json');
}

export function validateSetupProfile(value: unknown): SebSetupProfile {
  if (!isRecord(value)) {
    throw new SetupProfileValidationError('The setup profile must contain one JSON object.');
  }
  if (value.schemaVersion !== SETUP_PROFILE_SCHEMA_VERSION) {
    throw new SetupProfileValidationError(
      `The setup profile schema must equal ${SETUP_PROFILE_SCHEMA_VERSION}.`,
    );
  }
  if (!isIsoDate(value.updatedAt)) {
    throw new SetupProfileValidationError('The setup profile needs a valid updatedAt value.');
  }
  const sleeper = readSleeperAccount(value.sleeper);

  return {
    schemaVersion: SETUP_PROFILE_SCHEMA_VERSION,
    sleeper,
    updatedAt: value.updatedAt,
  };
}

export function formatSetupProfile(profile: SebSetupProfile, path?: string): string {
  return [
    '## Seb preferences',
    '',
    `- Sleeper account: ${profile.sleeper ? `@${profile.sleeper.username}` : 'not connected'}`,
    `- Updated: ${profile.updatedAt}`,
    ...(path ? [`- File: \`${path}\``] : []),
    '- Model keys never appear in this profile. Seb stores configured keys in a separate private credentials file.',
    '- Seb refreshes the NFL week, leagues, and owned rosters when chat starts.',
    '- Run `/connect USERNAME` or `/disconnect` to change the Sleeper account.',
  ].join('\n');
}

function readSetupProfile(value: unknown): {
  migrated: boolean;
  profile: SebSetupProfile;
} {
  if (isRecord(value) && value.schemaVersion === 1 && isRecord(value.defaults)) {
    if (!isIsoDate(value.updatedAt)) {
      throw new SetupProfileValidationError('The legacy setup profile needs a valid updatedAt value.');
    }
    return {
      migrated: true,
      profile: {
        schemaVersion: SETUP_PROFILE_SCHEMA_VERSION,
        sleeper: readLegacySleeperAccount(value.sleeper),
        updatedAt: value.updatedAt,
      },
    };
  }
  if (isRecord(value) && value.schemaVersion === 2 && isRecord(value.defaults)) {
    if (!isIsoDate(value.updatedAt)) {
      throw new SetupProfileValidationError('The legacy setup profile needs a valid updatedAt value.');
    }
    return {
      migrated: true,
      profile: {
        schemaVersion: SETUP_PROFILE_SCHEMA_VERSION,
        sleeper: null,
        updatedAt: value.updatedAt,
      },
    };
  }
  return { migrated: false, profile: validateSetupProfile(value) };
}

function readSleeperAccount(value: unknown): SebSetupProfile['sleeper'] {
  if (value === null) return null;
  if (!isRecord(value) || !validUsername(value.username)) {
    throw new SetupProfileValidationError('The Sleeper account needs a valid username or null.');
  }
  return { username: value.username.trim() };
}

function readLegacySleeperAccount(value: unknown): SebSetupProfile['sleeper'] {
  return isRecord(value) && validUsername(value.username)
    ? { username: value.username.trim() }
    : null;
}

function validUsername(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,100}$/u.test(value.trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isReadOnlyFileError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EACCES' || code === 'EPERM' || code === 'EROFS';
}
