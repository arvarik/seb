import { loadEnvFile } from 'node:process';

import {
  createFantasyFootballAgent,
  DEFAULT_GEMINI_FALLBACK_MODEL,
  DEFAULT_GEMINI_MODEL,
} from './agent.js';
import { isModelCapacityError } from './model-capacity-error.js';

async function main(): Promise<void> {
  loadLocalEnvironment();

  const prompt = process.argv.slice(2).join(' ').trim();
  if (!prompt) {
    throw new Error(
      'Add a question. Example: npm run ask -- "Show the current NFL state."',
    );
  }

  const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      'Set GOOGLE_GENERATIVE_AI_API_KEY in .env. Start with: cp .env.example .env',
    );
  }

  const primaryModel = process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
  const fallbackModel =
    process.env.GEMINI_FALLBACK_MODEL?.trim() ||
    DEFAULT_GEMINI_FALLBACK_MODEL;

  try {
    process.stdout.write(
      `${await generateResponse(apiKey, primaryModel, prompt)}\n`,
    );
  } catch (error) {
    if (!isModelCapacityError(error) || fallbackModel === primaryModel) {
      throw error;
    }
    process.stderr.write(
      `${primaryModel} has no available capacity. Retrying with ${fallbackModel}.\n`,
    );
    process.stdout.write(
      `${await generateResponse(apiKey, fallbackModel, prompt)}\n`,
    );
  }
}

async function generateResponse(
  apiKey: string,
  model: string,
  prompt: string,
): Promise<string> {
  const agent = createFantasyFootballAgent({ apiKey, model });
  const result = await agent.generate({ prompt });
  return result.text;
}

function loadLocalEnvironment(): void {
  try {
    loadEnvFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Seb failed: ${message}\n`);
  process.exitCode = 1;
});
