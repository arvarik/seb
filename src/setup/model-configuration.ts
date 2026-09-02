import {
  DEFAULT_PROVIDER_MODELS,
  MODEL_PROVIDER_IDS,
  MODEL_PROVIDER_LABELS,
  resolveModelProvider,
  resolveProviderApiKey,
  validateModelProviderApiKey,
  validateModelId,
  validateModelProviderId,
  validateOpenAICompatibleBaseURL,
  type ModelProviderCredentials,
  type ModelProviderId,
  type ResolvedModelProvider,
} from '../ai/model-provider.js';
import {
  createModelSettings,
  setActiveModelProvider,
  setProviderModelSettings,
  type ModelSettingsStore,
  type ProviderModelSettings,
  type SebModelSettings,
} from '../ai/model-settings.js';
import { formatModelErrorForUser } from '../model-capacity-error.js';
import {
  createSetupCredentials,
  type SetupCredentialStore,
} from './credentials.js';
import type { SetupPrompt, SetupPromptChoice } from './prompt.js';

const MAX_MODELS_RESPONSE_BYTES = 1024 * 1024;
const MAX_DISCOVERED_MODELS = 100;
const MANUAL_MODEL_CHOICE = '!enter-model-id';
const KEEP_COMPATIBLE_KEY = '!keep-compatible-key';
const REPLACE_COMPATIBLE_KEY = '!replace-compatible-key';
const ENTER_COMPATIBLE_KEY = '!enter-compatible-key';
const REMOVE_COMPATIBLE_KEY = '!remove-compatible-key';
const PROVIDER_MODEL_ENVIRONMENT: Readonly<
  Record<ModelProviderId, { fallback: string; model: string }>
> = {
  anthropic: {
    fallback: 'ANTHROPIC_FALLBACK_MODEL',
    model: 'ANTHROPIC_MODEL',
  },
  google: {
    fallback: 'GEMINI_FALLBACK_MODEL',
    model: 'GEMINI_MODEL',
  },
  openai: {
    fallback: 'OPENAI_FALLBACK_MODEL',
    model: 'OPENAI_MODEL',
  },
  'openai-compatible': {
    fallback: 'OPENAI_COMPATIBLE_FALLBACK_MODEL',
    model: 'OPENAI_COMPATIBLE_MODEL',
  },
};

export interface ModelConfigurationVerification {
  fallbackUsed: boolean;
  model: string;
}

export interface ModelConfigurationWizardOptions {
  credentialStore: SetupCredentialStore;
  environment: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  prompt: SetupPrompt;
  settingsStore: ModelSettingsStore;
  verify: (
    selection: ResolvedModelProvider,
    signal: AbortSignal,
  ) => Promise<ModelConfigurationVerification>;
  write?: (text: string) => void;
}

export interface ModelConfigurationWizardResult {
  selection: ResolvedModelProvider;
  settings: SebModelSettings;
  verification: ModelConfigurationVerification;
}

export class ModelConfigurationWizardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelConfigurationWizardError';
  }
}

type ProviderKeyDecision =
  | { action: 'keep' }
  | { action: 'remove' }
  | { action: 'replace'; apiKey: string };

