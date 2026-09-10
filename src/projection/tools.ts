import { compareProjections } from './comparison.js';
import { tool } from 'ai';
import { z } from 'zod';

import { NflverseClient } from '../nflverse/client.js';
import { SleeperClient } from '../sleeper/client.js';
import { WeatherClient } from '../weather/client.js';
import { PlayerProjectionService } from './service.js';
import { projectPlayers } from './batch.js';
import { projectLeagueMatchup } from './matchup.js';

const seasonSchema = z.number().int().min(1999).max(2100);

export function createProjectionTools(
  sleeper: SleeperClient,
  nflverse: NflverseClient,
  weather: WeatherClient,
) {
  const service = new PlayerProjectionService(sleeper, nflverse, weather);
  return {
    projectLeagueMatchup: tool({
      description: 'Calculate both roster subtotals for a selected league matchup. Reads the selected week starters, completed player scores, and remaining projections. Use the returned totals directly instead of adding player scores yourself. Includes team D/ST and individual special teams. Missing scores and unsupported scoring rules remain explicit.',
      inputSchema: z.object({
        leagueId: z.string().trim().regex(/^\d+$/),
        rosterId: z.number().int().positive(),
        season: seasonSchema,
        week: z.number().int().min(1).max(18),
      }),
      execute: (request) => projectLeagueMatchup(sleeper, nflverse, service, request),
    }),
    projectPlayers: tool({
      description: 'Project several QB, RB, WR, TE, K, or team D/ST starters in one selected league. Use this for roster or matchup analysis instead of repeated projectPlayer calls. Each result includes uncertainty and eligibility. Use a team name or code for D/ST. Missing projections remain unavailable. This tool does not add news adjustments or infer missing scores.',
      inputSchema: z.object({
        leagueId: z.string().trim().regex(/^\d+$/),
        playerNames: z.array(z.string().trim().min(2).max(100)).min(1).max(40),
        season: seasonSchema,
        week: z.number().int().min(1).max(18),
        analysisSeason: seasonSchema.optional(),
        throughWeek: z.number().int().min(1).max(18).optional(),
      }),
      execute: ({ analysisSeason, throughWeek, ...request }) => projectPlayers(service, {
        ...request,
        ...(analysisSeason === undefined ? {} : { analysisSeason }),
        ...(throughWeek === undefined ? {} : { throughWeek }),
      }),
    }),
    compareStartSit: tool({
      description: 'Compare two through six players using league scoring, forecast uncertainty, and scheduled games. Flag close decisions and ineligible players.',
      inputSchema: z.object({
        leagueId: z.string().trim().regex(/^\d+$/),
        playerNames: z.array(z.string().trim().min(2).max(100)).min(2).max(6),
        slot: z.enum(['QB', 'RB', 'WR', 'TE', 'FLEX', 'SUPER_FLEX', 'REC_FLEX', 'WRRB_FLEX', 'DEF', 'K']).optional(),
        season: seasonSchema, week: z.number().int().min(1).max(18),
      }),
      execute: async ({ playerNames, slot, ...request }) => compareProjections(await Promise.all(
        playerNames.map((playerName) => service.project({ ...request, playerName })),
      ), slot),
    }),
    projectPlayer: tool({
      description:
        'Project one player or team D/ST with the selected Sleeper league scoring rules. The result includes expected points, an 80% target interval, evidence completeness, adjustments, and limits.',
      inputSchema: z.object({
        leagueId: z.string().trim().regex(/^\d+$/),
        playerName: z.string().trim().min(2).max(100),
        season: seasonSchema.describe('The NFL season for the projected game.'),
        week: z.number().int().min(1).max(18),
        analysisSeason: seasonSchema
          .optional()
          .describe('The statistics season. Week 1 defaults to the prior season.'),
        throughWeek: z.number().int().min(1).max(18).optional(),
      }),
      inputExamples: [
        {
          input: {
            leagueId: '123456789012345678',
            playerName: 'Justin Jefferson',
            season: 2026,
            week: 8,
            analysisSeason: 2026,
            throughWeek: 7,
          },
        },
      ],
      strict: true,
      execute: async ({
        leagueId,
        playerName,
        season,
        week,
        analysisSeason,
        throughWeek,
      }) => service.project({
        leagueId,
        playerName,
        season,
        week,
        ...(analysisSeason === undefined ? {} : { analysisSeason }),
        ...(throughWeek === undefined ? {} : { throughWeek }),
      }),
    }),
  };
}
