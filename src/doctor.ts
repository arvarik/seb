import { LearningStore } from './learning/store.js';
import { createGoogle } from '@ai-sdk/google';
import {
  generateText,
  stepCountIs,
  streamText,
  tool,
  type TelemetryOptions,
} from 'ai';
import { existsSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

import {
  DEFAULT_GEMINI_FALLBACK_MODEL,
  DEFAULT_GEMINI_MODEL,
} from './agent.js';
import {
  currentRequestSignal,
  throwIfRequestAborted,
} from './ai/request-signal.js';
import { activeAiDevToolsTelemetry } from './ai/devtools.js';
import {
  createProviderLanguageModel,
  MODEL_PROVIDER_LABELS,
  type ResolvedModelProvider,
} from './ai/model-provider.js';
import { resolveModelSettingsPath } from './ai/model-settings.js';
import { createGeminiLanguageModel } from './gemini-model.js';
import {
  classifyModelError,
  formatModelErrorForUser,
  isModelCapacityError,
} from './model-capacity-error.js';
import { getSharedSebDatabase } from './data/sqlite-store.js';
import { NflverseClient } from './nflverse/client.js';
import { SleeperClient } from './sleeper/client.js';
import { WeatherClient } from './weather/client.js';
import { normalizeWebUrl } from './sources.js';
import { resolveSetupCredentialsPath } from './setup/credentials.js';
import {
  SebUsageTelemetry,
  type SebUsageTelemetryOptions,
} from './usage/telemetry.js';

export type DoctorStatus = 'pass' | 'fail' | 'skip';

export interface DoctorCheck {
  detail: string;
  name: string;
  status: DoctorStatus;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  ok: boolean;
}

export interface ModelProviderVerificationTelemetryOptions {
  agentKind: 'contract' | 'doctor' | 'setup';
  database?: SebUsageTelemetryOptions['database'];
  sessionId?: string;
  sessionUsage?: SebUsageTelemetryOptions['sessionUsage'];
  surface: 'cli' | 'contract' | 'interactive';
}

export type GeminiVerificationTelemetryOptions =
  ModelProviderVerificationTelemetryOptions;

export interface ModelProviderVerificationResult {
  fallbackUsed: boolean;
  model: string;
}

export interface DoctorOptions {
  environment?: NodeJS.ProcessEnv;
  geminiTelemetry?: GeminiVerificationTelemetryOptions;
  modelProvider?: ResolvedModelProvider;
  modelProviderTelemetry?: ModelProviderVerificationTelemetryOptions;
  nodeVersion?: string;
  offline: boolean;
  skipModelProviderCheck?: boolean;
  verifyGemini?: (
    apiKey: string,
    primaryModel: string,
    fallbackModel: string,
    signal: AbortSignal,
  ) => Promise<ModelProviderVerificationResult>;
  verifyModelProvider?: (
    modelProvider: ResolvedModelProvider,
    signal: AbortSignal,
  ) => Promise<ModelProviderVerificationResult>;
  verifyDatabase?: () => {
    cacheEntries: number;
    file: string;
    identities: number;
    identityLinks: number;
    schemaVersion: number;
    snapshots: number;
  };
  verifyNflverse?: () => Promise<{
    games: number;
    latestSeason: number;
  }>;
  verifySleeper?: () => Promise<{
    season: string;
    seasonType: string;
    week: number;
  }>;
  verifyWeather?: () => Promise<{
    periods: number;
    timeZone: string | null;
  }>;
  verifyPermissions?: () => DoctorCheck;
  verifyLearning?: () => Promise<{ enabled?: boolean; parameters?: unknown }>;
}

class ModelProviderVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelProviderVerificationError';
  }
}

class GeminiVerificationError extends ModelProviderVerificationError {
  constructor(message: string) {
    super(message);
    this.name = 'GeminiVerificationError';
  }
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  throwIfRequestAborted();
  const environment = options.environment ?? process.env;
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const modelProvider = options.modelProvider;
  const googleApiKey = environment.GOOGLE_GENERATIVE_AI_API_KEY?.trim();
  const geminiApiKey = environment.GEMINI_API_KEY?.trim();
  const apiKey = googleApiKey || geminiApiKey;
  const apiKeyVariable = googleApiKey
    ? 'GOOGLE_GENERATIVE_AI_API_KEY'
    : geminiApiKey
      ? 'GEMINI_API_KEY'
      : null;
  const primaryModel =
    environment.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
  const fallbackModel =
    environment.GEMINI_FALLBACK_MODEL?.trim() ||
    DEFAULT_GEMINI_FALLBACK_MODEL;
  const checks: DoctorCheck[] = [checkNodeVersion(nodeVersion)];

