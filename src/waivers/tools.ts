import { tool } from 'ai';
import { z } from 'zod';

import { NflverseClient } from '../nflverse/client.js';
import { SleeperClient } from '../sleeper/client.js';
import { WaiverAssistantService } from './service.js';

const leagueIdSchema = z
  .string()
  .trim()
  .regex(/^\d+$/)
  .describe('The numeric Sleeper league ID.');

export function createWaiverTools(
  sleeper: SleeperClient,
  nflverse: NflverseClient,
) {
  const assistant = new WaiverAssistantService(sleeper, nflverse);
  return {
    rankWaiverTargets: tool({
      description:
        'Rank unrostered waiver targets for one Sleeper roster. This read-only tool uses league scoring, roster need, Sleeper add demand, player status, recent nflverse production, risk, and a transparent FAAB range.',
      inputSchema: z.object({
        leagueId: leagueIdSchema,
        rosterId: z.number().int().positive(),
        analysisSeason: z.number().int().min(1999).max(2200).optional(),
        throughWeek: z.number().int().min(1).max(18).optional(),
        lookbackHours: z.number().int().min(1).max(168).optional().default(24),
        trendingLimit: z.number().int().min(1).max(50).optional().default(50),
        resultLimit: z.number().int().min(1).max(25).optional().default(10),
      }),
      inputExamples: [{
        input: {
          leagueId: '123456789012345678',
          rosterId: 4,
          lookbackHours: 24,
          trendingLimit: 50,
          resultLimit: 10,
        },
      }],
      strict: true,
      execute: async ({
        leagueId,
        rosterId,
        analysisSeason,
        throughWeek,
        lookbackHours,
        trendingLimit,
        resultLimit,
      }) => assistant.rankTargets({
        leagueId,
        rosterId,
        lookbackHours,
        trendingLimit,
        resultLimit,
        ...(analysisSeason === undefined ? {} : { analysisSeason }),
        ...(throughWeek === undefined ? {} : { throughWeek }),
      }),
    }),
  };
}
