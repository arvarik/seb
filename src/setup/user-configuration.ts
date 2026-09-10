import { randomUUID } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseEnv } from 'node:util';

import { DEFAULT_PROVIDER_MODELS, validateModelProviderId } from '../ai/model-provider.js';
import { createModelSettings, FileModelSettingsStore, type SebModelSettings } from '../ai/model-settings.js';
import { readBoundedUtf8File } from './bounded-file.js';
import { createSetupCredentials, FileSetupCredentialStore, type SebSetupCredentials } from './credentials.js';
import { CONFIGURATION_SETTINGS, settingDefinition, validateSetting, validateStoredEnvironment } from './configuration-registry.js';

const MAX_CONFIGURATION_BYTES = 64 * 1024;

export interface UserConfiguration {
  values: Record<string, string>;
  credentials: SebSetupCredentials | null;
  models: SebModelSettings | null;
}

/** Shares the credential lock with the existing model setup wizard. */
export class UserConfigurationStore {
  readonly path: string;
  readonly credentials: FileSetupCredentialStore;
  readonly models: FileModelSettingsStore;

  constructor(environment: NodeJS.ProcessEnv = process.env) {
    this.credentials = new FileSetupCredentialStore({ environment });
    this.models = new FileModelSettingsStore({ environment });
    this.path = resolve(dirname(this.credentials.path), 'settings.json');
  }

  load(): Promise<UserConfiguration> {
    return this.credentials.withConfigurationCommitLock(() => this.read());
  }

  private async read(): Promise<UserConfiguration> {
    const [content, credentials, models] = await Promise.all([
      readBoundedUtf8File(this.path, MAX_CONFIGURATION_BYTES, configurationSizeError),
      this.credentials.load(), this.models.load(),
    ]);
    let values: Record<string, string> = {};
    if (content !== null) {
      let parsed: unknown;
      try { parsed = JSON.parse(content); }
      catch { throw new Error('The user settings file contains invalid JSON.'); }
      values = validateStoredEnvironment(parsed, false);
    }
    return { values, credentials, models };
  }

  async save(changes: Record<string, string | null>): Promise<void> {
    await this.credentials.withConfigurationCommitLock(async () => {
      const previous = await this.read();
      const values = { ...previous.values };
      const credentials = previous.credentials
        ? structuredClone(previous.credentials) : createSetupCredentials();
      const providers = structuredClone(previous.models?.providers ?? {});
      let activeProvider = previous.models?.activeProvider;
      for (const [name, input] of Object.entries(changes)) {
        const setting = settingDefinition(name);
        if (!setting || setting.name !== name) throw new Error('Unsupported configuration setting.');
        const value = input === null ? null : validateSetting(setting, input);
        if (name === 'SEB_MODEL_PROVIDER') {
          if (value === null) throw new Error('Select an active provider instead of removing it.');
          activeProvider = validateModelProviderId(value);
        } else if (setting.provider) {
          const provider = setting.provider;
          if (setting.field === 'key') {
            if (value === null) delete credentials.keys[provider];
            else credentials.keys[provider] = value;
          }
          const defaults = DEFAULT_PROVIDER_MODELS[provider];
          const modelSettings = providers[provider] ?? {
            model: defaults.model!, fallbackModel: defaults.fallbackModel!,
          };
          if (setting.field === 'model') modelSettings.model = value ?? defaults.model!;
          if (setting.field === 'fallbackModel') modelSettings.fallbackModel = value ?? defaults.fallbackModel!;
          providers[provider] = modelSettings;
          activeProvider ??= provider;
        } else {
          const target = setting.secret ? (credentials.environment ??= {}) : values;
          if (value === null) delete target[name];
          else target[name] = value;
        }
      }
      if (activeProvider && !providers[activeProvider]) {
        if (activeProvider === 'openai-compatible') {
          throw new Error('Configure the compatible endpoint through model provider setup first.');
        }
        const defaults = DEFAULT_PROVIDER_MODELS[activeProvider];
        providers[activeProvider] = { model: defaults.model!, fallbackModel: defaults.fallbackModel! };
      }
      const models = activeProvider ? createModelSettings(activeProvider, providers) : null;
      credentials.updatedAt = new Date().toISOString();
      try {
        await this.credentials.save(credentials);
        if (models) await this.models.save(models);
        await this.writeValues(values);
      } catch {
        // Restore all three snapshots before releasing the shared writer lock.
        try {
          if (previous.credentials) await this.credentials.save(previous.credentials);
          else await this.credentials.remove();
          if (previous.models) await this.models.save(previous.models);
          else await this.models.remove();
          await this.writeValues(previous.values);
        } catch {
          throw new Error('Configuration save and recovery failed. Review your saved configuration before restarting.');
        }
        throw new Error('Seb could not save the configuration. It restored the previous values.');
      }
    });
  }

