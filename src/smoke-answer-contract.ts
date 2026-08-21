import { loadEnvFile } from 'node:process';

import {
  createFantasyFootballAnalysisAgent,
  DEFAULT_GEMINI_FALLBACK_MODEL,
  DEFAULT_GEMINI_MODEL,
} from './agent.js';
import { fantasyAnalysisSchema } from './analysis/output.js';
import { isModelCapacityError } from './model-capacity-error.js';

try {
  loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

const apiKey = requiredApiKey(process.env.GOOGLE_GENERATIVE_AI_API_KEY);

const primaryModel = process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
const fallbackModel = process.env.GEMINI_FALLBACK_MODEL?.trim() ||
  DEFAULT_GEMINI_FALLBACK_MODEL;

const evidence = {
  question: 'Summarize the supplied player evidence. Do not recommend an action.',
  research: {
    dataPeriod: '2025 regular season through Week 3',
    player: 'Contract Test Player',
    weeklyPoints: [12.4, 15.1, 13.8],
  },
  sources: [{
    label: 'Contract fixture',
    retrievedAt: '2026-08-21T00:00:00.000Z',
  }],
};

let model = primaryModel;
let output;
try {
  output = await requestAnswer(model);
} catch (error) {
  if (!isModelCapacityError(error) || fallbackModel === primaryModel) throw error;
  model = fallbackModel;
  output = await requestAnswer(model);
}

const parsed = fantasyAnalysisSchema.parse(output);
if (parsed.recommendation !== null) {
  throw new Error('The live answer contract added an unsupported recommendation.');
}
if (!parsed.summary.includes('Contract Test Player')) {
  throw new Error('The live answer contract lost the supplied player identity.');
}

process.stdout.write(`${JSON.stringify({
  confidence: parsed.confidence,
  kind: parsed.kind,
  model,
  schemaVersion: parsed.schemaVersion,
  subject: parsed.subject,
}, null, 2)}\n`);

async function requestAnswer(requestedModel: string) {
  const agent = createFantasyFootballAnalysisAgent({
    apiKey,
    model: requestedModel,
  });
  const result = await agent.generate({
    abortSignal: AbortSignal.timeout(45_000),
    prompt: JSON.stringify(evidence),
  });
  return result.output;
}

function requiredApiKey(value: string | undefined): string {
  const apiKey = value?.trim();
  if (!apiKey) {
    throw new Error(
      'GOOGLE_GENERATIVE_AI_API_KEY is required for the live answer contract.',
    );
  }
  return apiKey;
}