  checks.push(
    options.skipModelProviderCheck
      ? {
          name: 'Model provider key',
          status: 'skip',
          detail: 'Seb skipped this check because the model configuration is invalid.',
        }
      : modelProvider
      ? checkModelProviderKey(modelProvider)
      : apiKey
      ? {
          name: 'Gemini key',
          status: 'pass',
          detail: `${apiKeyVariable} is set.`,
        }
      : {
          name: 'Gemini key',
          status: 'fail',
          detail: 'Add GOOGLE_GENERATIVE_AI_API_KEY or GEMINI_API_KEY to .env.',
        },
  );
  checks.push(checkDatabase(options.verifyDatabase ?? verifyDatabase));
  checks.push(
    options.verifyPermissions?.() ?? checkLocalPermissions(environment),
  );

  try {
    const learning = await (options.verifyLearning ?? (() => new LearningStore().overrides()))();
    checks.push({ name: 'Local forecast learning', status: 'pass', detail: learning.enabled === false
      ? 'Local learning is disabled. Projections use the default parameters.'
      : learning.parameters ? 'The local forecast override passes validation.' : 'The default forecast configuration passes validation.' });
  } catch {
    throwIfRequestAborted();
    checks.push({ name: 'Local forecast learning', status: 'fail', detail: 'The local learning override is invalid or unreadable. Check .cache/learning/overrides.json.' });
  }

  if (options.offline) {
    checks.push(
      {
        name: 'Sleeper API',
        status: 'skip',
        detail: 'The offline check skipped this request.',
      },
      {
        name: 'nflverse data',
        status: 'skip',
        detail: 'The offline check skipped this request.',
      },
      {
        name: 'National Weather Service API',
        status: 'skip',
        detail: 'The offline check skipped this request.',
      },
      {
        name: modelProvider ? 'Model provider API' : 'Gemini API',
        status: 'skip',
        detail: 'The offline check skipped this request.',
      },
    );
  } else {
    const verifySleeper = options.verifySleeper ?? verifySleeperApi;
    const verifyNflverse = options.verifyNflverse ?? verifyNflverseData;
    const verifyWeather =
      options.verifyWeather ?? (() => verifyWeatherApi(environment));
    const modelSignal = requestSignalWithTimeout(currentRequestSignal(), 30_000);
    const modelCheck = options.skipModelProviderCheck
      ? Promise.resolve<DoctorCheck>({
          name: 'Model provider API',
          status: 'skip',
          detail: 'Seb skipped this request because the model configuration is invalid.',
        })
      : modelProvider
      ? createModelProviderCheck(options, modelProvider, modelSignal)
      : createLegacyGeminiCheck(
          options,
          apiKey,
          primaryModel,
          fallbackModel,
          modelSignal,
        );
    checks.push(
      ...(await Promise.all([
        checkSleeper(verifySleeper),
        checkNflverse(verifyNflverse),
        checkWeather(verifyWeather),
        modelCheck,
      ])),
    );
  }

  throwIfRequestAborted();
  return {
    checks,
    ok: checks.every((check) => check.status !== 'fail'),
  };
}

function checkDatabase(
  verify: NonNullable<DoctorOptions['verifyDatabase']>,
): DoctorCheck {
  try {
    const status = verify();
    return {
      name: 'SQLite data store',
      status: 'pass',
      detail: [
        `Schema ${status.schemaVersion}, ${status.cacheEntries} cache entries,`,
        `${status.snapshots} snapshots,`,
        `${status.identities} canonical ${status.identities === 1 ? 'identity' : 'identities'},`,
        `and ${status.identityLinks} source ${status.identityLinks === 1 ? 'link' : 'links'} at ${status.file}.`,
      ].join(' '),
    };
  } catch (error) {
    return {
      name: 'SQLite data store',
      status: 'fail',
      detail: errorMessage(error),
    };
  }
}

function verifyDatabase() {
  return getSharedSebDatabase().status();
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines = ['Seb doctor', ''];
  for (const check of report.checks) {
    const symbol =
      check.status === 'pass' ? '✓' : check.status === 'fail' ? '✗' : '–';
    lines.push(`${symbol} ${check.name}: ${check.detail}`);
  }
  lines.push('', report.ok ? 'All required checks passed.' : 'One or more checks failed.');
  return lines.join('\n');
}