/** Collects one provider configuration through prompts that never enter chat history. */
export async function runModelConfigurationWizard(
  options: ModelConfigurationWizardOptions,
): Promise<ModelConfigurationWizardResult> {
  const [storedCredentials, storedSettings] = await Promise.all([
    options.credentialStore.load(),
    options.settingsStore.load(),
  ]);
  const environmentProvider = explicitEnvironmentProvider(options.environment);
  const provider = await options.prompt.select(
    'Select a model provider.',
    providerChoices(),
    environmentProvider?.provider ??
      storedSettings?.activeProvider ??
      discoverDefaultProvider(options.environment),
  );
  if (environmentProvider && provider !== environmentProvider.provider) {
    throw new ModelConfigurationWizardError(
      `The environment selects ${MODEL_PROVIDER_LABELS[environmentProvider.provider]} through ${environmentProvider.variable}. Remove ${environmentProvider.variable} before you configure ${MODEL_PROVIDER_LABELS[provider]}.`,
    );
  }
  const savedProviderSettings = storedSettings?.providers[provider];
  const savedKeys = storedCredentials?.keys ?? {};
  const credentials: ModelProviderCredentials = { ...savedKeys };
  const baseURL = provider === 'openai-compatible'
    ? await readCompatibleBaseURL(
        options.prompt,
        options.environment,
        savedProviderSettings?.baseURL,
      )
    : undefined;
  if (provider === 'openai-compatible' && baseURL) {
    await confirmRemoteEndpoint(options.prompt, baseURL);
  }
  if (
    provider === 'openai-compatible' &&
    credentials['openai-compatible'] &&
    storedCredentials?.compatibleBaseURL !== baseURL
  ) {
    delete credentials['openai-compatible'];
    options.write?.(
      'The saved OpenAI-compatible key belongs to another endpoint. Seb will not send it to this endpoint.\n',
    );
  }
  const keyDecision = await readProviderKey(
    provider,
    options.prompt,
    options.environment,
    credentials,
  );
  if (keyDecision.action === 'replace') {
    credentials[provider] = keyDecision.apiKey;
  } else if (keyDecision.action === 'remove') {
    delete credentials[provider];
  }

  const model = await readModel(
    provider,
    options,
    baseURL,
    resolveProviderApiKey(provider, options.environment, credentials),
    savedProviderSettings?.model,
  );
  const fallbackModel = await readFallbackModel(
    provider,
    options,
    savedProviderSettings?.fallbackModel,
    model,
  );
  const selection = resolveModelProvider({
    ...(baseURL ? { baseURL } : {}),
    credentials,
    environment: options.environment,
    fallbackModel,
    model,
    provider,
  });

  options.write?.(`Testing ${MODEL_PROVIDER_LABELS[provider]} with ${model}...\n`);
  let verification: ModelConfigurationVerification;
  try {
    verification = await options.verify(
      selection,
      AbortSignal.timeout(30_000),
    );
  } catch (error) {
    const credentialName = selection.apiKey
      ? providerCredentialName(provider)
      : undefined;
    throw new ModelConfigurationWizardError(
      formatModelErrorForUser(error, 'cli', {
        ...(credentialName ? { credentialName } : {}),
        providerLabel: MODEL_PROVIDER_LABELS[provider],
      }),
    );
  }

  const now = options.now?.() ?? new Date();
  const providerSettings = {
    ...(baseURL ? { baseURL } : {}),
    fallbackModel,
    model,
  };
  let nextSettings: SebModelSettings | undefined;
  await withConfigurationCommitLock(options.credentialStore, async () => {
    const [currentCredentials, currentSettings] = await Promise.all([
      options.credentialStore.load(),
      options.settingsStore.load(),
    ]);
    const persistedKeys: ModelProviderCredentials = {
      ...currentCredentials?.keys,
    };
    let compatibleBaseURL = currentCredentials?.compatibleBaseURL;
    if (
      provider === 'openai-compatible' &&
      persistedKeys['openai-compatible'] &&
      compatibleBaseURL !== baseURL
    ) {
      delete persistedKeys['openai-compatible'];
      compatibleBaseURL = undefined;
    }
    if (keyDecision.action === 'remove') {
      delete persistedKeys[provider];
      if (provider === 'openai-compatible') compatibleBaseURL = undefined;
    } else if (keyDecision.action === 'replace') {
      persistedKeys[provider] = keyDecision.apiKey;
      if (provider === 'openai-compatible') compatibleBaseURL = baseURL;
    }

    const nextCredentials = createSetupCredentials(
      persistedKeys,
      now,
      persistedKeys['openai-compatible'] ? compatibleBaseURL : undefined,
    );
    nextSettings = buildSettings(
      currentSettings,
      provider,
      providerSettings,
      now,
    );
    let credentialsChanged = false;
    if (Object.keys(nextCredentials.keys).length > 0) {
      await options.credentialStore.save(nextCredentials);
      credentialsChanged = true;
    } else if (currentCredentials) {
      await options.credentialStore.remove();
      credentialsChanged = true;
    }
    try {
      await options.settingsStore.save(nextSettings);
    } catch (error) {
      if (credentialsChanged) {
        try {
          if (currentCredentials) {
            await options.credentialStore.save(currentCredentials);
          } else {
            await options.credentialStore.remove();
          }
        } catch {
          throw new ModelConfigurationWizardError(
            'Seb could not save the model settings or restore the previous credentials.',
          );
        }
      }
      throw error;
    }
  });
  if (!nextSettings) {
    throw new ModelConfigurationWizardError(
      'Seb could not save the model configuration.',
    );
  }

  return { selection, settings: nextSettings, verification };
}

