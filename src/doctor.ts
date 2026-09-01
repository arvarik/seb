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

export interface GeminiVerificationTelemetryOptions {
  agentKind: 'contract' | 'doctor' | 'setup';
  database?: SebUsageTelemetryOptions['database'];
  sessionId?: string;
  sessionUsage?: SebUsageTelemetryOptions['sessionUsage'];
  surface: 'cli' | 'contract' | 'interactive';
}

export interface DoctorOptions {
  environment?: NodeJS.ProcessEnv;
  geminiTelemetry?: GeminiVerificationTelemetryOptions;
  nodeVersion?: string;
  offline: boolean;
  verifyGemini?: (
    apiKey: string,
    primaryModel: string,
    fallbackModel: string,
    signal: AbortSignal,
  ) => Promise<{ fallbackUsed: boolean; model: string }>;
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
}

class GeminiVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeminiVerificationError';
  }
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  throwIfRequestAborted();
  const environment = options.environment ?? process.env;
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const apiKey = environment.GOOGLE_GENERATIVE_AI_API_KEY?.trim();
  const primaryModel =
    environment.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
  const fallbackModel =
    environment.GEMINI_FALLBACK_MODEL?.trim() ||
    DEFAULT_GEMINI_FALLBACK_MODEL;
  const checks: DoctorCheck[] = [checkNodeVersion(nodeVersion)];

  checks.push(
    apiKey
      ? {
          name: 'Gemini key',
          status: 'pass',
          detail: 'GOOGLE_GENERATIVE_AI_API_KEY is set.',
        }
      : {
          name: 'Gemini key',
          status: 'fail',
          detail: 'Add GOOGLE_GENERATIVE_AI_API_KEY to .env.',
        },
  );
  checks.push(checkDatabase(options.verifyDatabase ?? verifyDatabase));
  checks.push(options.verifyPermissions?.() ?? checkLocalPermissions());

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
        name: 'Gemini API',
        status: 'skip',
        detail: 'The offline check skipped this request.',
      },
    );
  } else {
    const verifySleeper = options.verifySleeper ?? verifySleeperApi;
    const verifyNflverse = options.verifyNflverse ?? verifyNflverseData;
    const verifyWeather =
      options.verifyWeather ?? (() => verifyWeatherApi(environment));
    const verifyGemini = options.verifyGemini ?? (
      (key, primary, fallback, signal) =>
        verifyGeminiApi(
          key,
          primary,
          fallback,
          signal,
          options.geminiTelemetry,
        )
    );
    const geminiSignal = requestSignalWithTimeout(currentRequestSignal(), 30_000);
    const geminiCheck = apiKey
      ? checkGemini(
          apiKey,
          primaryModel,
          fallbackModel,
          verifyGemini,
          geminiSignal,
        )
      : Promise.resolve<DoctorCheck>({
        name: 'Gemini API',
        status: 'skip',
        detail: 'The request needs a Gemini key.',
      });
    checks.push(
      ...(await Promise.all([
        checkSleeper(verifySleeper),
        checkNflverse(verifyNflverse),
        checkWeather(verifyWeather),
        geminiCheck,
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

function checkLocalPermissions(): DoctorCheck {
  if (process.platform === 'win32') {
    return {
      name: 'Local file permissions',
      status: 'skip',
      detail: 'Windows does not expose Unix permission bits.',
    };
  }
  const paths = [resolve('.env'), dirname(getSharedSebDatabase().file)];
  const unsafe = paths.filter((path) => {
    if (!existsSync(path)) return false;
    return (statSync(path).mode & 0o077) !== 0;
  });
  if (unsafe.length > 0) {
    return {
      name: 'Local file permissions',
      status: 'fail',
      detail: `Restrict access to ${unsafe.join(', ')}. Use mode 0600 for .env and 0700 for .cache.`,
    };
  }
  return {
    name: 'Local file permissions',
    status: 'pass',
    detail: 'The local environment and cache paths use private permissions.',
  };
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
): Promise<{ fallbackUsed: boolean; model: string }> {
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
  const telemetry = {
    functionId: `seb.${telemetryOptions.surface}.${telemetryOptions.agentKind}`,
    integrations: [...devToolsTelemetry, usageTelemetry],
    isEnabled: true,
    recordInputs: recordContent,
    recordOutputs: recordContent,
  } satisfies TelemetryOptions;
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