function checkNodeVersion(version: string): DoctorCheck {
  const major = Number.parseInt(version.split('.')[0] ?? '', 10);
  if (Number.isInteger(major) && major >= 22) {
    return {
      name: 'Node.js',
      status: 'pass',
      detail: `${version} satisfies the Node.js 22 requirement.`,
    };
  }
  return {
    name: 'Node.js',
    status: 'fail',
    detail: `${version} is too old. Install Node.js 22 or newer.`,
  };
}

function checkModelProviderKey(
  modelProvider: ResolvedModelProvider,
): DoctorCheck {
  const label = MODEL_PROVIDER_LABELS[modelProvider.provider];
  if (modelProvider.provider === 'openai-compatible') {
    if (!modelProvider.baseURL?.trim()) {
      return {
        name: 'Model provider key',
        status: 'fail',
        detail: 'The OpenAI-compatible provider needs a base URL.',
      };
    }
    return {
      name: 'Model provider key',
      status: 'pass',
      detail: modelProvider.apiKey?.trim()
        ? `${label} has an API key and a base URL.`
        : `${label} will connect without an API key.`,
    };
  }
  const variable = providerCredentialName(modelProvider);
  return modelProvider.apiKey?.trim()
    ? {
        name: 'Model provider key',
        status: 'pass',
        detail: `${label} has a configured ${variable}.`,
      }
    : {
        name: 'Model provider key',
        status: 'fail',
        detail: `${label} needs ${variable}.`,
      };
}

function createLegacyGeminiCheck(
  options: DoctorOptions,
  apiKey: string | undefined,
  primaryModel: string,
  fallbackModel: string,
  signal: AbortSignal,
): Promise<DoctorCheck> {
  if (!apiKey) {
    return Promise.resolve({
      name: 'Gemini API',
      status: 'skip',
      detail: 'The request needs a Gemini key.',
    });
  }
  const verifyGemini = options.verifyGemini ?? (
    (key, primary, fallback, requestSignal) =>
      verifyGeminiApi(
        key,
        primary,
        fallback,
        requestSignal,
        options.geminiTelemetry,
      )
  );
  return checkGemini(
    apiKey,
    primaryModel,
    fallbackModel,
    verifyGemini,
    signal,
  );
}

function createModelProviderCheck(
  options: DoctorOptions,
  modelProvider: ResolvedModelProvider,
  signal: AbortSignal,
): Promise<DoctorCheck> {
  if (!modelProviderReady(modelProvider)) {
    return Promise.resolve({
      name: 'Model provider API',
      status: 'skip',
      detail: `${MODEL_PROVIDER_LABELS[modelProvider.provider]} configuration is incomplete.`,
    });
  }
  const verify = options.verifyModelProvider ?? (
    (selection, requestSignal) => verifyModelProviderApi(
      selection,
      requestSignal,
      options.modelProviderTelemetry ?? options.geminiTelemetry,
    )
  );
  return checkModelProvider(modelProvider, verify, signal);
}

async function checkModelProvider(
  modelProvider: ResolvedModelProvider,
  verify: NonNullable<DoctorOptions['verifyModelProvider']>,
  signal: AbortSignal,
): Promise<DoctorCheck> {
  const label = MODEL_PROVIDER_LABELS[modelProvider.provider];
  try {
    const result = await verify(modelProvider, signal);
    const grounding = modelProvider.provider === 'google'
      ? ' and returned a grounded Google Search source'
      : '';
    const suffix = result.fallbackUsed
      ? ' The primary model had no capacity.'
      : '';
    return {
      name: 'Model provider API',
      status: 'pass',
      detail: `${label} model ${result.model} completed a local tool loop${grounding}.${suffix}`,
    };
  } catch (error) {
    const credentialName = providerCredentialName(modelProvider);
    return {
      name: 'Model provider API',
      status: 'fail',
      detail: error instanceof ModelProviderVerificationError
        ? error.message
        : formatModelErrorForUser(
            error,
            'cli',
            {
              providerLabel: label,
              ...(credentialName ? { credentialName } : {}),
            },
          ),
    };
  }
}

function modelProviderReady(modelProvider: ResolvedModelProvider): boolean {
  return modelProvider.provider === 'openai-compatible'
    ? Boolean(modelProvider.baseURL?.trim())
    : Boolean(modelProvider.apiKey?.trim());
}

