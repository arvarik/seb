import { tool } from 'ai';
import { z } from 'zod';
import { LearningService } from './service.js';
import { LearningStore } from './store.js';
import { DEFAULT_PROJECTION_PARAMETERS } from '../projection/statistics.js';
import { PPR_SCORING } from './engine.js';
import type { SleeperClient } from '../sleeper/client.js';

export function createLearningTools(sleeper: SleeperClient, store = new LearningStore(), service?: LearningService) {
  return {
    inspectLearning: tool({
      description: 'Inspect local forecast learning, validation errors, and player or team trends. State the scoring profile and learned week.',
      inputSchema: z.object({ season: z.number().int().min(1999).max(2100),
        week: z.number().int().min(1).max(19), leagueId: z.string().regex(/^\d+$/).optional(),
        playerId: z.string().max(100).optional(), team: z.string().max(10).optional() }),
      execute: async ({ season, week, leagueId, playerId, team }) => {
        const scoring = leagueId ? (await sleeper.getLeague(leagueId)).scoring_settings : PPR_SCORING;
        const context = await store.context(season, week - 1, scoring);
        const revision = context.revision;
        const active = { learningEnabled: context.enabled, manualOverride: context.manual, effectiveParameters: context.parameters ?? DEFAULT_PROJECTION_PARAMETERS };
        if (!revision) return { ...active, available: false, reason: 'No matching learning revision exists before this week.' };
        return { ...active, available: true, season, throughWeek: revision.throughWeek, scoring: revision.scoring,
          modelVersion: revision.modelVersion, parameters: revision.parameters, promoted: revision.promoted,
          reason: revision.reason, validationWeeks: revision.validationWeeks,
          baseline: revision.baseline, candidateMetrics: revision.candidateMetrics,
          player: playerId && Object.hasOwn(revision.players, playerId) ? revision.players[playerId] : null,
          team: team ? revision.teams[team.toUpperCase()] ?? null : null,
          playerCount: Object.keys(revision.players).length, sources: revision.sources };
      },
    }),
    learnCompletedWeek: tool({
      description: 'Refresh local learning from completed NFL weeks. Use only when the user requests a learning update. Validate parameters before promotion.',
      inputSchema: z.object({ season: z.number().int().min(1999).max(2100),
        throughWeek: z.number().int().min(1).max(18).optional(), leagueId: z.string().regex(/^\d+$/).optional() }),
      execute: async ({ season, throughWeek, leagueId }) => {
        const scoring = leagueId ? (await sleeper.getLeague(leagueId)).scoring_settings : PPR_SCORING;
        const result = await (service ?? new LearningService(undefined, store)).update({ season, scoring,
          ...(throughWeek === undefined ? {} : { throughWeek }) });
        return { changed: result.changed, file: result.file, season, throughWeek: result.revision.throughWeek,
          reason: result.revision.reason, parameters: result.revision.parameters,
          baseline: result.revision.baseline, candidateMetrics: result.revision.candidateMetrics };
      },
    }),
  };
}
