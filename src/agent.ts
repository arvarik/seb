import { createGoogle } from '@ai-sdk/google';
import { isStepCount, ToolLoopAgent, type LanguageModel } from 'ai';

import { SleeperClient } from './sleeper/client.js';
import { createSleeperTools } from './sleeper/tools.js';
import { NflverseClient } from './nflverse/client.js';
import { createNflverseTools } from './nflverse/tools.js';
import { WeatherClient } from './weather/client.js';
import { createWeatherTools } from './weather/tools.js';
import { createIdentityTools } from './identity/tools.js';

export const DEFAULT_GEMINI_MODEL = 'gemini-3.7-flash';
export const DEFAULT_GEMINI_FALLBACK_MODEL = 'gemini-3.6-flash';

export interface FantasyFootballAgentOptions {
  apiKey?: string;
  getRuntimeInstructions?: () => string;
  languageModel?: LanguageModel;
  model?: string;
  nflverseClient?: NflverseClient;
  onUsage?: (usage: {
    inputTokens: number | undefined;
    outputTokens: number | undefined;
    totalTokens: number | undefined;
  }) => void;
  sleeperClient?: SleeperClient;
  weatherClient?: WeatherClient;
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
  const nflverseClient = options.nflverseClient ?? new NflverseClient();
  const weatherClient = options.weatherClient ?? new WeatherClient();
  const tools = {
    ...createSleeperTools(sleeperClient),
    ...createNflverseTools(nflverseClient),
    ...createWeatherTools(weatherClient, nflverseClient),
    ...createIdentityTools(sleeperClient, nflverseClient),
  };

  return new ToolLoopAgent({
    model: languageModel,
    instructions: BASE_INSTRUCTIONS,
    prepareCall: ({ options: _options, ...call }) => ({
      ...call,
      instructions: [
        BASE_INSTRUCTIONS,
        options.getRuntimeInstructions?.(),
      ]
        .filter(Boolean)
        .join('\n\n'),
    }),
    onEnd: ({ usage }) => options.onUsage?.(usage),
    tools,
    stopWhen: isStepCount(12),
  });
}

const BASE_INSTRUCTIONS = `
You are Seb, a fantasy football analyst for Sleeper leagues.

Use a Sleeper tool for every current fact about a Sleeper user, league, roster, matchup, transaction, or add trend.
Use an nflverse tool for every schedule, game result, player game log, usage trend, team performance, or defense-by-position fact.
Use a National Weather Service tool for every current United States forecast or weather alert.
Use an identity tool when a player or team name can map to several source identifiers.
Use the prior completed season as a baseline when the current regular season has no weekly statistics. State that season clearly.
Never invent an ID, score, injury, schedule, news item, or projection.
Ask for a league ID or roster ID when the available facts do not identify one.
Distinguish an NFL team from a fantasy roster.

Seb has no publisher news feed or current injury-report feed.
Sleeper profile fields can contain injury information, but those fields are not a news report.
State this limit when a request needs current reporting.
Do not present model memory as current news.

For league analysis, explain the data period and the heuristic.
For matchup predictions, state the probability, the expected scores, the confidence, and the disclaimer.
Treat all predictions as estimates, not facts or betting advice.
Separate a future forecast from a recorded historical game condition.
Treat the betting line fields as context, not betting advice.

Keep the response concise.
Use clear tables when the user asks for comparisons across three or more rosters.
`.trim();
