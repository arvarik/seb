import { randomUUID } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';

import { resolveSetupProfilePath } from '../setup/profile.js';
import { readBoundedUtf8File } from '../setup/bounded-file.js';
import {
  validateModelId,
  validateOpenAICompatibleBaseURL,
} from './model-provider.js';

export const MODEL_SETTINGS_SCHEMA_VERSION = 1;
export const MODEL_PROVIDER_IDS = [
  'google',
  'anthropic',
  'openai',
  'openai-compatible',
] as const;
export const MAX_MODEL_ID_LENGTH = 200;
export const MAX_MODEL_SETTINGS_BYTES = 64 * 1024;

const TOP_LEVEL_FIELDS = new Set([
  'activeProvider',
  'providers',
  'schemaVersion',
  'updatedAt',
]);
const STANDARD_PROVIDER_FIELDS = new Set(['fallbackModel', 'model']);
const COMPATIBLE_PROVIDER_FIELDS = new Set([
  'baseURL',
  'fallbackModel',
  'model',
]);
const PROVIDER_IDS = new Set<string>(MODEL_PROVIDER_IDS);

export type ModelProviderId = (typeof MODEL_PROVIDER_IDS)[number];

export interface ProviderModelSettings {
  baseURL?: string;
  fallbackModel?: string;
  model: string;
}

export type ModelSettingsProviders = Partial<
  Record<ModelProviderId, ProviderModelSettings>
>;

export interface SebModelSettings {
  activeProvider: ModelProviderId;
  providers: ModelSettingsProviders;
  schemaVersion: typeof MODEL_SETTINGS_SCHEMA_VERSION;
  updatedAt: string;
}

export interface ModelSettingsStore {
  readonly path: string;
  load(): Promise<SebModelSettings | null>;
  remove(): Promise<boolean>;
  save(settings: SebModelSettings): Promise<void>;
}

export interface FileModelSettingsStoreOptions {
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  path?: string;
}

export class ModelSettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelSettingsValidationError';
  }
}

export class FileModelSettingsStore implements ModelSettingsStore {
  readonly path: string;

  constructor(options: FileModelSettingsStoreOptions = {}) {
    this.path = options.path ?? resolveModelSettingsPath(
      options.environment ?? process.env,
      options.homeDirectory,
    );
  }

  async load(): Promise<SebModelSettings | null> {
    const content = await readBoundedUtf8File(
      this.path,
      MAX_MODEL_SETTINGS_BYTES,
      settingsSizeError,
    );
    if (content === null) return null;

    let value: unknown;
    try {
      value = JSON.parse(content);
    } catch {
      throw new ModelSettingsValidationError(
        'The model settings file contains invalid JSON.',
      );
    }
    return validateModelSettings(value);
  }

