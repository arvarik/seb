import {
  DEFAULT_PROVIDER_MODELS,
  MODEL_PROVIDER_IDS,
  resolveModelProvider,
  validateModelProviderId,
  validateOpenAICompatibleBaseURL,
  type ModelProviderCredentials,
  type ModelProviderId,
  type ResolvedModelProvider,
} from './model-provider.js';
import {
  FileModelSettingsStore,
  type ModelSettingsStore,
  type ProviderModelSettings,
  type SebModelSettings,
} from './model-settings.js';
import {
  FileSetupCredentialStore,
  type SebSetupCredentials,
  type SetupCredentialStore,
} from '../setup/credentials.js';

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

export interface LoadModelProviderOptions {
  baseURL?: string;
  credentialStore?: SetupCredentialStore;
  environment?: NodeJS.ProcessEnv;
  fallbackModel?: string;
  model?: string;
  provider?: string;
  settingsStore?: ModelSettingsStore;
}

export interface LoadedModelConfiguration {
  credentials: SebSetupCredentials | null;
  selection: ResolvedModelProvider;
  settings: SebModelSettings | null;
}

/** Loads private credentials and non-secret settings, then resolves one provider. */
export async function loadModelConfiguration(
  options: LoadModelProviderOptions = {},
): Promise<LoadedModelConfiguration> {
  const environment = options.environment ?? process.env;
  const credentialStore = options.credentialStore ??
    new FileSetupCredentialStore({ environment });
  const settingsStore = options.settingsStore ??
    new FileModelSettingsStore({ environment });
  const [credentials, settings] = await Promise.all([
    credentialStore.load(),
    settingsStore.load(),
  ]);
  const selection = resolveLoadedModelProvider({
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    credentials,
    environment,
    ...(options.fallbackModel === undefined
      ? {}
      : { fallbackModel: options.fallbackModel }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.provider === undefined ? {} : { provider: options.provider }),
    settings,
  });
  return { credentials, selection, settings };
}

export function resolveLoadedModelProvider(
  options: Omit<LoadModelProviderOptions, 'credentialStore' | 'settingsStore'> & {
    credentials?: SebSetupCredentials | null;
    settings?: SebModelSettings | null;
  } = {},
): ResolvedModelProvider {
  const environment = options.environment ?? process.env;
  const savedCredentials = options.credentials?.keys ?? {};
  const requestedProvider = firstNonEmpty([
    options.provider,
    providerFromQualifiedModel(options.model),
    environment.SEB_MODEL_PROVIDER,
    environment.SEB_PROVIDER,
    providerFromQualifiedModel(environment.SEB_MODEL),
    options.settings?.activeProvider,
  ]);
  const provider = requestedProvider
    ? validateModelProviderId(requestedProvider)
    : discoverProviderFromAllConfiguration(
        environment,
        savedCredentials,
        options.settings,
      );
  const saved = provider ? options.settings?.providers[provider] : undefined;
  const variables = provider ? PROVIDER_MODEL_ENVIRONMENT[provider] : undefined;
  const explicitModel = nonEmpty(options.model);
  const model = firstNonEmpty([
    explicitModel,
    environment.SEB_MODEL,
    variables ? environment[variables.model] : undefined,
    saved?.model,
    provider ? DEFAULT_PROVIDER_MODELS[provider].model ?? undefined : undefined,
  ]);
  const fallbackModel = firstNonEmpty([
    options.fallbackModel,
    explicitModel ? model : undefined,
    environment.SEB_FALLBACK_MODEL,
    variables ? environment[variables.fallback] : undefined,
    saved?.fallbackModel,
    provider
      ? DEFAULT_PROVIDER_MODELS[provider].fallbackModel ?? model
      : undefined,
    model,
  ]);
  const baseURL = provider === 'openai-compatible'
    ? firstNonEmpty([
        options.baseURL,
        environment.OPENAI_COMPATIBLE_BASE_URL,
        saved?.baseURL,
      ])
    : undefined;
  const canonicalBaseURL = baseURL
    ? validateOpenAICompatibleBaseURL(baseURL)
    : undefined;
  const credentials = { ...savedCredentials };
  if (
    provider === 'openai-compatible' &&
    credentials['openai-compatible'] &&
    options.credentials?.compatibleBaseURL !== canonicalBaseURL
  ) {
    delete credentials['openai-compatible'];
  }

  return resolveModelProvider({
    ...(canonicalBaseURL ? { baseURL: canonicalBaseURL } : {}),
    credentials,
    environment,
    ...(fallbackModel ? { fallbackModel } : {}),
    ...(model ? { model } : {}),
    ...(provider ? { provider } : {}),
  });
}

/** Returns each provider that has enough data for a model request. */
export function configuredModelProviders(options: {
  credentials?: SebSetupCredentials | null;
  environment?: NodeJS.ProcessEnv;
  settings?: SebModelSettings | null;
} = {}): ModelProviderId[] {
  const environment = options.environment ?? process.env;
  const providers: ModelProviderId[] = [];
  for (const provider of MODEL_PROVIDER_IDS) {
    const saved = options.settings?.providers[provider];
    if (!hasProviderAccess(
      provider,
      environment,
      options.credentials?.keys,
      saved,
    )) {
      continue;
    }
    try {
      resolveLoadedModelProvider({
        environment,
        provider,
        ...(options.credentials === undefined
          ? {}
          : { credentials: options.credentials }),
        ...(options.settings === undefined ? {} : { settings: options.settings }),
      });
      providers.push(provider);
    } catch {
      // A partial provider configuration is not ready for model requests.
    }
  }
  return providers;
}

function discoverProviderFromAllConfiguration(
  environment: NodeJS.ProcessEnv,
  credentials: ModelProviderCredentials,
  settings: SebModelSettings | null | undefined,
): ModelProviderId | undefined {
  for (const provider of MODEL_PROVIDER_IDS) {
    const saved = settings?.providers[provider];
    if (hasProviderAccess(provider, environment, credentials, saved)) {
      return provider;
    }
  }
  return undefined;
}

function hasProviderAccess(
  provider: ModelProviderId,
  environment: NodeJS.ProcessEnv,
  credentials: ModelProviderCredentials | undefined,
  saved: ProviderModelSettings | undefined,
): boolean {
  if (provider === 'google') {
    return Boolean(
      nonEmpty(environment.GOOGLE_GENERATIVE_AI_API_KEY) ??
      nonEmpty(environment.GEMINI_API_KEY) ??
      nonEmpty(credentials?.google),
    );
  }
  if (provider === 'anthropic') {
    return Boolean(
      nonEmpty(environment.ANTHROPIC_API_KEY) ??
      nonEmpty(credentials?.anthropic),
    );
  }
  if (provider === 'openai') {
    return Boolean(
      nonEmpty(environment.OPENAI_API_KEY) ??
      nonEmpty(credentials?.openai),
    );
  }
  return Boolean(
    nonEmpty(environment.OPENAI_COMPATIBLE_BASE_URL) ?? saved?.baseURL,
  );
}

function providerFromQualifiedModel(value: string | undefined): string | undefined {
  const normalized = nonEmpty(value);
  if (!normalized) return undefined;
  const separator = normalized.indexOf(':');
  if (separator < 1) return undefined;
  const provider = normalized.slice(0, separator);
  return MODEL_PROVIDER_IDS.includes(provider as ModelProviderId)
    ? provider
    : undefined;
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
