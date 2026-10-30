import { compareProjections } from './comparison.js';
import { tool, type JSONValue } from 'ai';
import { z } from 'zod';

import type { NewsClient } from '../news/client.js';
import { bundleCandidateNewsChecks } from '../news/tools.js';
import { NflverseClient } from '../nflverse/client.js';
import { SleeperClient } from '../sleeper/client.js';
import { WeatherClient } from '../weather/client.js';
import { PlayerProjectionService, type ProjectionSnapshotStore } from './service.js';
import { projectPlayers } from './batch.js';
import { optimizeRosterLineup, projectLeagueMatchup } from './matchup.js';

const seasonSchema = z.number().int().min(1999).max(2100);

export interface ProjectionToolsOptions {
  news?: Pick<NewsClient, 'search'> | undefined;
  snapshotDatabase?: ProjectionSnapshotStore | false | undefined;
}

export function createProjectionTools(
  sleeper: SleeperClient,
  nflverse: NflverseClient,
  weather: WeatherClient,
  options?: ProjectionToolsOptions,
) {
  const service = new PlayerProjectionService(
    sleeper,
    nflverse,
    weather,
    undefined,
    options?.snapshotDatabase ?? false,
  );
  return {
    optimizeRosterLineup: tool({
      description: 'Solve the optimal legal starting lineup for a Sleeper roster in a selected week. Projects starters and bench players, assigns overlapping FLEX/SUPER_FLEX slots via exact combinatorial optimization, returns concrete bench-to-starter swaps and point gains, and automatically bundles first-class newsroom checks for swap and injured starter candidates.',
      inputSchema: z.object({
        leagueId: z.string().trim().regex(/^\d+$/),
        rosterId: z.number().int().positive(),
        season: seasonSchema,
        week: z.number().int().min(1).max(18),
      }),
      execute: async (request) => {
        const result = await optimizeRosterLineup(sleeper, nflverse, service, request);
        if (!options?.news) return result;
        const teamById = new Map<string, string>();
        for (const item of result.projections) {
          if (item.status === 'projected' && item.projection.player.team) {
            teamById.set(item.projection.player.playerId, item.projection.player.team);
          }
        }
        const candidates: Array<{ name: string; team?: string | undefined }> = [];
        for (const swap of result.recommendedSwaps) {
          candidates.push({
            name: swap.startPlayer.name,
            team: teamById.get(swap.startPlayer.playerId),
          });
          if (swap.sitPlayer && swap.sitPlayer.playerId !== '0') {
            candidates.push({
              name: swap.sitPlayer.name,
              team: teamById.get(swap.sitPlayer.playerId),
            });
          }
        }
        for (const starter of result.optimalLineup) {
          if (starter.injuryStatus) {
            candidates.push({
              name: starter.name,
              team: teamById.get(starter.playerId),
            });
          }
        }
        if (candidates.length === 0 && result.optimalLineup.length > 0) {
          const topStarter = [...result.optimalLineup]
            .sort((a, b) => (b.points ?? -Infinity) - (a.points ?? -Infinity))[0]!;
          candidates.push({
            name: topStarter.name,
            team: teamById.get(topStarter.playerId),
          });
        }
        const bundledNewsChecks = await bundleCandidateNewsChecks(options.news, candidates, 6);
        return { ...result, bundledNewsChecks };
      },
      toModelOutput: ({ output: { projections: _projections, ...rest } }) => ({
        type: 'json',
        value: rest as unknown as JSONValue,
      }),
    }),
    projectLeagueMatchup: tool({
      description: 'Calculate both roster subtotals for a selected league matchup. Reads the selected week starters, completed player scores, and remaining projections. Use the returned totals directly instead of adding player scores yourself. Includes team D/ST and individual special teams. Missing scores and unsupported scoring rules remain explicit.',
      inputSchema: z.object({
        leagueId: z.string().trim().regex(/^\d+$/),
        rosterId: z.number().int().positive(),
        season: seasonSchema,
        week: z.number().int().min(1).max(18),
      }),
      execute: (request) => projectLeagueMatchup(sleeper, nflverse, service, request),
      toModelOutput: ({ output: { projections: _projections, ...rest } }) => ({
        type: 'json',
        value: rest as unknown as JSONValue,
      }),
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
      description: 'Compare two through six players using league scoring, forecast uncertainty, scheduled games, and automatically bundled first-class newsroom checks. Flag close decisions and ineligible players.',
      inputSchema: z.object({
        leagueId: z.string().trim().regex(/^\d+$/),
        playerNames: z.array(z.string().trim().min(2).max(100)).min(2).max(6),
        slot: z.enum(['QB', 'RB', 'WR', 'TE', 'FLEX', 'WRRBTE_FLEX', 'SUPER_FLEX', 'REC_FLEX', 'WRTE_FLEX', 'WRRB_FLEX', 'DEF', 'K']).optional(),
        season: seasonSchema, week: z.number().int().min(1).max(18),
      }),
      execute: async ({ playerNames, slot, ...request }) => {
        const [projections, league] = await Promise.all([
          Promise.all(playerNames.map((playerName) => service.project({ ...request, playerName }))),
          sleeper.getLeague(request.leagueId).catch(() => null),
        ]);
        const comparison = compareProjections(projections, slot, league?.roster_positions);
        if (!options?.news) return comparison;
        const bundledNewsChecks = await bundleCandidateNewsChecks(
          options.news,
          projections.map((proj) => ({ name: proj.player.name, team: proj.player.team })),
          6,
        );
        return { ...comparison, bundledNewsChecks };
      },
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