function providerCredentialName(
  modelProvider: ResolvedModelProvider,
): string | undefined {
  switch (modelProvider.provider) {
    case 'google':
      return 'GOOGLE_GENERATIVE_AI_API_KEY';
    case 'anthropic':
      return 'ANTHROPIC_API_KEY';
    case 'openai':
      return 'OPENAI_API_KEY';
    case 'openai-compatible':
      return modelProvider.apiKey ? 'OPENAI_COMPATIBLE_API_KEY' : undefined;
  }
}

async function checkSleeper(
  verify: NonNullable<DoctorOptions['verifySleeper']>,
): Promise<DoctorCheck> {
  try {
    const state = await verify();
    if (!/^\d{4}$/u.test(state.season) || !Number.isInteger(state.week)) {
      throw new Error('Sleeper returned an invalid NFL state.');
    }
    return {
      name: 'Sleeper API',
      status: 'pass',
      detail: `${state.season} ${state.seasonType}, week ${state.week}.`,
    };
  } catch (error) {
    return {
      name: 'Sleeper API',
      status: 'fail',
      detail: errorMessage(error),
    };
  }
}

async function checkGemini(
  apiKey: string,
  primaryModel: string,
  fallbackModel: string,
  verify: NonNullable<DoctorOptions['verifyGemini']>,
  signal: AbortSignal,
): Promise<DoctorCheck> {
  try {
    const result = await verify(apiKey, primaryModel, fallbackModel, signal);
    const suffix = result.fallbackUsed ? ' The primary model had no capacity.' : '';
    return {
      name: 'Gemini API',
      status: 'pass',
      detail: `${result.model} completed a local tool loop and returned a grounded Google Search source.${suffix}`,
    };
  } catch (error) {
    return {
      name: 'Gemini API',
      status: 'fail',
      detail: error instanceof GeminiVerificationError
        ? error.message
        : formatModelErrorForUser(error, 'cli'),
    };
  }
}

async function checkNflverse(
  verify: NonNullable<DoctorOptions['verifyNflverse']>,
): Promise<DoctorCheck> {
  try {
    const result = await verify();
    if (result.games < 1 || !Number.isInteger(result.latestSeason)) {
      throw new Error('nflverse returned no valid schedule rows.');
    }
    return {
      name: 'nflverse data',
      status: 'pass',
      detail: `${result.games} schedule rows loaded through the ${result.latestSeason} season.`,
    };
  } catch (error) {
    return {
      name: 'nflverse data',
      status: 'fail',
      detail: errorMessage(error),
    };
  }
}

async function checkWeather(
  verify: NonNullable<DoctorOptions['verifyWeather']>,
): Promise<DoctorCheck> {
  try {
    const result = await verify();
    if (result.periods < 1) {
      throw new Error('The National Weather Service returned no hourly periods.');
    }
    return {
      name: 'National Weather Service API',
      status: 'pass',
      detail: `${result.periods} hourly periods loaded for ${result.timeZone ?? 'the test point'}.`,
    };
  } catch (error) {
    return {
      name: 'National Weather Service API',
      status: 'fail',
      detail: errorMessage(error),
    };
  }
}

async function verifySleeperApi(): Promise<{
  season: string;
  seasonType: string;
  week: number;
}> {
  const state = await new SleeperClient({ database: false, timeoutMs: 10_000 }).getNflState();
  return {
    season: state.season,
    seasonType: state.season_type,
    week: state.week,
  };
}

async function verifyNflverseData(): Promise<{
  games: number;
  latestSeason: number;
}> {
  const games = await new NflverseClient({ database: false, timeoutMs: 20_000 }).getSchedule();
  return {
    games: games.length,
    latestSeason: Math.max(...games.map((game) => game.season)),
  };
}

async function verifyWeatherApi(
  environment: NodeJS.ProcessEnv,
): Promise<{ periods: number; timeZone: string | null }> {
  const forecast = await new WeatherClient({
    database: false,
    timeoutMs: 15_000,
    ...(environment.NWS_USER_AGENT?.trim()
      ? { userAgent: environment.NWS_USER_AGENT.trim() }
      : {}),
  }).getHourlyForecast(47.5952, -122.3316);
  return { periods: forecast.periods.length, timeZone: forecast.timeZone };
}