async function withConfigurationCommitLock<T>(
  store: SetupCredentialStore,
  commit: () => Promise<T>,
): Promise<T> {
  if (!store.withConfigurationCommitLock) return commit();
  return store.withConfigurationCommitLock(commit);
}

/** Reads model IDs from an OpenAI-compatible GET /models endpoint. */
export async function discoverOpenAICompatibleModels(options: {
  apiKey?: string;
  baseURL: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}): Promise<string[]> {
  const baseURL = validateOpenAICompatibleBaseURL(options.baseURL);
  const apiKey = options.apiKey === undefined
    ? undefined
    : validateModelProviderApiKey(
        options.apiKey,
        'The OpenAI-compatible API key',
      );
  const response = await (options.fetch ?? globalThis.fetch)(
    `${baseURL}/models`,
    {
      ...(apiKey
        ? { headers: { Authorization: `Bearer ${apiKey}` } }
        : {}),
      redirect: 'error',
      signal: options.signal ?? AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) {
    throw new Error(`The model list request returned HTTP ${response.status}.`);
  }
  const contentLength = Number(response.headers.get('content-length') ?? '0');
  if (contentLength > MAX_MODELS_RESPONSE_BYTES) {
    throw new Error('The model list response exceeds 1 MiB.');
  }
  const text = await readBoundedResponseText(
    response,
    MAX_MODELS_RESPONSE_BYTES,
  );

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('The model list response contains invalid JSON.');
  }
  if (!isRecord(value) || !Array.isArray(value.data)) {
    throw new Error('The model list response needs one data array.');
  }

  const models = new Set<string>();
  for (const item of value.data.slice(0, MAX_DISCOVERED_MODELS)) {
    if (!isRecord(item) || typeof item.id !== 'string') continue;
    try {
      models.add(validateModelId(item.id));
    } catch {
      // Ignore one invalid model entry and keep the valid model IDs.
    }
  }
  return [...models].sort((left, right) => left.localeCompare(right));
}

function providerChoices(): SetupPromptChoice<ModelProviderId>[] {
  return MODEL_PROVIDER_IDS.map((provider) => ({
    description: providerDescription(provider),
    label: MODEL_PROVIDER_LABELS[provider],
    value: provider,
  }));
}

function providerDescription(provider: ModelProviderId): string {
  switch (provider) {
    case 'google':
      return 'Uses a Gemini API key and Google Search grounding.';
    case 'anthropic':
      return 'Uses an Anthropic API key.';
    case 'openai':
      return 'Uses an OpenAI API key.';
    case 'openai-compatible':
      return 'Uses a local or HTTPS OpenAI-compatible API.';
  }
}

function providerCredentialName(provider: ModelProviderId): string | undefined {
  switch (provider) {
    case 'google':
      return 'GOOGLE_GENERATIVE_AI_API_KEY';
    case 'anthropic':
      return 'ANTHROPIC_API_KEY';
    case 'openai':
      return 'OPENAI_API_KEY';
    case 'openai-compatible':
      return 'OPENAI_COMPATIBLE_API_KEY';
  }
}

async function readProviderKey(
  provider: ModelProviderId,
  prompt: SetupPrompt,
  environment: NodeJS.ProcessEnv,
  credentials: ModelProviderCredentials,
): Promise<ProviderKeyDecision> {
  const savedKey = credentials[provider];
  const environmentKey = resolveProviderApiKey(provider, environment, {});
  if (environmentKey) {
    const useEnvironment = await prompt.confirm(
      `${MODEL_PROVIDER_LABELS[provider]} has an API key in the environment. Use it`,
      true,
    );
    if (useEnvironment) return { action: 'keep' };
    throw new Error(
      'Remove the provider API key from the environment before you save another key.',
    );
  }

  if (provider === 'openai-compatible') {
    return readCompatibleProviderKey(prompt, savedKey !== undefined);
  }

  const key = await prompt.text(
    `${MODEL_PROVIDER_LABELS[provider]} API key`,
    {
      ...(savedKey ? { defaultValue: savedKey } : {}),
      required: true,
      secret: true,
    },
  );
  if (key) return { action: 'replace', apiKey: key };
  if (savedKey) return { action: 'keep' };
  throw new Error(`${MODEL_PROVIDER_LABELS[provider]} needs an API key.`);
}

