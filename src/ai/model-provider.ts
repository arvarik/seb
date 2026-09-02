import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogle } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

export const MODEL_PROVIDER_IDS = [
  'google',
  'anthropic',
  'openai',
  'openai-compatible',
] as const;

export type ModelProviderId = (typeof MODEL_PROVIDER_IDS)[number];

export interface ModelProviderCredentials {
  anthropic?: string;
  google?: string;
  openai?: string;
  'openai-compatible'?: string;
}

export interface ProviderModelDefaults {
  fallbackModel: string | null;
  model: string | null;
}

export const DEFAULT_PROVIDER_MODELS: Readonly<
  Record<ModelProviderId, ProviderModelDefaults>
> = {
  google: {
    fallbackModel: 'gemini-3.6-flash',
    model: 'gemini-3.7-flash',
  },
  anthropic: {
    fallbackModel: 'claude-haiku-4-5',
    model: 'claude-sonnet-5',
  },
  openai: {
    fallbackModel: 'gpt-5.4-mini',
    model: 'gpt-5.6-luna',
  },
  'openai-compatible': {
    fallbackModel: null,
    model: null,
  },
};

export const MODEL_PROVIDER_LABELS: Readonly<Record<ModelProviderId, string>> = {
  anthropic: 'Anthropic',
  google: 'Google Gemini',
  openai: 'OpenAI',
  'openai-compatible': 'OpenAI-compatible endpoint',
};

export interface ResolvedModelProvider {
  apiKey?: string;
  baseURL?: string;
  fallbackModel: string;
  model: string;
  provider: ModelProviderId;
}

export interface ResolveModelProviderOptions {
  baseURL?: string;
  credentials?: ModelProviderCredentials;
  environment?: NodeJS.ProcessEnv;
  fallbackModel?: string;
  model?: string;
  provider?: string;
}

export type ProviderLanguageModel = Exclude<LanguageModel, string>;

export class ModelProviderConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelProviderConfigurationError';
  }
}

const PROVIDER_PRECEDENCE: readonly ModelProviderId[] = MODEL_PROVIDER_IDS;

const API_KEY_ENVIRONMENT_VARIABLES: Readonly<
  Record<ModelProviderId, readonly string[]>
> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  google: ['GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  'openai-compatible': ['OPENAI_COMPATIBLE_API_KEY'],
};

const MODEL_ENVIRONMENT_VARIABLES: Readonly<
  Record<ModelProviderId, { fallback: string; primary: string }>
> = {
  anthropic: {
    fallback: 'ANTHROPIC_FALLBACK_MODEL',
    primary: 'ANTHROPIC_MODEL',
  },
  google: {
    fallback: 'GEMINI_FALLBACK_MODEL',
    primary: 'GEMINI_MODEL',
  },
  openai: {
    fallback: 'OPENAI_FALLBACK_MODEL',
    primary: 'OPENAI_MODEL',
  },
  'openai-compatible': {
    fallback: 'OPENAI_COMPATIBLE_FALLBACK_MODEL',
    primary: 'OPENAI_COMPATIBLE_MODEL',
  },
};

const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/+@-]{0,199}$/u;
const MAX_MODEL_PROVIDER_API_KEY_BYTES = 16 * 1024;

/** Returns every provider that has the required local configuration. */
export function discoverConfiguredModelProviders(
  options: Pick<
    ResolveModelProviderOptions,
    'baseURL' | 'credentials' | 'environment'
  > = {},
): ModelProviderId[] {
  const environment = options.environment ?? process.env;
  const credentials = options.credentials ?? {};
  const configured: ModelProviderId[] = [];

  for (const provider of PROVIDER_PRECEDENCE) {
    if (provider === 'openai-compatible') {
      const baseURL = nonEmpty(options.baseURL) ??
        nonEmpty(environment.OPENAI_COMPATIBLE_BASE_URL);
      if (baseURL) {
        validateOpenAICompatibleBaseURL(baseURL);
        configured.push(provider);
      }
      continue;
    }
    if (resolveProviderApiKey(provider, environment, credentials)) {
      configured.push(provider);
    }
  }

  return configured;
}