function checkLocalPermissions(environment: NodeJS.ProcessEnv): DoctorCheck {
  if (process.platform === 'win32') {
    return {
      name: 'Local file permissions',
      status: 'skip',
      detail: 'Windows does not expose Unix permission bits.',
    };
  }
  const privateFiles = [
    resolve('.env'),
    resolveSetupCredentialsPath(environment),
    resolveModelSettingsPath(environment),
  ];
  const privateDirectories = [
    dirname(getSharedSebDatabase().file),
    ...privateFiles.slice(1).map((path) => dirname(path)),
  ];
  const paths = [...new Set([...privateFiles, ...privateDirectories])];
  const unsafe = paths.filter((path) => {
    if (!existsSync(path)) return false;
    return (statSync(path).mode & 0o077) !== 0;
  });
  if (unsafe.length > 0) {
    return {
      name: 'Local file permissions',
      status: 'fail',
      detail: `Restrict access to ${unsafe.join(', ')}. Use mode 0600 for files and 0700 for directories.`,
    };
  }
  return {
    name: 'Local file permissions',
    status: 'pass',
    detail: 'The local environment, configuration, and cache paths use private permissions.',
  };
}

export async function verifyModelProviderApi(
  modelProvider: ResolvedModelProvider,
  signal = AbortSignal.timeout(30_000),
  telemetryOptions: ModelProviderVerificationTelemetryOptions = {
    agentKind: 'doctor',
    surface: 'cli',
  },
): Promise<ModelProviderVerificationResult> {
  const telemetry = createVerificationTelemetry(telemetryOptions);
  try {
    await sendModelProviderTest(
      modelProvider,
      modelProvider.model,
      signal,
      telemetry,
    );
    return { fallbackUsed: false, model: modelProvider.model };
  } catch (error) {
    if (
      !isModelCapacityError(error) ||
      modelProvider.fallbackModel === modelProvider.model
    ) {
      throw error;
    }
    await sendModelProviderTest(
      modelProvider,
      modelProvider.fallbackModel,
      signal,
      telemetry,
    );
    return { fallbackUsed: true, model: modelProvider.fallbackModel };
  }
}

export async function verifyGeminiApi(
  apiKey: string,
  primaryModel: string,
  fallbackModel: string,
  signal = AbortSignal.timeout(30_000),
  telemetryOptions: GeminiVerificationTelemetryOptions = {
    agentKind: 'doctor',
    surface: 'cli',
  },
): Promise<ModelProviderVerificationResult> {
  const telemetry = createVerificationTelemetry(telemetryOptions);
  try {
    await sendGeminiTest(apiKey, primaryModel, signal, telemetry);
    return { fallbackUsed: false, model: primaryModel };
  } catch (error) {
    if (!isModelCapacityError(error) || fallbackModel === primaryModel) {
      throw error;
    }
    await sendGeminiTest(apiKey, fallbackModel, signal, telemetry);
    return { fallbackUsed: true, model: fallbackModel };
  }
}

function createVerificationTelemetry(
  telemetryOptions: ModelProviderVerificationTelemetryOptions,
): TelemetryOptions {
  const usageTelemetry = new SebUsageTelemetry({
    agentKind: telemetryOptions.agentKind,
    database: telemetryOptions.database ?? getSharedSebDatabase(),
    ...(telemetryOptions.sessionId === undefined
      ? {}
      : { sessionId: telemetryOptions.sessionId }),
    ...(telemetryOptions.sessionUsage === undefined
      ? {}
      : { sessionUsage: telemetryOptions.sessionUsage }),
    surface: telemetryOptions.surface,
  });
  const devToolsTelemetry = activeAiDevToolsTelemetry();
  const recordContent = devToolsTelemetry.length > 0;
  return {
    functionId: `seb.${telemetryOptions.surface}.${telemetryOptions.agentKind}`,
    integrations: [...devToolsTelemetry, usageTelemetry],
    isEnabled: true,
    recordInputs: recordContent,
    recordOutputs: recordContent,
  } satisfies TelemetryOptions;
}