async function readCompatibleProviderKey(
  prompt: SetupPrompt,
  hasSavedKey: boolean,
): Promise<ProviderKeyDecision> {
  if (hasSavedKey) {
    const action = await prompt.select(
      'Choose the API key for this OpenAI-compatible endpoint.',
      [
        {
          description: 'Uses the key already bound to this endpoint.',
          label: 'Keep saved key',
          value: KEEP_COMPATIBLE_KEY,
        },
        {
          description: 'Saves a new key for this endpoint.',
          label: 'Replace saved key',
          value: REPLACE_COMPATIBLE_KEY,
        },
        {
          description: 'Deletes the saved key and sends requests without one.',
          label: 'Use no key',
          value: REMOVE_COMPATIBLE_KEY,
        },
      ],
      KEEP_COMPATIBLE_KEY,
    );
    if (action === KEEP_COMPATIBLE_KEY) return { action: 'keep' };
    if (action === REMOVE_COMPATIBLE_KEY) return { action: 'remove' };
  } else {
    const action = await prompt.select(
      'Choose the API key for this OpenAI-compatible endpoint.',
      [
        {
          description: 'Prompts for a key and binds it to this endpoint.',
          label: 'Enter a key for this endpoint',
          value: ENTER_COMPATIBLE_KEY,
        },
        {
          description: 'Sends requests to this endpoint without a key.',
          label: 'Use no key',
          value: REMOVE_COMPATIBLE_KEY,
        },
      ],
      REMOVE_COMPATIBLE_KEY,
    );
    if (action === REMOVE_COMPATIBLE_KEY) return { action: 'remove' };
  }

  const apiKey = await prompt.text('OpenAI-compatible endpoint API key', {
    required: true,
    secret: true,
  });
  return { action: 'replace', apiKey };
}

async function readCompatibleBaseURL(
  prompt: SetupPrompt,
  environment: NodeJS.ProcessEnv,
  savedBaseURL: string | undefined,
): Promise<string> {
  const environmentBaseURL = environment.OPENAI_COMPATIBLE_BASE_URL?.trim();
  if (environmentBaseURL) {
    const useEnvironment = await prompt.confirm(
      `The environment sets ${environmentBaseURL}. Use this base URL`,
      true,
    );
    if (!useEnvironment) {
      throw new Error(
        'Remove OPENAI_COMPATIBLE_BASE_URL before you save another base URL.',
      );
    }
    return validateOpenAICompatibleBaseURL(environmentBaseURL);
  }
  const value = await prompt.text('OpenAI-compatible API base URL', {
    ...(savedBaseURL ? { defaultValue: savedBaseURL } : {}),
    required: true,
  });
  return validateOpenAICompatibleBaseURL(value);
}

async function confirmRemoteEndpoint(
  prompt: SetupPrompt,
  baseURL: string,
): Promise<void> {
  const url = new URL(baseURL);
  if (isLoopbackHost(url.hostname)) return;
  const confirmed = await prompt.confirm(
    `Seb will send prompts, tool results, and an optional key to ${url.origin}. Continue`,
    false,
  );
  if (!confirmed) throw new Error('The remote endpoint was not approved.');
}