/** Resolves one provider, its model IDs, and its private credential. */
export function resolveModelProvider(
  options: ResolveModelProviderOptions = {},
): ResolvedModelProvider {
  const environment = options.environment ?? process.env;
  const credentials = options.credentials ?? {};
  const explicitModel = nonEmpty(options.model);
  const environmentModel = nonEmpty(environment.SEB_MODEL);
  const explicitReference = explicitModel
    ? parseQualifiedModelReference(explicitModel)
    : null;
  const environmentReference = environmentModel
    ? parseQualifiedModelReference(environmentModel)
    : null;
  const requestedProvider = firstNonEmpty([
    options.provider,
    explicitReference?.provider,
    options.baseURL ? 'openai-compatible' : undefined,
    environment.SEB_MODEL_PROVIDER,
    environment.SEB_PROVIDER,
    environmentReference?.provider,
  ]);
  const provider = requestedProvider
    ? validateModelProviderId(requestedProvider)
    : discoverFirstConfiguredModelProvider({
        ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
        credentials,
        environment,
      });

  if (!provider) {
    throw new ModelProviderConfigurationError(
      'No model provider is configured. Add a provider API key or an OpenAI-compatible base URL.',
    );
  }
  const explicitProvider = firstNonEmpty([
    options.provider,
    options.baseURL ? 'openai-compatible' : undefined,
    environment.SEB_MODEL_PROVIDER,
    environment.SEB_PROVIDER,
  ]);
  const useLiteralModelIds = provider === 'openai-compatible' &&
    explicitProvider === 'openai-compatible';
  const selectedExplicitReference = useLiteralModelIds
    ? null
    : explicitReference;
  const selectedEnvironmentReference = useLiteralModelIds
    ? null
    : environmentReference;
  assertMatchingReference(
    selectedExplicitReference,
    provider,
    'The model override',
  );
  assertMatchingReference(
    selectedEnvironmentReference,
    provider,
    'SEB_MODEL',
  );

  const apiKey = resolveProviderApiKey(provider, environment, credentials);
  const baseURL = resolveProviderBaseURL(provider, options.baseURL, environment);
  if (provider !== 'openai-compatible' && !apiKey) {
    const variable = API_KEY_ENVIRONMENT_VARIABLES[provider][0];
    throw new ModelProviderConfigurationError(
      `${MODEL_PROVIDER_LABELS[provider]} needs ${variable}.`,
    );
  }

  const providerVariables = MODEL_ENVIRONMENT_VARIABLES[provider];
  const defaultModels = DEFAULT_PROVIDER_MODELS[provider];
  const primaryValue = selectedExplicitReference?.model ??
    explicitModel ??
    selectedEnvironmentReference?.model ??
    environmentModel ??
    nonEmpty(environment[providerVariables.primary]) ??
    defaultModels.model;
  if (!primaryValue) {
    throw new ModelProviderConfigurationError(
      `${MODEL_PROVIDER_LABELS[provider]} needs a model ID.`,
    );
  }
  const model = validateModelId(primaryValue, 'The primary model');

  const explicitFallback = nonEmpty(options.fallbackModel);
  const fallbackReference = explicitFallback && !useLiteralModelIds
    ? parseQualifiedModelReference(explicitFallback)
    : null;
  const environmentFallback = nonEmpty(environment.SEB_FALLBACK_MODEL);
  const environmentFallbackReference = environmentFallback && !useLiteralModelIds
    ? parseQualifiedModelReference(environmentFallback)
    : null;
  assertMatchingReference(fallbackReference, provider, 'The fallback model');
  assertMatchingReference(
    environmentFallbackReference,
    provider,
    'SEB_FALLBACK_MODEL',
  );
  const fallbackValue = fallbackReference?.model ??
    explicitFallback ??
    (explicitModel
      ? model
      : environmentFallbackReference?.model ??
        environmentFallback ??
        nonEmpty(environment[providerVariables.fallback]) ??
        defaultModels.fallbackModel ??
        model);
  const fallbackModel = validateModelId(
    fallbackValue,
    'The fallback model',
  );

  return {
    ...(apiKey ? { apiKey } : {}),
    ...(baseURL ? { baseURL } : {}),
    fallbackModel,
    model,
    provider,
  };
}

/** Uses the exact primary or fallback model that a verification request proved. */
export function resolveVerifiedModelProvider(
  selection: ResolvedModelProvider,
  verifiedModel: string,
): ResolvedModelProvider {
  const model = validateModelId(verifiedModel, 'The verified model');
  if (model !== selection.model && model !== selection.fallbackModel) {
    throw new ModelProviderConfigurationError(
      'The verified model must equal the configured primary or fallback model.',
    );
  }
  return { ...selection, fallbackModel: model, model };
}

