import { tool } from 'ai';
import { z } from 'zod';

import { NflverseClient } from '../nflverse/client.js';
import { SleeperClient } from '../sleeper/client.js';
import { TradeImpactService } from './service.js';

const playerNamesSchema = z.array(z.string().trim().min(2).max(100))
  .min(1)
  .max(8)
  .refine(
    (names) => new Set(names.map(normalizePlayerName)).size === names.length,
    'Each trade player must appear only once.',
  );

function normalizePlayerName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, ' ').trim();
}

export function createTradeTools(
  sleeper: SleeperClient,
  nflverse: NflverseClient,
) {
  const service = new TradeImpactService(sleeper, nflverse);
  return {
    analyzeTradeImpact: tool({
      description:
        'Compare both sides of a trade with league scoring, completed production, player status, and roster depth. This tool does not issue the final recommendation.',
      inputSchema: z.object({
        leagueId: z.string().trim().regex(/^\d+$/),
        rosterId: z.number().int().positive(),
        givePlayerNames: playerNamesSchema,
        receivePlayerNames: playerNamesSchema,
        analysisSeason: z.number().int().min(1999).max(2100).optional(),
        throughWeek: z.number().int().min(1).max(18).optional(),
      }),
      inputExamples: [{
        input: {
          leagueId: '123456789012345678',
          rosterId: 4,
          givePlayerNames: ['Player One'],
          receivePlayerNames: ['Player Two'],
          analysisSeason: 2026,
          throughWeek: 7,
        },
      }],
      strict: true,
      execute: async ({
        leagueId,
        rosterId,
        givePlayerNames,
        receivePlayerNames,
        analysisSeason,
        throughWeek,
      }) => service.analyze({
        givePlayerNames,
        leagueId,
        receivePlayerNames,
        rosterId,
        ...(analysisSeason === undefined ? {} : { analysisSeason }),
        ...(throughWeek === undefined ? {} : { throughWeek }),
      }),
    }),
  };
}
