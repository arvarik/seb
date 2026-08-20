import { createGoogle } from '@ai-sdk/google';
import { isStepCount, ToolLoopAgent, type LanguageModel } from 'ai';

import { SleeperClient } from './sleeper/client.js';
import { createSleeperTools } from './sleeper/tools.js';

export const DEFAULT_GEMINI_MODEL = 'gemini-3.7-flash';
export const DEFAULT_GEMINI_FALLBACK_MODEL = 'gemini-3.6-flash';

export interface FantasyFootballAgentOptions {
  apiKey?: string;
  languageModel?: LanguageModel;
  model?: string;
  sleeperClient?: SleeperClient;
}

export function createFantasyFootballAgent(
  options: FantasyFootballAgentOptions,
) {
  let languageModel = options.languageModel;
  if (!languageModel) {
    const apiKey = options.apiKey?.trim();
    if (!apiKey) {
      throw new Error('The Google Generative AI API key is empty.');
    }
    const google = createGoogle({ apiKey });
    languageModel = google(options.model ?? DEFAULT_GEMINI_MODEL);
  }

  const sleeperClient = options.sleeperClient ?? new SleeperClient();

  return new ToolLoopAgent({
    model: languageModel,
    instructions: `
You are Seb, a fantasy football analyst for Sleeper leagues.

Use a Sleeper tool for every current fact about a player, user, league, roster, matchup, transaction, season, or trend.
Never invent an ID, score, injury, schedule, news item, or projection.
Ask for a league ID or roster ID when the available facts do not identify one.
Distinguish an NFL team from a fantasy roster.

The V0 has Sleeper data only.
Sleeper does not provide documented NFL schedules, player game logs, projections, or news through these tools.
State this limit when a request needs missing data.
Do not present model memory as current news.

For league analysis, explain the data period and the heuristic.
For matchup predictions, state the probability, the expected scores, the confidence, and the disclaimer.
Treat all predictions as estimates, not facts or betting advice.

Keep the response concise.
Use clear tables when the user asks for comparisons across three or more rosters.
`.trim(),
    tools: createSleeperTools(sleeperClient),
    stopWhen: isStepCount(10),
  });
}