/** Creates an AI SDK language model for the selected provider. */
export function createProviderLanguageModel(
  selection: ResolvedModelProvider,
  requestedModel = selection.model,
): ProviderLanguageModel {
  const model = modelForSelectedProvider(requestedModel, selection.provider);
  switch (selection.provider) {
    case 'google':
      return createGoogle({ apiKey: requiredSelectionApiKey(selection) })(model);
    case 'anthropic':
      return createAnthropic({ apiKey: requiredSelectionApiKey(selection) })(model);
    case 'openai':
      return createOpenAI({ apiKey: requiredSelectionApiKey(selection) })(model);
    case 'openai-compatible': {
      const baseURL = selection.baseURL;
      if (!baseURL) {
        throw new ModelProviderConfigurationError(
          'The OpenAI-compatible provider needs a base URL.',
        );
      }
      const apiKey = selection.apiKey === undefined
        ? undefined
        : validateModelProviderApiKey(
            selection.apiKey,
            'The OpenAI-compatible API key',
          );
      return createOpenAICompatible({
        baseURL: validateOpenAICompatibleBaseURL(baseURL),
        fetch: rejectRedirectsFetch,
        includeUsage: true,
        name: 'openai-compatible',
        ...(apiKey ? { apiKey } : {}),
      })(model);
    }
  }
}

const rejectRedirectsFetch: typeof globalThis.fetch = (input, init) =>
  globalThis.fetch(input, { ...init, redirect: 'error' });

/** Returns an environment key before a saved credential. */
export function resolveProviderApiKey(
  provider: ModelProviderId,
  environment: NodeJS.ProcessEnv = process.env,
  credentials: ModelProviderCredentials = {},
): string | undefined {
  for (const variable of API_KEY_ENVIRONMENT_VARIABLES[provider]) {
    const value = environment[variable];
    if (value?.trim()) {
      return validateModelProviderApiKey(value, variable);
    }
  }
  const supplied = credentials[provider];
  return supplied === undefined
    ? undefined
    : validateModelProviderApiKey(
        supplied,
        `${MODEL_PROVIDER_LABELS[provider]} API key`,
      );
}

/** Normalizes one key and rejects unsafe header values without printing the key. */
export function validateModelProviderApiKey(
  value: string,
  label = 'The model provider API key',
): string {
  if (
    Buffer.byteLength(value, 'utf8') > MAX_MODEL_PROVIDER_API_KEY_BYTES ||
    /[\u0000-\u001F\u007F]/u.test(value)
  ) {
    throw new ModelProviderConfigurationError(`${label} contains an invalid value.`);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new ModelProviderConfigurationError(`${label} must not be empty.`);
  }
  return normalized;
}

export function validateModelProviderId(value: string): ModelProviderId {
  const normalized = value.trim();
  if (MODEL_PROVIDER_IDS.includes(normalized as ModelProviderId)) {
    return normalized as ModelProviderId;
  }
  throw new ModelProviderConfigurationError(
    `Unknown model provider: ${normalized || '<empty>'}.`,
  );
}

export function validateModelId(value: string, label = 'The model'): string {
  const normalized = value.trim();
  const pathSegments = normalized.split('/');
  if (
    !MODEL_ID_PATTERN.test(normalized) ||
    pathSegments.includes('.') ||
    pathSegments.includes('..')
  ) {
    throw new ModelProviderConfigurationError(
      `${label} must contain 1 through 200 safe model ID characters.`,
    );
  }
  return normalized;
}

