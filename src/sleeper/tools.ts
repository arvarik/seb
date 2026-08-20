import { tool } from 'ai';
import { z } from 'zod';

import { SleeperAnalysisService } from './analysis-service.js';
import { SleeperClient } from './client.js';
import type { SleeperPlayer } from './types.js';

const identifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .describe('A Sleeper username or user ID.');
const leagueIdSchema = z
  .string()
  .trim()
  .regex(/^\d+$/)
  .describe('The numeric Sleeper league ID.');
const weekSchema = z
  .number()
  .int()
  .min(1)
  .max(18)
  .describe('The NFL week from 1 through 18.');
const analysisWeekSchema = z
  .number()
  .int()
  .min(0)
  .max(18)
  .optional()
  .describe('The last completed week. Use 0 when no games are complete.');

export function createSleeperTools(client: SleeperClient) {
  const analysis = new SleeperAnalysisService(client);

  return {
    getNflState: tool({
      description: 'Get the current NFL season, week, and Sleeper league season.',
      inputSchema: z.object({}),
      execute: async () => client.getNflState(),
    }),

    findPlayers: tool({
      description:
        'Find current Sleeper player records by a name or player ID. This returns profile, team, depth chart, and injury fields.',
      inputSchema: z.object({
        query: z.string().trim().min(1).max(100),
        position: z
          .string()
          .trim()
          .min(1)
          .max(10)
          .optional()
          .describe('An optional position, such as QB, RB, WR, TE, K, or DEF.'),
        includeInactive: z.boolean().optional().default(false),
        limit: z.number().int().min(1).max(25).optional().default(10),
      }),
      execute: async ({ query, position, includeInactive, limit }) =>
        (
          await client.findPlayers(query, {
            active: !includeInactive,
            ...(position ? { position } : {}),
            limit,
          })
        ).map(compactPlayer),
    }),

    getUserLeagues: tool({
      description:
        'Get an NFL user and that user\'s Sleeper leagues for one season.',
      inputSchema: z.object({
        user: identifierSchema,
        season: z
          .string()
          .regex(/^20\d{2}$/)
          .optional()
          .describe('The four-digit season. The current Sleeper league season is the default.'),
      }),
      execute: async ({ user: identifier, season }) => {
        const [user, state] = await Promise.all([
          client.getUser(identifier),
          season ? Promise.resolve(null) : client.getNflState(),
        ]);
        const selectedSeason = season ?? state?.league_season ?? state?.season;
        if (!selectedSeason) {
          throw new Error('Sleeper did not return a league season.');
        }
        return {
          user,
          season: selectedSeason,
          leagues: await client.getUserLeagues(user.user_id, selectedSeason),
        };
      },
    }),

    getLeagueOverview: tool({
      description:
        'Get league settings, users, rosters, records, and roster player IDs for a Sleeper league.',
      inputSchema: z.object({ leagueId: leagueIdSchema }),
      execute: async ({ leagueId }) => {
        const [league, users, rosters] = await Promise.all([
          client.getLeague(leagueId),
          client.getLeagueUsers(leagueId),
          client.getLeagueRosters(leagueId),
        ]);
        return { league, users, rosters };
      },
    }),

    getRosterPlayers: tool({
      description:
        'Get one fantasy roster and resolve its Sleeper player IDs into current player records.',
      inputSchema: z.object({
        leagueId: leagueIdSchema,
        rosterId: z.number().int().positive(),
      }),
      execute: async ({ leagueId, rosterId }) => {
        const details = await analysis.getRosterDetails(leagueId, rosterId);
        return {
          roster: details.roster,
          players: details.players.map(compactPlayer),
          missingPlayerIds: details.missingPlayerIds,
        };
      },
    }),

    getLeagueMatchups: tool({
      description:
        'Get every fantasy roster matchup and score for one Sleeper league week.',
      inputSchema: z.object({ leagueId: leagueIdSchema, week: weekSchema }),
      execute: async ({ leagueId, week }) => ({
        leagueId,
        week,
        matchups: await client.getLeagueMatchups(leagueId, week),
      }),
    }),

    getLeagueTransactions: tool({
      description:
        'Get completed and pending trades, waivers, and free-agent moves for one league week.',
      inputSchema: z.object({ leagueId: leagueIdSchema, week: weekSchema }),
      execute: async ({ leagueId, week }) => ({
        leagueId,
        week,
        transactions: await client.getLeagueTransactions(leagueId, week),
      }),
    }),

    getTrendingPlayers: tool({
      description:
        'Get the most added or dropped Sleeper players and resolve each player record.',
      inputSchema: z.object({
        type: z.enum(['add', 'drop']),
        lookbackHours: z.number().int().min(1).max(168).optional().default(24),
        limit: z.number().int().min(1).max(50).optional().default(25),
      }),
      execute: async ({ type, lookbackHours, limit }) => ({
        type,
        lookbackHours,
        players: (
          await client.getResolvedTrendingPlayers(type, lookbackHours, limit)
        ).map((item) => ({
          playerId: item.player_id,
          count: item.count,
          player: item.player ? compactPlayer(item.player) : null,
        })),
        source: 'Sleeper trending add and drop activity',
      }),
    }),

    analyzeLeague: tool({
      description:
        'Rank every fantasy roster and describe scoring strengths, weaknesses, recent form, consistency, and schedule context.',
      inputSchema: z.object({
        leagueId: leagueIdSchema,
        throughWeek: analysisWeekSchema,
      }),
      execute: async ({ leagueId, throughWeek }) =>
        analysis.analyzeLeague(leagueId, throughWeek),
    }),

    predictMatchup: tool({
      description:
        'Compare two fantasy rosters with a transparent estimate based only on prior Sleeper scores.',
      inputSchema: z.object({
        leagueId: leagueIdSchema,
        rosterAId: z.number().int().positive(),
        rosterBId: z.number().int().positive(),
        throughWeek: analysisWeekSchema,
      }),
      execute: async ({ leagueId, rosterAId, rosterBId, throughWeek }) =>
        analysis.predictMatchup(
          leagueId,
          rosterAId,
          rosterBId,
          throughWeek,
        ),
    }),
  };
}

function compactPlayer(player: SleeperPlayer) {
  return {
    playerId: player.player_id,
    name:
      player.full_name ??
      [player.first_name, player.last_name].filter(Boolean).join(' '),
    position: player.position ?? null,
    fantasyPositions: player.fantasy_positions ?? [],
    team: player.team ?? null,
    active: player.active ?? null,
    status: player.status ?? null,
    injuryStatus: player.injury_status ?? null,
    injuryBodyPart: player.injury_body_part ?? null,
    injuryNotes: player.injury_notes ?? null,
    practiceParticipation: player.practice_participation ?? null,
    depthChartPosition: player.depth_chart_position ?? null,
    depthChartOrder: player.depth_chart_order ?? null,
    number: player.number ?? null,
    age: player.age ?? null,
    yearsExperience: player.years_exp ?? null,
  };
}
