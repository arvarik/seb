import { InvalidToolInputError, NoSuchToolError } from 'ai';
import { ZodError } from 'zod';

import { formatModelErrorForUser, type ModelErrorContext } from '../model-capacity-error.js';
import { SleeperApiError } from '../sleeper/client.js';
import { NflverseApiError } from '../nflverse/client.js';
import { WeatherApiError } from '../weather/client.js';
import { ResearchDataError } from '../data/research-error.js';

/** Reports known data and tool failures without exposing inputs or response bodies. */
export function formatInteractiveStreamError(error: unknown, context: ModelErrorContext): string {
  if (error instanceof ResearchDataError) return error.message;
  if (error instanceof NflverseApiError) {
    return 'nflverse could not return the requested statistics. Retry or use the prior completed season.';
  }
  if (error instanceof WeatherApiError) {
    return 'The weather service could not return the forecast. Retry the weather request.';
  }
  if (NoSuchToolError.isInstance(error)) {
    return 'The model requested an unavailable tool. Retry with one of the available tools.';
  }
  if (InvalidToolInputError.isInstance(error)) {
    return 'The model supplied invalid tool inputs. Retry with the required tool inputs.';
  }
  if (error instanceof ZodError) {
    return 'A data source returned an unexpected format. Run `/stats session` to identify the failed tool.';
  }
  if (error instanceof SleeperApiError) {
    if (error.status === 404) return 'Sleeper could not find this resource. Check the league or user ID, then retry.';
    if (error.status === 429) return 'Sleeper limited the request rate. Wait briefly, then retry.';
    return 'Sleeper could not return the requested data. Retry the request or run `/doctor`.';
  }
  return formatModelErrorForUser(error, 'interactive', context);
}