export function validateOpenAICompatibleBaseURL(value: string): string {
  const normalized = value.trim();
  if (normalized.length > 2_048) {
    throw new ModelProviderConfigurationError(
      'The OpenAI-compatible base URL exceeds 2048 characters.',
    );
  }
  if (/[?#]/u.test(normalized)) {
    throw new ModelProviderConfigurationError(
      'The OpenAI-compatible base URL cannot contain a query or fragment.',
    );
  }
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new ModelProviderConfigurationError(
      'The OpenAI-compatible base URL is invalid.',
    );
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new ModelProviderConfigurationError(
      'The OpenAI-compatible base URL must use HTTP or HTTPS.',
    );
  }
  if (url.username || url.password) {
    throw new ModelProviderConfigurationError(
      'The OpenAI-compatible base URL cannot contain credentials.',
    );
  }
  if (url.search || url.hash) {
    throw new ModelProviderConfigurationError(
      'The OpenAI-compatible base URL cannot contain a query or fragment.',
    );
  }
  if (url.protocol === 'http:' && !isLoopbackHost(url.hostname)) {
    throw new ModelProviderConfigurationError(
      'An HTTP OpenAI-compatible endpoint must use a loopback host.',
    );
  }
  if (/\/(?:chat\/completions|completions|models|responses)\/?$/u.test(url.pathname)) {
    throw new ModelProviderConfigurationError(
      'Use the OpenAI-compatible API base URL, not one endpoint path.',
    );
  }
  url.pathname = url.pathname.replace(/\/+$/u, '') || '/';
  return url.toString().replace(/\/$/u, '');
}

function resolveProviderBaseURL(
  provider: ModelProviderId,
  override: string | undefined,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  const value = nonEmpty(override) ??
    nonEmpty(environment.OPENAI_COMPATIBLE_BASE_URL);
  if (provider !== 'openai-compatible') {
    if (override) {
      throw new ModelProviderConfigurationError(
        'A custom base URL requires the openai-compatible provider.',
      );
    }
    return undefined;
  }
  if (!value) {
    throw new ModelProviderConfigurationError(
      'The OpenAI-compatible provider needs OPENAI_COMPATIBLE_BASE_URL.',
    );
  }
  return validateOpenAICompatibleBaseURL(value);
}

function parseQualifiedModelReference(
  value: string,
): { model: string; provider: ModelProviderId } | null {
  const separator = value.indexOf(':');
  if (separator < 1) return null;
  const prefix = value.slice(0, separator);
  if (!MODEL_PROVIDER_IDS.includes(prefix as ModelProviderId)) return null;
  const provider = prefix as ModelProviderId;
  const model = validateModelId(
    value.slice(separator + 1),
    'The qualified model',
  );
  return { model, provider };
}

function assertMatchingReference(
  reference: { provider: ModelProviderId } | null,
  provider: ModelProviderId,
  label: string,
): void {
  if (reference && reference.provider !== provider) {
    throw new ModelProviderConfigurationError(
      `${label} selects ${reference.provider}, but the active provider is ${provider}.`,
    );
  }
}

function modelForSelectedProvider(
  value: string,
  provider: ModelProviderId,
): string {
  if (provider === 'openai-compatible') {
    return validateModelId(value, 'The requested model');
  }
  const reference = parseQualifiedModelReference(value);
  assertMatchingReference(reference, provider, 'The requested model');
  return validateModelId(reference?.model ?? value, 'The requested model');
}

function discoverFirstConfiguredModelProvider(
  options: Pick<
    ResolveModelProviderOptions,
    'baseURL' | 'credentials' | 'environment'
  >,
): ModelProviderId | undefined {
  const environment = options.environment ?? process.env;
  const credentials = options.credentials ?? {};
  for (const provider of PROVIDER_PRECEDENCE) {
    if (provider === 'openai-compatible') {
      const baseURL = nonEmpty(options.baseURL) ??
        nonEmpty(environment.OPENAI_COMPATIBLE_BASE_URL);
      if (!baseURL) continue;
      validateOpenAICompatibleBaseURL(baseURL);
      return provider;
    }
    if (resolveProviderApiKey(provider, environment, credentials)) {
      return provider;
    }
  }
  return undefined;
}

function requiredSelectionApiKey(selection: ResolvedModelProvider): string {
  const apiKey = selection.apiKey === undefined
    ? undefined
    : validateModelProviderApiKey(
        selection.apiKey,
        `${MODEL_PROVIDER_LABELS[selection.provider]} API key`,
      );
  if (!apiKey) {
    const variable = API_KEY_ENVIRONMENT_VARIABLES[selection.provider][0];
    throw new ModelProviderConfigurationError(
      `${MODEL_PROVIDER_LABELS[selection.provider]} needs ${variable}.`,
    );
  }
  return apiKey;
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === '[::1]' ||
    /^127(?:\.\d{1,3}){3}$/u.test(normalized);
}

function firstNonEmpty(values: readonly (string | undefined)[]): string | undefined {
  for (const value of values) {
    const normalized = nonEmpty(value);
    if (normalized) return normalized;
  }
  return undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}
