import { throwIfRequestAborted } from '../ai/request-signal.js';
import { ResearchDataError } from '../data/research-error.js';
import type { PlayerProjectionRequest, PlayerProjectionService } from './service.js';
import type { ScoringAwarePlayerProjection } from './player-projection.js';

export type BatchPlayerProjection = {
  playerName: string;
} & (
  | { status: 'projected'; projection: ScoringAwarePlayerProjection }
  | { status: 'unavailable'; reason: string }
);

/** Projects each distinct player once, with at most four concurrent requests. */
export async function projectPlayers(
  service: Pick<PlayerProjectionService, 'project'>,
  request: Omit<PlayerProjectionRequest, 'playerName'> & { playerNames: string[] },
): Promise<{ results: BatchPlayerProjection[]; complete: boolean }> {
  const { playerNames, ...common } = request;
  const uniqueNames = new Map<string, string>();
  for (const name of playerNames) {
    const key = name.trim().toLowerCase();
    if (!uniqueNames.has(key)) uniqueNames.set(key, name.trim());
  }
  const names = [...uniqueNames.values()];
  const results: BatchPlayerProjection[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, names.length) }, async () => {
    while (next < names.length) {
      throwIfRequestAborted();
      const index = next++;
      const playerName = names[index]!;
      try {
        const projection = await service.project({ ...common, playerName });
        throwIfRequestAborted();
        results[index] = { playerName, status: 'projected', projection };
      } catch (error) {
        throwIfRequestAborted();
        if (error instanceof Error && error.name === 'AbortError') throw error;
        results[index] = {
          playerName,
          status: 'unavailable',
          reason: error instanceof ResearchDataError ? error.message
            : 'The projection data could not be loaded. Retry this player or report the missing projection.',
        };
      }
    }
  }));
  return { results, complete: results.every((result) => result.status === 'projected' && result.projection.scoreScope === 'weekly-estimate') };
}
