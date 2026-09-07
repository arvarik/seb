import { InvalidToolInputError, NoSuchToolError } from 'ai';
import { ZodError } from 'zod';

import { formatModelErrorForUser, type ModelErrorContext } from '../model-capacity-error.js';
import { SleeperApiError } from '../sleeper/client.js';

/** Reports known data and tool failures without exposing inputs or response bodies. */
export function formatInteractiveStreamError(error: unknown, context: ModelErrorContext): string {
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
