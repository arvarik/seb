import { tool } from 'ai';
import { z } from 'zod';

import type { NewsClient } from '../news/client.js';
import { bundleCandidateNewsChecks } from '../news/tools.js';
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
  news?: Pick<NewsClient, 'search'>,
) {
  const service = new TradeImpactService(sleeper, nflverse);
  return {
    analyzeTradeImpact: tool({
      description:
        'Compare both sides of a trade with league scoring, completed production, player status, roster depth, and automatically bundled first-class newsroom checks. This tool does not issue the final recommendation.',
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
      execute: async ({
        leagueId,
        rosterId,
        givePlayerNames,
        receivePlayerNames,
        analysisSeason,
        throughWeek,
      }) => {
        const result = await service.analyze({
          givePlayerNames,
          leagueId,
          receivePlayerNames,
          rosterId,
          ...(analysisSeason === undefined ? {} : { analysisSeason }),
          ...(throughWeek === undefined ? {} : { throughWeek }),
        });
        if (!news) return result;
        const bundledNewsChecks = await bundleCandidateNewsChecks(
          news,
          [...result.give.players, ...result.receive.players].map((player) => ({
            name: player.name,
            team: player.team,
          })),
          8,
        );
        return { ...result, bundledNewsChecks };
      },
    }),
  };
}