  async save(settings: SebModelSettings): Promise<void> {
    const validated = validateModelSettings(settings);
    const content = `${JSON.stringify(validated, null, 2)}\n`;
    assertSettingsSize(content);

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
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
}

export function resolveModelSettingsPath(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): string {
  const explicitFile = environment.SEB_MODEL_SETTINGS_FILE?.trim();
  if (explicitFile) return resolve(explicitFile);

  const profilePath = resolveSetupProfilePath(environment, homeDirectory);
  return resolve(dirname(profilePath), 'model-settings.json');
}

export function createModelSettings(
  activeProvider: ModelProviderId,
  providers: ModelSettingsProviders,
  now = new Date(),
): SebModelSettings {
  return validateModelSettings({
    activeProvider,
    providers,
    schemaVersion: MODEL_SETTINGS_SCHEMA_VERSION,
    updatedAt: now.toISOString(),
  });
}

export function validateModelSettings(value: unknown): SebModelSettings {
  if (!isRecord(value)) {
    throw new ModelSettingsValidationError(
      'The model settings file must contain one JSON object.',
    );
  }
  if (hasUnknownFields(value, TOP_LEVEL_FIELDS)) {
    throw new ModelSettingsValidationError(
      'The model settings file contains an unsupported field.',
    );
  }
  if (value.schemaVersion !== MODEL_SETTINGS_SCHEMA_VERSION) {
    throw new ModelSettingsValidationError(
      `The model settings schema must equal ${MODEL_SETTINGS_SCHEMA_VERSION}.`,
    );
  }
  const activeProvider = readProviderId(value.activeProvider);
  if (!isIsoDate(value.updatedAt)) {
    throw new ModelSettingsValidationError(
      'The model settings file needs a valid updatedAt value.',
    );
  }
  const providers = readProviders(value.providers);
  if (!providers[activeProvider]) {
    throw new ModelSettingsValidationError(
      'The active provider needs one saved model configuration.',
    );
  }

  return {
    activeProvider,
    providers,
    schemaVersion: MODEL_SETTINGS_SCHEMA_VERSION,
    updatedAt: value.updatedAt,
  };
}

export function setActiveModelProvider(
  settings: SebModelSettings,
  activeProvider: ModelProviderId,
  now = new Date(),
): SebModelSettings {
  const current = validateModelSettings(settings);
  return validateModelSettings({
    ...current,
    activeProvider,
    updatedAt: now.toISOString(),
  });
}

export function setProviderModelSettings(
  settings: SebModelSettings,
  provider: ModelProviderId,
  providerSettings: ProviderModelSettings,
  now = new Date(),
): SebModelSettings {
  const current = validateModelSettings(settings);
  return validateModelSettings({
    ...current,
    providers: {
      ...current.providers,
      [provider]: providerSettings,
    },
    updatedAt: now.toISOString(),
  });
}

export function removeProviderModelSettings(
  settings: SebModelSettings,
  provider: ModelProviderId,
  now = new Date(),
): SebModelSettings {
  const current = validateModelSettings(settings);
  const resolvedProvider = readProviderId(provider, 'provider');
  if (current.activeProvider === resolvedProvider) {
    throw new ModelSettingsValidationError(
      'Select another active provider before you remove this provider.',
    );
  }
  const providers = { ...current.providers };
  delete providers[resolvedProvider];
  return validateModelSettings({
    ...current,
    providers,
    updatedAt: now.toISOString(),
  });
}

export function formatModelSettings(
  settings: SebModelSettings,
  path?: string,
): string {
  const validated = validateModelSettings(settings);
  const lines = [
    '## Seb model settings',
    '',
    `- Active provider: ${inlineCode(validated.activeProvider)}`,
    `- Updated: ${validated.updatedAt}`,
    ...(path ? [`- File: ${inlineCode(path)}`] : []),
    '- This file stores model names and a custom endpoint. It stores no API keys.',
    '',
    '### Configured providers',
    '',
  ];

  for (const provider of MODEL_PROVIDER_IDS) {
    const providerSettings = validated.providers[provider];
    if (!providerSettings) continue;
    const details = [
      `model ${inlineCode(providerSettings.model)}`,
      ...(providerSettings.fallbackModel
        ? [`fallback ${inlineCode(providerSettings.fallbackModel)}`]
        : []),
      ...(providerSettings.baseURL
        ? [`endpoint ${inlineCode(providerSettings.baseURL)}`]
        : []),
    ];
    lines.push(`- ${inlineCode(provider)}: ${details.join(', ')}`);
  }
  return lines.join('\n');
}

function readProviderId(
  value: unknown,
  name = 'active provider',
): ModelProviderId {
  if (typeof value !== 'string' || !PROVIDER_IDS.has(value)) {
    throw new ModelSettingsValidationError(
      `The ${name} is not supported.`,
    );
  }
  return value as ModelProviderId;
}

function readProviders(value: unknown): ModelSettingsProviders {
  if (!isRecord(value)) {
    throw new ModelSettingsValidationError(
      'The model settings file needs one providers object.',
    );
  }
  if (Object.keys(value).some((provider) => !PROVIDER_IDS.has(provider))) {
    throw new ModelSettingsValidationError(
      'The providers object contains an unsupported provider.',
    );
  }

  const providers: ModelSettingsProviders = {};
  for (const provider of MODEL_PROVIDER_IDS) {
    const providerSettings = value[provider];
    if (providerSettings === undefined) continue;
    providers[provider] = readProviderSettings(provider, providerSettings);
  }
  return providers;
}

function readProviderSettings(
  provider: ModelProviderId,
  value: unknown,
): ProviderModelSettings {
  if (!isRecord(value)) {
    throw new ModelSettingsValidationError(
      `The ${provider} model configuration must contain one JSON object.`,
    );
  }
  if (provider !== 'openai-compatible' && 'baseURL' in value) {
    throw new ModelSettingsValidationError(
      `The ${provider} model configuration cannot contain a base URL.`,
    );
  }
  const allowedFields = provider === 'openai-compatible'
    ? COMPATIBLE_PROVIDER_FIELDS
    : STANDARD_PROVIDER_FIELDS;
  if (hasUnknownFields(value, allowedFields)) {
    throw new ModelSettingsValidationError(
      `The ${provider} model configuration contains an unsupported field.`,
    );
  }

  const model = readModelId(value.model, `${provider} model`);
  const fallbackModel = value.fallbackModel === undefined
    ? undefined
    : readModelId(value.fallbackModel, `${provider} fallback model`);
  const baseURL = readBaseURL(provider, value.baseURL);

  return {
    ...(baseURL === undefined ? {} : { baseURL }),
    ...(fallbackModel === undefined ? {} : { fallbackModel }),
    model,
  };
}

function readModelId(value: unknown, name: string): string {
  if (typeof value !== 'string') {
    throw new ModelSettingsValidationError(`The ${name} must contain text.`);
  }
  try {
    return validateModelId(value, `The ${name}`);
  } catch {
    throw new ModelSettingsValidationError(
      `The ${name} must contain 1 through ${MAX_MODEL_ID_LENGTH} safe model ID characters.`,
    );
  }
}

function readBaseURL(
  provider: ModelProviderId,
  value: unknown,
): string | undefined {
  if (provider !== 'openai-compatible') {
    if (value !== undefined) {
      throw new ModelSettingsValidationError(
        `The ${provider} model configuration cannot contain a base URL.`,
      );
    }
    return undefined;
  }
  if (typeof value !== 'string' || !value.trim()) {
    throw new ModelSettingsValidationError(
      'The openai-compatible model configuration needs a base URL.',
    );
  }

  try {
    return validateOpenAICompatibleBaseURL(value);
  } catch {
    throw new ModelSettingsValidationError(
      'The openai-compatible base URL is invalid or unsafe.',
    );
  }
}

function assertSettingsSize(content: string): void {
  if (Buffer.byteLength(content, 'utf8') > MAX_MODEL_SETTINGS_BYTES) {
    throw settingsSizeError();
  }
}

function settingsSizeError(): ModelSettingsValidationError {
  return new ModelSettingsValidationError(
    'The model settings file exceeds 64 KiB.',
  );
}

function hasUnknownFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): boolean {
  return Object.keys(value).some((key) => !allowed.has(key));
}

function inlineCode(value: string): string {
  return `\`${value.replaceAll('`', '\\`')}\``;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}
