import { tool, type JSONValue } from 'ai';
import { z } from 'zod';

import type { NewsClient } from '../news/client.js';
import { bundleCandidateNewsChecks } from '../news/tools.js';
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
  news?: Pick<NewsClient, 'search'>,
) {
  const assistant = new WaiverAssistantService(sleeper, nflverse);
  return {
    rankWaiverTargets: tool({
      description:
        'Rank unrostered waiver targets for one Sleeper roster. This read-only tool uses league scoring, roster need, Sleeper add demand, player status, recent nflverse production, risk, a transparent FAAB range, and automatically bundled first-class newsroom checks for the top waiver candidates.',
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
      execute: async ({
        leagueId,
        rosterId,
        analysisSeason,
        throughWeek,
        lookbackHours,
        trendingLimit,
        resultLimit,
      }) => {
        const result = await assistant.rankTargets({
          leagueId,
          rosterId,
          lookbackHours,
          trendingLimit,
          resultLimit,
          ...(analysisSeason === undefined ? {} : { analysisSeason }),
          ...(throughWeek === undefined ? {} : { throughWeek }),
        });
        if (!news || result.targets.length === 0) return result;
        const prioritized = result.targets.slice(0, 3);
        const coveredPositions = new Set(prioritized.map((t) => t.player.position.toUpperCase()));
        for (const target of result.targets.slice(3)) {
          const pos = target.player.position.toUpperCase();
          if (!coveredPositions.has(pos)) {
            coveredPositions.add(pos);
            prioritized.push(target);
          }
          if (prioritized.length >= 6) break;
        }
        const bundledNewsChecks = await bundleCandidateNewsChecks(
          news,
          prioritized.map((target) => ({
            name: target.player.name,
            team: target.player.team,
          })),
          6,
        );
        return { ...result, bundledNewsChecks };
      },
      toModelOutput: ({ output }) => ({
        type: 'json',
        value: (
          !output || !Array.isArray(output.targets)
            ? output
            : {
                ...output,
                ...(output.methodology
                  ? {
                      methodology: {
                        ...output.methodology,
                        scoringKeysUsed: Array.isArray(output.methodology.scoringKeysUsed)
                          ? output.methodology.scoringKeysUsed.length
                          : output.methodology.scoringKeysUsed,
                      },
                    }
                  : {}),
                targets: output.targets.map((target) => ({
                  ...target,
                  production: target.production
                    ? {
                        analysisSeason: target.production.analysisSeason,
                        expectedPoints: target.production.expectedPoints,
                        games: target.production.games,
                        latestWeek: target.production.latestWeek,
                        recentAverage: target.production.recentAverage,
                        seasonAverage: target.production.seasonAverage,
                        trend: target.production.trend,
                      }
                    : null,
                })),
              }
        ) as unknown as JSONValue,
      }),
    }),
  };
}