  private async writeValues(values: Record<string, string>): Promise<void> {
    const content = `${JSON.stringify(validateStoredEnvironment(values, false), null, 2)}\n`;
    if (Buffer.byteLength(content) > MAX_CONFIGURATION_BYTES) throw configurationSizeError();
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    try {
      await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
      await rename(temporary, this.path);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
}

export function savedEnvironment(configuration: UserConfiguration): Record<string, string> {
  const result = { ...configuration.values, ...configuration.credentials?.environment };
  for (const setting of CONFIGURATION_SETTINGS) {
    if (!setting.provider) continue;
    const value = setting.field === 'key'
      ? configuration.credentials?.keys[setting.provider]
      : configuration.models?.providers[setting.provider]?.[setting.field!];
    if (value !== undefined) result[setting.name] = value;
  }
  if (configuration.models) result.SEB_MODEL_PROVIDER = configuration.models.activeProvider;
  const compatible = configuration.models?.providers['openai-compatible'];
  if (compatible) {
    result.OPENAI_COMPATIBLE_MODEL = compatible.model;
    if (compatible.fallbackModel) result.OPENAI_COMPATIBLE_FALLBACK_MODEL = compatible.fallbackModel;
    if (compatible.baseURL) result.OPENAI_COMPATIBLE_BASE_URL = compatible.baseURL;
    if (compatible.baseURL === configuration.credentials?.compatibleBaseURL && configuration.credentials?.keys['openai-compatible']) {
      result.OPENAI_COMPATIBLE_API_KEY = configuration.credentials.keys['openai-compatible'];
    }
  }
  return result;
}

/** Apply saved values only where the shell supplies no value. Never read the working directory. */
export async function loadUserEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  includeModelConfiguration = false,
): Promise<void> {
  const configuration = await new UserConfigurationStore(environment).load();
  // The CLI resolves model settings through loadModelConfiguration. Keep saved
  // endpoint credentials out of its environment so CLI overrides retain key binding.
  // Connectors resolve a fixed startup model from their environment instead.
  const saved = includeModelConfiguration ? savedEnvironment(configuration)
    : { ...configuration.values, ...configuration.credentials?.environment };
  // A shell endpoint must never inherit a key saved for a different endpoint.
  if (environment.OPENAI_COMPATIBLE_BASE_URL !== undefined &&
      environment.OPENAI_COMPATIBLE_BASE_URL !== saved.OPENAI_COMPATIBLE_BASE_URL) {
    delete saved.OPENAI_COMPATIBLE_API_KEY;
  }
  if (environment.GEMINI_API_KEY !== undefined) delete saved.GOOGLE_GENERATIVE_AI_API_KEY;
  if (environment.SEB_PROVIDER !== undefined || environment.SEB_MODEL !== undefined) delete saved.SEB_MODEL_PROVIDER;
  for (const [name, value] of Object.entries(saved)) {
    if (environment[name] === undefined) environment[name] = value;
  }
}

export async function readEnvironmentImport(path: string): Promise<{
  changes: Record<string, string>;
  ignored: string[];
}> {
  const content = await readBoundedUtf8File(resolve(path), MAX_CONFIGURATION_BYTES, configurationSizeError);
  if (content === null) throw new Error('The import file does not exist.');
  let parsed: ReturnType<typeof parseEnv>;
  try { parsed = parseEnv(content); }
  catch { throw new Error('The import file contains invalid dotenv syntax.'); }
  const changes: Record<string, string> = {};
  const ignored: string[] = [];
  for (const [name, input] of Object.entries(parsed)) {
    const setting = settingDefinition(name);
    if (!setting) { ignored.push(name); continue; }
    if (!input?.trim()) continue;
    const value = validateSetting(setting, input);
    if (changes[setting.name] !== undefined && changes[setting.name] !== value) {
      throw new Error(`Conflicting aliases for ${setting.name}.`);
    }
    changes[setting.name] = value;
  }
  return { changes, ignored };
}

function configurationSizeError(): Error {
  return new Error('The configuration file exceeds 64 KiB.');
}