async function readModel(
  provider: ModelProviderId,
  options: ModelConfigurationWizardOptions,
  baseURL: string | undefined,
  apiKey: string | undefined,
  savedModel: string | undefined,
): Promise<string> {
  const environmentModel = readEnvironmentModel(
    provider,
    options.environment,
    'model',
  );
  if (environmentModel) {
    options.write?.(
      `Using model ${environmentModel} from the environment.\n`,
    );
    return environmentModel;
  }
  if (provider === 'openai-compatible' && baseURL) {
    try {
      const discovered = await discoverOpenAICompatibleModels({
        ...(apiKey ? { apiKey } : {}),
        baseURL,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
      if (discovered.length > 0) {
        const choices: SetupPromptChoice[] = [
          ...discovered.slice(0, 25).map((model) => ({ label: model, value: model })),
          { label: 'Enter another model ID', value: MANUAL_MODEL_CHOICE },
        ];
        const selected = await options.prompt.select(
          'Select a model from the endpoint.',
          choices,
          savedModel && discovered.includes(savedModel) ? savedModel : undefined,
        );
        if (selected !== MANUAL_MODEL_CHOICE) return validateModelId(selected);
      }
    } catch {
      options.write?.(
        'Seb could not read the endpoint model list. Enter the model ID manually.\n',
      );
    }
  }

  const defaultModel = savedModel ?? DEFAULT_PROVIDER_MODELS[provider].model ?? undefined;
  const value = await options.prompt.text('Primary model ID', {
    ...(defaultModel ? { defaultValue: defaultModel } : {}),
    required: true,
  });
  return validateModelId(value, 'The primary model');
}

async function readFallbackModel(
  provider: ModelProviderId,
  options: ModelConfigurationWizardOptions,
  savedFallback: string | undefined,
  model: string,
): Promise<string> {
  const environmentFallback = readEnvironmentModel(
    provider,
    options.environment,
    'fallback',
  );
  if (environmentFallback) {
    options.write?.(
      `Using fallback model ${environmentFallback} from the environment.\n`,
    );
    return environmentFallback;
  }
  const defaultFallback = savedFallback ??
    DEFAULT_PROVIDER_MODELS[provider].fallbackModel ??
    model;
  const value = await options.prompt.text(
    'Fallback model ID. Use the primary model to disable fallback',
    { defaultValue: defaultFallback, required: true },
  );
  return validateModelId(value, 'The fallback model');
}

function readEnvironmentModel(
  provider: ModelProviderId,
  environment: NodeJS.ProcessEnv,
  kind: 'fallback' | 'model',
): string | undefined {
  const genericVariable = kind === 'model' ? 'SEB_MODEL' : 'SEB_FALLBACK_MODEL';
  const providerVariable = PROVIDER_MODEL_ENVIRONMENT[provider][kind];
  const value = environment[genericVariable]?.trim() ||
    environment[providerVariable]?.trim();
  if (!value) return undefined;
  const prefix = `${provider}:`;
  return validateModelId(
    value.startsWith(prefix) ? value.slice(prefix.length) : value,
    kind === 'model' ? 'The primary model' : 'The fallback model',
  );
}

function buildSettings(
  current: SebModelSettings | null,
  provider: ModelProviderId,
  providerSettings: ProviderModelSettings,
  now: Date,
): SebModelSettings {
  if (!current) {
    return createModelSettings(provider, { [provider]: providerSettings }, now);
  }
  const updated = setProviderModelSettings(
    current,
    provider,
    providerSettings,
    now,
  );
  return setActiveModelProvider(updated, provider, now);
}

function discoverDefaultProvider(
  environment: NodeJS.ProcessEnv,
): ModelProviderId | undefined {
  if (environment.GOOGLE_GENERATIVE_AI_API_KEY?.trim() || environment.GEMINI_API_KEY?.trim()) {
    return 'google';
  }
  if (environment.ANTHROPIC_API_KEY?.trim()) return 'anthropic';
  if (environment.OPENAI_API_KEY?.trim()) return 'openai';
  if (environment.OPENAI_COMPATIBLE_BASE_URL?.trim()) return 'openai-compatible';
  return undefined;
}

function explicitEnvironmentProvider(
  environment: NodeJS.ProcessEnv,
): { provider: ModelProviderId; variable: string } | undefined {
  for (const variable of ['SEB_MODEL_PROVIDER', 'SEB_PROVIDER'] as const) {
    const value = environment[variable]?.trim();
    if (value) {
      return { provider: validateModelProviderId(value), variable };
    }
  }
  const model = environment.SEB_MODEL?.trim();
  if (!model) return undefined;
  const separator = model.indexOf(':');
  if (separator < 1) return undefined;
  const prefix = model.slice(0, separator);
  if (!MODEL_PROVIDER_IDS.includes(prefix as ModelProviderId)) return undefined;
  return { provider: prefix as ModelProviderId, variable: 'SEB_MODEL' };
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/u.test(normalized);
}

async function readBoundedResponseText(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let byteCount = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      byteCount += chunk.value.byteLength;
      if (byteCount > maximumBytes) {
        await reader.cancel();
        throw new Error('The model list response exceeds 1 MiB.');
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
