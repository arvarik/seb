import { createGoogle } from '@ai-sdk/google';
import { generateText } from 'ai';

import {
  DEFAULT_GEMINI_FALLBACK_MODEL,
  DEFAULT_GEMINI_MODEL,
} from './agent.js';
import { isModelCapacityError } from './model-capacity-error.js';
import { SleeperClient } from './sleeper/client.js';

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

export interface DoctorOptions {
  environment?: NodeJS.ProcessEnv;
  nodeVersion?: string;
  offline: boolean;
  verifyGemini?: (
    apiKey: string,
    primaryModel: string,
    fallbackModel: string,
  ) => Promise<{ fallbackUsed: boolean; model: string }>;
  verifySleeper?: () => Promise<{
    season: string;
    seasonType: string;
    week: number;
  }>;
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
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

  if (options.offline) {
    checks.push(
      {
        name: 'Sleeper API',
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
    checks.push(await checkSleeper(verifySleeper));

    if (apiKey) {
      const verifyGemini = options.verifyGemini ?? verifyGeminiApi;
      checks.push(
        await checkGemini(apiKey, primaryModel, fallbackModel, verifyGemini),
      );
    } else {
      checks.push({
        name: 'Gemini API',
        status: 'skip',
        detail: 'The request needs a Gemini key.',
      });
    }
  }

  return {
    checks,
    ok: checks.every((check) => check.status !== 'fail'),
  };
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
): Promise<DoctorCheck> {
  try {
    const result = await verify(apiKey, primaryModel, fallbackModel);
    const suffix = result.fallbackUsed ? ' The primary model had no capacity.' : '';
    return {
      name: 'Gemini API',
      status: 'pass',
      detail: `${result.model} answered the test request.${suffix}`,
    };
  } catch (error) {
    return {
      name: 'Gemini API',
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
  const state = await new SleeperClient({ timeoutMs: 10_000 }).getNflState();
  return {
    season: state.season,
    seasonType: state.season_type,
    week: state.week,
  };
}

async function verifyGeminiApi(
  apiKey: string,
  primaryModel: string,
  fallbackModel: string,
): Promise<{ fallbackUsed: boolean; model: string }> {
  try {
    await sendGeminiTest(apiKey, primaryModel);
    return { fallbackUsed: false, model: primaryModel };
  } catch (error) {
    if (!isModelCapacityError(error) || fallbackModel === primaryModel) {
      throw error;
    }
    await sendGeminiTest(apiKey, fallbackModel);
    return { fallbackUsed: true, model: fallbackModel };
  }
}

async function sendGeminiTest(apiKey: string, model: string): Promise<void> {
  const google = createGoogle({ apiKey });
  await generateText({
    model: google(model),
    prompt: 'Reply with only OK.',
    maxOutputTokens: 32,
    abortSignal: AbortSignal.timeout(30_000),
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