async function sendModelProviderTest(
  modelProvider: ResolvedModelProvider,
  model: string,
  signal: AbortSignal,
  telemetry: TelemetryOptions,
): Promise<void> {
  if (modelProvider.provider === 'google') {
    const apiKey = modelProvider.apiKey?.trim();
    if (!apiKey) {
      throw new ModelProviderVerificationError(
        'Google Gemini needs GOOGLE_GENERATIVE_AI_API_KEY.',
      );
    }
    await sendGeminiTest(apiKey, model, signal, telemetry);
    return;
  }

  const localResult = streamText({
    model: createProviderLanguageModel(modelProvider, model),
    tools: {
      verifyLocalTool: tool({
        description: 'Returns a fixed marker for the Seb local tool-loop check.',
        inputSchema: z.object({ marker: z.literal('seb') }),
        execute: ({ marker }) => ({ marker: `${marker}-tool-ok` }),
      }),
    },
    prompt: [
      'Call verifyLocalTool once with the marker seb.',
      'After the tool returns, write only SEB_TOOL_LOOP_OK.',
    ].join(' '),
    maxOutputTokens: 1_024,
    prepareStep: ({ stepNumber }) =>
      stepNumber === 0
        ? {}
        : { activeTools: [], toolChoice: 'none' },
    stopWhen: stepCountIs(3),
    abortSignal: signal,
    telemetry,
    toolChoice: { toolName: 'verifyLocalTool', type: 'tool' },
  });
  const [finishReason, text, toolResults] = await Promise.all([
    localResult.finishReason,
    localResult.text,
    localResult.toolResults,
  ]);
  const completedLocalTool = toolResults.some((toolResult) => {
    if (toolResult.toolName !== 'verifyLocalTool') return false;
    const output = toolResult.output;
    return output !== null &&
      typeof output === 'object' &&
      (output as Record<string, unknown>).marker === 'seb-tool-ok';
  });
  if (
    !completedLocalTool ||
    finishReason !== 'stop' ||
    text.trim() !== 'SEB_TOOL_LOOP_OK'
  ) {
    throw new ModelProviderVerificationError(
      `${MODEL_PROVIDER_LABELS[modelProvider.provider]} did not complete the local tool loop.`,
    );
  }
}

async function sendGeminiTest(
  apiKey: string,
  model: string,
  signal: AbortSignal,
  telemetry: TelemetryOptions,
): Promise<void> {
  const google = createGoogle({ apiKey });
  const localResult = streamText({
    model: createGeminiLanguageModel(google, model),
    tools: {
      searchCurrentNews: google.tools.googleSearch({
        searchTypes: { webSearch: {} },
      }),
      verifyLocalTool: tool({
        description: 'Returns a fixed marker for the Seb local tool-loop check.',
        inputSchema: z.object({ marker: z.literal('seb') }),
        execute: ({ marker }) => ({ marker: `${marker}-tool-ok` }),
      }),
    },
    prompt: [
      'Call verifyLocalTool once with the marker seb.',
      'After the tool returns, write only SEB_TOOL_LOOP_OK.',
    ].join(' '),
    maxOutputTokens: 1_024,
    prepareStep: ({ stepNumber }) =>
      stepNumber === 0
        ? {}
        : { activeTools: [], toolChoice: 'none' },
    stopWhen: stepCountIs(3),
    abortSignal: signal,
    telemetry,
    toolChoice: { toolName: 'verifyLocalTool', type: 'tool' },
  });
  const [localFinishReason, localText, localToolResults] = await Promise.all([
    localResult.finishReason,
    localResult.text,
    localResult.toolResults,
  ]);
  const completedLocalTool = localToolResults.some((toolResult) => {
    if (toolResult.toolName !== 'verifyLocalTool') return false;
    const output = toolResult.output;
    return output !== null &&
      typeof output === 'object' &&
      (output as Record<string, unknown>).marker === 'seb-tool-ok';
  });
  if (
    !completedLocalTool ||
    localFinishReason !== 'stop' ||
    localText.trim() !== 'SEB_TOOL_LOOP_OK'
  ) {
    throw new GeminiVerificationError(
      'Gemini did not complete the local tool loop.',
    );
  }

  const searchResult = await generateText({
    model: createGeminiLanguageModel(google, model),
    tools: {
      searchCurrentNews: google.tools.googleSearch({
        searchTypes: { webSearch: {} },
      }),
    },
    prompt: [
      'You must use searchCurrentNews to find one current NFL news report.',
      'Do not answer from model memory.',
      'Give the publisher, publication date, headline, and source link.',
    ].join(' '),
    maxOutputTokens: 1_024,
    abortSignal: signal,
    telemetry,
  });
  const hasValidWebSource = searchResult.sources.some(
    (source) =>
      source.sourceType === 'url' && normalizeWebUrl(source.url) !== null,
  );
  if (
    searchResult.finishReason !== 'stop' ||
    !searchResult.text.trim() ||
    !hasValidWebSource
  ) {
    throw new GeminiVerificationError(
      'Gemini Google Search returned no valid web source.',
    );
  }
}

function requestSignalWithTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function errorMessage(error: unknown): string {
  if (classifyModelError(error)) return formatModelErrorForUser(error);
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  return String(error);
}
